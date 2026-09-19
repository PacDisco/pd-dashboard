// netlify/functions/_shared/cash-refresh.mjs
//
// Pull the cached monthly data from Xero and store it.
//
// WHY THIS IS ITS OWN MODULE
// --------------------------
// Closed months are cached forever, because a closed month does not change.
// But the CODE that reads them does, and every time it has, the cache has been
// the last thing holding the old wrong numbers:
//
//   - the P&L parser was fixed with standardLayout; August corrected itself and
//     April to July sat on 18,657 / 131 / 25,170 / 4,687 for another week.
//   - the Bank Summary parser was fixed to stop reading the FX Gain column as
//     the closing balance; the same five months kept reporting closing
//     balances of zero afterwards.
//
// Both times the answer was "wait for the hourly sync", and both times that was
// a bad answer: it is unverifiable from the dashboard, indistinguishable from
// the fix not working, and it asks someone to sit and wonder for an hour.
//
// So the refresh is a function anyone with write access can call on demand, and
// the scheduled sync calls the same one. There is exactly one implementation of
// "what does a refresh do", which also means the on-demand path cannot drift
// away from the scheduled one.
//
// READ-ONLY AGAINST XERO. Every Xero request here is a GET; the only writes are
// to this application's own blob store.

import { getStore } from "@netlify/blobs";
import {
  fiscalMonthKeys, fetchMonthActuals, getBankAccountCurrencies,
  isMonthRecordCurrent, BANKSUMMARY_PARSER_VERSION,
} from "./cash-xero.mjs";
import { fetchMonthOpex, isOpexRecordCurrent, OPEX_PARSER_VERSION } from "./cash-opex.mjs";
import { listBudgets, fetchBudget, accountIndex, overheadsFromBudget, budgetSeries } from "./cash-budget.mjs";
import {
  bankAccountIndex, fetchMonthTransactions, isTxRecordCurrent, TX_PARSER_VERSION,
} from "./cash-bank-tx.mjs";
import { loadAssumptions } from "./cash-store.mjs";

/**
 * A refresh does not fit in one HTTP request, and pretending it does is how the
 * transaction pull silently never happened.
 *
 * Twelve Bank Summaries, twelve months of transactions across three paged
 * endpoints, eleven P&L calls and a budget is comfortably sixty Xero requests.
 * A Netlify function gets ten seconds. The earlier passes finish, the function
 * is killed partway through the later ones, and the only symptom is a store
 * that stays empty — which looks exactly like a fix that did not work.
 *
 * So every pass takes a deadline, stops cleanly when it runs out, and reports
 * how much is left. The caller calls again until nothing is.
 */
export function deadlineIn(ms) {
  const at = Date.now() + ms;
  return () => Date.now() >= at;
}
const NO_DEADLINE = () => false;

/**
 * A clock alone was not enough, for two reasons that both bit.
 *
 * FIRST: each pass did setup work — an Accounts call to index the bank
 * accounts, a currency lookup — BEFORE reaching the loop where the deadline is
 * checked. Three passes past their deadline still cost three Xero round trips,
 * and the function was killed before it could reply at all. The symptom is not
 * an error message; it is "response was not JSON", because what came back was
 * Netlify's HTML timeout page.
 *
 * SECOND: a deadline can only stop work that has not started. One month of
 * transactions is three paged endpoints and can take several seconds by itself,
 * so checking the clock between months still allows a single unit of work to
 * overrun everything.
 *
 * So the budget is a clock AND a hard count of units. The count is what makes
 * this predictable: a request does at most N pulls whatever the network is
 * doing, and comes back to say what is left.
 */
export function budgetOf(ms, units) {
  const expired = deadlineIn(ms);
  let left = units;
  return {
    expired,
    // True when there is room to do one more pull. Decrements when there is.
    take() {
      if (left <= 0 || expired()) return false;
      left -= 1;
      return true;
    },
    get spent() { return units - left; },
  };
}
const UNLIMITED = { expired: NO_DEADLINE, take: () => true, spent: 0 };

/* Where the background worker reports progress, and where the dashboard reads
 * it. One key: a refresh is a single global operation, not a per-user one. */
export const STATUS_KEY = "refresh-status";
export function statusStore() {
  return getStore({ name: "cash-xero-refresh", consistency: "strong" });
}

/**
 * Bank Summary months.
 *
 * @param force  ignore the cache entirely and refetch every month. For the
 *               on-demand path, where someone has just deployed a parser change
 *               and wants to see it take effect now rather than reasoning about
 *               which months the version check will catch.
 */
export async function refreshMonths(token, tenantId, fy, { force = false, budget = UNLIMITED } = {}) {
  const store = getStore({ name: "cash-xero-months", consistency: "strong" });
  const out = { fetched: 0, cached: 0, restated: 0, remaining: 0, version: BANKSUMMARY_PARSER_VERSION, error: null };
  // Out of budget before doing ANY setup work. The Accounts lookup below is
  // itself a Xero round trip, and three passes each spending one of those past
  // their deadline is what killed the request outright.
  if (budget.expired()) { out.remaining = 12; return out; }
  try {
    const currency = await getBankAccountCurrencies(token, tenantId, "NZD");
    const keys = fiscalMonthKeys(fy);
    // The current month and the one before it always refresh: late supplier
    // invoices and bank feeds land a few days after month end.
    const alwaysRefresh = keys.slice(-2);

    for (const key of keys) {
      const blobKey = `${tenantId}/${key}`;
      if (!force && !alwaysRefresh.includes(key)) {
        const stored = await store.get(blobKey, { type: "json" });
        if (isMonthRecordCurrent(stored)) { out.cached++; continue; }
        if (stored) out.restated++;
      }
      // Checked BEFORE the work, not after: stopping with the month unwritten
      // leaves it to the next call, where stopping after it would still have
      // been killed mid-request.
      if (!budget.take()) { out.remaining++; continue; }
      await store.setJSON(blobKey, await fetchMonthActuals(token, tenantId, key, currency));
      out.fetched++;
    }
  } catch (err) {
    out.error = err.message;
  }
  return out;
}

/** Operating expenses, one P&L call per finished month. */
/**
 * How many fiscal years of P&L to keep.
 *
 * WHY MORE THAN ONE
 * -----------------
 * The calendar cost profile — what share of a year's program cost leaves in
 * each fiscal month — can only be defined by a COMPLETE fiscal year, because a
 * part-year's shares describe the months it happens to contain. This function
 * used to walk `fiscalMonthKeys(fy)` alone, so the only year it ever stored was
 * the one still running. There was never a complete year in the store and there
 * never could be, which the panel reported as "no complete fiscal year" without
 * either of us being able to tell that no amount of waiting would fix it.
 *
 * Matches TX_HISTORY_YEARS so the two sides of a month arrive together.
 */
export const OPEX_HISTORY_YEARS = 2;

export async function refreshOpex(token, tenantId, fy, { force = false, budget = UNLIMITED, years = OPEX_HISTORY_YEARS } = {}) {
  const store = getStore({ name: "cash-xero-opex", consistency: "strong" });
  const out = { fetched: 0, cached: 0, restated: 0, remaining: 0, version: OPEX_PARSER_VERSION, error: null, years };
  if (budget.expired()) { out.remaining = 11 * Math.max(1, years); return out; }
  try {
    // Current year first, then each prior one, so a budget that runs out leaves
    // the forecast's own months complete and only the history short.
    const finished = [];
    for (let back = 0; back < Math.max(1, years); back++) {
      const y = fy - back;
      // The current month is still running, so its P&L is partial. A past year
      // has no running month — take all twelve.
      finished.push(...(back === 0
        ? fiscalMonthKeys(y).slice(0, -1)
        : fiscalMonthKeys(y, new Date(`${y + 1}-03-31T00:00:00Z`))));
    }
    const alwaysRefresh = fiscalMonthKeys(fy).slice(0, -1).slice(-1);

    for (const key of finished) {
      const blobKey = `${tenantId}/${key}`;
      if (!force && !alwaysRefresh.includes(key)) {
        const stored = await store.get(blobKey, { type: "json" });
        if (isOpexRecordCurrent(stored)) { out.cached++; continue; }
        if (stored) out.restated++;
      }
      if (!budget.take()) { out.remaining++; continue; }
      await store.setJSON(blobKey, await fetchMonthOpex(token, tenantId, key));
      out.fetched++;
    }
  } catch (err) {
    out.error = err.message;
  }
  return out;
}

/** Budget Manager, for forward overheads. Small, so always refetched. */
export async function refreshBudget(token, tenantId, fy) {
  const out = { accounts: 0, description: null, error: null };
  try {
    const assumptions = await loadAssumptions(fy);
    const budgets = await listBudgets(token, tenantId);
    const chosen = assumptions.xeroBudgetId
      ? budgets.find((b) => b.budgetID === assumptions.xeroBudgetId)
      : budgets[0];
    if (!chosen) return out;

    const [budget, accounts] = await Promise.all([
      fetchBudget(token, tenantId, chosen.budgetID, { from: `${fy}-04-01`, to: `${fy + 1}-03-31` }),
      accountIndex(token, tenantId),
    ]);
    if (!budget) return out;

    const result = overheadsFromBudget(budget, accounts, fy);
    // Revenue and cost of sales from the same budget, in the same pass. The
    // cash forecast has no use for either — program costs come from pax — but
    // the surplus view cannot be computed without them, and fetching the budget
    // twice to get two views of it would be absurd.
    const series = budgetSeries(budget, accounts, fy);
    await getStore({ name: "cash-xero-budget", consistency: "strong" })
      .setJSON(`${tenantId}/${fy}`, {
        budgetID: chosen.budgetID,
        description: chosen.description,
        requested: assumptions.xeroBudgetId ?? null,
        months: result.months,
        monthsCovered: result.slotsCovered.length,
        included: result.included,
        excluded: result.excluded,
        // The three lines a surplus is made of, each POSITIVE. Nothing is
        // netted off here; the subtraction happens once, where it can be read.
        series: {
          revenue: series.revenue.months,
          directCosts: series.directCosts.months,
          overheads: series.overheads.months,
          revenueTotal: series.revenue.total,
          directCostsTotal: series.directCosts.total,
          overheadsTotal: series.overheads.total,
          surplus: series.surplus,
          monthsCovered: series.monthsCovered,
          revenueAccounts: series.revenue.included,
          directCostAccounts: series.directCosts.included,
        },
        fetchedAt: new Date().toISOString(),
      });
    out.accounts = result.included.length;
    out.description = chosen.description;
  } catch (err) {
    // A 403 here means accounting.budgets.read was not granted. Everything else
    // carries on — the forecast keeps whatever overheads it had.
    out.error = err.message;
  }
  return out;
}

/**
 * Bank movement in the currency each account actually holds.
 *
 * WHY THIS IS SEPARATE FROM refreshMonths
 * ---------------------------------------
 * The Bank Summary reports EVERY account converted to the base currency. So the
 * bucket the dashboard labelled "USD" has always held New Zealand dollars, and
 * the engine then multiplied it by the planning rate a second time — August's
 * total position read 370,307 where about 204,500 was right.
 *
 * The transaction detail is in each account's own currency, so it is the only
 * source that can say how many actual dollars are sitting in Wise. It also
 * excludes transfers between the organisation's own accounts, which the summary
 * cannot: June moved roughly 1.08m between nineteen accounts and counted every
 * leg as cash.
 *
 * Runs AFTER refreshMonths, because the implied rate comes from comparing the
 * two views of the same month.
 */
/**
 * How many fiscal years of transactions to keep.
 *
 * WHY MORE THAN ONE
 * -----------------
 * A cost curve is "how does spend on a program sit relative to its departure",
 * and that needs a COMPLETE cycle: first supplier deposit through to final
 * payment. The current year alone cannot give one. Fall departs 1 September, so
 * April to August is entirely pre-departure — enough to see the ramp up, and
 * nothing at all about the departure month or the tail. Deriving a full curve
 * from it would mean inventing the second half again, which is what the whole
 * exercise is meant to stop.
 *
 * One prior year gives Fall 25, Spring 26 and Summer 26 start to finish. Roughly
 * seventy extra Xero calls, once, against a daily limit of a thousand.
 */
export const TX_HISTORY_YEARS = 2;

export async function refreshTransactions(token, tenantId, fy, { force = false, budget = UNLIMITED, years = TX_HISTORY_YEARS } = {}) {
  const store = getStore({ name: "cash-xero-tx", consistency: "strong" });
  const monthStore = getStore({ name: "cash-xero-months", consistency: "strong" });
  const out = { fetched: 0, cached: 0, restated: 0, remaining: 0, version: TX_PARSER_VERSION, error: null, truncated: [], years };
  // Same reason as refreshMonths: bankAccountIndex is a Xero call, and spending
  // it when there is no budget left to use the result is pure overrun.
  if (budget.expired()) { out.remaining = 12 * Math.max(1, years); return out; }
  try {
    const accounts = await bankAccountIndex(token, tenantId, "NZD");
    // The current year, then each prior one. Current first so a budget that runs
    // out leaves the forecast's own months complete and only the history short.
    const keys = [];
    for (let back = 0; back < Math.max(1, years); back++) {
      const y = fy - back;
      // A past year is complete, so take the whole twelve months rather than
      // stopping at today.
      keys.push(...(back === 0
        ? fiscalMonthKeys(y)
        : fiscalMonthKeys(y, new Date(`${y + 1}-03-31T00:00:00Z`))));
    }
    const alwaysRefresh = fiscalMonthKeys(fy).slice(-2);

    for (const key of keys) {
      const blobKey = `${tenantId}/${key}`;
      if (!force && !alwaysRefresh.includes(key)) {
        const stored = await store.get(blobKey, { type: "json" });
        if (isTxRecordCurrent(stored)) { out.cached++; continue; }
        if (stored) out.restated++;
      }
      // The heaviest pass by far — three paged endpoints per month — so this is
      // the one that was being cut off, and the one the budget matters for.
      if (!budget.take()) { out.remaining++; continue; }
      // A prior year has no stored bank summary, so no implied rate — foreign
      // amounts in those months come back unconverted and say so, rather than
      // being mixed into a base-currency total at a guessed rate.
      const month = await monthStore.get(blobKey, { type: "json" });
      const record = await fetchMonthTransactions(
        token, tenantId, key, accounts, month?.byCurrency ?? {});
      await store.setJSON(blobKey, record);
      if (record.truncated) out.truncated.push(key);
      out.fetched++;
    }
  } catch (err) {
    out.error = err.message;
  }
  return out;
}

/**
 * All of them, in dependency order, within a time budget.
 *
 * Transactions run second because the implied rate needs both views of the same
 * month, and the bank summary is the other one. Budget runs last because it is a
 * handful of calls and never the thing that gets starved.
 */
export async function refreshAll(token, tenantId, fy, { force = false, budget = UNLIMITED } = {}) {
  /* ORDER: CHEAPEST AND MOST USEFUL FIRST.
   *
   * This used to run months → transactions → opex → budget, and that ordering
   * quietly broke three features at once.
   *
   * The transaction pass is by far the heaviest: two years of months, each one
   * three paged Xero endpoints plus a batch of supplier bills — six or more
   * calls per month, twenty-four months. It routinely consumes the whole
   * twelve-minute allowance on its own. Everything behind it therefore never
   * ran, and the symptom was not an error: overheads stayed on an old parser,
   * cost phasing said "no program cost recorded", and the surplus view said
   * nothing had been closed off. Three different panels reporting three
   * different problems, all caused by a pass that never got a turn.
   *
   * The P&L pass is ONE call per month and it is what the overheads, the cost
   * profile and the surplus all read. The budget is a handful of calls and it
   * is the entire right-hand column of the surplus view. Both now go first.
   *
   * Transactions go last because they are the only pass that degrades
   * gracefully: they drive reconciliation detail and tracking coverage, so a
   * partial pull is genuinely useful and the next run continues where this one
   * stopped. Nothing else has that property. */
  const months = await refreshMonths(token, tenantId, fy, { force, budget });
  const opex = await refreshOpex(token, tenantId, fy, { force, budget });
  // Skipped rather than half-run when the budget has gone: a partial budget
  // write would look like a complete one.
  const budgetResult = budget.expired() || !budget.take()
    ? { accounts: 0, description: null, error: null, skipped: true }
    : await refreshBudget(token, tenantId, fy);
  const transactions = await refreshTransactions(token, tenantId, fy, { force, budget });

  const remaining = months.remaining + transactions.remaining + opex.remaining +
    (budgetResult.skipped ? 1 : 0);

  return {
    months, transactions, opex, budget: budgetResult,
    remaining, done: remaining === 0, pullsThisPass: budget.spent,
  };
}

/** One log line, identical whichever path ran the refresh. */
export function refreshSummary(r) {
  return `months=${r.months.fetched}fetched/${r.months.cached}cached/${r.months.restated}restated(v${r.months.version}) ` +
    `tx=${r.transactions.fetched}fetched/${r.transactions.cached}cached/${r.transactions.restated}restated(v${r.transactions.version}) ` +
    `opex=${r.opex.fetched}fetched/${r.opex.cached}cached/${r.opex.restated}restated(v${r.opex.version}) ` +
    `budgetAccounts=${r.budget.accounts}` +
    (r.remaining ? ` remaining=${r.remaining}` : "");
}

export default { refreshMonths, refreshTransactions, refreshOpex, refreshBudget, refreshAll, refreshSummary, deadlineIn };

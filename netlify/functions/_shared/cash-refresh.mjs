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
import { listBudgets, fetchBudget, accountIndex, overheadsFromBudget } from "./cash-budget.mjs";
import {
  bankAccountIndex, fetchMonthTransactions, isTxRecordCurrent, TX_PARSER_VERSION,
} from "./cash-bank-tx.mjs";
import { loadAssumptions } from "./cash-store.mjs";

/**
 * Bank Summary months.
 *
 * @param force  ignore the cache entirely and refetch every month. For the
 *               on-demand path, where someone has just deployed a parser change
 *               and wants to see it take effect now rather than reasoning about
 *               which months the version check will catch.
 */
export async function refreshMonths(token, tenantId, fy, { force = false } = {}) {
  const store = getStore({ name: "cash-xero-months", consistency: "strong" });
  const out = { fetched: 0, cached: 0, restated: 0, version: BANKSUMMARY_PARSER_VERSION, error: null };
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
      await store.setJSON(blobKey, await fetchMonthActuals(token, tenantId, key, currency));
      out.fetched++;
    }
  } catch (err) {
    out.error = err.message;
  }
  return out;
}

/** Operating expenses, one P&L call per finished month. */
export async function refreshOpex(token, tenantId, fy, { force = false } = {}) {
  const store = getStore({ name: "cash-xero-opex", consistency: "strong" });
  const out = { fetched: 0, cached: 0, restated: 0, version: OPEX_PARSER_VERSION, error: null };
  try {
    const keys = fiscalMonthKeys(fy);
    // The current month is still running, so its P&L is partial.
    const finished = keys.slice(0, -1);
    const alwaysRefresh = finished.slice(-1);

    for (const key of finished) {
      const blobKey = `${tenantId}/${key}`;
      if (!force && !alwaysRefresh.includes(key)) {
        const stored = await store.get(blobKey, { type: "json" });
        if (isOpexRecordCurrent(stored)) { out.cached++; continue; }
        if (stored) out.restated++;
      }
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
    await getStore({ name: "cash-xero-budget", consistency: "strong" })
      .setJSON(`${tenantId}/${fy}`, {
        budgetID: chosen.budgetID,
        description: chosen.description,
        requested: assumptions.xeroBudgetId ?? null,
        months: result.months,
        monthsCovered: result.slotsCovered.length,
        included: result.included,
        excluded: result.excluded,
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
export async function refreshTransactions(token, tenantId, fy, { force = false } = {}) {
  const store = getStore({ name: "cash-xero-tx", consistency: "strong" });
  const monthStore = getStore({ name: "cash-xero-months", consistency: "strong" });
  const out = { fetched: 0, cached: 0, restated: 0, version: TX_PARSER_VERSION, error: null, truncated: [] };
  try {
    const accounts = await bankAccountIndex(token, tenantId, "NZD");
    const keys = fiscalMonthKeys(fy);
    const alwaysRefresh = keys.slice(-2);

    for (const key of keys) {
      const blobKey = `${tenantId}/${key}`;
      if (!force && !alwaysRefresh.includes(key)) {
        const stored = await store.get(blobKey, { type: "json" });
        if (isTxRecordCurrent(stored)) { out.cached++; continue; }
        if (stored) out.restated++;
      }
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

/** All of them, in the order the scheduled sync does them. */
export async function refreshAll(token, tenantId, fy, { force = false } = {}) {
  return {
    months: await refreshMonths(token, tenantId, fy, { force }),
    // After months: the implied rate needs both views of the same month.
    transactions: await refreshTransactions(token, tenantId, fy, { force }),
    opex: await refreshOpex(token, tenantId, fy, { force }),
    budget: await refreshBudget(token, tenantId, fy),
  };
}

/** One log line, identical whichever path ran the refresh. */
export function refreshSummary(r) {
  return `months=${r.months.fetched}fetched/${r.months.cached}cached/${r.months.restated}restated(v${r.months.version}) ` +
    `tx=${r.transactions.fetched}fetched/${r.transactions.cached}cached/${r.transactions.restated}restated(v${r.transactions.version}) ` +
    `opex=${r.opex.fetched}fetched/${r.opex.cached}cached/${r.opex.restated}restated(v${r.opex.version}) ` +
    `budgetAccounts=${r.budget.accounts}`;
}

export default { refreshMonths, refreshTransactions, refreshOpex, refreshBudget, refreshAll, refreshSummary };

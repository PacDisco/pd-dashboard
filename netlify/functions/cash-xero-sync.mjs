/**
 * Scheduled sync — the only thing that talks to Xero.
 *
 * Runs hourly, pulls a cash position for every connected organisation, and
 * writes one consolidated JSON blob. The dashboard reads that blob, so no
 * page view ever waits on Xero and no page view burns API quota.
 *
 * Call budget per org per run: 5 — BankSummary, BalanceSheet, Organisation,
 * TrackingCategories, and a tracked ProfitAndLoss. The P&L returns every
 * program as columns in one response, so this does NOT grow as programs are
 * added. Hourly → 120/day/org against a Starter limit of 1000/day/org.
 */
import { getStore } from "@netlify/blobs";
import {
  getAccessToken, getConnections, xeroGet,
  parseBankSummary, parseBalanceSheet, refreshTokenHealth,
  monthBounds, iso,
  fiscalMonthKeys, fetchMonthActuals, getBankAccountCurrencies,
  getTrackingCategories, pickProgramCategory, getTrackedActuals, fiscalYearBounds,
} from "./_shared/cash-xero.mjs";
import { fetchMonthOpex } from "./_shared/cash-opex.mjs";
import { listBudgets, fetchBudget, accountIndex, overheadsFromBudget } from "./_shared/cash-budget.mjs";
import { loadAssumptions } from "./_shared/cash-store.mjs";
async function orgCurrency(token, tenantId) {
    try {
        const org = await xeroGet(token, tenantId, "Organisation");
        return org?.Organisations?.[0]?.BaseCurrency ?? "NZD";
    }
    catch {
        return "NZD";
    }
}
async function pullOrg(token, tenantId, name, from, to) {
    const base = {
        tenantId,
        name,
        currency: "NZD",
        bankAccounts: [],
        closingBalance: 0,
        cashReceivedMTD: 0,
        cashSpentMTD: 0,
        receivables: 0,
        payables: 0,
    };
    try {
        const [bankSummary, balanceSheet, currency] = await Promise.all([
            xeroGet(token, tenantId, "Reports/BankSummary", { fromDate: from, toDate: to }),
            xeroGet(token, tenantId, "Reports/BalanceSheet", { date: to }).catch(() => null),
            orgCurrency(token, tenantId),
        ]);
        const parsed = parseBankSummary(bankSummary);
        const bs = balanceSheet ? parseBalanceSheet(balanceSheet) : { receivables: 0, payables: 0 };
        // Per-program actuals, for the fiscal year to date. One extra call for the
        // category list, one for the P&L — the P&L returns every program at once
        // as columns, so this doesn't scale with the number of programs.
        let byProgram;
        try {
            const categories = await getTrackingCategories(token, tenantId);
            const category = pickProgramCategory(categories, process.env.XERO_PROGRAM_CATEGORY);
            if (category) {
                const fy = fiscalYearBounds(currentFiscalYear());
                byProgram = await getTrackedActuals(token, tenantId, fy.from, to, category);
            }
        }
        catch {
            // Tracking is a bonus, not a dependency. A org without it still syncs.
        }
        return {
            ...base,
            byProgram,
            currency,
            bankAccounts: parsed.accounts,
            closingBalance: parsed.totalClosing,
            cashReceivedMTD: parsed.accounts.reduce((s, a) => s + a.received, 0),
            cashSpentMTD: parsed.accounts.reduce((s, a) => s + a.spent, 0),
            receivables: bs.receivables,
            payables: bs.payables,
        };
    }
    catch (err) {
        // One bad org shouldn't take down the whole sync.
        return { ...base, error: err instanceof Error ? err.message : String(err) };
    }
}
export default async (_req, _context) => {
    const started = Date.now();
    const token = await getAccessToken();
    const pinned = (process.env.XERO_TENANTS ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    let connections = await getConnections(token);
    if (pinned.length) {
        connections = pinned
            .map((id) => connections.find((c) => c.tenantId === id))
            .filter((c) => Boolean(c));
    }
    const { from, to } = monthBounds();
    // Sequential, not parallel across orgs — Xero rate limits per app as well as
    // per org, and four orgs is not worth the concurrency risk.
    const orgs = [];
    for (const c of connections) {
        orgs.push(await pullOrg(token, c.tenantId, c.tenantName, from, to));
    }
    /* ---- monthly history, for replacing closed months with what happened ----
   *
   * One Bank Summary call per month is wasteful at an hourly cadence, and a
   * closed month does not change. So months already stored are skipped, except
   * the current one and the one before it — late supplier invoices and bank
   * feeds landing a few days after month end are exactly the case that would
   * otherwise be missed. Steady state is 2 extra calls per run, not 12. */
  const monthStore = getStore({ name: "cash-xero-months", consistency: "strong" });
  const fy = currentFiscalYear();
  const primary = connections[0];
  let monthsFetched = 0;
  let monthsCached = 0;

  if (primary) {
    try {
      const currency = await getBankAccountCurrencies(token, primary.tenantId, "NZD");
      const keys = fiscalMonthKeys(fy);
      const alwaysRefresh = keys.slice(-2);   // current month and the one before

      for (const key of keys) {
        const blobKey = `${primary.tenantId}/${key}`;
        if (!alwaysRefresh.includes(key) && (await monthStore.get(blobKey))) {
          monthsCached++;
          continue;
        }
        const actuals = await fetchMonthActuals(token, primary.tenantId, key, currency);
        await monthStore.setJSON(blobKey, actuals);
        monthsFetched++;
      }
    } catch (err) {
      console.error(`[cash-xero-sync] monthly history failed: ${err.message}`);
    }
  }

  /* ---- overheads: the P&L for months that have ended, the budget for the rest ----
   *
   * Two different questions. What DID we spend comes off the P&L, month by
   * month, non-cash lines removed. What WILL we spend comes off Budget Manager.
   * Neither is twelve numbers copied out of a workbook once a year, which is
   * what this replaces.
   *
   * Same caching as the bank months: a finished month does not change, so it is
   * fetched once. The budget is small and refetched every run. */
  const opexStore = getStore({ name: "cash-xero-opex", consistency: "strong" });
  const budgetStore = getStore({ name: "cash-xero-budget", consistency: "strong" });
  let opexFetched = 0;
  let opexCached = 0;
  let budgetLines = 0;

  if (primary) {
    try {
      const keys = fiscalMonthKeys(fy);
      // The current month is still running, so its P&L is partial. Only months
      // that have actually ended are stored.
      const finished = keys.slice(0, -1);
      const alwaysRefresh = finished.slice(-1);

      for (const key of finished) {
        const blobKey = `${primary.tenantId}/${key}`;
        if (!alwaysRefresh.includes(key) && (await opexStore.get(blobKey))) {
          opexCached++;
          continue;
        }
        await opexStore.setJSON(blobKey, await fetchMonthOpex(token, primary.tenantId, key));
        opexFetched++;
      }
    } catch (err) {
      console.error(`[cash-xero-sync] monthly opex failed: ${err.message}`);
    }

    try {
      const assumptions = await loadAssumptions(fy);
      const budgets = await listBudgets(token, primary.tenantId);
      // Whichever budget was asked for, or the most recently updated one. The
      // id and description are stored alongside the figures so the dashboard can
      // say WHICH budget it is showing rather than just "the budget".
      const chosen = assumptions.xeroBudgetId
        ? budgets.find((b) => b.budgetID === assumptions.xeroBudgetId)
        : budgets[0];

      if (chosen) {
        const [budget, accounts] = await Promise.all([
          fetchBudget(token, primary.tenantId, chosen.budgetID,
            { from: `${fy}-04-01`, to: `${fy + 1}-03-31` }),
          accountIndex(token, primary.tenantId),
        ]);
        if (budget) {
          const result = overheadsFromBudget(budget, accounts, fy);
          await budgetStore.setJSON(`${primary.tenantId}/${fy}`, {
            budgetID: chosen.budgetID,
            description: chosen.description,
            requested: assumptions.xeroBudgetId ?? null,
            months: result.months,
            monthsCovered: result.slotsCovered.length,
            included: result.included,
            excluded: result.excluded,
            fetchedAt: new Date().toISOString(),
          });
          budgetLines = result.included.length;
        }
      }
    } catch (err) {
      // A 403 here means accounting.budgets.read was not granted. Everything
      // else in the sync carries on — the forecast just keeps using whatever
      // overheads it had.
      console.error(`[cash-xero-sync] budget failed: ${err.message}`);
    }
  }

  const health = await refreshTokenHealth();
    // Group total is only meaningful where currencies match. Anything else is
    // reported per currency — do NOT silently add NZD and USD together.
    const byCurrency = {};
    for (const o of orgs) {
        if (o.error)
            continue;
        byCurrency[o.currency] = (byCurrency[o.currency] ?? 0) + o.closingBalance;
    }
    const payload = {
        generatedAt: new Date().toISOString(),
        periodFrom: from,
        periodTo: to,
        asAt: iso(new Date()),
        orgs,
        groupClosingByCurrency: byCurrency,
        tokenHealth: health,
        errors: orgs.filter((o) => o.error).map((o) => ({ name: o.name, error: o.error })),
        durationMs: Date.now() - started,
    };
    console.log(
      `[cash-xero-sync] orgs=${orgs.length} ` +
        `ok=${orgs.filter((o) => !o.error).length} ` +
        `errors=${payload.errors.length} ` +
        `tokenDays=${health?.daysRemaining ?? "?"} ` +
        `months=${monthsFetched}fetched/${monthsCached}cached opex=${opexFetched}fetched/${opexCached}cached budgetAccounts=${budgetLines} ` +
        `durationMs=${payload.durationMs} ` +
        `closingByCurrency=${JSON.stringify(byCurrency)}`,
    );
    for (const e of payload.errors) {
      console.error(`[cash-xero-sync] ${e.name}: ${e.error}`);
    }

    await getStore({ name: "cash-xero" }).setJSON("latest", payload);
    // Keep a dated snapshot so you can chart actual vs forecast over time
    // instead of only ever seeing "now".
    await getStore({ name: "cash-xero-history" }).setJSON(payload.asAt, payload);
    return new Response(JSON.stringify({ ok: true, orgs: orgs.length, errors: payload.errors }), {
        headers: { "Content-Type": "application/json" },
    });
};
export const config = {
    schedule: "@hourly",
};
/** Fiscal year starting April. Before April we're still in last year's. */
function currentFiscalYear() {
    const now = new Date();
    return now.getUTCMonth() + 1 >= 4 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
}

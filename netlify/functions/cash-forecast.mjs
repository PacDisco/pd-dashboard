// netlify/functions/cash-forecast.mjs
//
// The computed view for the Cash Forecast dashboard: the forecast built from
// the stored assumptions, plus whatever the last Xero and FX syncs wrote.
//
// Routes:
//   GET  /api/cash-forecast              -> forecast + assumptions + actuals
//   GET  /api/cash-forecast?fy=2026      -> a specific fiscal year
//   GET  /api/cash-forecast?versions=1   -> saved assumption versions
//
// The forecast is recomputed on every request rather than cached. It is pure
// arithmetic over a handful of programs, and recomputing means there is no
// stored figure that can drift out of step with the variables that produced it —
// which is the failure mode the whole rebuild exists to fix.

import { getStore } from "@netlify/blobs";
import { requireCashRole, canEdit, json } from "./_shared/cash-access.mjs";
import {
  loadAssumptions,
  listVersions,
  currentFiscalYear,
  resolveOpeningBalances,
  resolveMonthlyOverheads,
} from "./_shared/cash-store.mjs";
import { isOpexRecordCurrent, OPEX_PARSER_VERSION } from "./_shared/cash-opex.mjs";
import { loadRateSummary, planningRate } from "./_shared/cash-fx.mjs";
import { fiscalMonthKeys } from "./_shared/cash-xero.mjs";
import { buildForecast } from "../../cash-forecast/engine.mjs";

export default async (req) => {
  const user = await requireCashRole(req, "read", "cash-forecast");
  if (user instanceof Response) return user;

  const url = new URL(req.url);
  const fy = Number(url.searchParams.get("fy")) || currentFiscalYear();

  if (url.searchParams.get("versions")) {
    return json({ versions: await listVersions(fy) });
  }

  const assumptions = await loadAssumptions(fy);

  // Resolve the planning rate from the live series BEFORE the engine runs, so
  // the engine stays pure and takes a plain number. "manual" pins whatever is
  // stored; anything else tracks the market.
  const fx = await loadRateSummary("USDNZD");
  const settlement = assumptions.settlementCurrency || "USD";
  const effectiveRate = planningRate(
    fx,
    assumptions.planningRateSource ?? "manual",
    assumptions.fxRates?.[settlement] ?? 1,
  );

  // Stored monthly figures, so closed months can show what happened and the
  // rest of the year can re-base onto the real closing balance.
  const actualsByMonth = {};
  let partialMonth = null;
  try {
    const monthStore = getStore({ name: "cash-xero-months" });
    const txStore = getStore({ name: "cash-xero-tx" });
    const latest = await getStore({ name: "cash-xero" }).get("latest", { type: "json" });
    const tenantId = latest?.orgs?.[0]?.tenantId;
    if (tenantId) {
      for (const key of fiscalMonthKeys(fy, new Date(`${fy + 1}-03-31T00:00:00Z`))) {
        const m = await monthStore.get(`${tenantId}/${key}`, { type: "json" });
        if (!m) continue;
        // The transaction detail rides along on the month it describes, so the
        // engine takes one object per month and never has to know there are two
        // stores behind it.
        const tx = await txStore.get(`${tenantId}/${key}`, { type: "json" });
        actualsByMonth[key] = tx ? { ...m, tx } : m;
      }
    }
  } catch (err) {
    console.warn("[cash-forecast] monthly actuals read failed:", err.message);
  }

  // A month still in progress is stored, but must never be offered as closable —
  // eight days of September presented as a closed month would understate the
  // month and re-base every month after it onto a stale balance.
  const closable = [];
  for (const [key, m] of Object.entries(actualsByMonth)) {
    if (m.partial) partialMonth = key;
    else closable.push(key);
  }
  closable.sort();

  // The 1 April balances come off April's own bank summary unless pinned. Done
  // here rather than in the engine so the engine keeps taking plain numbers and
  // never has to know Xero exists.
  const openings = resolveOpeningBalances(assumptions, actualsByMonth[`${fy}-04`]);

  // Overheads: the P&L for months that have closed, Xero's budget for the rest.
  // Resolved here rather than in the engine, so the engine keeps taking twelve
  // plain numbers and never has to know Xero exists.
  const opexByMonth = {};
  let budgetInfo = null;
  try {
    const latest = await getStore({ name: "cash-xero" }).get("latest", { type: "json" });
    const tenantId = latest?.orgs?.[0]?.tenantId;
    if (tenantId) {
      const opexStore = getStore({ name: "cash-xero-opex" });
      for (const key of fiscalMonthKeys(fy, new Date(`${fy + 1}-03-31T00:00:00Z`))) {
        const m = await opexStore.get(`${tenantId}/${key}`, { type: "json" });
        if (m) opexByMonth[key] = m;
      }
      budgetInfo = await getStore({ name: "cash-xero-budget" })
        .get(`${tenantId}/${fy}`, { type: "json" });
    }
  } catch (err) {
    console.warn("[cash-forecast] overhead sources read failed:", err.message);
  }

  const overheads = resolveMonthlyOverheads(assumptions, {
    opexByMonth,
    budgetMonths: budgetInfo?.months ?? null,
  });

  const effective = {
    ...assumptions,
    openingBalances: openings.balances,
    // Passed through purely so a warning about the opening balance can say
    // WHICH opening it used and where that came from. The engine never computes
    // with it.
    openingsMeta: {
      source: openings.source,
      fromXero: openings.fromXero,
      typed: openings.typed,
      openingRateSource: openings.openingRateSource,
    },
    monthlyOverheads: overheads.months,
    fxRates: { ...assumptions.fxRates, [settlement]: effectiveRate },
  };

  const forecast = buildForecast(effective, actualsByMonth);
  // The same year with no actuals applied, so the UI can show variance for
  // closed months without a second round trip.
  const forecastOnly = buildForecast(effective, {});

  // Actuals come from whatever the last sync wrote. If it has never run, the
  // dashboard still works — it shows forecast only, and says so.
  let actuals = null;
  try {
    actuals = await getStore({ name: "cash-xero" }).get("latest", { type: "json" });
  } catch (err) {
    console.warn("[cash-forecast] actuals read failed:", err.message);
  }

  return json({
    fiscalYear: `${fy}/${String(fy + 1).slice(2)}`,
    fiscalYearStartYear: fy,
    assumptions,
    forecast,
    forecastOnly,
    actualMonthsAvailable: closable,
    partialMonth,
    // The three fields the engine reads from a closed month, and nothing else.
    //
    // Without these the browser cannot run the same chain the server ran: its
    // local recompute would start from April with no actuals, spend its USD
    // differently, and hand the forecast tail an opening balance that never
    // existed. The table then shows two runs joined at the lock boundary, and
    // balances do not carry across a join — August closed with 229,675 USD and
    // September opened with none of it.
    //
    // Trimmed rather than passed whole: the full record carries nineteen bank
    // account rows per month that nothing on the client reads.
    actualsByMonth: Object.fromEntries(Object.entries(actualsByMonth).map(([k, m]) => [k, {
      byCurrency: m.byCurrency ?? {},
      source: m.source ?? null,
      partial: m.partial ?? false,
      // Only the fields the engine reads, so the browser runs the same chain
      // without shipping every transaction to it.
      tx: m.tx ? {
        source: m.tx.source ?? null,
        byCurrency: m.tx.byCurrency ?? {},
        transfersByCurrency: m.tx.transfersByCurrency ?? {},
        impliedRates: m.tx.impliedRates ?? {},
        transferLegs: m.tx.transferLegs ?? null,
        truncated: Boolean(m.tx.truncated),
      } : null,
    }])),
    overheads: {
      months: overheads.months,
      sources: overheads.sources,
      counts: overheads.counts,
      // Enough to tell the three "no actuals" cases apart: nothing closed, the
      // P&L not synced, or genuinely no data for those months. The panel used
      // to state that closed months come from the P&L whether or not any
      // actually did, which is the kind of confident-but-wrong copy this whole
      // dashboard is supposed to avoid.
      closedMonths: assumptions.actualsThroughMonth
        ? fiscalMonthKeys(fy, new Date(`${fy + 1}-03-31T00:00:00Z`))
            .filter((k) => k <= assumptions.actualsThroughMonth).length
        : 0,
      opexMonthsStored: Object.keys(opexByMonth).length,
      typed: assumptions.monthlyOverheads,
      source: assumptions.overheadSource ?? "auto",
      basis: assumptions.overheadBasis ?? "total",
      // Both figures per closed month, so the UI can show what the other basis
      // would give without a round trip.
      byMonth: Object.fromEntries(Object.entries(opexByMonth)
        .map(([k, v]) => [k, {
          total: v.total,
          cashTotal: v.cashTotal,
          // A month stored by an older parser is still being displayed, so say
          // so rather than letting a stale figure look like a current one. The
          // next sync refetches it.
          stale: !isOpexRecordCurrent(v),
        }])),
      staleMonths: Object.entries(opexByMonth)
        .filter(([, v]) => !isOpexRecordCurrent(v))
        .map(([k]) => k)
        .sort(),
      parserVersion: OPEX_PARSER_VERSION,
      budget: budgetInfo
        ? {
            id: budgetInfo.budgetID,
            description: budgetInfo.description,
            monthsCovered: budgetInfo.monthsCovered,
            accounts: budgetInfo.included?.length ?? 0,
            fetchedAt: budgetInfo.fetchedAt,
          }
        : null,
    },
    openings: {
      source: openings.source,
      fromXero: openings.fromXero,
      typed: openings.typed,
      mixed: openings.mixed,
      inUse: openings.balances,
    },
    fx,
    effectiveRate,
    actuals,
    canEdit: canEdit(user),
    email: user.email,
  });
};

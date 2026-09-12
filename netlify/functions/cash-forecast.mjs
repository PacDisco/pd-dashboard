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
    const latest = await getStore({ name: "cash-xero" }).get("latest", { type: "json" });
    const tenantId = latest?.orgs?.[0]?.tenantId;
    if (tenantId) {
      for (const key of fiscalMonthKeys(fy, new Date(`${fy + 1}-03-31T00:00:00Z`))) {
        const m = await monthStore.get(`${tenantId}/${key}`, { type: "json" });
        if (m) actualsByMonth[key] = m;
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

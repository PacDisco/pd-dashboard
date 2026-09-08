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
} from "./_shared/cash-store.mjs";
import { loadRateSummary, planningRate } from "./_shared/cash-fx.mjs";
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

  const forecast = buildForecast({
    ...assumptions,
    fxRates: { ...assumptions.fxRates, [settlement]: effectiveRate },
  });

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
    fx,
    effectiveRate,
    actuals,
    canEdit: canEdit(user),
    email: user.email,
  });
};

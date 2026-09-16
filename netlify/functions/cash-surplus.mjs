// netlify/functions/cash-surplus.mjs
//
// Extrapolated full-year surplus, against the budgeted one.
//
//   GET /api/cash-surplus?fy=2026
//
// Reads the stored P&L months and budget — no Xero calls — and runs the same
// engine the forecast uses to project the months that have not closed.
//
// Read role: this computes and returns, it changes nothing.

import { getStore } from "@netlify/blobs";
import { requireCashRole, json } from "./_shared/cash-access.mjs";
import {
  loadAssumptions, currentFiscalYear, resolveMonthlyOverheads,
} from "./_shared/cash-store.mjs";
import { fiscalMonthKeys } from "./_shared/cash-xero.mjs";
import { surplusView } from "./_shared/cash-surplus.mjs";
import { buildForecast } from "../../cash-forecast/engine.mjs";

export default async (req) => {
  const user = await requireCashRole(req, "read", "cash-surplus");
  if (user instanceof Response) return user;

  const url = new URL(req.url);
  const fy = Number(url.searchParams.get("fy")) || currentFiscalYear();

  const latest = await getStore({ name: "cash-xero" }).get("latest", { type: "json" });
  const tenantId = latest?.orgs?.[0]?.tenantId;
  if (!tenantId) return json({ error: "No synced organisation yet." }, 409);

  const assumptions = await loadAssumptions(fy);

  const opexStore = getStore({ name: "cash-xero-opex" });
  const opexByMonth = {};
  for (const key of fiscalMonthKeys(fy, new Date(`${fy + 1}-03-31T00:00:00Z`))) {
    const rec = await opexStore.get(`${tenantId}/${key}`, { type: "json" });
    if (rec) opexByMonth[key] = rec;
  }

  const budgetInfo = await getStore({ name: "cash-xero-budget" })
    .get(`${tenantId}/${fy}`, { type: "json" });

  const overheads = resolveMonthlyOverheads(assumptions, {
    opexByMonth,
    budgetMonths: budgetInfo?.months ?? null,
  });

  /* The SAME engine the forecast runs.
   *
   * The projection has to come from the pax model, and the pax model is the
   * engine. Re-implementing "what does this program recognise and cost" here
   * would give two answers to one question, and the two would drift the first
   * time either changed. What this reads off the engine is the accrual pair —
   * recognisedRevenue and programCostsOut — and never the cash rows. */
  const forecast = buildForecast({
    ...assumptions,
    monthlyOverheads: overheads.months,
    monthlyOverheadsForward: overheads.forward,
    monthlyOverheadsForwardSources: overheads.forwardSources,
  }, {});

  const view = surplusView({
    fiscalYearStartYear: fy,
    actualsThroughMonth: assumptions.actualsThroughMonth || null,
    opexByMonth,
    // Fiscal year only: a full-year surplus is a question about twelve months,
    // and the engine now returns more than that.
    forecastMonths: forecast.months.slice(0, 12),
    budgetSeries: budgetInfo?.series ?? null,
    overheadsForward: overheads.forward,
    overheadBasis: assumptions.overheadBasis ?? "total",
  });

  return json({
    ...view,
    budgetDescription: budgetInfo?.description ?? null,
    budgetFetchedAt: budgetInfo?.fetchedAt ?? null,
    // A budget stored before the revenue and cost-of-sales series were kept has
    // overheads and nothing else. Saying so is the difference between "there is
    // no budget" and "the budget needs re-reading".
    budgetNeedsRefresh: Boolean(budgetInfo) && !budgetInfo.series,
    source: "Xero Profit and Loss (closed months) + pax model (projection) + Xero Budget Manager",
  });
};

// netlify/functions/cash-pnl.mjs
//
// The profit and loss for a fiscal year, by account, against budget.
//
//   GET /api/cash-pnl?fy=2026&basis=total
//
// Reads what is already stored — the monthly P&L records and the budget — and
// assembles the statement. NO XERO CALLS: this is arithmetic over the blob
// store, so it returns in milliseconds and cannot be the thing that exhausts
// the day's API allowance.
//
// Read role: this computes and returns, it changes nothing.

import { getStore } from "@netlify/blobs";
import { requireCashRole, json } from "./_shared/cash-access.mjs";
import { currentFiscalYear } from "./_shared/cash-store.mjs";
import { fiscalKeys, pnlView } from "./_shared/cash-pnl.mjs";

export default async (req) => {
  const user = await requireCashRole(req, "read", "cash-pnl");
  if (user instanceof Response) return user;

  const url = new URL(req.url);
  const fy = Number(url.searchParams.get("fy")) || currentFiscalYear();
  // "total" is the default here, unlike the overheads breakdown, and the
  // difference is deliberate: that panel exists to inform a cash forecast, this
  // one is the statutory statement. A P&L with the revaluations quietly removed
  // is not the P&L, and would not tie to anything the accountant sends.
  const basis = url.searchParams.get("basis") === "cash" ? "cash" : "total";

  const latest = await getStore({ name: "cash-xero" }).get("latest", { type: "json" });
  const tenantId = latest?.orgs?.[0]?.tenantId;
  if (!tenantId) return json({ error: "No synced organisation yet." }, 409);

  const opexStore = getStore({ name: "cash-xero-opex" });
  const months = [];
  for (const key of fiscalKeys(fy)) {
    const rec = await opexStore.get(`${tenantId}/${key}`, { type: "json" });
    if (rec) months.push(rec);
  }

  if (!months.length) {
    return json({
      error: `No P&L months stored for FY ${fy}/${String(fy + 1).slice(2)} yet.`,
      hint: "Run Overheads → Diagnostics → Refresh Xero data now first.",
    }, 409);
  }

  const budget = await getStore({ name: "cash-xero-budget" })
    .get(`${tenantId}/${fy}`, { type: "json" });

  return json(pnlView({ fiscalYearStartYear: fy, months, budget, basis }));
};

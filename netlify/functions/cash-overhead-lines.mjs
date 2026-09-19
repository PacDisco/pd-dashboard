// netlify/functions/cash-overhead-lines.mjs
//
// What the overheads are made of.
//
//   GET /api/cash-overhead-lines?fy=2026&basis=cash
//
// Reads the stored P&L months — no Xero calls — and returns the expense lines
// aggregated across them, ranked by annual cost, each marked steady or lumpy.
//
// Read role: this computes and returns, it changes nothing.

import { getStore } from "@netlify/blobs";
import { requireCashRole, json } from "./_shared/cash-access.mjs";
import { currentFiscalYear } from "./_shared/cash-store.mjs";
import { fiscalMonthKeys } from "./_shared/cash-xero.mjs";
import { overheadLines } from "./_shared/cash-overhead-lines.mjs";

export default async (req) => {
  const user = await requireCashRole(req, "read", "cash-overhead-lines");
  if (user instanceof Response) return user;

  const url = new URL(req.url);
  const fy = Number(url.searchParams.get("fy")) || currentFiscalYear();
  const basis = url.searchParams.get("basis") === "total" ? "total" : "cash";

  const latest = await getStore({ name: "cash-xero" }).get("latest", { type: "json" });
  const tenantId = latest?.orgs?.[0]?.tenantId;
  if (!tenantId) return json({ error: "No synced organisation yet." }, 409);

  const store = getStore({ name: "cash-xero-opex" });
  const months = [];
  // Two fiscal years, same span the cost curve reads. A single year of
  // overheads is enough to rank lines but not to tell a standing cost from one
  // that only looked standing across the months that happened to be stored.
  for (const y of [fy - 1, fy]) {
    for (const key of fiscalMonthKeys(y, new Date(`${y + 1}-03-31T00:00:00Z`))) {
      const rec = await store.get(`${tenantId}/${key}`, { type: "json" });
      if (rec) months.push(rec);
    }
  }

  if (!months.length) {
    return json({
      error: "No stored P&L months yet.",
      hint: "Run Overheads → Diagnostics → Refresh Xero data now first.",
    }, 409);
  }

  const result = overheadLines(months, { basis });

  return json({
    fiscalYearStartYear: fy,
    ...result,
    // Named so the page can say where this came from without the reader having
    // to trust a label. Every figure here is the P&L's own operating-expense
    // section, summed by account name.
    source: "Xero Profit and Loss — Operating Expenses, by account",
  });
};

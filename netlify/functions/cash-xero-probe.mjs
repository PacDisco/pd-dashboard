// netlify/functions/cash-xero-probe.mjs
//
// A read-only look at what Xero actually returns for one month of receivable
// payments, before any of it is wired into the forecast.
//
// WHY A PROBE RATHER THAN JUST BUILDING IT
// ----------------------------------------
// Two things about the real books cannot be established from documentation:
// whether student invoices carry a program tracking option at all, and what
// those options are called. Guessing produces a table where every figure lands
// in "Unattributed" and nobody can tell whether the parser is wrong or the
// bookkeeping is different from what was assumed. This endpoint answers both
// questions with one call, against the real organisation, changing nothing.
//
// Delete it once receipts are wired in and trusted.
//
//   GET /api/cash-xero-probe?month=2026-08
//
// Admin/operations only, like every other endpoint here.

import { requireCashRole, json } from "./_shared/cash-access.mjs";
import { getAccessToken, getConnections } from "./_shared/cash-xero.mjs";
import { loadAssumptions, currentFiscalYear } from "./_shared/cash-store.mjs";
import {
  fetchPayments,
  fetchInvoicesByIds,
  attributeReceipts,
} from "./_shared/cash-receipts.mjs";

/**
 * Describe an object's shape without emitting its contents.
 *
 * The point of the probe is to confirm field names and nesting. Student names,
 * emails and invoice references are not needed for that, and a diagnostic
 * endpoint is no place to accumulate them — so keys are returned, values are
 * not, apart from the handful of non-identifying numeric fields the parser
 * actually reads.
 */
function shapeOf(obj, keep = []) {
  if (!obj || typeof obj !== "object") return null;
  const out = { __keys: Object.keys(obj) };
  for (const k of keep) if (obj[k] !== undefined) out[k] = obj[k];
  return out;
}

export default async (req) => {
  const user = await requireCashRole(req, "write", "cash-xero-probe");
  if (user instanceof Response) return user;

  const url = new URL(req.url);
  const month = url.searchParams.get("month");
  if (!/^\d{4}-\d{2}$/.test(month ?? "")) {
    return json({ error: "Pass ?month=YYYY-MM, e.g. ?month=2026-08" }, 400);
  }

  const started = Date.now();
  try {
    const token = await getAccessToken();
    const pinned = (process.env.XERO_TENANTS ?? "")
      .split(",").map((s) => s.trim()).filter(Boolean);
    const all = await getConnections(token);
    const connections = pinned.length ? all.filter((c) => pinned.includes(c.tenantId)) : all;
    const org = connections[0];
    if (!org) return json({ error: "No Xero organisation connected." }, 409);

    const { payments, truncated } = await fetchPayments(token, org.tenantId, month);
    const ids = payments.map((p) => p?.Invoice?.InvoiceID).filter(Boolean);
    const invoicesById = await fetchInvoicesByIds(token, org.tenantId, ids);

    const assumptions = await loadAssumptions(currentFiscalYear());
    const result = attributeReceipts(month, payments, invoicesById, assumptions.programs);

    const sample = payments[0];
    const sampleInvoice = sample?.Invoice?.InvoiceID
      ? invoicesById.get(sample.Invoice.InvoiceID)
      : null;

    return json({
      month,
      organisation: org.tenantName,
      paymentsFound: payments.length,
      paymentsTruncated: truncated,
      invoiceIdsOnPayments: ids.length,
      invoicesReturned: invoicesById.size,

      // The answer to "how much came in from students, by season".
      total: Math.round(result.total),
      bySeason: Object.fromEntries(
        Object.entries(result.bySeason).map(([k, v]) => [k, Math.round(v.base)]),
      ),
      byCurrency: result.byCurrency,
      unattributed: Math.round(result.unattributed),

      // The answer to "and why did anything land in Unattributed".
      diagnostics: result.diagnostics,
      programTrackingOptionsExpected: (assumptions.programs ?? [])
        .map((p) => p.xeroTrackingOption || p.name),

      // Field names only — see shapeOf above.
      shape: {
        payment: shapeOf(sample, ["Amount", "CurrencyRate", "Date", "PaymentType", "Status"]),
        paymentInvoice: shapeOf(sample?.Invoice, ["CurrencyCode", "Type"]),
        invoice: shapeOf(sampleInvoice, ["Type", "Status", "CurrencyCode", "LineAmountTypes"]),
        invoiceLine: shapeOf(sampleInvoice?.LineItems?.[0], ["AccountCode", "LineAmount"]),
        invoiceLineTracking: shapeOf(sampleInvoice?.LineItems?.[0]?.Tracking?.[0], ["Name", "Option"]),
      },

      durationMs: Date.now() - started,
    });
  } catch (err) {
    // The message matters more than the status here — a 403 means the scope is
    // missing and consent needs redoing, which looks nothing like a parse error.
    console.error(`[cash-xero-probe] ${err.message}`);
    return json({ error: err.message, durationMs: Date.now() - started }, 502);
  }
};

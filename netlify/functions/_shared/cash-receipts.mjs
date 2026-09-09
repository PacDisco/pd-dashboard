// netlify/functions/_shared/cash-receipts.mjs
//
// Receivable payments — the money students actually paid us in a month.
//
// WHY THIS EXISTS SEPARATELY FROM THE BANK SUMMARY
// -----------------------------------------------
// The Bank Summary report gives four numbers per account: opening, received,
// spent, closing. "Received" is every credit that hit the account — student
// payments, a currency conversion landing from the USD account, an interest
// credit, a refund reversal. It cannot tell you which of those was a student
// paying an invoice, which is the number the forecast is actually trying to
// predict.
//
// So this reads AR payments directly. Each payment names the invoice it settled,
// and the invoice's line items carry the program tracking option, which maps to
// a season. That gives a real "received from students, by season" figure to set
// against the forecast's Deposits in + Balances in.
//
// COST
// ----
// One Payments page per 100 payments, plus one Invoices call per batch of
// invoice ids seen. For a month with 60 student payments across 55 invoices:
// 1 + 2 = 3 calls. Fetched once per month and cached, same as the bank months.
//
// READ-ONLY. Every request here is a GET.

import { xeroGet } from "./cash-xero.mjs";

/** Xero wants dates in its own DateTime(y,m,d) literal inside a where clause. */
function xeroDate(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return `DateTime(${y},${m},${d})`;
}

/** First day of the month after `key` ("2026-08" -> "2026-09-01"). */
function nextMonthStart(key) {
  const [y, m] = key.split("-").map(Number);
  return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`;
}

/**
 * Every AR payment dated inside the month.
 *
 * Paged rather than assumed to fit in one response — a season's balance-due
 * date lands 50+ payments on a single day, and a silently truncated first page
 * would understate the month with no error to notice.
 */
export async function fetchPayments(accessToken, tenantId, key, { maxPages = 20 } = {}) {
  const from = `${key}-01`;
  const to = nextMonthStart(key);
  const where = [
    `Date>=${xeroDate(from)}`,
    `Date<${xeroDate(to)}`,
    `PaymentType=="ACCRECPAYMENT"`,
    `Status=="AUTHORISED"`,
  ].join("&&");

  const out = [];
  for (let page = 1; page <= maxPages; page++) {
    const json = await xeroGet(accessToken, tenantId, "Payments", { where, page, order: "Date" });
    const batch = json?.Payments ?? [];
    out.push(...batch);
    // Xero pages at 100. A short page is the last page.
    if (batch.length < 100) return { payments: out, truncated: false };
  }
  // Hitting the cap means real data is missing, and a wrong number that looks
  // right is worse than an obvious gap. Say so rather than returning quietly.
  return { payments: out, truncated: true };
}

/**
 * Invoices by id, in batches.
 *
 * A Payment names its invoice but does not carry the invoice's line items, and
 * the line items are where the tracking lives. Xero accepts a comma-separated
 * IDs filter; batches are kept small enough to stay well inside URL limits.
 */
export async function fetchInvoicesByIds(accessToken, tenantId, ids, { batchSize = 40 } = {}) {
  const unique = [...new Set(ids.filter(Boolean))];
  const byId = new Map();
  for (let i = 0; i < unique.length; i += batchSize) {
    const slice = unique.slice(i, i + batchSize);
    const json = await xeroGet(accessToken, tenantId, "Invoices", { IDs: slice.join(",") });
    for (const inv of json?.Invoices ?? []) {
      if (inv?.InvoiceID) byId.set(inv.InvoiceID, inv);
    }
  }
  return byId;
}

/**
 * Build a lookup from a tracking option name to a season.
 *
 * Programs already carry `xeroTrackingOption` (defaulting to the program name)
 * and a season, so the mapping the model already holds is reused rather than
 * configured twice and allowed to drift.
 */
export function seasonLookup(programs = []) {
  const map = new Map();
  for (const p of programs) {
    if (!p?.season) continue;
    for (const name of [p.xeroTrackingOption, p.name]) {
      if (name) map.set(String(name).trim().toLowerCase(), { season: p.season, program: p.name });
    }
  }
  return map;
}

const UNATTRIBUTED = "Unattributed";

/**
 * Which season(s) an invoice belongs to, and in what proportion.
 *
 * An invoice normally covers one program, but nothing enforces that, so the
 * split is done by line amount rather than by picking the first match. Lines
 * with no recognisable tracking option fall to Unattributed — the one thing
 * this must never do is quietly spread unknown money across known seasons.
 */
export function invoiceSeasonWeights(invoice, lookup) {
  const weights = new Map();
  let total = 0;

  for (const line of invoice?.LineItems ?? []) {
    const amount = Math.abs(Number(line?.LineAmount ?? 0));
    if (!amount) continue;
    total += amount;

    let season = null;
    for (const t of line?.Tracking ?? []) {
      const hit = lookup.get(String(t?.Option ?? "").trim().toLowerCase());
      if (hit) { season = hit.season; break; }
    }
    const bucket = season || UNATTRIBUTED;
    weights.set(bucket, (weights.get(bucket) || 0) + amount);
  }

  if (!total) {
    // No line detail at all (or a zero-value invoice). One bucket, honestly named.
    return new Map([[UNATTRIBUTED, 1]]);
  }
  for (const [k, v] of weights) weights.set(k, v / total);
  return weights;
}

/**
 * Attribute a month's payments to seasons. Pure — no I/O, so it can be tested
 * against fixtures rather than against Xero.
 *
 * Amounts: a payment's `Amount` is in the invoice's currency. `CurrencyRate` is
 * the rate to the organisation's base currency, which is what the bank actually
 * received. Both are kept — the base figure is what the forecast compares
 * against, the native figure is what a student was told they owed.
 *
 * @returns {{month, total, totalNative, bySeason, byCurrency, count, unattributed, diagnostics}}
 */
export function attributeReceipts(key, payments, invoicesById, programs) {
  const lookup = seasonLookup(programs);
  const bySeason = {};
  const byCurrency = {};
  const optionsSeen = new Map();
  const accountCodesSeen = new Map();
  const missingInvoices = new Set();

  let total = 0;
  let totalNative = 0;

  for (const p of payments) {
    const native = Number(p?.Amount ?? 0);
    if (!native) continue;
    // A missing rate means the payment is already in base currency.
    const rate = Number(p?.CurrencyRate) || 1;
    const base = native * rate;
    total += base;
    totalNative += native;

    const invoiceId = p?.Invoice?.InvoiceID;
    const invoice = invoiceId ? invoicesById.get(invoiceId) : null;
    if (invoiceId && !invoice) missingInvoices.add(invoiceId);

    const cur = p?.Invoice?.CurrencyCode || p?.CurrencyCode || "unknown";
    const c = (byCurrency[cur] ||= { native: 0, base: 0, count: 0 });
    c.native += native; c.base += base; c.count++;

    // Record what was actually on the invoice, whether or not it matched. This
    // is what turns "everything is Unattributed" from a mystery into a mapping
    // problem with a named cause.
    for (const line of invoice?.LineItems ?? []) {
      if (line?.AccountCode) {
        accountCodesSeen.set(line.AccountCode, (accountCodesSeen.get(line.AccountCode) || 0) + 1);
      }
      for (const t of line?.Tracking ?? []) {
        if (!t?.Option) continue;
        const label = `${t.Name ?? "?"}: ${t.Option}`;
        const seen = optionsSeen.get(label) || { count: 0, matched: lookup.has(String(t.Option).trim().toLowerCase()) };
        seen.count++;
        optionsSeen.set(label, seen);
      }
    }

    const weights = invoice ? invoiceSeasonWeights(invoice, lookup) : new Map([[UNATTRIBUTED, 1]]);
    for (const [season, share] of weights) {
      const s = (bySeason[season] ||= { base: 0, native: 0, count: 0 });
      s.base += base * share;
      s.native += native * share;
      // A payment spanning two seasons counts once in each — the counts are for
      // orientation, the money is what reconciles.
      s.count++;
    }
  }

  return {
    month: key,
    count: payments.length,
    total,
    totalNative,
    bySeason,
    byCurrency,
    unattributed: bySeason[UNATTRIBUTED]?.base ?? 0,
    diagnostics: {
      trackingOptionsSeen: [...optionsSeen.entries()]
        .map(([label, v]) => ({ label, payments: v.count, matched: v.matched }))
        .sort((a, b) => b.payments - a.payments),
      accountCodesSeen: [...accountCodesSeen.entries()]
        .map(([code, count]) => ({ code, lines: count }))
        .sort((a, b) => b.lines - a.lines),
      invoicesNotReturned: [...missingInvoices],
    },
    source: "Xero Payments (ACCRECPAYMENT) + Invoices",
    fetchedAt: new Date().toISOString(),
  };
}

/** Pull and attribute one month. */
export async function fetchMonthReceipts(accessToken, tenantId, key, programs) {
  const { payments, truncated } = await fetchPayments(accessToken, tenantId, key);
  const ids = payments.map((p) => p?.Invoice?.InvoiceID).filter(Boolean);
  const invoicesById = await fetchInvoicesByIds(accessToken, tenantId, ids);
  const result = attributeReceipts(key, payments, invoicesById, programs);
  result.truncated = truncated;
  result.invoicesFetched = invoicesById.size;
  return result;
}

export default { fetchPayments, fetchInvoicesByIds, attributeReceipts, fetchMonthReceipts };

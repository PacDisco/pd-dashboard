// netlify/functions/_shared/cash-bank-tx.mjs
//
// What actually hit the bank, transaction by transaction.
//
// WHY THIS EXISTS
// ---------------
// The Bank Summary gives four numbers per account — opening, received, spent,
// closing. Those four numbers are true, and they are all the dashboard has had.
// They are also unusable as a revenue figure: June showed 1,563,931 of "cash in"
// against roughly 190,000 of student money, because a summary cannot tell a
// customer payment from an intercompany transfer, and cannot tell either from
// this company moving its own USD into its own NZD account — which inflates
// received and spent by the same amount and nets to nothing.
//
// THE PART THAT IS EASY TO GET WRONG
// ----------------------------------
// "Every transaction in the bank account" is not one endpoint in Xero. It is
// three, and they do not overlap:
//
//   BankTransactions  Spend Money and Receive Money — direct bank entries that
//                     are NOT linked to an invoice or bill.
//   Payments          money applied to an AR invoice or an AP bill. A student
//                     paying an invoice appears HERE and not in BankTransactions.
//   BankTransfers     money moved between two of the organisation's own accounts.
//
// A categoriser built on BankTransactions alone would miss every student payment
// and every supplier bill — which is most of the money — and would look like it
// was working, because it would still return plausible-sized numbers.
//
// So this module pulls all three and RECONCILES them against the Bank Summary
// before anything is categorised. If the three sources do not add up to the
// received and spent figures Xero reports, something is missing, and the
// residual says how much. That check runs before the forecast ever sees a
// figure from here.
//
// READ-ONLY. Every request is a GET.

import { xeroGet } from "./cash-xero.mjs";

/** Bumped when a change here would alter a month already fetched and stored. */
export const BANKTX_PARSER_VERSION = 1;

/**
 * Xero's bank transaction types.
 *
 * The transfer pair is the whole reason the current Cash in row overstates:
 * moving USD into NZD writes a SPEND-TRANSFER against one account and a
 * RECEIVE-TRANSFER against the other. Both are real bank movements and both
 * belong in the balances; neither is money entering or leaving the business.
 */
export const RECEIVE_TYPES = new Set([
  "RECEIVE",
  "RECEIVE-OVERPAYMENT",
  "RECEIVE-PREPAYMENT",
  "RECEIVE-TRANSFER",
]);
export const SPEND_TYPES = new Set([
  "SPEND",
  "SPEND-OVERPAYMENT",
  "SPEND-PREPAYMENT",
  "SPEND-TRANSFER",
]);
export const TRANSFER_TYPES = new Set(["SPEND-TRANSFER", "RECEIVE-TRANSFER"]);

export function isTransfer(type) {
  return TRANSFER_TYPES.has(String(type ?? "").toUpperCase());
}

/**
 * "in", "out", or null for a type this code has never seen.
 *
 * Null rather than a guess: an unrecognised type landing silently in one
 * direction is how a reconciliation passes while being wrong. The caller counts
 * them and reports them.
 */
export function direction(type) {
  const t = String(type ?? "").toUpperCase();
  if (RECEIVE_TYPES.has(t)) return "in";
  if (SPEND_TYPES.has(t)) return "out";
  return null;
}

function xeroDate(d) {
  return `DateTime(${d.slice(0, 4)}, ${Number(d.slice(5, 7))}, ${Number(d.slice(8, 10))})`;
}

export function nextMonthStart(key) {
  const [y, m] = key.split("-").map(Number);
  return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`;
}

/**
 * Page through a Xero collection, stopping at a short page.
 *
 * Shared by all three pulls so the truncation behaviour is identical: hitting
 * the cap is reported, never swallowed. A month that silently returned its
 * first 100 transactions would understate and look fine.
 */
async function paged(accessToken, tenantId, path, collection, params, maxPages) {
  const out = [];
  for (let page = 1; page <= maxPages; page++) {
    const json = await xeroGet(accessToken, tenantId, path, { ...params, page });
    const batch = json?.[collection] ?? [];
    out.push(...batch);
    if (batch.length < 100) return { rows: out, truncated: false };
  }
  return { rows: out, truncated: true };
}

/** Spend Money / Receive Money entries dated inside the month. */
export async function fetchBankTransactions(accessToken, tenantId, key, { maxPages = 30 } = {}) {
  const where = [
    `Date>=${xeroDate(`${key}-01`)}`,
    `Date<${xeroDate(nextMonthStart(key))}`,
    `Status=="AUTHORISED"`,
  ].join("&&");
  const { rows, truncated } = await paged(
    accessToken, tenantId, "BankTransactions", "BankTransactions",
    { where, order: "Date" }, maxPages,
  );
  return { bankTransactions: rows, truncated };
}

/**
 * Every payment dated inside the month, both directions.
 *
 * Deliberately NOT filtered to ACCRECPAYMENT the way cash-receipts does. That
 * module answers "how much came in from students"; this one answers "what hit
 * the bank", and a supplier bill paid is exactly as real as a student paying.
 */
export async function fetchAllPayments(accessToken, tenantId, key, { maxPages = 30 } = {}) {
  const where = [
    `Date>=${xeroDate(`${key}-01`)}`,
    `Date<${xeroDate(nextMonthStart(key))}`,
    `Status=="AUTHORISED"`,
  ].join("&&");
  const { rows, truncated } = await paged(
    accessToken, tenantId, "Payments", "Payments",
    { where, order: "Date" }, maxPages,
  );
  return { payments: rows, truncated };
}

/**
 * Transfers between the organisation's own accounts.
 *
 * Pulled even though the transfer types above should already identify them from
 * the BankTransactions side, because "should" is doing a lot of work in that
 * sentence and this is the assumption the whole double-count fix rests on. If
 * the two views disagree, the probe says so rather than the forecast being
 * quietly wrong by the size of a month's conversions.
 */
export async function fetchBankTransfers(accessToken, tenantId, key, { maxPages = 10 } = {}) {
  const where = [
    `Date>=${xeroDate(`${key}-01`)}`,
    `Date<${xeroDate(nextMonthStart(key))}`,
  ].join("&&");
  try {
    const { rows, truncated } = await paged(
      accessToken, tenantId, "BankTransfers", "BankTransfers",
      { where }, maxPages,
    );
    return { transfers: rows, truncated, available: true };
  } catch (err) {
    // A 403 here means the transfers endpoint needs its own scope. That is worth
    // knowing precisely, and it is not fatal — the transfer TYPES on the
    // BankTransactions side may be enough on their own.
    return { transfers: [], truncated: false, available: false, error: err.message };
  }
}

/* ------------------------------------------------------------------ *
 * Reconciliation
 * ------------------------------------------------------------------ */

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

function bucket(map, currency, side, amount) {
  const c = currency || "?";
  map[c] ??= { in: 0, out: 0 };
  map[c][side] += amount;
}

/**
 * Total the three sources per currency, keeping transfers separate.
 *
 * Pure — no I/O — so it runs against fixtures in tests rather than against the
 * real organisation.
 *
 * Amounts are taken in the BANK ACCOUNT's own currency, because that is what the
 * Bank Summary reports and so is the only thing the result can be checked
 * against. A bank transaction's Total is already in its account's currency; a
 * payment's Amount is in the invoice currency, so it is converted at the
 * payment's own CurrencyRate the same way cash-receipts does.
 *
 * @param {object} input
 * @param {Array}  input.bankTransactions
 * @param {Array}  input.payments
 * @param {Array}  input.transfers
 * @param {Function} input.currencyOf  bank account name -> currency code
 * @returns {{byCurrency, transfersByCurrency, counts, unknownTypes, accountsSeen}}
 */
export function summariseSources({
  bankTransactions = [],
  payments = [],
  transfers = [],
  currencyOf = () => "NZD",
} = {}) {
  const byCurrency = {};
  const transfersByCurrency = {};
  const counts = { bankTransactions: 0, payments: 0, transfers: 0, skipped: 0 };
  const unknownTypes = new Map();
  const accountsSeen = new Map();

  const noteAccount = (name, currency) => {
    if (!name) return;
    const k = String(name).trim();
    if (!accountsSeen.has(k)) accountsSeen.set(k, currency);
  };

  for (const t of bankTransactions) {
    const dir = direction(t?.Type);
    if (!dir) {
      unknownTypes.set(t?.Type ?? "(none)", (unknownTypes.get(t?.Type ?? "(none)") || 0) + 1);
      counts.skipped++;
      continue;
    }
    const name = t?.BankAccount?.Name;
    // A bank transaction's CurrencyCode is the account's own currency; the
    // account list is the fallback when the field is absent.
    const currency = t?.CurrencyCode || currencyOf(name);
    noteAccount(name, currency);
    const amount = Math.abs(num(t?.Total));
    if (!amount) { counts.skipped++; continue; }

    counts.bankTransactions++;
    // Transfers are counted so the reconciliation ties, and kept apart so the
    // business figure can exclude them.
    if (isTransfer(t?.Type)) bucket(transfersByCurrency, currency, dir, amount);
    else bucket(byCurrency, currency, dir, amount);
  }

  for (const p of payments) {
    const type = String(p?.PaymentType ?? "").toUpperCase();
    // ACCREC money in, ACCPAY money out. Overpayments and prepayments carry
    // their own type names and are matched on the same prefix.
    const dir = type.startsWith("ACCREC") ? "in" : type.startsWith("ACCPAY") ? "out" : null;
    if (!dir) {
      unknownTypes.set(type || "(none)", (unknownTypes.get(type || "(none)") || 0) + 1);
      counts.skipped++;
      continue;
    }
    const name = p?.Account?.Name;
    const currency = currencyOf(name);
    noteAccount(name, currency);
    // Amount is in the invoice's currency; CurrencyRate converts it to what the
    // bank actually moved. A missing rate means they are the same currency.
    const amount = Math.abs(num(p?.Amount)) * (num(p?.CurrencyRate) || 1);
    if (!amount) { counts.skipped++; continue; }

    counts.payments++;
    bucket(byCurrency, currency, dir, amount);
  }

  // BankTransfers, when the endpoint is available, are the cross-check on the
  // transfer types above rather than an additional source of movement.
  for (const t of transfers) {
    counts.transfers++;
    const fromName = t?.FromBankAccount?.Name;
    const toName = t?.ToBankAccount?.Name;
    noteAccount(fromName, currencyOf(fromName));
    noteAccount(toName, currencyOf(toName));
  }

  return {
    byCurrency,
    transfersByCurrency,
    counts,
    unknownTypes: Object.fromEntries(unknownTypes),
    accountsSeen: Object.fromEntries(accountsSeen),
  };
}

/**
 * Does the transaction detail account for the Bank Summary?
 *
 * This is the gate. Until the three sources add up to what Xero says moved,
 * nothing here is fit to replace the Cash in row — a categoriser that explains
 * 80% of the money is not a cash forecast, it is a guess with extra steps.
 *
 * @param summary per-currency {received, spent} from the stored bank month
 * @returns per-currency expected vs detail, with the residual named
 */
export function reconcileToSummary(summarised, summary = {}, { tolerance = 1 } = {}) {
  const currencies = new Set([
    ...Object.keys(summarised?.byCurrency ?? {}),
    ...Object.keys(summarised?.transfersByCurrency ?? {}),
    ...Object.keys(summary ?? {}),
  ]);

  const rows = [];
  for (const c of currencies) {
    const biz = summarised?.byCurrency?.[c] ?? { in: 0, out: 0 };
    const tr = summarised?.transfersByCurrency?.[c] ?? { in: 0, out: 0 };
    const s = summary?.[c] ?? {};
    const received = num(s.received);
    const spent = num(s.spent);

    const detailIn = biz.in + tr.in;
    const detailOut = biz.out + tr.out;
    const inResidual = received - detailIn;
    const outResidual = spent - detailOut;
    // A residual of a few cents is rounding; a residual of thousands is a
    // missing source, and the difference between those two is the whole point.
    const tol = (base) => Math.max(tolerance, Math.abs(base) * 0.001);

    rows.push({
      currency: c,
      summaryReceived: received,
      summarySpent: spent,
      detailIn,
      detailOut,
      businessIn: biz.in,
      businessOut: biz.out,
      transfersIn: tr.in,
      transfersOut: tr.out,
      inResidual,
      outResidual,
      inTies: Math.abs(inResidual) <= tol(received),
      outTies: Math.abs(outResidual) <= tol(spent),
    });
  }

  rows.sort((a, b) => a.currency.localeCompare(b.currency));
  return { rows, ties: rows.every((r) => r.inTies && r.outTies) };
}

export default {
  BANKTX_PARSER_VERSION,
  RECEIVE_TYPES,
  SPEND_TYPES,
  TRANSFER_TYPES,
  isTransfer,
  direction,
  fetchBankTransactions,
  fetchAllPayments,
  fetchBankTransfers,
  summariseSources,
  reconcileToSummary,
};

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

/**
 * Payment types that allocate rather than move money.
 *
 * ARCREDITPAYMENT and APCREDITPAYMENT are a credit note being applied to an
 * invoice or bill. No cash leaves or enters the bank — the balance owing simply
 * drops. Counting them would overstate both sides, and the June probe found
 * five of them, so this is a real case and not a hypothetical.
 */
export const ALLOCATION_PAYMENT_TYPES = new Set([
  "ARCREDITPAYMENT",
  "APCREDITPAYMENT",
  // Over- and prepayments are the subtle pair. The money arrived earlier, as a
  // RECEIVE-OVERPAYMENT or RECEIVE-PREPAYMENT bank transaction — and June's
  // probe confirmed RECEIVE-OVERPAYMENT is in use here. A Payment of these
  // types is the LATER allocation of that money to an invoice. Counting both
  // would bank the same dollar twice.
  "AROVERPAYMENTPAYMENT",
  "APOVERPAYMENTPAYMENT",
  "ARPREPAYMENTPAYMENT",
  "APPREPAYMENTPAYMENT",
]);

/**
 * The only two payment types that move money at a bank.
 *
 * Named explicitly rather than matched on an "ACCREC"/"ACCPAY" prefix. The
 * prefix reads as safe against today's enum and is not: anything Xero adds
 * later starting with those six letters would be silently banked as cash in the
 * direction the prefix implies, with nothing to notice. An explicit pair means a
 * new type shows up in unknownTypes instead.
 */
export const CASH_PAYMENT_TYPES = new Map([
  ["ACCRECPAYMENT", "in"],
  ["ACCPAYPAYMENT", "out"],
]);

/**
 * Bank accounts by id AND by name, with each one's own currency.
 *
 * Pacific Discovery runs nineteen bank accounts — two credit cards, a tax
 * account, payroll accounts in two currencies, and several per-program accounts.
 * A per-CURRENCY reconciliation on top of that says "USD is short 533,030",
 * which is almost useless; a per-ACCOUNT one names the account, which is
 * something you can open in Xero.
 */
export async function bankAccountIndex(accessToken, tenantId, baseCurrency = "NZD") {
  const byId = new Map();
  const byName = new Map();
  try {
    const json = await xeroGet(accessToken, tenantId, "Accounts", { where: 'Type=="BANK"' });
    for (const a of json?.Accounts ?? []) {
      const rec = {
        id: a.AccountID,
        name: (a.Name ?? "").trim(),
        code: a.Code ?? null,
        currency: a.CurrencyCode || baseCurrency,
      };
      if (rec.id) byId.set(rec.id, rec);
      if (rec.name) byName.set(rec.name.toLowerCase(), rec);
    }
  } catch {
    // Without the list, currency falls back to whatever each row carries.
  }
  return {
    byId,
    byName,
    resolve(ref = {}) {
      // A Payment's Account carries AccountID and CurrencyCode but NO Name —
      // which is how the first pass silently filed every USD payment as NZD.
      // Id first, then name, then whatever the row states about itself.
      const hit =
        (ref.AccountID && byId.get(ref.AccountID)) ||
        (ref.Name && byName.get(String(ref.Name).trim().toLowerCase())) ||
        null;
      return {
        name: hit?.name ?? (ref.Name ? String(ref.Name).trim() : "(unknown account)"),
        currency: hit?.currency ?? ref.CurrencyCode ?? baseCurrency,
      };
    },
    size: byId.size,
  };
}

/**
 * What the bank account actually moved for one payment.
 *
 * `Amount` is in the INVOICE's currency and `CurrencyRate` relates the two, but
 * the direction of that rate is not what it looks like — June's sample carried
 * 0.592969 on a USD payment against an NZD base, which is USD-per-NZD, the
 * inverse of the obvious reading. Multiplying by it would have quietly halved
 * every cross-currency receipt.
 *
 * `BankAmount` is the figure in the bank account's own currency. It is what the
 * statement shows, it needs no conversion, and it cannot be got backwards.
 */
export function bankMoved(payment) {
  const bank = num(payment?.BankAmount);
  if (bank) return { amount: Math.abs(bank), field: "BankAmount" };
  // Older or same-currency payments may not carry it; then Amount already is
  // the bank figure.
  return { amount: Math.abs(num(payment?.Amount)), field: "Amount" };
}

function bucket(map, key, side, amount) {
  const k = key || "?";
  map[k] ??= { in: 0, out: 0 };
  map[k][side] += amount;
}

/**
 * Total the sources per currency and per account, keeping transfers separate.
 *
 * Pure — no I/O — so it runs against fixtures rather than the real organisation.
 *
 * @returns {{byCurrency, transfersByCurrency, byAccount, transfersByAccount,
 *            counts, unknownTypes, allocations, accountsSeen}}
 */
export function summariseSources({
  bankTransactions = [],
  payments = [],
  transfers = [],
  accounts = null,
} = {}) {
  const resolve = accounts?.resolve
    ? (ref) => accounts.resolve(ref)
    : (ref) => ({
        name: ref?.Name ? String(ref.Name).trim() : "(unknown account)",
        currency: ref?.CurrencyCode || "NZD",
      });

  const byCurrency = {};
  const transfersByCurrency = {};
  const byAccount = {};
  const transfersByAccount = {};
  const counts = {
    bankTransactions: 0, payments: 0, transfers: 0,
    allocations: 0, skipped: 0, zeroAmount: 0,
  };
  const unknownTypes = new Map();
  const accountsSeen = new Map();

  for (const t of bankTransactions) {
    const dir = direction(t?.Type);
    if (!dir) {
      unknownTypes.set(t?.Type ?? "(none)", (unknownTypes.get(t?.Type ?? "(none)") || 0) + 1);
      counts.skipped++;
      continue;
    }
    const acct = resolve(t?.BankAccount);
    // A bank transaction states its own currency, and it is the account's.
    const currency = t?.CurrencyCode || acct.currency;
    accountsSeen.set(acct.name, currency);
    const amount = Math.abs(num(t?.Total));
    if (!amount) { counts.zeroAmount++; continue; }

    counts.bankTransactions++;
    if (isTransfer(t?.Type)) {
      bucket(transfersByCurrency, currency, dir, amount);
      bucket(transfersByAccount, acct.name, dir, amount);
    } else {
      bucket(byCurrency, currency, dir, amount);
      bucket(byAccount, acct.name, dir, amount);
    }
  }

  for (const p of payments) {
    const type = String(p?.PaymentType ?? "").toUpperCase();
    if (ALLOCATION_PAYMENT_TYPES.has(type)) {
      // Real, and deliberately not counted: a credit note applied to an invoice
      // moves no bank money. Reported so it is a decision, not an oversight.
      counts.allocations++;
      continue;
    }
    const dir = CASH_PAYMENT_TYPES.get(type) ?? null;
    if (!dir) {
      unknownTypes.set(type || "(none)", (unknownTypes.get(type || "(none)") || 0) + 1);
      counts.skipped++;
      continue;
    }
    const acct = resolve(p?.Account);
    accountsSeen.set(acct.name, acct.currency);
    const { amount } = bankMoved(p);
    if (!amount) { counts.zeroAmount++; continue; }

    counts.payments++;
    bucket(byCurrency, acct.currency, dir, amount);
    bucket(byAccount, acct.name, dir, amount);
  }

  for (const _t of transfers) counts.transfers++;

  return {
    byCurrency, transfersByCurrency, byAccount, transfersByAccount,
    counts,
    unknownTypes: Object.fromEntries(unknownTypes),
    accountsSeen: Object.fromEntries(accountsSeen),
  };
}

/**
 * Are both legs of every transfer present in the transactions we pulled?
 *
 * This is the assumption the double-count fix rests on, and it is checkable
 * exactly rather than by inference: a BankTransfer names the two bank
 * transactions it created, in FromBankTransactionID and ToBankTransactionID.
 * Either those ids are in the set or they are not.
 *
 * June showed USD transfers OUT of 212,132 against transfers IN of 41,840 —
 * asymmetric in a way that suggests missing legs, and this says so for certain.
 */
export function transferLegCoverage(transfers = [], bankTransactions = []) {
  const ids = new Set(bankTransactions.map((t) => t?.BankTransactionID).filter(Boolean));
  let bothPresent = 0, fromOnly = 0, toOnly = 0, neither = 0;
  const missing = [];

  for (const t of transfers) {
    const from = t?.FromBankTransactionID;
    const to = t?.ToBankTransactionID;
    const hasFrom = Boolean(from && ids.has(from));
    const hasTo = Boolean(to && ids.has(to));
    if (hasFrom && hasTo) bothPresent++;
    else if (hasFrom) { fromOnly++; missing.push({ side: "to", amount: num(t?.Amount) }); }
    else if (hasTo) { toOnly++; missing.push({ side: "from", amount: num(t?.Amount) }); }
    else { neither++; missing.push({ side: "both", amount: num(t?.Amount) }); }
  }

  return {
    transfers: transfers.length,
    bothPresent, fromOnly, toOnly, neither,
    complete: fromOnly === 0 && toOnly === 0 && neither === 0,
    missingAmount: missing.reduce((s, m) => s + Math.abs(m.amount), 0),
  };
}

/**
 * Does the transaction detail account for what the Bank Summary says moved?
 *
 * The gate. Until the sources add up, nothing here is fit to replace the Cash in
 * row — a categoriser that explains 80% of the money is not a cash forecast.
 *
 * Runs per account when the stored month carries account rows, and per currency
 * otherwise. Per account is what makes a residual actionable: "USD is short
 * 533,030" is not something anyone can act on; "Bali Summer USD is short
 * 533,030" is a screen in Xero.
 */
export function reconcile(summarised, { byCurrency = {}, accounts = null } = {}, { tolerance = 1 } = {}) {
  const build = (detailBiz, detailTr, expected, label) => {
    const keys = new Set([
      ...Object.keys(detailBiz ?? {}),
      ...Object.keys(detailTr ?? {}),
      ...Object.keys(expected ?? {}),
    ]);
    const rows = [];
    for (const k of keys) {
      const biz = detailBiz?.[k] ?? { in: 0, out: 0 };
      const tr = detailTr?.[k] ?? { in: 0, out: 0 };
      const e = expected?.[k] ?? {};
      const received = num(e.received);
      const spent = num(e.spent);
      const detailIn = biz.in + tr.in;
      const detailOut = biz.out + tr.out;
      const inResidual = received - detailIn;
      const outResidual = spent - detailOut;
      // Cents are rounding. Thousands are a missing source. The gap between
      // those two readings is the entire value of this function.
      const tol = (base) => Math.max(tolerance, Math.abs(base) * 0.001);
      rows.push({
        [label]: k,
        summaryReceived: received, summarySpent: spent,
        detailIn, detailOut,
        businessIn: biz.in, businessOut: biz.out,
        transfersIn: tr.in, transfersOut: tr.out,
        inResidual, outResidual,
        inTies: Math.abs(inResidual) <= tol(received),
        outTies: Math.abs(outResidual) <= tol(spent),
      });
    }
    // Worst first — with nineteen accounts, the ones that tie are noise.
    rows.sort((a, b) =>
      Math.abs(b.inResidual) + Math.abs(b.outResidual) -
      (Math.abs(a.inResidual) + Math.abs(a.outResidual)));
    return rows;
  };

  const currencyRows = build(
    summarised.byCurrency, summarised.transfersByCurrency, byCurrency, "currency");

  let accountRows = null;
  if (accounts?.length) {
    const expected = {};
    for (const a of accounts) {
      if (!a?.name) continue;
      expected[String(a.name).trim()] = { received: num(a.received), spent: num(a.spent) };
    }
    accountRows = build(
      summarised.byAccount, summarised.transfersByAccount, expected, "account");
  }

  return {
    currencyRows,
    accountRows,
    ties: currencyRows.every((r) => r.inTies && r.outTies),
    worstAccounts: accountRows
      ? accountRows.filter((r) => !r.inTies || !r.outTies).slice(0, 8)
      : null,
  };
}

export default {
  BANKTX_PARSER_VERSION,
  RECEIVE_TYPES,
  SPEND_TYPES,
  TRANSFER_TYPES,
  isTransfer,
  direction,
  bankAccountIndex,
  bankMoved,
  transferLegCoverage,
  fetchBankTransactions,
  fetchAllPayments,
  fetchBankTransfers,
  summariseSources,
  reconcile,
};

/* ------------------------------------------------------------------ *
 * A month, in the currency each account actually holds
 * ------------------------------------------------------------------ */

/**
 * Bumped when a change here would alter a month already fetched and stored.
 *
 * History:
 *   1  first version.
 */
export const TX_PARSER_VERSION = 1;

/**
 * The rate Xero used, implied by the two views of the same month.
 *
 * The Bank Summary reports every account in the ORGANISATION'S BASE CURRENCY.
 * The transaction detail reports each account in ITS OWN. So for any month with
 * movement, the ratio between them is the rate Xero applied — no guessing, no
 * FX series, no assumption about which way round `CurrencyRate` runs.
 *
 * June and August agreed to four significant figures across three currencies:
 * USD 1.7194 and 1.6949, AUD 1.2183 and 1.2108, NZD exactly 1. That agreement
 * is what makes this trustworthy rather than a plausible-looking division.
 *
 * It is an AVERAGE over the month's transactions, so it is right for converting
 * flows and only approximately right for a point-in-time balance. Returned with
 * the evidence so a caller can see how much movement it rests on.
 */
export function impliedRates(summaryByCurrency = {}, detailByCurrency = {}, transfersByCurrency = {}) {
  const out = {};
  for (const [cur, s] of Object.entries(summaryByCurrency)) {
    const biz = detailByCurrency[cur] ?? { in: 0, out: 0 };
    const tr = transfersByCurrency[cur] ?? { in: 0, out: 0 };
    const detailIn = biz.in + tr.in;
    const detailOut = biz.out + tr.out;
    const base = Math.abs(num(s.received)) + Math.abs(num(s.spent));
    const account = detailIn + detailOut;

    // A month with almost no movement gives a rate built on rounding. Say so
    // rather than returning a confident number derived from two small figures.
    const thin = account < 1000;
    out[cur] = {
      rate: account > 0 ? base / account : null,
      basedOn: Math.round(account),
      thin,
    };
  }
  return out;
}

/**
 * Do the three sources account for the month's movement?
 *
 * WHY NOT JUST COMPARE BALANCES
 * -----------------------------
 * For the base currency you can: the rate is 1, so the transaction-derived
 * balance and the summary's closing balance are directly comparable and any
 * difference is real.
 *
 * For a foreign account you cannot. The summary is base-currency, so comparing
 * it to a balance in dollars needs a rate — and the only rate available is the
 * one implied by the month's FLOWS, which is an average over the month's
 * transactions. Applying an average-of-month rate to a point-in-time balance
 * produces a difference that is pure arithmetic artefact, and it grows with the
 * balance. That is what made every USD month report a mismatch of tens of
 * thousands while the underlying data was fine.
 *
 * So the completeness question is asked of the flows instead. The implied rate
 * is derived from receipts AND payments together; if the detail is complete,
 * that same rate reproduces each side separately. If a source is missing, the
 * two sides disagree. No point-in-time conversion anywhere.
 */
export function flowCheck(summaryByCurrency = {}, detailByCurrency = {}, transfersByCurrency = {}, rates = {}) {
  const out = {};
  for (const [cur, sum] of Object.entries(summaryByCurrency)) {
    const biz = detailByCurrency[cur] ?? { in: 0, out: 0 };
    const tr = transfersByCurrency[cur] ?? { in: 0, out: 0 };
    const detailIn = biz.in + tr.in;
    const detailOut = biz.out + tr.out;
    const rate = rates[cur]?.rate;

    if (!rate || rates[cur]?.thin) {
      out[cur] = { ties: null, reason: "too little movement to check" };
      continue;
    }
    const expectedIn = Math.abs(num(sum.received)) / rate;
    const expectedOut = Math.abs(num(sum.spent)) / rate;
    const gap = (a, b) => (Math.max(Math.abs(a), Math.abs(b)) < 1 ? 0
      : Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b), 1));

    const inGap = gap(expectedIn, detailIn);
    const outGap = gap(expectedOut, detailOut);
    out[cur] = {
      // 1% either side. A single day's rate movement inside a month is smaller
      // than that; a missing source is very much larger.
      ties: inGap <= 0.01 && outGap <= 0.01,
      inGapPct: Math.round(inGap * 1000) / 10,
      outGapPct: Math.round(outGap * 1000) / 10,
      detailIn: Math.round(detailIn),
      detailOut: Math.round(detailOut),
      expectedIn: Math.round(expectedIn),
      expectedOut: Math.round(expectedOut),
    };
  }
  return out;
}

/**
 * Everything the forecast needs about one month's bank movement, in account
 * currency, plus the rate implied against the base-currency summary.
 *
 * Three Xero calls (paged): BankTransactions, Payments, BankTransfers.
 */
export async function fetchMonthTransactions(accessToken, tenantId, key, accounts, summaryByCurrency = {}) {
  const [{ bankTransactions, truncated: txTrunc },
         { payments, truncated: payTrunc },
         transferResult] = await Promise.all([
    fetchBankTransactions(accessToken, tenantId, key),
    fetchAllPayments(accessToken, tenantId, key),
    fetchBankTransfers(accessToken, tenantId, key),
  ]);

  const s = summariseSources({
    bankTransactions, payments, transfers: transferResult.transfers, accounts,
  });
  const legs = transferLegCoverage(transferResult.transfers, bankTransactions);
  const rates = impliedRates(summaryByCurrency, s.byCurrency, s.transfersByCurrency);
  const flows = flowCheck(summaryByCurrency, s.byCurrency, s.transfersByCurrency, rates);

  return {
    month: key,
    parserVersion: TX_PARSER_VERSION,
    // Business cash, in each account's own currency, with the organisation's
    // own transfers between its own accounts excluded.
    byCurrency: s.byCurrency,
    transfersByCurrency: s.transfersByCurrency,
    byAccount: s.byAccount,
    impliedRates: rates,
    // Whether the three sources actually account for the month's movement,
    // checked per currency. See flowCheck for why this is the right question to
    // ask of a foreign-currency account and a balance comparison is not.
    flowCheck: flows,
    counts: s.counts,
    unknownTypes: s.unknownTypes,
    transferLegs: legs,
    // A truncated page means real movement is missing, which must never be
    // silently treated as a complete month.
    truncated: Boolean(txTrunc || payTrunc || transferResult.truncated),
    transfersAvailable: transferResult.available,
    source: "Xero BankTransactions + Payments + BankTransfers",
    fetchedAt: new Date().toISOString(),
  };
}

/** Is a stored transaction month still one this code would produce? */
export function isTxRecordCurrent(record, version = TX_PARSER_VERSION) {
  if (!record) return false;
  const stored = Number(record.parserVersion ?? 0);
  return Number.isFinite(stored) && stored >= version;
}

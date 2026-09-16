// netlify/functions/_shared/cash-costs.mjs
//
// Which program did this money go out for?
//
// WHY THIS IS A MEASUREMENT AND NOT A MAPPING
// -------------------------------------------
// Cost phasing is the largest remaining invention in the forecast: the model
// spends 25% the month before departure and 45% in the departure month, while
// the real books show 316,915 of program cost already incurred by August for a
// season departing 1 September. To replace that curve with a measured one, each
// outgoing dollar has to be tied to a program and lined up against its
// departure date.
//
// There are THREE possible routes to that attribution here, and which of them
// actually works is a question about Pacific Discovery's bookkeeping, not about
// Xero:
//
//   tracking      a line item's Tracking option names the program. The field
//                 exists on every line item; whether anyone fills it in on
//                 SUPPLIER spend is unknown.
//   accountCode   the expense account the spend was coded to. Always present,
//                 but names a category (flights, accommodation) not a program.
//   bankAccount   which account the money left. Unusually promising here —
//                 there are accounts literally called "Bali Summer USD" and
//                 "New Zealand & Fiji NZD", so for some spend the account IS
//                 the program.
//
// So this module does not pick one. It measures all three against the same
// month of real spend and reports how much each explains. Choosing the route
// before knowing which is populated is how you end up with a curve derived from
// 8% of the money and no way to tell.
//
// Pure — no I/O — so it runs against fixtures.

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/** Amount in the organisation's base currency, using the month's implied rate. */
function toBase(amount, currency, impliedRates, baseCurrency) {
  if (!amount) return 0;
  if (currency === baseCurrency) return amount;
  const implied = impliedRates?.[currency];
  // The implied rate is measured from this month's own flows, seen once in base
  // and once in account currency — the same rate that reconciled to four
  // significant figures across two months and three currencies. Where there is
  // no usable rate the amount is left in account currency and REPORTED as
  // unconverted, rather than being silently mixed into a base-currency total.
  if (!implied?.rate || implied.thin) return null;
  return amount * implied.rate;
}

/**
 * A line item's tracking, kept BY CATEGORY.
 *
 * Xero allows two tracking categories, and Pacific Discovery uses both:
 * "Program" and "Season". They are different questions about the same line, and
 * flattening them into one list of options is wrong in a way that hides itself.
 *
 * The first version of this did exactly that, and then split each line's amount
 * equally across the options it found. A line tagged Program "NZA" AND Season
 * "Fall 26" would have had half its value filed under each — halving both, with
 * coverage still reading a confident 100%. With one category in use the bug is
 * invisible; with two it is everywhere.
 *
 * So: category name is the key, option is the value, and a line contributes its
 * FULL amount to each category independently. Program totals and Season totals
 * each add up to the same money, viewed two ways.
 *
 * @returns {Record<string, string>} e.g. { Program: "NZA", Season: "Fall 26" }
 */
export function trackingByCategory(lineItem) {
  const out = {};
  for (const t of lineItem?.Tracking ?? []) {
    const category = String(t?.Name ?? "").trim();
    const option = String(t?.Option ?? "").trim();
    // A category with no option is "not tagged", not a category called "".
    if (category && option) out[category] = option;
  }
  return out;
}

/** Back-compat: every option on a line, category ignored. */
export function trackingOptions(lineItem) {
  return Object.values(trackingByCategory(lineItem));
}

/**
 * Measure how well each attribution route explains a month's outgoing money.
 *
 * @returns {{
 *   totalOut, unconverted,
 *   byTracking, byAccountCode, byBankAccount,
 *   coverage: {tracking, accountCode, bankAccount},
 *   lineItemsSeen, spendWithoutLineDetail
 * }}
 */
export function costSignals({
  bankTransactions = [],
  payments = [],
  invoicesById = new Map(),
  accounts = null,
  impliedRates = {},
  baseCurrency = "NZD",
} = {}) {
  // One bucket per tracking CATEGORY, so Program and Season are counted
  // independently and each sums to the same money.
  const byCategory = {};
  const categoryTotals = {};
  const byAccountCode = {};
  const byBankAccount = {};
  const codedTotal = { v: 0 };

  let totalOut = 0;
  let unconverted = 0;
  let lineItemsSeen = 0;
  let spendWithoutLineDetail = 0;

  const resolve = accounts?.resolve
    ? (ref) => accounts.resolve(ref)
    : (ref) => ({ name: ref?.Name ?? "(unknown account)", currency: ref?.CurrencyCode || baseCurrency });

  const add = (bucket, key, amount) => {
    if (!key || !amount) return;
    bucket[key] = (bucket[key] ?? 0) + amount;
  };

  /* ---- Spend Money: line items carry both tracking and account code ---- */
  for (const t of bankTransactions) {
    const type = String(t?.Type ?? "").toUpperCase();
    // Money OUT only, and never a transfer between the organisation's own
    // accounts — moving money is not a cost.
    if (!type.startsWith("SPEND") || type === "SPEND-TRANSFER") continue;

    const acct = resolve(t?.BankAccount);
    const currency = t?.CurrencyCode || acct.currency;
    const total = Math.abs(num(t?.Total));
    if (!total) continue;

    const base = toBase(total, currency, impliedRates, baseCurrency);
    if (base === null) { unconverted += total; continue; }
    totalOut += base;
    add(byBankAccount, acct.name, base);

    const lines = t?.LineItems ?? [];
    if (!lines.length) { spendWithoutLineDetail += base; continue; }

    // Split the transaction across its lines by line amount, so a bill covering
    // two programs is not filed entirely under the first one.
    const lineTotal = lines.reduce((s, l) => s + Math.abs(num(l?.LineAmount)), 0);
    for (const line of lines) {
      lineItemsSeen++;
      const share = lineTotal > 0 ? Math.abs(num(line?.LineAmount)) / lineTotal : 1 / lines.length;
      const amount = base * share;

      for (const [category, option] of Object.entries(trackingByCategory(line))) {
        byCategory[category] ??= {};
        // The FULL amount, not a share. Two categories are two views of the
        // same money, not two claims on it.
        add(byCategory[category], option, amount);
        categoryTotals[category] = (categoryTotals[category] ?? 0) + amount;
      }
      const code = line?.AccountCode ? String(line.AccountCode) : null;
      if (code) { add(byAccountCode, code, amount); codedTotal.v += amount; }
    }
  }

  /* ---- Supplier bills paid: the tracking lives on the INVOICE, not here ---- */
  for (const p of payments) {
    if (String(p?.PaymentType ?? "").toUpperCase() !== "ACCPAYPAYMENT") continue;

    const acct = resolve(p?.Account);
    const bank = Math.abs(num(p?.BankAmount)) || Math.abs(num(p?.Amount));
    if (!bank) continue;

    const base = toBase(bank, acct.currency, impliedRates, baseCurrency);
    if (base === null) { unconverted += bank; continue; }
    totalOut += base;
    add(byBankAccount, acct.name, base);

    // A Payment names its bill but does not carry the bill's lines. Without the
    // invoice fetched, this money is real and simply unattributable — counted
    // in the total so coverage tells the truth about it.
    const invoice = p?.Invoice?.InvoiceID ? invoicesById.get(p.Invoice.InvoiceID) : null;
    const lines = invoice?.LineItems ?? [];
    if (!lines.length) { spendWithoutLineDetail += base; continue; }

    const lineTotal = lines.reduce((s, l) => s + Math.abs(num(l?.LineAmount)), 0);
    for (const line of lines) {
      lineItemsSeen++;
      const share = lineTotal > 0 ? Math.abs(num(line?.LineAmount)) / lineTotal : 1 / lines.length;
      const amount = base * share;

      for (const [category, option] of Object.entries(trackingByCategory(line))) {
        byCategory[category] ??= {};
        add(byCategory[category], option, amount);
        categoryTotals[category] = (categoryTotals[category] ?? 0) + amount;
      }
      const code = line?.AccountCode ? String(line.AccountCode) : null;
      if (code) { add(byAccountCode, code, amount); codedTotal.v += amount; }
    }
  }

  const pct = (part) => (totalOut > 0 ? Math.round((part / totalOut) * 1000) / 10 : 0);

  return {
    totalOut: Math.round(totalOut),
    unconverted: Math.round(unconverted),
    // { Program: { NZA: 12345, ... }, Season: { "Fall 26": 98765, ... } }
    byCategory: Object.fromEntries(
      Object.entries(byCategory).map(([cat, bucket]) => [cat, round(bucket)])),
    byAccountCode: round(byAccountCode),
    byBankAccount: round(byBankAccount),
    // THE ANSWER TO "which route works". Percentages of outgoing money each
    // route can attribute. A curve built on a low-coverage route is a curve
    // built on a minority of the spend.
    coverage: {
      // Per category, because Program and Season are tagged independently and
      // one can be well kept while the other is not.
      ...Object.fromEntries(
        Object.entries(categoryTotals).map(([cat, v]) => [cat, pct(v)])),
      accountCode: pct(codedTotal.v),
      // The bank-account route always covers everything, because every payment
      // leaves an account — but only some of those accounts name a program, so
      // this number alone does not mean it is useful. The account names in
      // byBankAccount are what decide that.
      bankAccount: pct(totalOut),
    },
    categoriesSeen: Object.keys(byCategory),
    lineItemsSeen,
    spendWithoutLineDetail: Math.round(spendWithoutLineDetail),
  };
}

function round(bucket) {
  return Object.fromEntries(
    Object.entries(bucket)
      .map(([k, v]) => [k, Math.round(v)])
      .sort((a, b) => b[1] - a[1]),
  );
}

export default { costSignals, trackingByCategory, trackingOptions };

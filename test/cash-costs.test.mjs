// test/cash-costs.test.mjs
//
// Which route can attribute a cost to a program?
//
// Cost phasing is the biggest remaining invention in the forecast, and
// replacing it needs each outgoing dollar tied to a program. Three routes are
// possible — line-item tracking, expense account code, and which bank account
// the money left — and which of them is actually populated is a fact about
// Pacific Discovery's bookkeeping that nobody can know without measuring.
//
// The failure this prevents: picking a route, deriving a curve from the 8% of
// spend it happens to explain, and having no way to tell. So coverage is
// reported per route and the numbers below pin how it is counted.
//
// Run: node test/cash-costs.test.mjs

import assert from "node:assert/strict";
import { costSignals, trackingOptions } from "../netlify/functions/_shared/cash-costs.mjs";

const near = (a, b, tol, msg) =>
  assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b}`);

const ACCOUNTS = [
  { id: "id-bnz", name: "BNZ Pacific Discovery (BNZ Current Account)", currency: "NZD" },
  { id: "id-bali", name: "Bali Summer USD", currency: "USD" },
];
const byId = new Map(ACCOUNTS.map((a) => [a.id, a]));
const accounts = {
  resolve(ref = {}) {
    const hit = ref.AccountID && byId.get(ref.AccountID);
    return { name: hit?.name ?? "(unknown account)", currency: hit?.currency ?? ref.CurrencyCode ?? "NZD" };
  },
};
const NZD = ACCOUNTS[0], BALI = ACCOUNTS[1];
const rates = { NZD: { rate: 1, thin: false }, USD: { rate: 1.72, thin: false } };

const line = (LineAmount, AccountCode, option) => ({
  LineAmount, AccountCode,
  Tracking: option ? [{ Name: "Program", Option: option }] : [],
});
const spend = (Total, acct, lines, Type = "SPEND") => ({
  Type, Total, CurrencyCode: acct.currency,
  BankAccount: { AccountID: acct.id }, LineItems: lines,
});

/* ---------- tracking options ---------- */

{
  assert.deepEqual(trackingOptions(line(100, "453", "NZA")), ["NZA"]);
  assert.deepEqual(trackingOptions(line(100, "453")), [], "no tracking is an empty list, not a guess");
  assert.deepEqual(trackingOptions({ Tracking: [{ Option: "  SAS  " }] }), ["SAS"], "trimmed");
  assert.deepEqual(trackingOptions(null), []);
  console.log("✓ tracking options are read without inventing one");
}

/* ---------- the three routes, measured against the same money ---------- */

{
  const s = costSignals({
    bankTransactions: [
      // Fully tracked, NZD.
      spend(10_000, NZD, [line(10_000, "453", "NZA")]),
      // Coded but NOT tracked — the case that decides whether tracking is usable.
      spend(5_000, NZD, [line(5_000, "477")]),
      // A USD payment from the per-program account, untracked. The ACCOUNT is
      // the attribution here, which is why the bank-account route matters.
      spend(1_000, BALI, [line(1_000, "300")]),
    ],
    accounts, impliedRates: rates,
  });

  // 1,000 USD at the month's implied 1.72 = 1,720 NZD.
  near(s.totalOut, 16_720, 1, "everything out, in base currency");
  near(s.byTracking.NZA, 10_000, 1, "the tracked spend is attributed");
  near(s.byAccountCode["477"], 5_000, 1, "and the untracked spend still has a code");
  near(s.byBankAccount["Bali Summer USD"], 1_720, 1, "the USD payment converts at the implied rate");

  assert.equal(s.coverage.tracking, 59.8, "tracking explains 10,000 of 16,720");
  assert.equal(s.coverage.accountCode, 100, "every line carries a code");
  console.log("✓ all three routes are measured against the same spend");
}

/* ---------- a bill covering two programs is split, not filed under one ---------- */

{
  const s = costSignals({
    bankTransactions: [spend(9_000, NZD, [
      line(6_000, "453", "NZA"),
      line(3_000, "453", "PolyJ"),
    ])],
    accounts, impliedRates: rates,
  });
  near(s.byTracking.NZA, 6_000, 1, "split by line amount");
  near(s.byTracking.PolyJ, 3_000, 1);
  assert.equal(s.coverage.tracking, 100);
  console.log("✓ a multi-program bill is split by line, not attributed to the first");
}

/* ---------- transfers are not costs ---------- */

{
  const s = costSignals({
    bankTransactions: [
      spend(10_000, NZD, [line(10_000, "453", "NZA")]),
      // Moving money between the organisation's own accounts. Real, and not a
      // cost — counting it would inflate every curve it touched.
      spend(80_000, NZD, [line(80_000, "090")], "SPEND-TRANSFER"),
    ],
    accounts, impliedRates: rates,
  });
  near(s.totalOut, 10_000, 1, "the transfer is excluded entirely");
  assert.equal(s.byAccountCode["090"], undefined);
  console.log("✓ own-account transfers are not treated as program cost");
}

/* ---------- money with no line detail is counted, not hidden ---------- */

{
  // A supplier bill paid: the Payment carries no line items, and without the
  // invoice fetched there is nothing to attribute it by. It is still real money
  // out, so it must land in the total — otherwise coverage flatters itself.
  const s = costSignals({
    payments: [{
      PaymentType: "ACCPAYPAYMENT", BankAmount: 20_000,
      Account: { AccountID: NZD.id }, Invoice: { InvoiceID: "inv-1" },
    }],
    invoicesById: new Map(),
    accounts, impliedRates: rates,
  });
  near(s.totalOut, 20_000, 1, "unattributable money is still money out");
  near(s.spendWithoutLineDetail, 20_000, 1, "and is reported as unattributable");
  assert.equal(s.coverage.tracking, 0, "so tracking coverage honestly reads zero");
  console.log("✓ spend with no line detail counts against coverage rather than vanishing");

  // With the invoice supplied, the same payment attributes.
  const withInvoice = costSignals({
    payments: [{
      PaymentType: "ACCPAYPAYMENT", BankAmount: 20_000,
      Account: { AccountID: NZD.id }, Invoice: { InvoiceID: "inv-1" },
    }],
    invoicesById: new Map([["inv-1", { LineItems: [line(20_000, "453", "SAS")] }]]),
    accounts, impliedRates: rates,
  });
  near(withInvoice.byTracking.SAS, 20_000, 1, "a fetched bill attributes to its program");
  assert.equal(withInvoice.coverage.tracking, 100);
  console.log("✓ a supplier bill attributes once its invoice lines are available");
}

/* ---------- an unusable rate is reported, never guessed ---------- */

{
  const s = costSignals({
    bankTransactions: [spend(1_000, BALI, [line(1_000, "300", "Bali")])],
    accounts,
    // A month with almost no movement implies a rate from two small numbers.
    impliedRates: { USD: { rate: 4.2, thin: true } },
  });
  near(s.totalOut, 0, 1, "nothing is added to a base-currency total at a bad rate");
  near(s.unconverted, 1_000, 1, "the amount is reported unconverted instead");
  console.log("✓ money that cannot be converted honestly is reported, not mixed in");
}

/* ---------- nothing at all ---------- */

{
  const s = costSignals({});
  assert.equal(s.totalOut, 0);
  assert.deepEqual(s.coverage, { tracking: 0, accountCode: 0, bankAccount: 0 });
  console.log("✓ an empty month reports zero coverage rather than dividing by zero");
}

console.log("\nAll cost attribution tests passed.");

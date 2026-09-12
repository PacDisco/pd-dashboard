// test/cash-bank-tx.test.mjs
//
// The reconciliation gate for the cash-rows rebuild.
//
// The failure this is built to prevent is specific and quiet: Xero splits bank
// movement across three endpoints that do not overlap, and a categoriser fed
// only BankTransactions would miss every student payment and every supplier
// bill while still returning numbers of a believable size. The only defence is
// checking the detail against the Bank Summary and refusing to proceed when it
// does not tie.
//
// Run: node test/cash-bank-tx.test.mjs

import assert from "node:assert/strict";
import {
  direction,
  isTransfer,
  summariseSources,
  reconcileToSummary,
} from "../netlify/functions/_shared/cash-bank-tx.mjs";

const near = (a, b, tol, msg) =>
  assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b}`);

// Two accounts, as Pacific Discovery has them.
const currencyOf = (name) =>
  /usd/i.test(String(name ?? "")) ? "USD" : "NZD";

const tx = (Type, Total, account = "PD NZD Cheque", extra = {}) => ({
  Type, Total, BankAccount: { Name: account }, ...extra,
});
const pay = (PaymentType, Amount, account = "PD NZD Cheque", extra = {}) => ({
  PaymentType, Amount, Account: { Name: account }, ...extra,
});

/* ---------- direction and transfers ---------- */

{
  assert.equal(direction("RECEIVE"), "in");
  assert.equal(direction("SPEND"), "out");
  assert.equal(direction("receive-prepayment"), "in", "type matching is case-insensitive");
  assert.equal(direction("SPEND-TRANSFER"), "out", "a transfer still has a direction");

  // THE IMPORTANT ONE. An unrecognised type must not be quietly assigned a
  // direction — a wrong guess here moves money and reconciles anyway.
  assert.equal(direction("SOMETHING-NEW"), null, "an unknown type is not guessed at");
  assert.equal(direction(undefined), null);

  assert.ok(isTransfer("SPEND-TRANSFER") && isTransfer("RECEIVE-TRANSFER"));
  assert.ok(!isTransfer("SPEND") && !isTransfer("RECEIVE"));
  console.log("✓ types are classified, and an unknown type is refused rather than guessed");
}

/* ---------- transfers are kept out of business cash, but still counted ---------- */

{
  // The June shape: a USD→NZD conversion plus real trading either side.
  const s = summariseSources({
    bankTransactions: [
      tx("RECEIVE", 5_000),                              // real money in, NZD
      tx("SPEND", 2_000),                                // real money out, NZD
      tx("RECEIVE-TRANSFER", 80_000),                    // conversion landing in NZD
      tx("SPEND-TRANSFER", 50_000, "PD USD Account"),    // the other leg, in USD
    ],
    currencyOf,
  });

  near(s.byCurrency.NZD.in, 5_000, 0.01, "the conversion is not business cash in");
  near(s.byCurrency.NZD.out, 2_000, 0.01);
  near(s.transfersByCurrency.NZD.in, 80_000, 0.01, "but it is still counted, separately");
  near(s.transfersByCurrency.USD.out, 50_000, 0.01, "and so is the other leg, in its own currency");
  assert.equal(s.byCurrency.USD, undefined, "no business movement in USD that month");
  console.log("✓ the organisation's own conversions are excluded from cash in, not discarded");
}

/* ---------- all three sources, in the account's currency ---------- */

{
  const s = summariseSources({
    bankTransactions: [tx("RECEIVE", 1_000), tx("SPEND", 400)],
    payments: [
      pay("ACCRECPAYMENT", 9_000),                                  // student, NZD invoice
      pay("ACCPAYPAYMENT", 3_000),                                  // supplier
      // A USD invoice paid into the USD account: Amount is in the INVOICE's
      // currency, CurrencyRate converts it to what the bank moved.
      pay("ACCRECPAYMENT", 10_000, "PD USD Account", { CurrencyRate: 1 }),
    ],
    currencyOf,
  });

  near(s.byCurrency.NZD.in, 10_000, 0.01, "bank receipts and AR payments both count as in");
  near(s.byCurrency.NZD.out, 3_400, 0.01, "bank spend and AP payments both count as out");
  near(s.byCurrency.USD.in, 10_000, 0.01, "and USD lands in the USD bucket");
  assert.equal(s.counts.payments, 3);
  assert.equal(s.counts.bankTransactions, 2);
  console.log("✓ payments and bank transactions are both counted, per account currency");

  // A payment type nobody anticipated must be reported, not silently dropped
  // into one side or the other.
  const odd = summariseSources({ payments: [pay("ARCREDITPAYMENT", 500)], currencyOf });
  assert.equal(odd.counts.payments, 0, "an unrecognised payment type moves no money");
  assert.ok(odd.unknownTypes.ARCREDITPAYMENT, "and is named in the report");
  console.log("✓ an unrecognised payment type is surfaced rather than bucketed");
}

/* ---------- the gate ---------- */

{
  const summarised = summariseSources({
    bankTransactions: [tx("RECEIVE", 1_000), tx("RECEIVE-TRANSFER", 80_000)],
    payments: [pay("ACCRECPAYMENT", 9_000), pay("ACCPAYPAYMENT", 3_000)],
    currencyOf,
  });

  // Xero says 90,000 received and 3,000 spent. The detail accounts for both.
  const good = reconcileToSummary(summarised, { NZD: { received: 90_000, spent: 3_000 } });
  assert.equal(good.ties, true, "detail that adds up ties");
  const row = good.rows.find((r) => r.currency === "NZD");
  near(row.businessIn, 10_000, 0.01, "business cash in excludes the conversion");
  near(row.detailIn, 90_000, 0.01, "while the reconciliation includes it, so it can tie");
  near(row.transfersIn, 80_000, 0.01);

  // Now the failure that matters: a whole source missing. If Payments were
  // never pulled, the detail is short by 6,000 and MUST NOT pass.
  const missing = summariseSources({
    bankTransactions: [tx("RECEIVE", 1_000), tx("RECEIVE-TRANSFER", 80_000)],
    currencyOf,
  });
  const bad = reconcileToSummary(missing, { NZD: { received: 90_000, spent: 3_000 } });
  assert.equal(bad.ties, false, "a missing source must fail the gate");
  const badRow = bad.rows.find((r) => r.currency === "NZD");
  near(badRow.inResidual, 9_000, 0.01, "and the residual says exactly how much is unexplained");
  near(badRow.outResidual, 3_000, 0.01);
  console.log("✓ detail that does not account for the bank summary fails, with the gap named");

  // Cents are rounding, not a missing source.
  const rounding = reconcileToSummary(summarised, { NZD: { received: 90_000.4, spent: 2_999.7 } });
  assert.equal(rounding.ties, true, "sub-dollar differences are rounding");
  console.log("✓ rounding does not trip the gate");

  // A currency present in the summary but absent from the detail is the
  // silent-hole case — it must appear as a row, not vanish.
  const oneSided = reconcileToSummary(summarised, {
    NZD: { received: 90_000, spent: 3_000 },
    USD: { received: 412_523, spent: 0 },
  });
  assert.ok(oneSided.rows.some((r) => r.currency === "USD"), "a currency with no detail still reports");
  assert.equal(oneSided.ties, false, "and fails, because 412,523 is unexplained");
  console.log("✓ a currency with no transaction detail is a failure, not an omission");
}

/* ---------- nothing at all ---------- */

{
  const empty = reconcileToSummary(summariseSources({}), {});
  assert.deepEqual(empty.rows, [], "no data produces no rows");
  assert.equal(empty.ties, true, "and vacuously ties — the caller checks the counts");
  console.log("✓ an empty month does not throw");
}

console.log("\nAll bank transaction tests passed.");

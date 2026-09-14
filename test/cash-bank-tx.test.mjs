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
  bankMoved,
  transferLegCoverage,
  summariseSources,
  reconcile,
} from "../netlify/functions/_shared/cash-bank-tx.mjs";

const near = (a, b, tol, msg) =>
  assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b}`);

// Real account names and ids, in the shape the June probe returned. Pacific
// Discovery runs nineteen bank accounts across three currencies; three is
// enough to catch the bugs.
const ACCOUNTS = [
  { id: "id-bnz", name: "BNZ Pacific Discovery (BNZ Current Account)", currency: "NZD" },
  { id: "id-wise-us", name: "Wise US Account", currency: "USD" },
  { id: "id-wise-au", name: "Wise Aus Account", currency: "AUD" },
];
const byId = new Map(ACCOUNTS.map((a) => [a.id, a]));
const byName = new Map(ACCOUNTS.map((a) => [a.name.toLowerCase(), a]));
const accounts = {
  byId, byName, size: byId.size,
  resolve(ref = {}) {
    const hit = (ref.AccountID && byId.get(ref.AccountID)) ||
      (ref.Name && byName.get(String(ref.Name).trim().toLowerCase())) || null;
    return {
      name: hit?.name ?? (ref.Name ? String(ref.Name).trim() : "(unknown account)"),
      currency: hit?.currency ?? ref.CurrencyCode ?? "NZD",
    };
  },
};
const NZD = ACCOUNTS[0], USD = ACCOUNTS[1], AUD = ACCOUNTS[2];

// A BankTransaction names its account AND states its own currency.
const tx = (Type, Total, acct = NZD, extra = {}) => ({
  BankTransactionID: `tx-${Math.random().toString(36).slice(2)}`,
  Type, Total, CurrencyCode: acct.currency,
  BankAccount: { Name: acct.name, AccountID: acct.id }, ...extra,
});

// A Payment's Account carries AccountID and CurrencyCode but NO Name — the
// exact shape that made the first pass file every USD receipt as NZD.
const pay = (PaymentType, BankAmount, acct = NZD, extra = {}) => ({
  PaymentType, BankAmount,
  Account: { AccountID: acct.id, CurrencyCode: acct.currency }, ...extra,
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
      tx("SPEND-TRANSFER", 50_000, USD),    // the other leg, in USD
    ],
    accounts,
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
      pay("ACCRECPAYMENT", 10_000, USD),
    ],
    accounts,
  });

  near(s.byCurrency.NZD.in, 10_000, 0.01, "bank receipts and AR payments both count as in");
  near(s.byCurrency.NZD.out, 3_400, 0.01, "bank spend and AP payments both count as out");
  near(s.byCurrency.USD.in, 10_000, 0.01, "and USD lands in the USD bucket");
  assert.equal(s.counts.payments, 3);
  assert.equal(s.counts.bankTransactions, 2);
  console.log("✓ payments and bank transactions are both counted, per account currency");

  // A payment type nobody anticipated must be reported, not silently dropped
  // into one side or the other.
  const odd = summariseSources({ payments: [pay("ACCRECSOMETHINGNEW", 500)], accounts });
  assert.equal(odd.counts.payments, 0, "an unrecognised payment type moves no money");
  assert.ok(odd.unknownTypes.ACCRECSOMETHINGNEW, "and is named in the report");
  // Deliberately a type that BEGINS with ACCREC. Prefix matching would have
  // banked this as cash in without a murmur; the explicit pair does not.
  console.log("✓ an unrecognised payment type is surfaced rather than bucketed");
}

/* ---------- THE THREE THINGS THE REAL JUNE DATA CORRECTED ---------- */

{
  // 1. A Payment's Account has AccountID and CurrencyCode but NO Name.
  //
  // The first pass looked up currency by account NAME, so every payment
  // resolved to undefined and fell back to the base currency. June's USD
  // receipts were filed as NZD: NZD over by 162,403, USD short by 533,030.
  const s = summariseSources({
    payments: [pay("ACCRECPAYMENT", 100_000, USD)],
    accounts,
  });
  near(s.byCurrency.USD?.in ?? 0, 100_000, 0.01, "a USD payment lands in USD");
  assert.equal(s.byCurrency.NZD, undefined, "and NOT in the base currency");
  assert.ok(s.byAccount["Wise US Account"], "and is attributed to the named account");
  console.log("✓ a payment's account resolves by id, because it carries no name");
}

{
  // 2. BankAmount, not Amount × CurrencyRate.
  //
  // June's sample payment carried CurrencyRate 0.592969 on a USD payment
  // against an NZD base — that is USD-per-NZD, the inverse of the obvious
  // reading. Multiplying by it would have quietly roughly halved every
  // cross-currency receipt, in the direction that looks plausible.
  const p = { PaymentType: "ACCRECPAYMENT", Amount: 8_430, BankAmount: 5_000, CurrencyRate: 0.592969 };
  const moved = bankMoved(p);
  near(moved.amount, 5_000, 0.01, "the bank figure is used as given");
  assert.equal(moved.field, "BankAmount");
  assert.notEqual(Math.round(moved.amount), Math.round(8_430 * 0.592969),
    "and is NOT Amount times the rate, which is the trap");

  // Same-currency payments may carry no BankAmount; then Amount is the bank figure.
  const same = bankMoved({ PaymentType: "ACCRECPAYMENT", Amount: 2_500 });
  near(same.amount, 2_500, 0.01, "falling back to Amount when there is no BankAmount");
  assert.equal(same.field, "Amount");
  console.log("✓ the bank-side amount is taken, never reconstructed from a rate");
}

{
  // 3. Credit note allocations move no money.
  //
  // June returned five ARCREDITPAYMENTs. A credit note applied to an invoice
  // reduces what is owed; nothing reaches the bank. Counting them would
  // overstate cash in by their value.
  const s = summariseSources({
    payments: [
      pay("ACCRECPAYMENT", 9_000),
      pay("ARCREDITPAYMENT", 1_500),
      pay("APCREDITPAYMENT", 800),
      // The money for this arrived earlier as a RECEIVE-OVERPAYMENT bank
      // transaction — which June's probe shows Pacific Discovery does use. This
      // record is only its allocation to an invoice.
      pay("AROVERPAYMENTPAYMENT", 2_200),
    ],
    accounts,
  });
  near(s.byCurrency.NZD.in, 9_000, 0.01, "only the real receipt counts");
  assert.equal(s.counts.allocations, 3, "and the allocations are counted, not hidden");
  assert.equal(s.unknownTypes.ARCREDITPAYMENT, undefined,
    "they are a known decision, not an unrecognised type");
  console.log("✓ credit note allocations are excluded deliberately and reported");
}

/* ---------- are both legs of every transfer actually present? ---------- */

{
  // June showed USD transfers OUT of 212,132 against IN of 41,840. Either the
  // legs are genuinely lopsided or BankTransactions did not return them all,
  // and a BankTransfer names both transactions it created — so this is a set
  // membership test, not an inference.
  const legA = tx("SPEND-TRANSFER", 50_000, USD);
  const legB = tx("RECEIVE-TRANSFER", 80_000, NZD);
  const orphan = { BankTransferID: "bt-2", Amount: 12_000,
    FromBankTransactionID: "tx-missing-a", ToBankTransactionID: "tx-missing-b" };

  const complete = transferLegCoverage(
    [{ BankTransferID: "bt-1", Amount: 50_000,
       FromBankTransactionID: legA.BankTransactionID,
       ToBankTransactionID: legB.BankTransactionID }],
    [legA, legB],
  );
  assert.equal(complete.complete, true, "both legs present");
  assert.equal(complete.bothPresent, 1);

  const short = transferLegCoverage([orphan], [legA, legB]);
  assert.equal(short.complete, false, "a transfer whose legs are absent is flagged");
  assert.equal(short.neither, 1);
  near(short.missingAmount, 12_000, 0.01, "and the amount at stake is named");
  console.log("✓ transfer legs are checked by id rather than assumed");
}

/* ---------- the gate ---------- */

{
  const summarised = summariseSources({
    bankTransactions: [tx("RECEIVE", 1_000), tx("RECEIVE-TRANSFER", 80_000)],
    payments: [pay("ACCRECPAYMENT", 9_000), pay("ACCPAYPAYMENT", 3_000)],
    accounts,
  });

  // Xero says 90,000 received and 3,000 spent. The detail accounts for both.
  const good = reconcile(summarised, { byCurrency: { NZD: { received: 90_000, spent: 3_000 } } });
  assert.equal(good.ties, true, "detail that adds up ties");
  const row = good.currencyRows.find((r) => r.currency === "NZD");
  near(row.businessIn, 10_000, 0.01, "business cash in excludes the conversion");
  near(row.detailIn, 90_000, 0.01, "while the reconciliation includes it, so it can tie");
  near(row.transfersIn, 80_000, 0.01);

  // Now the failure that matters: a whole source missing. If Payments were
  // never pulled, the detail is short by 6,000 and MUST NOT pass.
  const missing = summariseSources({
    bankTransactions: [tx("RECEIVE", 1_000), tx("RECEIVE-TRANSFER", 80_000)],
    accounts,
  });
  const bad = reconcile(missing, { byCurrency: { NZD: { received: 90_000, spent: 3_000 } } });
  assert.equal(bad.ties, false, "a missing source must fail the gate");
  const badRow = bad.currencyRows.find((r) => r.currency === "NZD");
  near(badRow.inResidual, 9_000, 0.01, "and the residual says exactly how much is unexplained");
  near(badRow.outResidual, 3_000, 0.01);
  console.log("✓ detail that does not account for the bank summary fails, with the gap named");

  // Cents are rounding, not a missing source.
  const rounding = reconcile(summarised, { byCurrency: { NZD: { received: 90_000.4, spent: 2_999.7 } } });
  assert.equal(rounding.ties, true, "sub-dollar differences are rounding");
  console.log("✓ rounding does not trip the gate");

  // A currency present in the summary but absent from the detail is the
  // silent-hole case — it must appear as a row, not vanish.
  const oneSided = reconcile(summarised, { byCurrency: {
    NZD: { received: 90_000, spent: 3_000 },
    USD: { received: 412_523, spent: 0 },
  } });
  assert.ok(oneSided.currencyRows.some((r) => r.currency === "USD"), "a currency with no detail still reports");
  assert.equal(oneSided.ties, false, "and fails, because 412,523 is unexplained");
  console.log("✓ a currency with no transaction detail is a failure, not an omission");
}

/* ---------- nothing at all ---------- */

{
  const empty = reconcile(summariseSources({}), {});
  assert.deepEqual(empty.currencyRows, [], "no data produces no rows");
  assert.equal(empty.ties, true, "and vacuously ties — the caller checks the counts");
  console.log("✓ an empty month does not throw");
}

console.log("\nAll bank transaction tests passed.");

/* ---------- a refresh that cannot finish must say so, not half-finish ---------- */

{
  // WHY THIS EXISTS
  // ---------------
  // A full-year refresh is twelve Bank Summaries, twelve months of transactions
  // across three paged endpoints, eleven P&L calls and a budget — sixty-odd Xero
  // requests against a ten-second function limit. It was being killed partway
  // through. The earlier passes completed, the heaviest one (transactions) never
  // ran, and the only symptom was a store that stayed empty — indistinguishable
  // from a deployment that had not worked.
  const { deadlineIn } = await import("../netlify/functions/_shared/cash-refresh.mjs");

  const already = deadlineIn(-1);
  assert.equal(already(), true, "a deadline in the past is expired immediately");

  const soon = deadlineIn(50);
  assert.equal(soon(), false, "and one in the future is not");
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(soon(), true, "until it passes");
  console.log("✓ the refresh deadline actually expires");
}

/**
 * Unit test for the Xero report parsers.
 *
 * Xero reports come back as nested Rows/Cells rather than anything tabular, and
 * the nesting depth varies by organisation and chart-of-accounts complexity.
 * These fixtures are built from Xero's DOCUMENTED shapes, not from Pacific
 * Discovery's real responses — if the live numbers look wrong after the first
 * sync, this is the file that should fail first, and the one to update.
 *
 * No network: the parsers are pure functions over the JSON.
 *
 * Usage: node test/cash-xero-parsers.test.mjs
 */

import { parseBankSummary, parseBalanceSheet, findReportLine, monthBounds } from "../netlify/functions/_shared/cash-xero.mjs";
import { resolveOpeningBalances } from "../netlify/functions/_shared/cash-store.mjs";
import assert from "node:assert/strict";
// Realistic Xero BankSummary shape: top-level Header row, then a Section
// containing detail Rows and a SummaryRow.
const bankSummary = {
    Reports: [
        {
            ReportID: "BankSummary",
            ReportName: "Bank Summary",
            Rows: [
                {
                    RowType: "Header",
                    Cells: [
                        { Value: "Bank Accounts" },
                        { Value: "Opening Balance" },
                        { Value: "Cash Received" },
                        { Value: "Cash Spent" },
                        { Value: "Closing Balance" },
                    ],
                },
                {
                    RowType: "Section",
                    Title: "",
                    Rows: [
                        {
                            RowType: "Row",
                            Cells: [
                                { Value: "ASB Business Cheque" },
                                { Value: "202147.69" },
                                { Value: "375186.96" },
                                { Value: "107299.54" },
                                { Value: "470035.11" },
                            ],
                        },
                        {
                            RowType: "Row",
                            Cells: [
                                { Value: "ASB USD Account" },
                                { Value: "12000.00" },
                                { Value: "0.00" },
                                { Value: "(3500.00)" },
                                { Value: "8500.00" },
                            ],
                        },
                        {
                            RowType: "SummaryRow",
                            Cells: [
                                { Value: "Total" },
                                { Value: "214147.69" },
                                { Value: "375186.96" },
                                { Value: "110799.54" },
                                { Value: "478535.11" },
                            ],
                        },
                    ],
                },
            ],
        },
    ],
};
const bank = parseBankSummary(bankSummary);
assert.equal(bank.accounts.length, 2, "should exclude the SummaryRow from detail");
assert.equal(bank.accounts[0].name, "ASB Business Cheque");
assert.equal(bank.accounts[0].closing, 470035.11);
assert.equal(bank.totalClosing, 478535.11, "should prefer the SummaryRow total");
assert.equal(bank.accounts[1].spent, -3500, "parenthesised negatives must invert");
console.log("✓ parseBankSummary");
// Falls back to summing detail when Xero omits a SummaryRow (happens with a
// single bank account on some report versions).
const noSummary = JSON.parse(JSON.stringify(bankSummary));
noSummary.Reports[0].Rows[1].Rows = noSummary.Reports[0].Rows[1].Rows.filter((r) => r.RowType !== "SummaryRow");
assert.equal(Math.round(parseBankSummary(noSummary).totalClosing * 100) / 100, 478535.11, "should sum detail rows when no SummaryRow present");
console.log("✓ parseBankSummary fallback");
// Balance sheet: nested Sections, deeper than one level.
const balanceSheet = {
    Reports: [
        {
            ReportID: "BalanceSheet",
            Rows: [
                { RowType: "Header", Cells: [{ Value: "" }, { Value: "30 Sep 2026" }] },
                {
                    RowType: "Section",
                    Title: "Assets",
                    Rows: [
                        {
                            RowType: "Section",
                            Title: "Current Assets",
                            Rows: [
                                { RowType: "Row", Cells: [{ Value: "Accounts Receivable" }, { Value: "184320.50" }] },
                                { RowType: "Row", Cells: [{ Value: "Prepayments" }, { Value: "4200.00" }] },
                            ],
                        },
                    ],
                },
                {
                    RowType: "Section",
                    Title: "Liabilities",
                    Rows: [
                        {
                            RowType: "Section",
                            Title: "Current Liabilities",
                            Rows: [
                                { RowType: "Row", Cells: [{ Value: "Accounts Payable" }, { Value: "(92150.25)" }] },
                                { RowType: "Row", Cells: [{ Value: "GST" }, { Value: "(31004.00)" }] },
                            ],
                        },
                    ],
                },
            ],
        },
    ],
};
const bs = parseBalanceSheet(balanceSheet);
assert.equal(bs.receivables, 184320.5, "receivables from nested section");
assert.equal(bs.payables, 92150.25, "payables normalised to positive");
assert.equal(findReportLine(balanceSheet, /^GST$/i), -31004, "GST line reachable");
assert.equal(findReportLine(balanceSheet, /^nonexistent$/i), null, "missing line returns null");
console.log("✓ parseBalanceSheet");
// Month bounds must land on real month ends, including leap years.
assert.deepEqual(monthBounds(new Date("2026-09-08T00:00:00Z")), {
    from: "2026-09-01",
    to: "2026-09-30",
});
assert.deepEqual(monthBounds(new Date("2026-02-14T00:00:00Z")), {
    from: "2026-02-01",
    to: "2026-02-28",
});
assert.deepEqual(monthBounds(new Date("2028-02-14T00:00:00Z")), {
    from: "2028-02-01",
    to: "2028-02-29",
});
assert.deepEqual(monthBounds(new Date("2026-12-31T00:00:00Z")), {
    from: "2026-12-01",
    to: "2026-12-31",
});
console.log("✓ monthBounds");
console.log("\nAll parser tests passed.");

/* ---------- 1 April opening balances, sourced from Xero ---------- */

const april = (byCurrency) => ({ month: "2026-04", byCurrency });
const typed = { openingBalances: { NZD: -501_125, USD: 0 }, openingBalanceSource: "xero" };

{
  const r = resolveOpeningBalances(typed, april({
    NZD: { opening: -418_300, closing: 1 },
    USD: { opening: 62_400, closing: 1 },
  }));
  assert.equal(r.source, "xero");
  assert.equal(r.balances.NZD, -418_300);
  assert.equal(r.balances.USD, 62_400, "the USD split the workbook never had");
  assert.equal(r.mixed, false);
  console.log("✓ openings come from April's opening column");
}

{
  // THE ONE THAT MATTERS. Xero has no USD bank account, so there is no USD
  // opening. Taking that as zero would silently delete a real balance and
  // change every conversion decision for the year.
  const r = resolveOpeningBalances(typed, april({ NZD: { opening: -418_300 } }));
  assert.equal(r.balances.NZD, -418_300, "NZD still comes from Xero");
  assert.equal(r.balances.USD, 0, "USD falls back to the typed figure, not to a Xero zero");
  assert.equal(r.mixed, true, "a partial source must be flagged so the UI can say so");
  console.log("✓ a currency Xero has no account for keeps its typed figure");

  const withUsd = resolveOpeningBalances(
    { ...typed, openingBalances: { NZD: -501_125, USD: 40_000 } },
    april({ NZD: { opening: -418_300 } }));
  assert.equal(withUsd.balances.USD, 40_000, "a real typed USD balance survives");
}

{
  const r = resolveOpeningBalances(typed, null);
  assert.equal(r.source, "manual-no-data", "no April synced yet is its own state, not silent success");
  assert.equal(r.balances.NZD, -501_125);
  assert.equal(r.fromXero, null);
  console.log("✓ no April data falls back and says so");
}

{
  const r = resolveOpeningBalances(
    { ...typed, openingBalanceSource: "manual" },
    april({ NZD: { opening: -418_300 }, USD: { opening: 62_400 } }));
  assert.equal(r.source, "manual");
  assert.equal(r.balances.NZD, -501_125, "pinning manual beats available Xero data");
  console.log("✓ manual pinning wins over available Xero data");
}

{
  // A bank account in a currency the model does not know about is money that
  // exists and would otherwise be invisible.
  const r = resolveOpeningBalances(typed, april({
    NZD: { opening: -418_300 }, USD: { opening: 62_400 }, AUD: { opening: 11_000 },
  }));
  assert.equal(r.balances.AUD, 11_000, "an unmodelled currency is surfaced, not dropped");
  console.log("✓ a currency Xero has that the model does not is carried through");
}

console.log("\nAll opening balance tests passed.");

/* ================================================================== *
 * THE FX GAIN COLUMN
 *
 * Xero's Bank Summary has four value columns for an organisation whose bank
 * accounts are all in the base currency, and FIVE when any account is foreign:
 * an "FX Gain" column is inserted BEFORE the closing balance.
 *
 * The parser read column 4 as closing. With foreign accounts present that is
 * the revaluation, so every NZD account reported a closing balance of exactly
 * zero (a base-currency account has no revaluation) and the USD accounts
 * reported -87, -258, 3,241, -6,470 and -1,785 where hundreds of thousands
 * belonged. Five months of balances came from a fallback rather than from Xero,
 * and the only reason anyone noticed was a guard printing both figures.
 * ================================================================== */

import { bankSummaryColumns } from "../netlify/functions/_shared/cash-xero.mjs";

const near = (a, b, tol, msg) =>
  assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b}`);

const cell = (v) => ({ Value: v });
const summaryReport = (titles, rows) => ({
  Reports: [{
    ReportName: "BankSummary",
    Rows: [
      { RowType: "Header", Cells: titles.map(cell) },
      { RowType: "Section", Title: "", Rows: rows },
    ],
  }],
});
const acct = (...values) => ({ RowType: "Row", Cells: values.map(cell) });

{
  // The five-column layout, which is what Pacific Discovery actually returns.
  const report = summaryReport(
    ["Bank Accounts", "Opening Balance", "Cash Received", "Cash Spent", "FX Gain", "Closing Balance"],
    [
      acct("BNZ Pacific Discovery", "-103207.00", "885907.00", "806470.00", "0.00", "-23770.00"),
      acct("Wise US Account", "175739.00", "412523.00", "358587.00", "-1785.00", "227890.00"),
    ],
  );

  const cols = bankSummaryColumns(report);
  assert.equal(cols.closing, 5, "closing is the sixth column, not the fifth");
  assert.equal(cols.fxGain, 4, "and the fifth is the revaluation");
  assert.ok(cols.resolvedFromHeader, "resolved from the header, not assumed");

  const parsed = parseBankSummary(report);
  const usd = parsed.accounts.find((a) => /Wise US/.test(a.name));
  near(usd.closing, 227_890, 0.01, "the USD account's real closing balance");
  near(usd.fxGain, -1_785, 0.01, "with the revaluation kept, not discarded");
  // The precise old failure: 4 was read as closing.
  assert.notEqual(Math.round(usd.closing), -1_785,
    "reading the FX column as closing is the bug, not the behaviour");

  const nzd = parsed.accounts.find((a) => /BNZ/.test(a.name));
  near(nzd.closing, -23_770, 0.01, "and a base-currency account is unaffected");
  near(nzd.fxGain, 0, 0.01, "carrying no revaluation");
  console.log("✓ the FX gain column is identified and does not masquerade as closing");
}

{
  // The four-column layout must still parse — an org with no foreign accounts.
  const report = summaryReport(
    ["Bank Accounts", "Opening Balance", "Cash Received", "Cash Spent", "Closing Balance"],
    [acct("BNZ Current", "1000.00", "5000.00", "2000.00", "4000.00")],
  );
  const parsed = parseBankSummary(report);
  near(parsed.accounts[0].closing, 4_000, 0.01, "closing is the fifth column here");
  near(parsed.accounts[0].fxGain, 0, 0.01, "and there is no revaluation column");
  console.log("✓ the four-column layout still parses correctly");
}

{
  // No header at all: fall back to the LAST cell for closing, which is right in
  // both layouts — unlike a hardcoded 4, which is right in only one.
  const noHeader = {
    Reports: [{ Rows: [{ RowType: "Section", Rows: [
      acct("Wise US Account", "175739.00", "412523.00", "358587.00", "-1785.00", "227890.00"),
    ] }] }],
  };
  const cols = bankSummaryColumns(noHeader);
  assert.equal(cols.resolvedFromHeader, false, "nothing to resolve from");
  const parsed = parseBankSummary(noHeader);
  near(parsed.accounts[0].closing, 227_890, 0.01,
    "the last column is still the closing balance");
  console.log("✓ with no header, the last column is taken rather than a fixed index");
}

console.log("\nAll bank summary column tests passed.");

/* ================================================================== *
 * THE APRIL OPENING IS IN THE WRONG CURRENCY UNTIL IT IS CONVERTED
 *
 * The Bank Summary reports every account in the base currency, so the "opening"
 * filed under USD is New Zealand dollars. Used as-is it starts the year's
 * treasury chain about 1.7x too high, and every conversion for twelve months is
 * sized off it.
 * ================================================================== */

{
  const aprilWithTx = {
    month: "2026-04",
    byCurrency: {
      NZD: { opening: -456_313, received: 100_000, spent: 50_000 },
      USD: { opening: 12_875, received: 171_940, spent: 0 },
    },
    tx: {
      byCurrency: { NZD: { in: 100_000, out: 50_000 }, USD: { in: 100_000, out: 0 } },
      transfersByCurrency: {},
      impliedRates: {
        NZD: { rate: 1, basedOn: 150_000, thin: false },
        USD: { rate: 1.7194, basedOn: 100_000, thin: false },
      },
    },
  };

  const r = resolveOpeningBalances(
    { openingBalances: { NZD: 0, USD: 0 }, openingBalanceSource: "xero" },
    aprilWithTx,
  );

  near(r.balances.USD, 12_875 / 1.7194, 1, "the USD opening becomes real dollars");
  assert.ok(r.balances.USD < 7_500, "roughly 7,488, not the 12,875 the summary reports");
  near(r.balances.NZD, -456_313, 0.01, "the base currency is untouched — its rate is 1");
  assert.equal(r.openingRateSource.USD.source, "implied", "and it says where the rate came from");
  near(r.openingRateSource.USD.rate, 1.7194, 0.0001);
  console.log("✓ the April opening is converted out of base currency, with the rate stated");
}

{
  // No transaction detail: convert nothing rather than guess a rate. Wrong, but
  // wrong in a way that is visible and labelled, which a silent 1.7x is not.
  const r = resolveOpeningBalances(
    { openingBalances: { NZD: 0, USD: 0 }, openingBalanceSource: "xero" },
    { byCurrency: { USD: { opening: 12_875 } } },
  );
  near(r.balances.USD, 12_875, 0.01, "left alone when there is nothing to imply a rate from");
  assert.equal(r.openingRateSource.USD.source, "no-transaction-detail");

  // A month with almost no movement implies a rate from two small numbers.
  const thin = resolveOpeningBalances(
    { openingBalances: { USD: 0 }, openingBalanceSource: "xero" },
    { byCurrency: { USD: { opening: 12_875 } },
      tx: { impliedRates: { USD: { rate: 4.2, basedOn: 30, thin: true } } } },
  );
  near(thin.balances.USD, 12_875, 0.01, "a rate built on 30 dollars of movement is not used");
  assert.equal(thin.openingRateSource.USD.source, "too-little-movement-to-imply");
  console.log("✓ an unreliable implied rate is refused rather than applied");
}

console.log("\nAll opening currency tests passed.");

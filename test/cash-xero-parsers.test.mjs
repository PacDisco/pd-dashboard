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

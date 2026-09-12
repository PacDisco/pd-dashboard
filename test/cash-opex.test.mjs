// test/cash-opex.test.mjs
//
// Fixtures built from Pacific Discovery's real April and June 2026 P&L figures,
// so the parser is checked against numbers that actually exist rather than
// invented ones. June is the important month: its unrealised currency line is a
// large GAIN, so excluding non-cash lines makes cash opex HIGHER than reported
// opex. A parser that only ever subtracts would get June wrong in the safe-
// looking direction.
//
// Run: node test/cash-opex.test.mjs

import assert from "node:assert/strict";
import {
  parseOperatingExpenses,
  isNonCash,
  isOpexRecordCurrent,
  OPEX_PARSER_VERSION,
  NON_CASH_LINES,
} from "../netlify/functions/_shared/cash-opex.mjs";

const near = (a, b, tol, msg) =>
  assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b}`);

const row = (name, amount) => ({
  RowType: "Row",
  Cells: [{ Value: name }, { Value: amount < 0 ? `(${Math.abs(amount)})` : String(amount) }],
});

const pnl = (opexRows) => ({
  Reports: [{
    ReportName: "ProfitAndLoss",
    Rows: [
      { RowType: "Header", Cells: [{ Value: "Account" }, { Value: "Apr 2026" }] },
      { RowType: "Section", Title: "Trading Income", Rows: [row("Sales Income", 87.6)] },
      { RowType: "Section", Title: "Cost of Sales", Rows: [row("Cost of programs", 35916.96)] },
      {
        RowType: "Section",
        Title: "Operating Expenses",
        Rows: [
          ...opexRows,
          // The section's own total. Counting it would double everything.
          { RowType: "SummaryRow", Cells: [{ Value: "Total Operating Expenses" }, { Value: "0" }] },
        ],
      },
    ],
  }],
});

/* ---------- April: non-cash lines are a net expense ---------- */

{
  const report = pnl([
    row("Wages", 19166.56),
    row("Contractors - Headquarters", 18684.97),
    row("CRM", 15645.37),
    row("Bank Overdraft - Interest", 6483.42),
    row("Bank Fees", 1023.67),
    row("Bank Revaluations", 75.13),
    row("Unrealised Currency Gains", 12402.71),
    row("Rent", 3196.00),
  ]);

  const p = parseOperatingExpenses(report);
  assert.equal(p.sectionFound, true);

  near(p.total, 76677.83, 0.01, "raw total is every line");
  near(p.cashTotal, 64199.99, 0.01, "cash total drops the two non-cash lines");
  near(p.total - p.cashTotal, 12477.84, 0.01, "which is exactly the April non-cash amount");
  assert.deepEqual(p.excluded.map((l) => l.name).sort(),
    ["Bank Revaluations", "Unrealised Currency Gains"]);
  console.log("✓ April: non-cash lines excluded, cash opex is lower");

  // Bank Fees and overdraft interest are real cash and must survive.
  const kept = p.lines.filter((l) => !l.nonCash).map((l) => l.name);
  assert.ok(kept.includes("Bank Fees"), "Bank Fees is real cash — 6,454 a year");
  assert.ok(kept.includes("Bank Overdraft - Interest"), "so is overdraft interest — 21,984 a year");
  console.log("✓ bank fees and overdraft interest are not mistaken for non-cash");
}

/* ---------- June: THE ONE THAT MATTERS — non-cash is a net gain ---------- */

{
  // June 2026 really did carry a 30,588 unrealised GAIN and a 3,216 revaluation
  // credit. Reported opex was 72,856; the cash cost of running the business that
  // month was 106,661. Excluding non-cash must make the figure BIGGER here.
  const report = pnl([
    row("Wages", 12740.01),
    row("Contractors - Headquarters", 22655.67),
    row("CRM", 15862.50),
    row("Commission", 16072.97),
    row("Bank Revaluations", -3216.40),
    row("Unrealised Currency Gains", -30588.42),
  ]);

  const p = parseOperatingExpenses(report);
  near(p.total, 33526.33, 0.01, "reported opex is flattered by the currency gain");
  near(p.cashTotal, 67331.15, 0.01, "cash opex is higher once the gain is removed");
  assert.ok(p.cashTotal > p.total,
    "a month with a net currency GAIN must end up with HIGHER cash opex, not lower");
  near(p.cashTotal - p.total, 33804.82, 0.01, "by exactly the June non-cash swing");
  console.log("✓ June: a currency gain does not make the month look cheap");
}

/* ---------- the exclusion list is narrow on purpose ---------- */

{
  for (const name of ["Bank Revaluations", "Bank Revaluation",
                      "Unrealised Currency Gains", "unrealised fx losses",
                      "Depreciation", "Amortisation"]) {
    assert.equal(isNonCash(name), true, `${name} should be excluded`);
  }
  // Everything that moves money must survive, including the near-misses.
  for (const name of ["Bank Fees", "Bank Overdraft - Interest", "BNZ Merchant Fees",
                      "Realised Currency Gains", "Wages", "Rent", "Xero Subscription"]) {
    assert.equal(isNonCash(name), false, `${name} must NOT be excluded`);
  }
  console.log("✓ the exclusion list catches non-cash and nothing else");
}

/* ---------- a report without the section must not silently read zero ---------- */

{
  const p = parseOperatingExpenses({ Reports: [{ Rows: [{ RowType: "Section", Title: "Trading Income", Rows: [] }] }] });
  assert.equal(p.sectionFound, false, "a missing section is reported, not treated as nil opex");
  assert.equal(p.cashTotal, 0);
  console.log("✓ a missing Operating Expenses section is flagged, not read as zero");
}

/* ---------- nested rows and summary rows ---------- */

{
  const report = {
    Reports: [{
      Rows: [{
        RowType: "Section", Title: "Operating Expenses",
        Rows: [
          row("Wages", 1000),
          { RowType: "Section", Title: "Sub", Rows: [row("Storage", 250)] },
          { RowType: "SummaryRow", Cells: [{ Value: "Total" }, { Value: "1250" }] },
        ],
      }],
    }],
  };
  const p = parseOperatingExpenses(report);
  near(p.total, 1250, 0.01, "nested leaves are collected");
  assert.equal(p.lines.length, 2, "and the summary row is not counted as a line");
  console.log("✓ nested rows are collected without double-counting the total");
}

/* ---------- the cache invalidates itself when the parser changes ---------- */

{
  // WHY THIS TEST EXISTS
  // --------------------
  // The standardLayout fix made August read 82,369 — exactly the P&L. April
  // through July stayed at 18,657 / 131 / 25,170 / 4,687, because the sync only
  // ever refetches the most recent finished month and a closed month is cached
  // forever. The code was right and the dashboard was still wrong. A stamp on
  // the stored record is what turns "delete the blobs by hand" into "the next
  // sync fixes it".

  assert.equal(isOpexRecordCurrent(null), false, "nothing stored is not current");
  assert.equal(isOpexRecordCurrent(undefined), false);

  // Records written before the stamp existed are exactly the stale ones.
  assert.equal(
    isOpexRecordCurrent({ month: "2026-04", total: 18_657 }),
    false,
    "a record with no version is treated as version 1 and refetched",
  );
  assert.equal(isOpexRecordCurrent({ parserVersion: 1 }), false, "an older version refetches");
  assert.equal(
    isOpexRecordCurrent({ parserVersion: OPEX_PARSER_VERSION }),
    true,
    "a record from this parser is left alone",
  );
  // A newer deploy's record must not be refetched in a loop by an older
  // function that is still running during a rollout.
  assert.equal(
    isOpexRecordCurrent({ parserVersion: OPEX_PARSER_VERSION + 1 }),
    true,
    "a newer record is left alone rather than being fought over",
  );

  // Garbage must not read as current — that would keep a bad record forever.
  assert.equal(isOpexRecordCurrent({ parserVersion: "two" }), false, "an unparseable stamp refetches");

  // The version only means anything if it is actually greater than the one the
  // broken records carry. Version 1 is implicit, so the fix must be 2 or more.
  assert.ok(OPEX_PARSER_VERSION >= 2,
    "the standardLayout fix must be a version above the implicit 1");

  console.log("✓ a month stored by an older parser refetches; a current one does not");
}

console.log("\nAll opex tests passed.");

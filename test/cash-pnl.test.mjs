// Assembling the P&L from stored months and the stored budget.
//
// The arithmetic is addition. What these tests are actually about is the three
// ways a drill-down lies without appearing to:
//
//   1. comparing five months of trading against twelve months of budget,
//   2. a line whose budget was not matched showing as an overspend,
//   3. lines that do not add up to the total they sit under.

import assert from "node:assert/strict";
import { pnlView, normaliseAccount, fiscalKeys } from "../netlify/functions/_shared/cash-pnl.mjs";

const FY = 2026;

/** A stored opex record at parser version 7. */
const rec = (month, { income = [], cos = [], opex = [] } = {}) => {
  const t = (a) => a.reduce((s, l) => s + l.amount, 0);
  return {
    month,
    parserVersion: 7,
    revenue: t(income),
    revenueSectionFound: true,
    revenueLines: income,
    programCost: t(cos),
    programCostSectionFound: true,
    programCostLines: cos,
    total: t(opex),
    cashTotal: t(opex.filter((l) => !l.nonCash)),
    sectionFound: true,
    lines: opex,
  };
};

const acct = (name, months) => ({ account: name, name: name.replace(/^\d+\s+/, ""), months });
const flat = (n) => Array(12).fill(n);
const sec = (r, id) => r.sections.find((s) => s.id === id);
const line = (s, name) => s.lines.find((l) => l.name === name);

/* ---- the comparison that is easy to get wrong ---- */
{
  // Two months closed out of twelve. Rent is 5,000 a month, budgeted at 5,000
  // a month, and therefore exactly on plan.
  const months = ["2026-04", "2026-05"].map((k) =>
    rec(k, { opex: [{ name: "Rent", amount: 5_000, nonCash: false }] }));

  const r = pnlView({
    fiscalYearStartYear: FY,
    months,
    budget: { series: { overheadAccounts: [acct("420 Rent", flat(5_000))], monthsCovered: [...Array(12).keys()] } },
  });

  const oh = sec(r, "overheads");
  assert.equal(oh.total, 10_000, "two months of actual rent");
  assert.equal(oh.budgetTotal, 60_000, "the full-year budget is still twelve months");
  // THE BUG THIS EXISTS TO PREVENT. 10,000 against 60,000 is a 50,000
  // underspend, which is both arithmetically true and completely meaningless.
  assert.equal(oh.budgetToDate, 10_000, "the budget is cut to the closed months");
  assert.equal(oh.varianceToDate, 0, "so a line exactly on plan reads as exactly on plan");
  assert.equal(line(oh, "Rent").varianceToDate, 0, "and the same at line level");
  console.log("✓ budget is cut to the months that have actually closed");
}

/* ---- matching a reported line to a budgeted account ---- */
{
  assert.equal(normaliseAccount("420 Rent"), "rent");
  assert.equal(normaliseAccount("Rent"), "rent");
  assert.equal(normaliseAccount("6200 - Staff  Training"), "staff training");
  // Not clever, deliberately. "Travel" must not find "Travel Insurance", or
  // the variance lands on the wrong row and looks right doing it.
  assert.notEqual(normaliseAccount("Travel"), normaliseAccount("Travel Insurance"));
  console.log("✓ an account code on one side and not the other still matches");
}

{
  const months = [rec("2026-04", {
    opex: [
      { name: "Rent", amount: 5_000, nonCash: false },
      { name: "Fireworks", amount: 900, nonCash: false },
    ],
  })];
  const r = pnlView({
    fiscalYearStartYear: FY,
    months,
    budget: { series: { overheadAccounts: [acct("420 Rent", flat(5_000))] } },
  });
  const oh = sec(r, "overheads");
  assert.equal(line(oh, "Rent").budgetStatus, "matched", "code stripped, matched");
  assert.equal(line(oh, "Fireworks").budgetStatus, "unbudgeted",
    "spending with no plan behind it is a finding, not a blank cell");
  assert.equal(line(oh, "Fireworks").varianceToDate, null,
    "and it gets no variance, because there is nothing to vary from");
  assert.equal(oh.unbudgetedTotal, 900);
  console.log("✓ unbudgeted spend is named rather than shown as an overspend");
}

/* ---- budgeted and not spent ---- */
{
  const r = pnlView({
    fiscalYearStartYear: FY,
    months: [rec("2026-04", { opex: [{ name: "Rent", amount: 5_000, nonCash: false }] })],
    budget: { series: { overheadAccounts: [acct("420 Rent", flat(5_000)), acct("480 Legal", flat(1_000))] } },
  });
  const oh = sec(r, "overheads");
  assert.equal(oh.lines.length, 1, "rows come from what the books reported");
  // But the budget total must still include Legal, or the section's budget
  // column silently disagrees with the budget itself.
  assert.equal(oh.budgetTotal, 72_000, "12 x 5,000 plus 12 x 1,000");
  assert.equal(oh.budgetOnly.length, 1);
  assert.equal(oh.budgetOnly[0].name, "480 Legal");
  assert.equal(oh.budgetOnly[0].budgetToDate, 1_000, "one closed month of it");
  console.log("✓ a budgeted account nobody spent on is a saving, not an absence");
}

/* ---- the lines must add up to the total ---- */
{
  // A record from before parser version 7: the totals are there, the income
  // and cost-of-sales lines are not.
  const old = {
    month: "2026-04",
    parserVersion: 6,
    revenue: 100_000,
    revenueSectionFound: true,
    programCost: 60_000,
    total: 20_000,
    cashTotal: 20_000,
    lines: [{ name: "Rent", amount: 20_000, nonCash: false }],
  };
  const r = pnlView({ fiscalYearStartYear: FY, months: [old] });

  const inc = sec(r, "revenue");
  assert.equal(inc.total, 100_000, "the section total still comes from the record");
  assert.equal(inc.lines.length, 0, "and it has no lines to open");
  // THE POINT. A drill-down whose parts fail to reconstruct the whole, without
  // saying so, is worse than one that admits the gap — the reader has no way
  // to detect it.
  assert.equal(inc.residual.total, 100_000, "so the whole total is unitemised");
  assert.equal(inc.residual.material, true, "and that is surfaced, not swallowed");
  assert.ok(inc.truncatedMonths.includes("2026-04"));
  assert.ok(r.warnings.some((w) => /stored before every line was kept/.test(w)),
    "and said in words at the top of the page");

  const oh = sec(r, "overheads");
  assert.equal(oh.residual.material, false, "a section that does add up says nothing");
  console.log("✓ lines that do not reconstruct their total are shown as unitemised");
}

/* ---- variance signs, and the check that catches a flipped one ---- */
{
  const months = [rec("2026-04", {
    income: [{ name: "Program fees", amount: 120_000 }],   // budget 100,000 -> +20,000
    cos: [{ name: "Suppliers", amount: 70_000 }],          // budget 60,000  -> -10,000
    opex: [{ name: "Rent", amount: 4_000, nonCash: false }], // budget 5,000  ->  +1,000
  })];
  const r = pnlView({
    fiscalYearStartYear: FY,
    months,
    budget: {
      series: {
        revenueAccounts: [acct("200 Program fees", flat(100_000))],
        directCostAccounts: [acct("300 Suppliers", flat(60_000))],
        overheadAccounts: [acct("420 Rent", flat(5_000))],
      },
    },
  });

  assert.equal(sec(r, "revenue").varianceToDate, 20_000, "revenue above plan is positive");
  assert.equal(sec(r, "directCosts").varianceToDate, -10_000, "cost above plan is negative");
  assert.equal(sec(r, "overheads").varianceToDate, 1_000, "cost below plan is positive");

  assert.equal(r.grossProfit.total, 50_000, "120,000 less 70,000");
  assert.equal(r.surplus.total, 46_000, "less 4,000 of overheads");
  assert.equal(r.surplus.budgetToDate, 35_000, "100,000 less 60,000 less 5,000");

  // THE ARITHMETIC CHECK. The three section variances must add to the surplus
  // variance. They only do if every sign convention above is right, which is
  // why the convention is "positive is good news" rather than raw subtraction.
  const parts = r.sections.reduce((s, x) => s + x.varianceToDate, 0);
  assert.equal(parts, r.surplus.varianceToDate, "the three rows add to the bottom line");
  assert.equal(r.surplus.varianceToDate, 11_000);

  // Gross margin on REVENUE, not as a markup on cost. 50,000/120,000 is 41.7%;
  // the same contribution over cost is 71.4%, and the markup always flatters.
  assert.equal(r.grossMarginPct, 41.7);
  console.log("✓ positive is good news on every row, and the rows add up");
}

/* ---- cash basis vs the statement ---- */
{
  const months = [rec("2026-04", {
    opex: [
      { name: "Rent", amount: 5_000, nonCash: false },
      { name: "Bank Revaluations", amount: 30_000, nonCash: true },
    ],
  })];

  const total = pnlView({ fiscalYearStartYear: FY, months, basis: "total" });
  const cash = pnlView({ fiscalYearStartYear: FY, months, basis: "cash" });

  assert.equal(sec(total, "overheads").total, 35_000, "the P&L as Xero prints it");
  assert.equal(sec(cash, "overheads").total, 5_000, "the cash view drops the revaluation");
  assert.equal(line(sec(total, "overheads"), "Bank Revaluations").budgetStatus, "nonCash",
    "not 'unbudgeted' — the budget excludes these by design, so an empty cell is correct");
  assert.equal(sec(cash, "overheads").lines.length, 1, "and on a cash basis it is gone entirely");
  assert.ok(total.warnings.some((w) => /non-cash/.test(w)),
    "the total basis says how much of it is non-cash");
  console.log("✓ non-cash lines are excluded by design, not by oversight");
}

/* ---- a budget stored before the monthly split ---- */
{
  const r = pnlView({
    fiscalYearStartYear: FY,
    months: [rec("2026-04", { opex: [{ name: "Rent", amount: 5_000, nonCash: false }] })],
    // The old shape: an annual total per account and no months.
    budget: { included: [{ account: "420 Rent", amount: 60_000 }] },
  });
  const oh = sec(r, "overheads");
  assert.equal(oh.budgetTotal, 60_000, "the year is still right");
  assert.equal(oh.budgetToDate, 5_000, "spread evenly, so one month is a twelfth");
  assert.ok(r.warnings.some((w) => /even twelfth/.test(w)),
    "and the page says it is a twelfth rather than the real phasing");
  console.log("✓ an older budget is spread evenly and admits to it");
}

/* ---- months outside the fiscal year ---- */
{
  const r = pnlView({
    fiscalYearStartYear: FY,
    months: [
      rec("2026-03", { opex: [{ name: "Rent", amount: 99_000, nonCash: false }] }), // prior FY
      rec("2026-04", { opex: [{ name: "Rent", amount: 5_000, nonCash: false }] }),
    ],
  });
  assert.equal(sec(r, "overheads").total, 5_000, "March 2026 belongs to FY25/26");
  assert.equal(r.monthsClosed, 1);
  assert.equal(r.lastActualMonth, "2026-04");
  assert.deepEqual(fiscalKeys(FY).slice(0, 2), ["2026-04", "2026-05"]);
  assert.equal(fiscalKeys(FY)[11], "2027-03", "and the year ends in March");
  console.log("✓ months outside the fiscal year are ignored, not assumed");
}

/* ---- a missing income section is a parse failure, not a bad month ---- */
{
  const r = pnlView({
    fiscalYearStartYear: FY,
    months: [{ month: "2026-04", parserVersion: 7, revenue: 0, revenueSectionFound: false, lines: [] }],
  });
  assert.ok(r.warnings.some((w) => /parsing problem rather than a trading one/.test(w)));
  console.log("✓ zero income from a missing section says which it is");
}

console.log("\nAll P&L tests passed.");

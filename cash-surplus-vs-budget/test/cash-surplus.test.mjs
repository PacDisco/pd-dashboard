// Extrapolated full-year surplus, against budget.
//
// The arithmetic is subtraction. Everything that can go wrong here is about
// WHICH SIDE OF THE SEAM a month sits on, and none of it looks like an error on
// screen — a double-counted month looks like a good year.

import assert from "node:assert/strict";
import { surplusView } from "../netlify/functions/_shared/cash-surplus.mjs";

const near = (a, b, tol, msg) => {
  assert.ok(Number.isFinite(a) && Number.isFinite(b), `${msg}: not a number (${a} vs ${b})`);
  assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b}`);
};

const KEYS = Array.from({ length: 12 }, (_, i) => {
  const abs = 3 + i;
  return `${2026 + Math.floor(abs / 12)}-${String((abs % 12) + 1).padStart(2, "0")}`;
});

/** Engine-shaped months: recognised revenue and program costs from the pax model. */
const forecastMonths = KEYS.map((key, i) => ({
  key,
  recognisedRevenue: i === 4 ? 1_000_000 : 0,   // Fall recognised in August
  programCostsOut: 50_000,
  overheads: 60_000,
}));

const budgetSeries = {
  revenue: KEYS.map((_, i) => (i === 4 ? 1_200_000 : 0)),
  directCosts: Array(12).fill(55_000),
  overheads: Array(12).fill(62_000),
  monthsCovered: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
};

/* ---- the seam: every month on exactly one side ---- */
{
  // April and May closed; the rest projected.
  const opexByMonth = {
    "2026-04": { revenue: 10_000, programCost: 40_000, total: 94_093, cashTotal: 94_093 },
    "2026-05": { revenue: 20_000, programCost: 45_000, total: 71_000, cashTotal: 71_000 },
  };

  const r = surplusView({
    fiscalYearStartYear: 2026,
    actualsThroughMonth: "2026-05",
    opexByMonth,
    forecastMonths,
    budgetSeries,
    overheadsForward: Array(12).fill(62_000),
  });

  assert.equal(r.actualMonths, 2);
  assert.equal(r.projectedMonths, 10);
  assert.equal(r.actualMonths + r.projectedMonths, 12,
    "every month belongs to exactly one side — this is the whole discipline");
  assert.equal(r.lastActualMonth, "2026-05");

  // April must carry the P&L's revenue, NOT the model's (which is zero for
  // April). And the model's April must not also be added.
  near(r.lines.revenue.actual, 30_000, 0.01, "actual revenue is April + May from the books");
  near(r.lines.revenue.projected, 1_000_000, 0.01, "projected revenue is the model's August");
  near(r.lines.revenue.extrapolated, 1_030_000, 0.01, "and the two are added exactly once");

  // THE DOUBLE COUNT. If April were taken from both sides, revenue would come
  // out at 1,030,000 + April's model figure. It is zero for April here, so the
  // test uses costs, where both sides are non-zero and a double count shows.
  near(r.lines.directCosts.actual, 85_000, 0.01, "April 40k + May 45k from the books");
  near(r.lines.directCosts.projected, 500_000, 0.01, "ten projected months at 50k");
  near(r.lines.directCosts.extrapolated, 585_000, 0.01,
    "NOT 685,000 — the two closed months must not also contribute their model figure");

  // Overheads: closed months from the P&L, projected months from the budget.
  near(r.lines.overheads.actual, 165_093, 0.01, "94,093 + 71,000");
  near(r.lines.overheads.projected, 620_000, 0.01, "ten months of budgeted 62,000");

  // And the surplus is the subtraction, done once.
  near(r.lines.surplus.extrapolated,
    r.lines.revenue.extrapolated - r.lines.directCosts.extrapolated - r.lines.overheads.extrapolated,
    0.01, "surplus is revenue less both cost lines");
  console.log("✓ each month contributes to exactly one side of the seam");
}

/* ---- a closed month with no stored P&L ---- */
{
  // May is inside the closed range but the refresh never reached it. Treating
  // "closed" as sufficient would give May zero revenue and its real overheads —
  // which reads as a catastrophic month rather than as a gap in the data.
  const r = surplusView({
    fiscalYearStartYear: 2026,
    actualsThroughMonth: "2026-05",
    opexByMonth: { "2026-04": { revenue: 10_000, programCost: 40_000, total: 94_093 } },
    forecastMonths,
    budgetSeries,
    overheadsForward: Array(12).fill(62_000),
  });

  assert.equal(r.actualMonths, 1, "only April has a record");
  const may = r.months.find((m) => m.key === "2026-05");
  assert.equal(may.source, "projected");
  assert.equal(may.projectedBecause, "no P&L stored for a closed month",
    "and it says WHY, because 'projected' alone would look like a future month");
  near(may.directCosts, 50_000, 0.01, "so it falls back to the model rather than to zero");
  assert.ok(r.warnings.some((w) => w.includes("2026-05") && w.includes("Refresh")),
    `the gap must be named — got: ${r.warnings.join(" | ")}`);
  console.log("✓ a closed month with no P&L is projected, not zeroed, and says so");
}

/* ---- variance signs ---- */
{
  const r = surplusView({
    fiscalYearStartYear: 2026,
    actualsThroughMonth: null,
    opexByMonth: {},
    forecastMonths,
    budgetSeries,
    overheadsForward: Array(12).fill(62_000),
  });

  // Revenue 1,000,000 against 1,200,000 budgeted — behind, so negative.
  near(r.variance.revenue, -200_000, 0.01, "revenue short of budget is a negative variance");
  // Costs 600,000 against 660,000 budgeted — UNDER budget, which is good news,
  // so positive. Stating cost variance as actual-minus-budget would make good
  // news negative and is the classic way a variance table gets misread.
  near(r.variance.directCosts, 60_000, 0.01, "coming in under on costs is positive");
  near(r.variance.overheads, 0, 0.01, "62,000 x 12 both ways");
  // And the surplus variance must equal the sum of the parts, or one of the
  // signs above is wrong.
  near(r.variance.surplus,
    r.variance.revenue + r.variance.directCosts + r.variance.overheads,
    0.01, "the parts must reconcile to the whole, which is what catches a flipped sign");
  console.log("✓ favourable is positive on every line, and the parts reconcile");
}

/* ---- accrual, not cash ---- */
{
  // The model recognises the whole Fall season in August. If this ever started
  // reading cash receipts instead, revenue would spread across the booking
  // months and August would collapse — so the shape is asserted, not just the
  // total.
  const r = surplusView({
    fiscalYearStartYear: 2026, actualsThroughMonth: null,
    opexByMonth: {}, forecastMonths, budgetSeries,
    overheadsForward: Array(12).fill(62_000),
  });
  const aug = r.months.find((m) => m.key === "2026-08");
  near(aug.revenue, 1_000_000, 0.01, "the whole season lands in its recognition month");
  assert.equal(r.months.filter((m) => m.revenue !== 0).length, 1,
    "and in no other month — this is accrual, not the cash timeline");
  assert.equal(r.basis.accrual, true);
  console.log("✓ revenue follows recognition, not receipts");
}

/* ---- degenerate inputs ---- */
{
  const noBudget = surplusView({
    fiscalYearStartYear: 2026, actualsThroughMonth: null,
    opexByMonth: {}, forecastMonths, budgetSeries: null,
  });
  assert.equal(noBudget.variance, null, "no budget means no variance, not a variance against zero");
  assert.equal(noBudget.lines.surplus.budget, null);
  assert.ok(noBudget.warnings.some((w) => w.includes("No budget stored")));

  const partial = surplusView({
    fiscalYearStartYear: 2026, actualsThroughMonth: null,
    opexByMonth: {}, forecastMonths,
    budgetSeries: { ...budgetSeries, monthsCovered: [0, 1, 2, 3, 4, 5, 6, 7, 8] },
  });
  assert.ok(partial.warnings.some((w) => w.includes("9 of 12")),
    "a part-year budget flatters the comparison and must say so");

  const empty = surplusView({ fiscalYearStartYear: 2026 });
  assert.equal(empty.months.length, 12, "twelve months even with no inputs at all");
  assert.equal(empty.lines.surplus.extrapolated, 0, "and zero, not NaN");
  console.log("✓ missing budget and empty input degrade without inventing a comparison");
}

console.log("\nAll surplus tests passed.");

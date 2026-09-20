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

  // TRUE-UP OFF, deliberately. This block tests the seam — that no month is
  // counted on both sides — and the true-up would rescale the projected figures
  // on top of that, making a double count and a rescale indistinguishable.
  // Timing behaviour is tested separately, further down.
  const r = surplusView({
    fiscalYearStartYear: 2026,
    actualsThroughMonth: "2026-05",
    opexByMonth,
    forecastMonths,
    budgetSeries,
    overheadsForward: Array(12).fill(62_000),
    trueUp: false,
  });

  assert.equal(r.actualMonths, 2);
  assert.equal(r.projectedMonths, 10);
  assert.equal(r.actualMonths + r.projectedMonths, 12,
    "every month belongs to exactly one side — this is the whole discipline");
  assert.equal(r.lastActualMonth, "2026-05");

  // April must carry the P&L's revenue, NOT the model's (which is zero for
  // April). And the model's April must not also be added.
  near(r.lines.revenue.actual, 30_000, 0.01, "actual revenue is April + May from the books");
  // 30,000 was booked in April and May, months the model expected nothing in.
  // That can only be a season recognising early on its way to a later deadline,
  // so it is netted off that deadline rather than added to it: 1,000,000 less
  // 30,000 already in the books.
  near(r.lines.revenue.projected, 970_000, 0.01, "the deadline carries only what is still outstanding");
  near(r.lines.revenue.extrapolated, 1_000_000, 0.01,
    "so the year holds at the season's own total — NOT 1,030,000, which would count the early part twice");
  near(r.revenueCheck.earlyRecognition, 30_000, 0.01, "and the netting is reported, not silent");

  // THE DOUBLE COUNT. If April were taken from both sides, revenue would come
  // out at 1,030,000 + April's model figure. It is zero for April here, so the
  // test uses costs, where both sides are non-zero and a double count shows.
  near(r.lines.directCosts.actual, 85_000, 0.01, "April 40k + May 45k from the books");
  near(r.lines.directCosts.projected, 500_000, 0.01, "ten projected months at 50k");
  near(r.lines.directCosts.extrapolated, 585_000, 0.01,
    "NOT 685,000 — the two closed months must not also contribute their model figure");

  // The same inputs WITH the true-up. April and May came in at 85,000 against
  // the curve's 100,000, so 15,000 of the year's cost moves forward into the
  // remaining months rather than disappearing from the year.
  const trued = surplusView({
    fiscalYearStartYear: 2026, actualsThroughMonth: "2026-05",
    opexByMonth, forecastMonths, budgetSeries,
    overheadsForward: Array(12).fill(62_000),
  });
  near(trued.lines.directCosts.actual, 85_000, 0.01, "the closed months are untouched");
  near(trued.lines.directCosts.projected, 515_000, 0.01, "the shortfall moves to the months to come");
  near(trued.lines.directCosts.extrapolated, 600_000, 0.01, "and the year holds at the model's total");
  assert.equal(trued.trueUp.closedGap, -15_000, "under the curve, so a negative gap");

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
  // True-up off: this block is about WHICH SOURCE a month falls back to, and
  // the true-up rescales the fallback figure, which would blur the assertion.
  const r = surplusView({
    fiscalYearStartYear: 2026,
    actualsThroughMonth: "2026-05",
    opexByMonth: { "2026-04": { revenue: 10_000, programCost: 40_000, total: 94_093 } },
    forecastMonths,
    budgetSeries,
    overheadsForward: Array(12).fill(62_000),
    trueUp: false,
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

/* ---- closed months the parser cannot read ---- */
{
  // THE ONE THAT SHIPPED WRONG.
  //
  // Five months closed off in the model, all stored by a parser that did not
  // yet read revenue. Every one falls back to the projection, which is correct
  // — but the panel then said "nothing closed yet", stating a cache problem as
  // a fact about the business. The two must be distinguishable.
  const preV6 = {};
  for (const k of KEYS.slice(0, 5)) preV6[k] = { programCost: 40_000, total: 90_000 };

  const r = surplusView({
    fiscalYearStartYear: 2026,
    actualsThroughMonth: "2026-08",
    opexByMonth: preV6,
    forecastMonths,
    budgetSeries,
    overheadsForward: Array(12).fill(62_000),
  });

  assert.equal(r.actualMonths, 0, "no month has a readable revenue figure");
  assert.equal(r.closedRangeMonths, 5, "but five are closed off in the model");
  assert.equal(r.unsyncedClosedMonths, 5, "and all five are unreadable");
  assert.ok(r.warnings.some((w) => w.includes("5 months are closed off") && w.includes("Refresh")),
    `the warning must say five months exist and cannot be read — got: ${r.warnings.join(" | ")}`);
  assert.ok(!r.warnings.some((w) => w.includes("No month has been closed off yet")),
    "and must NOT claim nothing has happened yet");

  // A genuinely fresh year still gets the honest version.
  const fresh = surplusView({
    fiscalYearStartYear: 2026, actualsThroughMonth: null,
    opexByMonth: {}, forecastMonths, budgetSeries,
  });
  assert.equal(fresh.closedRangeMonths, 0);
  assert.ok(fresh.warnings.some((w) => w.includes("No month has been closed off yet")),
    "nothing closed is still stated plainly when it is true");
  console.log("✓ a stale cache is never reported as an empty year");
}

/* ---- a budget stored before this view existed ---- */
{
  // Two warnings fired at once on the deployed build — "the stored budget
  // predates this view" AND "no budget stored for this year" — which read as
  // contradictory. They describe the same state and only one should speak.
  const r = surplusView({
    fiscalYearStartYear: 2026, actualsThroughMonth: null,
    opexByMonth: {}, forecastMonths,
    budgetSeries: null, budgetStoredWithoutSeries: true,
  });
  assert.ok(r.warnings.some((w) => w.includes("read before this view existed")));
  assert.ok(!r.warnings.some((w) => w.includes("No budget stored for this year")),
    "a budget that exists must not also be reported as absent");
  console.log("✓ an out-of-date budget and a missing one are one message, not two");
}

/* ---- cost to complete ---- */
{
  // Model: 50,000 a month, 600,000 for the year. Five months closed.
  //
  // THE PROPERTY THAT MATTERS: the year's total program cost must not depend on
  // WHEN the money went out. Without a true-up the projected months replay the
  // curve regardless, so a heavy start silently inflates the year and a light
  // start silently deflates it — in both cases by exactly the amount of the
  // timing difference, and invisibly.
  const closed = (perMonth) => {
    const o = {};
    for (const k of KEYS.slice(0, 5)) {
      o[k] = { revenue: 100_000, programCost: perMonth, total: 60_000 };
    }
    return o;
  };
  const run = (perMonth, opts = {}) => surplusView({
    fiscalYearStartYear: 2026, actualsThroughMonth: KEYS[4],
    opexByMonth: closed(perMonth), forecastMonths, budgetSeries,
    overheadsForward: Array(12).fill(62_000), ...opts,
  });

  const onPlan = run(50_000);
  const heavy = run(80_000);
  const light = run(20_000);

  // The curve's own view of the closed months is 5 x 50,000.
  assert.equal(onPlan.trueUp.plannedInClosed, 250_000);
  assert.equal(onPlan.trueUp.modelYearTotal, 600_000);

  for (const [name, r] of [["on plan", onPlan], ["heavy start", heavy], ["light start", light]]) {
    near(r.lines.directCosts.extrapolated, 600_000, 1,
      `${name}: the year's program cost is the year's program cost`);
  }

  // And the remaining months absorb the difference rather than the total doing so.
  near(heavy.lines.directCosts.actual, 400_000, 1, "heavy start spent 400,000 by August");
  near(heavy.lines.directCosts.projected, 200_000, 1, "so only 200,000 is left for the rest");
  near(light.lines.directCosts.projected, 500_000, 1, "a light start leaves more to come");
  assert.equal(heavy.trueUp.applied, true);
  console.log("✓ the year's cost no longer depends on when the money went out");
}

/* ---- the overspend must not vanish ---- */
{
  // The true-up's own failure mode: it cannot tell "paid earlier" from "paid
  // more", and left to itself it would spread an overspend across the
  // remaining months where nobody would see it. It must say so instead.
  const o = {};
  for (const k of KEYS.slice(0, 5)) o[k] = { revenue: 100_000, programCost: 80_000, total: 60_000 };
  const r = surplusView({
    fiscalYearStartYear: 2026, actualsThroughMonth: KEYS[4],
    opexByMonth: o, forecastMonths, budgetSeries,
    overheadsForward: Array(12).fill(62_000),
  });

  assert.equal(r.trueUp.closedGap, 150_000, "400,000 incurred against 250,000 planned");
  assert.equal(r.trueUp.closedGapPct, 60);
  assert.ok(r.warnings.some((w) => w.includes("150,000") && w.includes("brought forward")),
    `the gap must be stated with both readings — got: ${r.warnings.join(" | ")}`);
  assert.ok(r.trueUp.ambiguity.includes("Program or Season tag"),
    "and why it cannot be resolved from this data");

  // A small gap is noise in a curve that was invented anyway — no warning.
  const small = {};
  for (const k of KEYS.slice(0, 5)) small[k] = { revenue: 100_000, programCost: 51_000, total: 60_000 };
  const quiet = surplusView({
    fiscalYearStartYear: 2026, actualsThroughMonth: KEYS[4],
    opexByMonth: small, forecastMonths, budgetSeries,
    overheadsForward: Array(12).fill(62_000),
  });
  assert.ok(!quiet.warnings.some((w) => w.includes("brought forward")),
    "a 2% gap must not cry wolf");
  console.log("✓ a real gap is named with both readings; a small one is not");
}

/* ---- already past the whole year's cost ---- */
{
  // 5 x 150,000 = 750,000 incurred against a 600,000 model year. Left alone the
  // remaining months would get NEGATIVE cost, which ADDS to the surplus — so a
  // business that had blown its entire annual program cost by August would show
  // the year improving from here. That is the worst possible direction to be
  // wrong in.
  const o = {};
  for (const k of KEYS.slice(0, 5)) o[k] = { revenue: 100_000, programCost: 150_000, total: 60_000 };
  const r = surplusView({
    fiscalYearStartYear: 2026, actualsThroughMonth: KEYS[4],
    opexByMonth: o, forecastMonths, budgetSeries,
    overheadsForward: Array(12).fill(62_000),
  });

  assert.equal(r.trueUp.floored, true);
  assert.equal(r.trueUp.remaining, 0);
  for (const m of r.months.filter((x) => x.source === "projected")) {
    assert.ok(m.directCosts >= 0, `${m.key} must never carry a negative program cost`);
  }
  near(r.lines.directCosts.projected, 0, 1, "nothing left in the model to spend");
  assert.ok(r.warnings.some((w) => w.includes("more than the model's whole-year figure")),
    "and that is reported as the finding rather than as a rounding");
  console.log("✓ an exhausted model floors at zero instead of crediting the year");
}

/* ---- true-up off, and nothing to true up against ---- */
{
  const o = {};
  for (const k of KEYS.slice(0, 5)) o[k] = { revenue: 100_000, programCost: 80_000, total: 60_000 };
  const off = surplusView({
    fiscalYearStartYear: 2026, actualsThroughMonth: KEYS[4],
    opexByMonth: o, forecastMonths, budgetSeries,
    overheadsForward: Array(12).fill(62_000), trueUp: false,
  });
  near(off.lines.directCosts.projected, 350_000, 1, "the curve replays untouched");
  near(off.lines.directCosts.extrapolated, 750_000, 1,
    "and the year's total moves with the timing — the behaviour this replaced");
  assert.equal(off.trueUp.applied, false);

  // With no closed month there is nothing to true up against, and the figures
  // must be the plain projection rather than scaled by an empty comparison.
  const fresh = surplusView({
    fiscalYearStartYear: 2026, actualsThroughMonth: null,
    opexByMonth: {}, forecastMonths, budgetSeries,
    overheadsForward: Array(12).fill(62_000),
  });
  assert.equal(fresh.trueUp.applied, false);
  near(fresh.lines.directCosts.extrapolated, 600_000, 1, "still the model's year");
  console.log("✓ true-up is skippable and degrades to the plain projection");
}

/* ---- revenue is compared, not corrected ---- */
{
  // Fall recognises in August (slot 4) in this fixture. The model says
  // 1,000,000; the books say 850,000 — 15% short, which is pax or price, not
  // timing. The projected months must NOT be scaled up to compensate: doing so
  // would take a shortfall in Fall and silently inflate Spring.
  const o = {};
  for (const k of KEYS.slice(0, 5)) o[k] = { revenue: 0, programCost: 50_000, total: 60_000 };
  o[KEYS[4]] = { revenue: 850_000, programCost: 50_000, total: 60_000 };

  const r = surplusView({
    fiscalYearStartYear: 2026, actualsThroughMonth: KEYS[4],
    opexByMonth: o, forecastMonths, budgetSeries,
    overheadsForward: Array(12).fill(62_000),
  });

  assert.equal(r.revenueCheck.applied, false, "revenue is never trued up");
  assert.equal(r.revenueCheck.plannedInClosed, 1_000_000);
  assert.equal(r.revenueCheck.bookedInClosed, 850_000);
  assert.equal(r.revenueCheck.gap, -150_000);
  assert.equal(r.revenueCheck.gapPct, -15);

  // The books' figure is what counts, and nothing downstream moved.
  near(r.lines.revenue.actual, 850_000, 0.01, "the year carries what was booked");
  near(r.lines.revenue.projected, 0, 0.01,
    "and the projected months are untouched — no compensating uplift");

  assert.ok(r.warnings.some((w) => w.includes("15%") && w.includes("not trued up")),
    `the gap must be reported with its consequence — got: ${r.warnings.join(" | ")}`);
  console.log("✓ a revenue shortfall is reported, and never spread into later seasons");
}

/* ---- a season on the wrong side of the seam ---- */
{
  // THE BUG WE ALREADY SHIPPED ONCE.
  //
  // The model expects Fall in August. August is closed and the books show
  // nothing, because Xero recognised it elsewhere. Since the month is closed,
  // the model's figure is discarded — so a whole season leaves the year and the
  // totals still look plausible.
  const missing = {};
  for (const k of KEYS.slice(0, 5)) missing[k] = { revenue: 0, programCost: 50_000, total: 60_000 };
  const r = surplusView({
    fiscalYearStartYear: 2026, actualsThroughMonth: KEYS[4],
    opexByMonth: missing, forecastMonths, budgetSeries,
    overheadsForward: Array(12).fill(62_000),
  });

  assert.deepEqual(r.revenueCheck.missingSeasonMonths, [KEYS[4]]);
  near(r.lines.revenue.extrapolated, 0, 0.01, "the season really is gone from the year");
  assert.equal(r.revenueCheck.settledShortfall, 1_000_000,
    "the deadline passed unsatisfied, so the whole season is a settled shortfall");
  assert.ok(r.warnings.some((w) => w.includes("nothing more is coming")
                                && w.includes("essentially the whole season")),
    `a deadline that passed empty must say so — got: ${r.warnings.join(" | ")}`);

  // The opposite shape: the books recognise a season the model did not expect
  // in that month. If the model also projects one later, it is in twice.
  const surprise = {};
  for (const k of KEYS.slice(0, 5)) surprise[k] = { revenue: 0, programCost: 50_000, total: 60_000 };
  surprise[KEYS[2]] = { revenue: 900_000, programCost: 50_000, total: 60_000 };
  const later = KEYS.map((key, i) => ({
    key, recognisedRevenue: i === 9 ? 900_000 : 0, programCostsOut: 50_000, overheads: 60_000,
  }));
  const r2 = surplusView({
    fiscalYearStartYear: 2026, actualsThroughMonth: KEYS[4],
    opexByMonth: surprise, forecastMonths: later, budgetSeries,
    overheadsForward: Array(12).fill(62_000),
  });
  // Nothing is double counted any more, and nothing is unexplained either: the
  // 900,000 booked in June is consumed against the January deadline, which is
  // exactly what it is — a season recognising early.
  assert.deepEqual(r2.revenueCheck.surpriseSeasonMonths, [],
    "revenue a later deadline can absorb is the normal case, not a surprise");
  assert.equal(r2.revenueCheck.unexplainedEarly, 0);
  assert.ok(r2.warnings.some((w) => w.includes("still in flight")),
    `it is reported as a season landing early — got: ${r2.warnings.join(" | ")}`);

  // THIS ASSERTION USED TO DEMAND 1,800,000 — the doubled total — on the
  // grounds that the detector existed because the arithmetic really did double.
  // It no longer does: the netting consumes the 900,000 booked in June against
  // the deadline in January, so the year holds at the season's own value. The
  // detector stays because the SHAPE is still worth flagging — a season landing
  // in a month the model did not expect usually means a wrong departure date —
  // but it is now a warning about the inputs rather than a guard against the
  // total being wrong.
  near(r2.lines.revenue.extrapolated, 900_000, 0.01,
    "the season is counted once, not twice — the netting removes the double count");
  near(r2.revenueCheck.earlyRecognition, 900_000, 0.01, "all of it recognised early");
  console.log("✓ a season on the wrong side of the seam is caught in both directions");
}

/* ---- and a season in the right place stays quiet ---- */
{
  const o = {};
  for (const k of KEYS.slice(0, 5)) o[k] = { revenue: 0, programCost: 50_000, total: 60_000 };
  o[KEYS[4]] = { revenue: 1_010_000, programCost: 50_000, total: 60_000 };
  const r = surplusView({
    fiscalYearStartYear: 2026, actualsThroughMonth: KEYS[4],
    opexByMonth: o, forecastMonths, budgetSeries,
    overheadsForward: Array(12).fill(62_000),
  });
  assert.equal(r.revenueCheck.missingSeasonMonths.length, 0);
  assert.equal(r.revenueCheck.surpriseSeasonMonths.length, 0);
  assert.ok(!r.warnings.some((w) => w.includes("MISSING") || w.includes("TWICE")),
    "a season within 1% of plan must not raise a seven-figure alarm");
  console.log("✓ seasons landing where expected raise nothing");
}

/* ---- overheads must never be trued up ---- */
{
  // Jake's rule, asserted: costs have a known total and true up; overheads do
  // not and must not. If overheads were ever rescaled the same way, a permanent
  // step change — a pay rise in October — would be cancelled out against the
  // remaining months and disappear.
  const heavy = {};
  for (const k of KEYS.slice(0, 5)) {
    heavy[k] = { revenue: 0, programCost: 50_000, total: 200_000 };  // way over
  }
  const r = surplusView({
    fiscalYearStartYear: 2026, actualsThroughMonth: KEYS[4],
    opexByMonth: heavy, forecastMonths, budgetSeries,
    overheadsForward: Array(12).fill(62_000),
  });

  near(r.lines.overheads.actual, 1_000_000, 0.01, "five closed months at 200,000");
  near(r.lines.overheads.projected, 434_000, 0.01,
    "seven months at the budgeted 62,000 — NOT reduced to hold a yearly total");
  near(r.lines.overheads.extrapolated, 1_434_000, 0.01,
    "so an overhead overrun flows straight through to the year, as it should");
  console.log("✓ overheads pass through untouched — an overrun is not cancelled out");
}

/* ---- surplus as at the last closed month ---- */
{
  // Five months closed. The budget is seasonal, matching how the business
  // actually trades: Fall recognises in August, which is inside the closed
  // range, so a year-to-date comparison is meaningful here.
  const o = {};
  for (const k of KEYS.slice(0, 5)) o[k] = { revenue: 0, programCost: 50_000, total: 60_000 };
  o[KEYS[4]] = { revenue: 1_000_000, programCost: 50_000, total: 60_000 };

  const r = surplusView({
    fiscalYearStartYear: 2026, actualsThroughMonth: KEYS[4],
    opexByMonth: o, forecastMonths, budgetSeries,
    overheadsForward: Array(12).fill(62_000),
  });

  assert.equal(r.toDate.months, 5);
  assert.equal(r.toDate.throughMonth, KEYS[4]);

  // THE POINT OF THIS BLOCK: the budget side must cover the SAME five months,
  // not the whole year. The full-year budget revenue is 1,200,000 and so is the
  // five-month figure here only because the fixture puts it all in August —
  // costs are where a whole-year budget would show up as obviously wrong.
  assert.equal(r.toDate.revenue.budget, 1_200_000, "August is the only budgeted revenue month");
  assert.equal(r.toDate.directCosts.budget, 275_000, "five months at 55,000 — NOT the year's 660,000");
  assert.equal(r.toDate.overheads.budget, 310_000, "five months at 62,000");

  assert.equal(r.toDate.revenue.actual, 1_000_000);
  assert.equal(r.toDate.directCosts.actual, 250_000);
  assert.equal(r.toDate.surplus.actual, 1_000_000 - 250_000 - 300_000);
  assert.equal(r.toDate.surplus.budget, 1_200_000 - 275_000 - 310_000);

  // Favourable is positive on every line here too, or the two variance blocks
  // on the same screen would use opposite conventions.
  assert.equal(r.toDate.revenue.variance, -200_000, "revenue behind plan is negative");
  assert.equal(r.toDate.directCosts.variance, 25_000, "costs under budget is positive");
  assert.ok(r.toDate.overheads.variance > 0, "overheads under budget is positive");
  assert.equal(
    r.toDate.surplus.variance,
    r.toDate.revenue.variance + r.toDate.directCosts.variance + r.toDate.overheads.variance,
    "and the parts reconcile, which is what catches a flipped sign");
  console.log("✓ to-date figures are measured against the same months' budget");
}

/* ---- a flat budget makes the to-date comparison meaningless ---- */
{
  // Xero budgets are very often one annual figure divided by twelve. Against a
  // business that books a season in a single month, that shape makes the
  // year-to-date read swing wildly — spectacular the month Fall recognises,
  // dire the month before. It has to be called out, not presented as a result.
  const flat = {
    revenue: Array(12).fill(100_000),
    directCosts: Array(12).fill(55_000),
    overheads: Array(12).fill(62_000),
    monthsCovered: [0,1,2,3,4,5,6,7,8,9,10,11],
  };
  const o = {};
  for (const k of KEYS.slice(0, 5)) o[k] = { revenue: 0, programCost: 50_000, total: 60_000 };
  o[KEYS[4]] = { revenue: 1_000_000, programCost: 50_000, total: 60_000 };

  const r = surplusView({
    fiscalYearStartYear: 2026, actualsThroughMonth: KEYS[4],
    opexByMonth: o, forecastMonths, budgetSeries: flat,
    overheadsForward: Array(12).fill(62_000),
  });
  assert.equal(r.toDate.budgetLooksFlat, true);
  assert.ok(r.warnings.some((w) => w.includes("spread fairly evenly")),
    `a flat budget must be named — got: ${r.warnings.join(" | ")}`);

  // And a genuinely seasonal budget must NOT trip it.
  const seasonal = surplusView({
    fiscalYearStartYear: 2026, actualsThroughMonth: KEYS[4],
    opexByMonth: o, forecastMonths, budgetSeries,
    overheadsForward: Array(12).fill(62_000),
  });
  assert.equal(seasonal.toDate.budgetLooksFlat, false, "a season-shaped budget is fine");
  console.log("✓ a flat budget is called out before anyone reads a YTD variance from it");
}

/* ---- no closed months, and a finished year ---- */
{
  const fresh = surplusView({
    fiscalYearStartYear: 2026, actualsThroughMonth: null,
    opexByMonth: {}, forecastMonths, budgetSeries,
    overheadsForward: Array(12).fill(62_000),
  });
  assert.equal(fresh.toDate.months, 0);
  assert.equal(fresh.toDate.throughMonth, null);
  assert.equal(fresh.toDate.surplus.actual, 0, "zero, not NaN");
  assert.ok(!fresh.warnings.some((w) => w.includes("spread fairly evenly")),
    "no closed months means no YTD comparison to warn about");
  console.log("✓ to-date degrades cleanly with nothing closed");
}

/* ---- Fall 2026: the case that forced the rule change ---- */
{
  // The real shape. Fall departs 10 September, so its deadline is September.
  // The books recognised 1,085,804 in August — closed, therefore fact. The
  // remainder lands in September, which is still open.
  //
  // Under the old rule the model put the whole season in August; August closed;
  // the model's figure was discarded; September was projected at zero. The tail
  // existed in NEITHER column and the year was short by it.
  const SEASON = 1_357_051;   // model: pax x price
  const BOOKED_AUG = 1_085_804;
  const fall = KEYS.map((key, i) => ({
    key,
    recognisedRevenue: i === 5 ? SEASON : 0,   // deadline = September, slot 5
    programCostsOut: 50_000,
    overheads: 60_000,
  }));
  const o = {};
  for (const k of KEYS.slice(0, 5)) o[k] = { revenue: 0, programCost: 50_000, total: 60_000 };
  o[KEYS[4]] = { revenue: BOOKED_AUG, programCost: 50_000, total: 60_000 };

  const r = surplusView({
    fiscalYearStartYear: 2026, actualsThroughMonth: KEYS[4],
    opexByMonth: o, forecastMonths: fall,
    overheadsForward: Array(12).fill(62_000),
  });

  near(r.revenueCheck.earlyRecognition, BOOKED_AUG, 1,
    "August's booking is recognised early against September's deadline");
  const sep = r.months.find((m) => m.key === KEYS[5]);
  near(sep.revenue, SEASON - BOOKED_AUG, 1, "September carries only what is outstanding");
  near(r.lines.revenue.extrapolated, SEASON, 1,
    "and the year holds at the season's own value — counted once");

  // THE GATE. A season mid-flight looks exactly like a pax shortfall: the books
  // are 271,247 under the model. I read precisely this as "the model is
  // carrying 25% too many students" and told Jake so. It must stay silent until
  // the deadline has passed.
  assert.equal(r.revenueCheck.seasonStillLanding, true);
  assert.ok(!r.warnings.some((w) => w.includes("pax or prices have moved")
                                 || w.includes("booked") && w.includes("less revenue")),
    `no shortfall may be claimed while a season is landing — got: ${r.warnings.join(" | ")}`);
  assert.ok(r.warnings.some((w) => w.includes("still in flight")),
    "it says what is actually happening instead");

  // Once September closes and the season really did come in short, the same
  // check must speak. Here the books complete at 1,150,000 against a model of
  // 1,357,051 — a genuine 207,051 shortfall, and now it IS a pax or price
  // problem because there is nothing left to land.
  const closed = { ...o };
  closed[KEYS[5]] = { revenue: 1_150_000 - BOOKED_AUG, programCost: 50_000, total: 60_000 };
  const after = surplusView({
    fiscalYearStartYear: 2026, actualsThroughMonth: KEYS[5],
    opexByMonth: closed, forecastMonths: fall,
    overheadsForward: Array(12).fill(62_000),
  });
  near(after.lines.revenue.extrapolated, 1_150_000, 1, "the year is what the books say");
  assert.equal(after.revenueCheck.seasonStillLanding, false, "nothing left in flight");
  assert.ok(after.warnings.some((w) => w.includes("less revenue than the model expected")),
    `once the deadline passes the shortfall must be named — got: ${after.warnings.join(" | ")}`);
  console.log("✓ a season straddling the month end is netted, not judged");
}

console.log("\nAll surplus tests passed.");

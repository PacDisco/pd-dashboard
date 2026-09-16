// test/cash-cost-curve.test.mjs
//
// Turning tagged spend into a cost curve, and refusing to when the data cannot
// support one.
//
// The invention being replaced: 25% the month before departure, 45% in the
// departure month. The real books show 316,915 of program cost already spent by
// August for a season departing 1 September.
//
// The trap on the way: FY26/27 alone runs April to August, which is ENTIRELY
// before that departure. A curve derived from it would be all ramp and no tail,
// confident and half-complete — replacing one invention with another. So the
// derivation reports its window and refuses to be adoptable without one.
//
// Run: node test/cash-cost-curve.test.mjs

import assert from "node:assert/strict";
import {
  parseSeasonOption, seasonAnchors, offsetFromAnchor,
  seasonObservations, deriveSeasonCurve, deriveAllSeasonCurves,
} from "../netlify/functions/_shared/cash-cost-curve.mjs";

const near = (a, b, tol, msg) =>
  assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b}`);

/* ---------- reading a season tag ---------- */

{
  assert.deepEqual(parseSeasonOption("Fall 26"), { season: "Fall", year: 2026, raw: "Fall 26" });
  assert.deepEqual(parseSeasonOption("FALL2026").year, 2026, "four digits work too");
  assert.deepEqual(parseSeasonOption("spring-27").season, "Spring", "case and punctuation");
  // Two digits mean this century. "Fall 26" is 2026, not 1926.
  assert.equal(parseSeasonOption("Fall 26").year, 2026);
  assert.equal(parseSeasonOption("Overheads"), null, "a non-season tag is not forced into one");
  assert.equal(parseSeasonOption(""), null);
  assert.equal(parseSeasonOption("Summer").year, null, "a season with no year is incomplete, not guessed");
  console.log("✓ season tags are parsed, and non-season tags are refused");
}

/* ---------- when a season actually departs ---------- */

{
  const programs = [
    // One large cohort and two small ones. The large one is when the season
    // departs, for cash purposes.
    { name: "NZA", season: "Fall", startDate: "2026-09-01", paxForecast: 40, price: 15_500 },
    { name: "PolyJ", season: "Fall", startDate: "2026-09-20", paxForecast: 5, price: 15_500 },
    { name: "SAS", season: "Spring", startDate: "2027-02-10", paxForecast: 20, price: 15_500 },
  ];
  const a = seasonAnchors(programs);

  assert.ok(a["Fall 2026"], "seasons are keyed by season and departure year");
  // Revenue-weighted: 40 pax on 1 Sept against 5 on the 20th pulls the anchor
  // close to the 1st, not to the midpoint.
  assert.ok(a["Fall 2026"].anchor >= "2026-09-01" && a["Fall 2026"].anchor <= "2026-09-05",
    `weighted toward the large cohort, got ${a["Fall 2026"].anchor}`);
  assert.equal(a["Fall 2026"].spreadDays, 19, "and the spread is published, not hidden");
  assert.equal(a["Spring 2027"].spreadDays, 0, "a single-program season has no spread");
  console.log("✓ a season's anchor is revenue-weighted, and its spread is reported");
}

/* ---------- offsets ---------- */

{
  assert.equal(offsetFromAnchor("2026-09-01", "2026-09"), 0, "the departure month is zero");
  assert.equal(offsetFromAnchor("2026-09-01", "2026-04"), -5, "April is five months before");
  assert.equal(offsetFromAnchor("2026-09-01", "2026-11"), 2, "November is two after");
  assert.equal(offsetFromAnchor("2026-09-01", "2027-01"), 4, "and it crosses the year end");
  console.log("✓ month offsets are signed from the departure month");
}

/* ---------- THE TRAP: a curve with no tail is not adoptable ---------- */

{
  // Exactly Pacific Discovery's FY26/27 shape: spend observed April to August
  // against a 1 September departure. Every offset negative.
  const rampOnly = deriveSeasonCurve([{
    programId: "Fall 2026", departure: "2026-09-01",
    byMonth: { "2026-04": 20_000, "2026-05": 30_000, "2026-06": 60_000,
               "2026-07": 90_000, "2026-08": 120_000 },
  }]);

  near(rampOnly.total, 320_000, 1, "the spend is all there");
  assert.equal(rampOnly.window.first, -5);
  assert.equal(rampOnly.window.last, -1, "nothing at or after departure");
  assert.equal(rampOnly.adoptable, false, "so it must NOT be adoptable");
  assert.ok(rampOnly.reasons.some((r) => /tail is missing/.test(r)),
    "and the reason says exactly why");
  console.log("✓ a season observed only before departure is refused, with the reason named");
}

/* ---------- a complete cycle derives a usable curve ---------- */

{
  const full = deriveSeasonCurve([{
    programId: "Fall 2025", departure: "2025-09-01",
    byMonth: {
      "2025-04": 20_000, "2025-05": 30_000, "2025-06": 50_000,
      "2025-07": 70_000, "2025-08": 80_000, "2025-09": 100_000,
      "2025-10": 40_000, "2025-11": 10_000,
    },
  }]);

  assert.equal(full.adoptable, true, "a full cycle is adoptable");
  assert.deepEqual(full.reasons, []);
  assert.equal(full.window.first, -5);
  assert.equal(full.window.last, 2, "and the tail is present");

  const shares = full.offsets.reduce((s, o) => s + o.share, 0);
  near(shares, 1, 0.001, "shares sum to one");

  // The point of the exercise, stated as a number: the model spends 25% the
  // month before departure and 45% in it. The measured shape here puts far more
  // out early — which is what moves the July trough.
  const beforeDeparture = full.offsets.filter((o) => o.monthOffset < 0)
    .reduce((s, o) => s + o.share, 0);
  assert.ok(beforeDeparture > 0.6,
    `most of the money goes out before departure, got ${Math.round(beforeDeparture * 100)}%`);
  console.log("✓ a complete cycle produces a curve summing to one, weighted pre-departure");
}

/* ---------- a tag nobody can place is reported, never folded in ---------- */

{
  const anchors = seasonAnchors([
    { name: "NZA", season: "Fall", startDate: "2026-09-01", paxForecast: 40, price: 15_500 },
  ]);
  const { observations, unmatchedOptions } = seasonObservations([
    { month: "2026-04", byCategory: { Season: { "Fall 26": 20_000, "Admin": 5_000, "Fall 24": 900 } } },
  ], anchors);

  assert.equal(observations.length, 1, "only the season that can be placed");
  near(observations[0].byMonth["2026-04"], 20_000, 1);
  // "Admin" is not a season; "Fall 24" is one, but there is no such program in
  // the model to anchor it to. Both are reported rather than being attached to
  // the nearest thing that looks similar.
  assert.equal(unmatchedOptions.Admin, 5_000);
  assert.equal(unmatchedOptions["Fall 24"], 900);
  console.log("✓ unplaceable tags are reported, not folded into a season they resemble");
}

/* ---------- two years of the same season are two observations of one rhythm ---------- */

{
  const programs = [
    { name: "NZA 25", season: "Fall", startDate: "2025-09-01", paxForecast: 30, price: 15_500 },
    { name: "NZA 26", season: "Fall", startDate: "2026-09-01", paxForecast: 40, price: 15_500 },
  ];
  const txMonths = [
    { month: "2025-07", byCategory: { Season: { "Fall 25": 70_000 } } },
    { month: "2025-09", byCategory: { Season: { "Fall 25": 100_000 } } },
    { month: "2025-10", byCategory: { Season: { "Fall 25": 30_000 } } },
    { month: "2026-07", byCategory: { Season: { "Fall 26": 90_000 } } },
    { month: "2026-08", byCategory: { Season: { "Fall 26": 110_000 } } },
  ];

  const result = deriveAllSeasonCurves({ txMonths, programs });
  const fall = result.seasons.Fall;

  assert.equal(fall.seasonYears, 2, "both years feed one Fall curve");
  assert.deepEqual(fall.observedYears.sort(), ["Fall 2025", "Fall 2026"]);
  // 2025 supplies the tail, so the combined window reaches past departure even
  // though 2026 alone would not. THIS is why the second year was pulled.
  assert.equal(fall.window.last, 1, "the prior year supplies the tail the current one lacks");
  assert.ok(fall.anchors.every((a) => a.departs), "each year keeps its own anchor");
  console.log("✓ a prior year supplies the tail the current year cannot");
}

/* ---------- nothing tagged at all ---------- */

{
  const result = deriveAllSeasonCurves({ txMonths: [], programs: [] });
  assert.deepEqual(result.seasons, {}, "no seasons, no curves");
  assert.deepEqual(result.unmatchedOptions, {});
  const empty = deriveSeasonCurve([]);
  assert.equal(empty.adoptable, false);
  assert.ok(empty.reasons.some((r) => /no tagged spend/.test(r)));
  console.log("✓ no tagged spend produces no curve and says so");
}

console.log("\nAll cost curve tests passed.");

/* ================================================================== *
 * THE SIMPLER ANSWER: a calendar profile
 *
 * Everything above needs each payment tied to a program, which needs a tracking
 * tag to have been filled in — a dependency nobody controls, which fails quietly
 * when the answer is "sometimes".
 *
 * A calendar profile needs only that the year repeats. That is an assumption
 * anyone can check, measured on 100% of program cost rather than the tagged
 * share. These tests pin the two things that make it honest: shares not dollars,
 * and a refusal to build a shape out of a part-year.
 * ================================================================== */

import { monthlyCostProfile } from "../netlify/functions/_shared/cash-cost-curve.mjs";

const fullYear = (fy, values) => {
  const out = {};
  ["04", "05", "06", "07", "08", "09", "10", "11", "12"].forEach((m, i) => { out[`${fy}-${m}`] = values[i]; });
  ["01", "02", "03"].forEach((m, i) => { out[`${fy + 1}-${m}`] = values[9 + i]; });
  return out;
};
// A plausible shape: spend builds toward the September departure, tails off.
const SHAPE = [60_000, 80_000, 120_000, 180_000, 240_000, 300_000, 120_000, 60_000, 40_000, 90_000, 140_000, 70_000];

{
  const p = monthlyCostProfile({ 2025: fullYear(2025, SHAPE) });
  near(p.shares.reduce((s, v) => s + v, 0), 1, 0.001, "shares sum to one");
  assert.equal(p.shares.length, 12);
  assert.equal(p.adoptable, true, "a complete year is usable");
  assert.deepEqual(p.yearsUsed, [2025]);
  // April is index 0 and September index 5, which is where the season departs.
  assert.ok(p.shares[5] > p.shares[0], "the shape follows the spend, not the calendar order");
  console.log("✓ a complete year gives twelve shares that sum to one");
}

{
  // THE REFUSAL THAT MATTERS. A part-year's shares describe only the months it
  // contains. Averaging one in would tilt the profile toward whichever months
  // happened to be observed — the same half-a-cycle trap as the season curve,
  // wearing different clothes.
  const p = monthlyCostProfile({ 2026: { "2026-04": 100_000, "2026-05": 200_000 } });
  assert.equal(p.adoptable, false, "two months cannot define a year");
  assert.equal(p.shares, null, "and no shape is offered at all");
  assert.ok(/no complete fiscal year/.test(p.reasons[0]));
  assert.equal(p.perYear[0].monthsWithData, 2, "but what WAS seen is still reported");
  console.log("✓ a part-year is refused, and says how much of the year it had");
}

{
  // A complete year and a partial one: only the complete one shapes the profile,
  // and the partial is still visible so nobody wonders where it went.
  const p = monthlyCostProfile({
    2025: fullYear(2025, SHAPE),
    2026: { "2026-04": 70_000, "2026-05": 90_000 },
  });
  assert.deepEqual(p.yearsUsed, [2025], "only the complete year defines the shape");
  assert.equal(p.perYear.length, 2, "both years are reported");
  assert.equal(p.perYear[1].complete, false);
  console.log("✓ a partial year is reported but never shapes the profile");
}

{
  // Two years that DISAGREE. The whole method rests on the calendar repeating,
  // so when it demonstrably does not, that has to surface rather than be
  // averaged into a confident-looking middle.
  const shifted = [...SHAPE];
  // Move the peak a month later. Same annual total, different rhythm — which is
  // exactly the situation the calendar assumption fails in, and exactly what a
  // season redesign would produce.
  shifted[5] = 30_000; shifted[6] = 390_000;
  const p = monthlyCostProfile({ 2025: fullYear(2025, SHAPE), 2026: fullYear(2026, shifted) });

  assert.ok(p.maxYearGapPct > 8, `the years disagree, got ${p.maxYearGapPct} points`);
  assert.equal(p.adoptable, false, "so the profile is not offered as settled");
  assert.ok(p.reasons.some((r) => /disagree/.test(r)), "and says the calendar assumption is not holding");
  console.log("✓ years that disagree are flagged rather than averaged into confidence");
}

{
  // Two years that AGREE are exactly the case this method is for.
  const p = monthlyCostProfile({ 2025: fullYear(2025, SHAPE), 2026: fullYear(2026, SHAPE.map((v) => v * 1.3)) });
  assert.equal(p.adoptable, true, "same shape at 30% more volume is still the same shape");
  assert.deepEqual(p.yearsUsed, [2025, 2026]);
  near(p.shares.reduce((s, v) => s + v, 0), 1, 0.001);
  // SHAPE FROM HISTORY, AMOUNT FROM THE MODEL: the totals differ by 30% and the
  // shares are identical. That is the property the whole approach depends on.
  near(p.perYear[1].total, p.perYear[0].total * 1.3, 2, "volume differs");
  assert.deepEqual(p.perYear[0].shares, p.perYear[1].shares, "and the shares do not");
  console.log("✓ volume changes do not move the shape — shares, never dollars");
}

{
  const none = monthlyCostProfile({});
  assert.equal(none.adoptable, false);
  assert.equal(none.shares, null);
  assert.ok(/no program cost/.test(none.reasons[0]));
  console.log("✓ no history produces no profile and says so");
}

console.log("\nAll calendar profile tests passed.");

/* ================================================================== *
 * BEFORE, DURING, AFTER
 *
 * Pacific Discovery's programs in a season END on the same day but START on
 * staggered dates. The engine anchors cost phasing to each program's start and
 * never reads endDate — so a program starting a month later gets its whole
 * shape slid a month later, including delivery costs that in reality have to
 * finish when the group goes home.
 *
 * Measuring the split is what says how much that matters.
 * ================================================================== */

import { seasonWindows, deliverySplit } from "../netlify/functions/_shared/cash-cost-curve.mjs";

const FALL = [
  { name: "NZA", season: "Fall", startDate: "2025-09-01", endDate: "2025-12-05" },
  // Starts a month later, finishes the same day — so it is a month shorter.
  { name: "PolyJ", season: "Fall", startDate: "2025-10-01", endDate: "2025-12-05" },
];

{
  const w = seasonWindows(FALL)["Fall 2025"];
  assert.equal(w.firstStart, "2025-09-01");
  assert.equal(w.lastStart, "2025-10-01");
  assert.equal(w.end, "2025-12-05", "the shared finish");
  // With a common end date, the stagger IS how much shorter the last program is.
  assert.equal(w.staggerDays, 30, "and the stagger is published");
  assert.equal(w.hasEnd, true);
  console.log("✓ a season's window carries both starts and the shared end");
}

{
  // A season with no end date on its programs cannot be split, and that must be
  // stated rather than papered over with an assumed duration.
  const w = seasonWindows([{ name: "X", season: "Summer", startDate: "2026-07-01" }])["Summer 2026"];
  assert.equal(w.hasEnd, false);

  const d = deliverySplit(
    [{ month: "2026-05", byCategory: { Season: { "Summer 26": 50_000 } } }],
    { "Summer 2026": w },
  );
  assert.equal(d.adoptable, false);
  near(d.taggedToUnknownSeason, 50_000, 1, "the money is reported, not silently dropped");
  assert.ok(d.reasons.some((r) => /no end date/.test(r)));
  console.log("✓ a season with no end date is refused, and its spend is still counted");
}

{
  const windows = seasonWindows(FALL);
  const d = deliverySplit([
    { month: "2025-06", byCategory: { Season: { "Fall 25": 100_000 } } },  // run-up
    { month: "2025-09", byCategory: { Season: { "Fall 25": 200_000 } } },  // delivery
    { month: "2025-11", byCategory: { Season: { "Fall 25": 150_000 } } },  // delivery
    { month: "2026-01", byCategory: { Season: { "Fall 25": 50_000 } } },   // after
  ], windows);

  assert.deepEqual(d.overall, { before: 0.2, during: 0.7, after: 0.1 });
  assert.equal(d.adoptable, true);
  const fall = d.seasonYears[0];
  assert.equal(fall.deliveryMonths, 2);
  assert.equal(fall.runUpMonths, 1);
  assert.equal(fall.staggerDays, 30, "carried through so the reader sees the compression");
  console.log("✓ spend splits into run-up, delivery and tail against the season's own window");
}

{
  // THE BOUNDARY. December is the month the season ends in (5 December), so
  // December is a DELIVERY month — the group is still away for part of it.
  // January begins after the end, so it is the tail.
  const windows = seasonWindows(FALL);
  const d = deliverySplit([
    { month: "2025-12", byCategory: { Season: { "Fall 25": 80_000 } } },
    { month: "2026-01", byCategory: { Season: { "Fall 25": 20_000 } } },
  ], windows);
  near(d.seasonYears[0].amounts.during, 80_000, 1, "the month the season ends in is delivery");
  near(d.seasonYears[0].amounts.after, 20_000, 1, "the month after is the tail");

  // And August, entirely before the first start, is run-up.
  const e = deliverySplit([
    { month: "2025-08", byCategory: { Season: { "Fall 25": 40_000 } } },
    { month: "2025-09", byCategory: { Season: { "Fall 25": 10_000 } } },
  ], windows);
  near(e.seasonYears[0].amounts.before, 40_000, 1, "a month that ends before the first start");
  near(e.seasonYears[0].amounts.during, 10_000, 1, "the first start's own month is delivery");
  console.log("✓ the month boundaries fall where the season actually runs");
}

{
  // A season seen only in its run-up cannot say what happens during delivery.
  // Same half-a-cycle refusal as everywhere else here.
  const windows = seasonWindows([
    { name: "NZA 26", season: "Fall", startDate: "2026-09-01", endDate: "2026-12-05" },
  ]);
  const d = deliverySplit([
    { month: "2026-04", byCategory: { Season: { "Fall 26": 60_000 } } },
    { month: "2026-08", byCategory: { Season: { "Fall 26": 200_000 } } },
  ], windows);
  assert.equal(d.seasonYears[0].complete, false, "run-up only");
  assert.equal(d.adoptable, false, "so no split is offered");
  assert.ok(d.reasons.some((r) => /through its delivery period/.test(r)));
  console.log("✓ a season observed only before it starts cannot define the split");
}

{
  // Bigger seasons count for more than small ones.
  const windows = seasonWindows([
    { name: "Big", season: "Fall", startDate: "2025-09-01", endDate: "2025-12-05" },
    { name: "Small", season: "Spring", startDate: "2026-02-01", endDate: "2026-05-05" },
  ]);
  const d = deliverySplit([
    // Fall: 900k, all during. Spring: 100k, all before.
    { month: "2025-10", byCategory: { Season: { "Fall 25": 900_000 } } },
    { month: "2025-12", byCategory: { Season: { "Spring 26": 100_000 } } },
  ], windows);
  assert.ok(d.overall.during > 0.85,
    `the large season dominates, got during ${d.overall.during}`);
  console.log("✓ the overall split is weighted by size, not a mean of seasons");
}

console.log("\nAll delivery split tests passed.");

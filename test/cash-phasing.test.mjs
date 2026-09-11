// test/cash-phasing.test.mjs
//
// The derived cost curve. The single most important behaviour here is that a
// curve built on incomplete data REFUSES to call itself adoptable — a derived
// number carries more authority than an invented one, so a half-observed season
// presented as measured truth is worse than the guess it replaces.
//
// Run: node test/cash-phasing.test.mjs

import assert from "node:assert/strict";
import {
  derivePhasing,
  comparePhasing,
  monthOffset,
} from "../netlify/functions/_shared/cash-phasing.mjs";

const near = (a, b, tol, msg) =>
  assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b}`);

/* ---------- offsets ---------- */

{
  assert.equal(monthOffset("2026-09-01", "2026-09"), 0, "the departure month is zero");
  assert.equal(monthOffset("2026-09-01", "2026-08"), -1, "the month before is -1");
  assert.equal(monthOffset("2026-09-01", "2026-04"), -5, "April is five months before September");
  assert.equal(monthOffset("2027-02-05", "2026-12"), -2, "and it crosses the year boundary");
  assert.equal(monthOffset("2026-09-01", "2026-11"), 2, "months after departure are positive");
  console.log("✓ month offsets, including across a year boundary");
}

/* ---------- a complete two-program sample ---------- */

{
  const obs = [
    { programId: "a", departure: "2026-09-01", totalCost: 100,
      byMonth: { "2026-07": 20, "2026-08": 30, "2026-09": 40, "2026-10": 10 } },
    { programId: "b", departure: "2027-02-05", totalCost: 100,
      byMonth: { "2026-12": 20, "2027-01": 30, "2027-02": 40, "2027-03": 10 } },
  ];
  const d = derivePhasing(obs);

  assert.deepEqual(d.offsets.map((o) => o.monthOffset), [-2, -1, 0, 1],
    "both programs line up on their own departure, not the calendar");
  near(d.offsets.find((o) => o.monthOffset === 0).share, 0.40, 1e-9, "departure month share");
  near(d.offsets.find((o) => o.monthOffset === -2).share, 0.20, 1e-9, "two months before");
  near(d.offsets.reduce((s, o) => s + o.share, 0), 1, 1e-9, "shares sum to one");
  assert.equal(d.adoptable, true, "two complete programs is enough to adopt");
  console.log("✓ programs are aligned on their own departure dates");
}

/* ---------- THE ONE THAT MATTERS: incomplete data refuses to be adopted ---------- */

{
  // Pacific Discovery's actual situation in September 2026: one season, five
  // months of spend, nothing after departure yet. The SHAPE is real and useful;
  // calling it a finished curve would be a lie.
  const obs = [
    { programId: "fall", departure: "2026-09-01", totalCost: 921_628,
      byMonth: {
        "2026-04": 35_917, "2026-05": 75_082, "2026-06": 38_464,
        "2026-07": 50_121, "2026-08": 117_330,
      } },
  ];
  const d = derivePhasing(obs);

  assert.equal(d.adoptable, false, "one partly-spent program must not be adopted");
  assert.ok(d.reasons.some((r) => r.includes("only 1 program")), "and it says why");
  assert.ok(d.reasons.some((r) => r.includes("34%")),
    `coverage should be reported as 34%, got: ${d.reasons.join(" | ")}`);
  assert.ok(d.reasons.some((r) => r.includes("before departure")),
    "and that nothing post-departure has been seen");

  // The shape it DID observe is still correct and still worth reading.
  assert.deepEqual(d.offsets.map((o) => o.monthOffset), [-5, -4, -3, -2, -1]);
  near(d.offsets.find((o) => o.monthOffset === -1).share, 117_330 / 316_914, 1e-6,
    "August is the biggest observed month");
  near(d.coverage, 316_914 / 921_628, 1e-6, "coverage is observed over expected");
  console.log("✓ an incomplete curve reports its shape but refuses to be adopted");
}

/* ---------- the comparison that makes the point ---------- */

{
  // The model's invented curve puts 25% before departure. The observed data puts
  // everything before departure, starting five months out instead of one. That
  // single comparison is the argument for doing any of this.
  const current = [
    { monthOffset: -1, share: 0.25 },
    { monthOffset: 0, share: 0.45 },
    { monthOffset: 1, share: 0.25 },
    { monthOffset: 2, share: 0.05 },
  ];
  const derived = derivePhasing([
    { programId: "fall", departure: "2026-09-01", totalCost: 921_628,
      byMonth: { "2026-04": 35_917, "2026-05": 75_082, "2026-06": 38_464,
                 "2026-07": 50_121, "2026-08": 117_330 } },
  ]).offsets;

  const c = comparePhasing(derived, current);
  near(c.currentShareBeforeDeparture, 0.25, 1e-9, "the invented curve front-loads a quarter");
  near(c.derivedShareBeforeDeparture, 1.0, 1e-9, "everything observed so far is pre-departure");
  assert.equal(c.currentEarliestMonth, -1, "the model starts spending one month out");
  assert.equal(c.derivedEarliestMonth, -5, "reality starts five months out");
  console.log("✓ the comparison shows the model starts spending four months too late");
}

/* ---------- degenerate input must not produce a confident curve ---------- */

{
  const empty = derivePhasing([]);
  assert.deepEqual(empty.offsets, [], "no observations, no curve");
  assert.equal(empty.adoptable, false);
  assert.equal(empty.totalObserved, 0);

  const zeros = derivePhasing([
    { programId: "z", departure: "2026-09-01", totalCost: 1000, byMonth: { "2026-08": 0 } },
  ]);
  assert.deepEqual(zeros.offsets, [], "a program with no spend contributes nothing");
  assert.equal(zeros.adoptable, false);

  const noExpected = derivePhasing([
    { programId: "n", departure: "2026-09-01", byMonth: { "2026-08": 500 } },
    { programId: "m", departure: "2026-09-01", byMonth: { "2026-08": 500 } },
  ]);
  assert.equal(noExpected.coverage, null);
  assert.equal(noExpected.adoptable, false, "unknown completeness is not adoptable");
  assert.ok(noExpected.reasons.some((r) => r.includes("completeness is unknown")));
  console.log("✓ empty, zero and unmeasurable inputs never claim to be adoptable");
}

console.log("\nAll phasing tests passed.");

// test/cash-overhead-source.test.mjs
//
// Where each month's overheads come from: the P&L for months that are closed,
// Xero's budget for the rest, the typed figure for anything neither covers.
//
// The behaviours worth pinning are the boundaries. A closed month must not fall
// through to the budget. A genuinely zero month must not be mistaken for a
// missing one. And every month must say which source it used, because a figure
// that quietly changed its own provenance is worse than one that is simply wrong.
//
// Run: node test/cash-overhead-source.test.mjs

import assert from "node:assert/strict";
import { resolveMonthlyOverheads } from "../netlify/functions/_shared/cash-store.mjs";

const near = (a, b, tol, msg) =>
  assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b}`);

const LABELS = ["Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec","Jan","Feb","Mar"];
const KEYS = ["2026-04","2026-05","2026-06","2026-07","2026-08","2026-09",
              "2026-10","2026-11","2026-12","2027-01","2027-02","2027-03"];

const model = (over = {}) => ({
  fiscalYearStartYear: 2026,
  monthlyOverheads: Array(12).fill(60_000),
  overheadSource: "auto",
  // Most of these tests are about WHICH SOURCE wins, not which figure within a
  // source, so they pin the basis and vary only what they are testing.
  overheadBasis: "cash",
  actualsThroughMonth: null,
  ...over,
});

// The real Apr–Aug cash opex, from Pacific Discovery's own P&L.
const REAL = [81_615, 54_130, 106_661, 63_036, 82_808];
// Total Operating Expenses as the P&L reports it, and the same figure with the
// non-cash lines stripped. June is the one that matters: its unrealised currency
// line was a GAIN, so the cash figure is HIGHER than the reported total.
const REPORTED = [94_093, 63_733, 72_856, 93_956, 82_369];
const opexByMonth = Object.fromEntries(
  REAL.map((cashTotal, i) => [KEYS[i], { month: KEYS[i], cashTotal, total: REPORTED[i] }]),
);
const budgetMonths = Array(12).fill(70_000);

/* ---------- the three sources in priority order ---------- */

{
  const r = resolveMonthlyOverheads(
    model({ actualsThroughMonth: "2026-08" }),
    { opexByMonth, budgetMonths },
  );

  for (let i = 0; i < 5; i++) {
    near(r.months[i], REAL[i], 0.01, `${LABELS[i]} takes the real P&L figure`);
    assert.equal(r.sources[i], "actual", `${LABELS[i]} is labelled actual`);
  }
  for (let i = 5; i < 12; i++) {
    near(r.months[i], 70_000, 0.01, `${LABELS[i]} takes the budget`);
    assert.equal(r.sources[i], "budget", `${LABELS[i]} is labelled budget`);
  }
  assert.deepEqual(r.counts, { actual: 5, budget: 7 });
  console.log("✓ closed months come from the P&L, the rest from the budget");
}

/* ---------- THE BOUNDARY: a closed month never falls through to the budget ---------- */

{
  // August is closed but has no stored P&L figure — a sync that has not caught
  // up. It must NOT quietly take the budget and look like a real actual.
  const partial = { ...opexByMonth };
  delete partial["2026-08"];

  const r = resolveMonthlyOverheads(
    model({ actualsThroughMonth: "2026-08" }),
    { opexByMonth: partial, budgetMonths },
  );
  assert.equal(r.sources[4], "budget", "with no actual it falls back rather than inventing one");
  assert.notEqual(r.sources[4], "actual", "and is never mislabelled as real");
  console.log("✓ a closed month with no P&L figure falls back, labelled honestly");
}

/* ---------- a genuine zero is not a missing figure ---------- */

{
  // A month that really did spend nothing must stay at zero, not fall through
  // to the budget — otherwise a quiet month silently becomes a forecast.
  const withZero = { ...opexByMonth, "2026-05": { month: "2026-05", cashTotal: 0 } };
  const r = resolveMonthlyOverheads(
    model({ actualsThroughMonth: "2026-08" }),
    { opexByMonth: withZero, budgetMonths },
  );
  near(r.months[1], 0, 0.01, "a real zero stays zero");
  assert.equal(r.sources[1], "actual", "and is still an actual");
  console.log("✓ a month that genuinely spent nothing is not treated as missing");
}

/* ---------- nothing from Xero at all ---------- */

{
  const r = resolveMonthlyOverheads(model(), {});
  assert.deepEqual(r.sources, Array(12).fill("typed"), "with no Xero data, everything is typed");
  near(r.months[0], 60_000, 0.01);
  console.log("✓ with no Xero data the typed figures are used");

  // A budget that only reaches December must not zero out January onward.
  const short = [...Array(9).fill(70_000), 0, 0, 0];
  const s = resolveMonthlyOverheads(model(), { budgetMonths: short });
  assert.deepEqual(s.sources.slice(9), ["typed", "typed", "typed"],
    "months the budget does not reach keep their typed figures");
  near(s.months[9], 60_000, 0.01, "rather than becoming zero");
  console.log("✓ a budget that stops early does not zero the rest of the year");
}

/* ---------- manual pins everything ---------- */

{
  const r = resolveMonthlyOverheads(
    model({ overheadSource: "manual", actualsThroughMonth: "2026-08" }),
    { opexByMonth, budgetMonths },
  );
  assert.deepEqual(r.sources, Array(12).fill("typed"), "manual overrides both Xero sources");
  near(r.months[0], 60_000, 0.01);
  console.log("✓ manual pins the typed figures even when Xero data exists");
}

/* ---------- nothing closed yet ---------- */

{
  const r = resolveMonthlyOverheads(model(), { opexByMonth, budgetMonths });
  assert.ok(r.sources.every((s) => s === "budget"),
    "with no close, even months that have P&L data use the budget");
  console.log("✓ actuals only apply to months actually closed off");
}

/* ---------- which P&L figure a closed month uses ---------- */

{
  // "total" is Total Operating Expenses exactly as reported — what ties to the
  // P&L. "cash" strips revaluations and unrealised currency movements.
  const asTotal = resolveMonthlyOverheads(
    model({ overheadBasis: "total", actualsThroughMonth: "2026-08" }),
    { opexByMonth, budgetMonths },
  );
  const asCash = resolveMonthlyOverheads(
    model({ overheadBasis: "cash", actualsThroughMonth: "2026-08" }),
    { opexByMonth, budgetMonths },
  );

  for (let i = 0; i < 5; i++) {
    near(asTotal.months[i], REPORTED[i], 0.01, `${LABELS[i]} reports the P&L line`);
    near(asCash.months[i], REAL[i], 0.01, `${LABELS[i]} reports the cash figure`);
  }
  console.log("✓ the basis decides which P&L figure a closed month uses");

  // June is the case that catches a parser which only ever subtracts: its
  // unrealised currency line was a gain, so cash opex is HIGHER than reported.
  assert.ok(asCash.months[2] > asTotal.months[2],
    "June cash opex exceeds reported opex, because the currency line was a gain");
  near(asCash.months[2] - asTotal.months[2], 33_805, 1, "by the June non-cash swing");
  console.log("✓ June's currency gain moves the two bases in the unintuitive direction");

  // Default is "total" — the P&L line, which is what ties to the accounts.
  const dflt = resolveMonthlyOverheads(
    { fiscalYearStartYear: 2026, monthlyOverheads: Array(12).fill(60_000),
      overheadSource: "auto", actualsThroughMonth: "2026-08" },
    { opexByMonth, budgetMonths },
  );
  near(dflt.months[0], REPORTED[0], 0.01, "with no basis set, the reported total is used");
  console.log("✓ the default basis is the P&L line as reported");

  // Forecast months are unaffected either way — the basis is a P&L concept.
  near(asTotal.months[8], 70_000, 0.01, "budget months ignore the basis");
  near(asCash.months[8], 70_000, 0.01);
  console.log("✓ the basis does not touch budget or typed months");
}

console.log("\nAll overhead basis tests passed.");

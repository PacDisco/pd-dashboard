// The table shows a whole fiscal year AND never less than twelve months ahead.
//
// THE BUG THIS PREVENTS
// ---------------------
// The forecast used to be exactly twelve fiscal months. In September that is
// seven months of visible runway; by February it is two. The months a business
// most needs to see fall off the right-hand edge precisely as they get close
// enough to matter.
//
// Extending the table is easy. What is NOT easy, and what these tests are
// actually for, is making sure the extension changes nothing else: a year total
// that quietly absorbed six months of the next year, or a liquidity warning
// sourced from months with no programs in them, would both be wrong in ways
// that look entirely plausible on screen.

import assert from "node:assert/strict";
import { buildForecast, horizonLength } from "../cash-forecast/engine.mjs";

const near = (a, b, tol, msg) => {
  // NaN vs NaN slipped through the original form of this helper: Math.abs(NaN)
  // <= tol is false, so it failed loudly here, but a fixture that produced NaN
  // in only SOME figures would have passed wherever both sides were NaN. Both
  // sides are checked for finiteness first.
  assert.ok(Number.isFinite(a) && Number.isFinite(b), `${msg}: not a number (${a} vs ${b})`);
  assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b}`);
};

const MODEL = {
  fiscalYearStartYear: 2026,
  baseCurrency: "NZD",
  settlementCurrency: "USD",
  fxRates: { NZD: 1, USD: 1.7 },
  baseMinimumBuffer: 0,
  openingBalances: { NZD: 500_000, USD: 0 },
  monthlyOverheads: Array.from({ length: 12 }, (_, i) => 10_000 + i * 1_000),
  monthlyCapital: Array(12).fill(1_000),
  monthlyTax: Array(12).fill(0),
  recognitionMonths: { Fall: 9, Spring: 1, Summer: 6 },
  paymentRulesByProgram: {},
  defaultPaymentRules: {
    // monthsBefore, NOT monthOffset — the booking and balance curves count
    // months back from departure. Getting this wrong makes addMonths receive
    // NaN, the slot lookup return null, and the money vanish without a warning,
    // which is how the first draft of this fixture "passed".
    bookingCurve: [{ monthsBefore: 6, share: 1 }],
    balanceCurve: [{ monthsBefore: 2, share: 1 }],
    // `deposit` is an AMOUNT in the program's currency, not a share. Spelled
    // depositShare it reads back undefined, Math.min(undefined, price) is NaN,
    // and every cash figure in the model becomes NaN — which compares equal to
    // itself under a naive tolerance check and passes silently.
    deposit: 2_500,
    balanceDueDaysBeforeDeparture: 90,
    nzdReceiptShare: 0,
    receiptsCurve: null,
  },
  costPhasing: { offsets: [{ monthOffset: -1, share: 0.4 }, { monthOffset: 0, share: 0.6 }] },
  // Field names matter here. The engine reads `currency`, `fixedCost` and
  // `variableCostPerPax`; a fixture spelling them priceCurrency / costPerPax
  // gets NaN from toBase, hits the "no FX rate" guard, and the program is
  // excluded from the forecast entirely — so every assertion below would have
  // been comparing one empty model against another and passing.
  programs: [{
    id: "p1", name: "Fall NZ", season: "Fall", active: true,
    startDate: "2026-10-01", endDate: "2026-12-05",
    paxForecast: 10, price: 10_000, currency: "USD",
    fixedCost: 20_000, variableCostPerPax: 3_000, costCurrency: "NZD",
  }],
};

/* ---- horizon length ---- */
{
  // April: the fiscal year already reaches twelve months out, so nothing extra.
  assert.equal(horizonLength(2026, new Date("2026-04-15T00:00:00Z")), 12,
    "in April the fiscal year IS the twelve months ahead");
  // September: Sep 26 + 11 = Aug 27, which is fiscal slot 16, so 17 months.
  assert.equal(horizonLength(2026, new Date("2026-09-15T00:00:00Z")), 17,
    "in September the table must reach August next year");
  // March, the worst case under the old behaviour: one month of visible runway
  // became twelve.
  assert.equal(horizonLength(2026, new Date("2027-03-15T00:00:00Z")), 23,
    "in March the table must reach February the year after");
  // Before the fiscal year starts, the year is still shown whole.
  assert.equal(horizonLength(2026, new Date("2026-01-15T00:00:00Z")), 12,
    "a fiscal year not yet started still shows all twelve of its months");
  console.log("✓ horizon is the longer of the fiscal year and twelve months out");
}

/* ---- the fiscal year is untouched by the extension ---- */
{
  const short = buildForecast(MODEL, {}, { today: new Date("2026-04-15T00:00:00Z") });
  const long = buildForecast(MODEL, {}, { today: new Date("2026-09-15T00:00:00Z") });

  assert.equal(short.months.length, 12);
  assert.equal(long.months.length, 17);

  // EVERY fiscal-year month must be identical. If extending the table changed
  // a single figure inside the year, the year's numbers would depend on when
  // you happened to look at them.
  for (let i = 0; i < 12; i++) {
    const a = short.months[i], b = long.months[i];
    assert.equal(a.key, b.key, `month ${i} key`);
    near(a.cashIn, b.cashIn, 0.01, `${a.label} cash in unchanged by the tail`);
    near(a.cashOut, b.cashOut, 0.01, `${a.label} cash out unchanged by the tail`);
    near(a.baseClosing, b.baseClosing, 0.01, `${a.label} NZD closing unchanged by the tail`);
    near(a.closing, b.closing, 0.01, `${a.label} total position unchanged by the tail`);
  }

  // And the year totals, which are what the tiles show.
  near(short.totals.cashIn, long.totals.cashIn, 0.01, "year cash in");
  near(short.totals.cashOut, long.totals.cashOut, 0.01, "year cash out");
  near(short.totals.closingBalance, long.totals.closingBalance, 0.01, "closing at 31 March");
  near(short.totals.lowestBaseClosing, long.totals.lowestBaseClosing, 0.01, "worst NZD position");
  assert.equal(short.totals.lowestBaseMonth, long.totals.lowestBaseMonth, "worst month");
  console.log("✓ the fiscal year is bit-for-bit unchanged by the runway months");
}

/* ---- what the tail contains ---- */
{
  const f = buildForecast(MODEL, {}, { today: new Date("2026-09-15T00:00:00Z") });
  const tail = f.months.slice(12);

  assert.equal(tail.length, 5, "Apr 27 to Aug 27");
  assert.equal(f.months[12].key, "2027-04");
  assert.equal(f.months[12].label, "Apr 27", "labels keep working past the year end");
  assert.ok(tail.every((m) => m.beyondFiscalYear), "every tail month is flagged");
  assert.ok(f.months.slice(0, 12).every((m) => !m.beyondFiscalYear), "no fiscal month is");

  // No programs entered for next year, so no student money and no program cost.
  for (const m of tail) {
    near(m.cashIn, 0, 0.01, `${m.label} has no student money`);
    near(m.programCostsOut, 0, 0.01, `${m.label} has no program cost`);
  }

  // But overheads DO continue, repeating the same fiscal month a year earlier.
  // Blank overheads would make the tail a flat line reading "nothing happens",
  // when the truth is "wages keep going out and next year is not entered yet".
  near(f.months[12].overheads, MODEL.monthlyOverheads[0], 0.01, "Apr 27 repeats Apr 26");
  near(f.months[16].overheads, MODEL.monthlyOverheads[4], 0.01, "Aug 27 repeats Aug 26");
  assert.ok(tail.every((m) => m.carriedForward), "and every one of them says it is a repeat");
  console.log("✓ the tail carries overheads forward and nothing else");
}

/* ---- warnings must not be sourced from the tail ---- */
{
  // Overheads big enough that the empty tail drains the account, while the
  // fiscal year itself stays comfortably positive. Under a naive extension the
  // worst-position warning would fire every month forever, pointing at the last
  // tail month — an alarm that measures only the absence of next year's
  // programs, which is exactly the kind that teaches people to ignore alarms.
  // 40k/month: the fiscal year never goes under (USD conversion holds it at
  // zero), and the five programless tail months then take it to -77,000.
  // Calibrated deliberately — at 60k the fiscal year drains too, and the test
  // would pass for the wrong reason.
  const drains = { ...MODEL, monthlyOverheads: Array(12).fill(40_000) };
  const f = buildForecast(drains, {}, { today: new Date("2026-09-15T00:00:00Z") });

  const last = f.months[f.months.length - 1];
  assert.ok(last.baseClosing < 0, "the tail does drain the account, as designed");

  assert.ok(!f.warnings.some((w) => w.includes(last.label)),
    `no warning may name a tail month — got: ${f.warnings.join(" | ")}`);
  assert.ok(f.totals.lowestBaseClosing >= 0,
    "the worst NZD position is taken from the fiscal year, not the tail");

  // The tail gets its own plainly-worded caveat instead.
  assert.ok(f.warnings.some((w) => w.includes("no programs entered")),
    "the tail is explained rather than alarmed about");
  console.log("✓ warnings and worst-position come from the fiscal year only");
}

/* ---- the horizon block the page draws from ---- */
{
  const f = buildForecast(MODEL, {}, { today: new Date("2026-09-15T00:00:00Z") });
  assert.deepEqual(
    { ...f.horizon },
    {
      length: 17,
      fiscalYearMonths: 12,
      beyondFiscalYear: 5,
      lastFiscalMonth: "2027-03",
      lastMonth: "2027-08",
      tailHasPrograms: false,
    },
    "the page must not have to re-derive the boundary and get a different answer",
  );

  // A model WITH next year's programs must report the tail as populated, or the
  // page would keep apologising for a tail that is genuinely forecast.
  const withNext = {
    ...MODEL,
    programs: [...MODEL.programs, {
      id: "p2", name: "Fall NZ 27", season: "Fall", active: true,
      startDate: "2027-10-01", endDate: "2027-12-05",
      paxForecast: 10, price: 10_000, currency: "USD",
      fixedCost: 20_000, variableCostPerPax: 3_000, costCurrency: "NZD",
    }],
  };
  const g = buildForecast(withNext, {}, { today: new Date("2026-09-15T00:00:00Z") });
  assert.equal(g.horizon.tailHasPrograms, true,
    "a program departing in the tail makes the tail a real forecast");
  assert.ok(!g.warnings.some((w) => w.includes("no programs entered")),
    "and the missing-programs caveat disappears");

  // That program's deposits land six months before departure — April 2027,
  // inside the tail. Under the old fiscal-only slot lookup they returned null
  // and were dropped silently, which is the failure that made an empty tail
  // look like a finding rather than a bug.
  assert.ok(g.months[12].cashIn > 0,
    "money belonging to a tail month must actually land there");
  console.log("✓ horizon block is accurate, and tail money is placed not dropped");
}

console.log("\nAll horizon tests passed.");

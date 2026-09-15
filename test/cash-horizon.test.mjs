// The table shows whole fiscal years AND never less than two years ahead.
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
import { buildForecast, horizonLength, MONTHS_AHEAD } from "../cash-forecast/engine.mjs";

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
  assert.equal(MONTHS_AHEAD, 24, "the horizon is two years of runway");

  // 1 April is the property worth protecting: with a round number of years the
  // table is EXACTLY two fiscal years, Apr-Mar and Apr-Mar, no remainder.
  assert.equal(horizonLength(2026, new Date("2026-04-15T00:00:00Z")), 24,
    "in April the table is exactly two fiscal years");
  // September: Sep 26 + 23 = Aug 28, fiscal slot 28, so 29 columns.
  assert.equal(horizonLength(2026, new Date("2026-09-15T00:00:00Z")), 29,
    "in September it must reach August two years out");
  // It grows by exactly one column a month, which is what makes the far edge
  // hold still while the near edge advances.
  for (const [a, b] of [["2026-09-15", "2026-10-15"], ["2027-01-15", "2027-02-15"]]) {
    assert.equal(
      horizonLength(2026, new Date(`${b}T00:00:00Z`)) -
      horizonLength(2026, new Date(`${a}T00:00:00Z`)),
      1, `one more column from ${a} to ${b}`);
  }
  assert.equal(horizonLength(2026, new Date("2027-03-15T00:00:00Z")), 35,
    "by March it has grown to 35, and rolls back to 24 when the year turns");
  // Before the fiscal year starts, the floor is whole YEARS, not a bare twelve.
  // A horizon of 24 that fell back to 12 here would shrink rather than grow.
  assert.equal(horizonLength(2026, new Date("2026-01-15T00:00:00Z")), 24,
    "a fiscal year not yet started still shows two whole years");
  console.log("✓ horizon is the longer of whole fiscal years and two years out");
}

/* ---- the fiscal year is untouched by the extension ---- */
{
  const short = buildForecast(MODEL, {}, { today: new Date("2026-04-15T00:00:00Z") });
  const long = buildForecast(MODEL, {}, { today: new Date("2026-09-15T00:00:00Z") });

  assert.equal(short.months.length, 24);
  assert.equal(long.months.length, 29);

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

  assert.equal(tail.length, 17, "Apr 27 to Aug 28");
  assert.equal(f.months[12].key, "2027-04");
  assert.equal(f.months[12].label, "Apr 27", "labels keep working past the year end");
  // Two years past the fiscal year end, so the month labels have to survive
  // more than one wrap. Slot 24 is April again, two calendar years on.
  assert.equal(f.months[24].key, "2028-04");
  assert.equal(f.months[24].label, "Apr 28", "and past the SECOND year end too");
  assert.equal(f.months[f.months.length - 1].key, "2028-08");
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
  // The repeat is by fiscal slot modulo twelve, so it keeps working in the
  // second tail year rather than running off the end of the array into zero.
  near(f.months[24].overheads, MODEL.monthlyOverheads[0], 0.01, "Apr 28 repeats Apr 26 again");
  assert.ok(tail.every((m) => Number.isFinite(m.overheads)),
    "no tail month falls off the end of the twelve entered figures");
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
  const hasProgramMoney = (m) => m.cashIn !== 0 || m.programCostsOut !== 0;
  const f = buildForecast(MODEL, {}, { today: new Date("2026-09-15T00:00:00Z") });
  assert.deepEqual(
    { ...f.horizon },
    {
      length: 29,
      fiscalYearMonths: 12,
      beyondFiscalYear: 17,
      lastFiscalMonth: "2027-03",
      lastMonth: "2028-08",
      tailHasPrograms: false,
      emptyFromKey: "2027-04",
      emptyFromLabel: "Apr 27",
      emptyMonths: 17,
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

  // THE CASE THAT ONLY EXISTS AT THIS LENGTH.
  //
  // FY27/28 is now entered, so "does the tail have programs" is true — but the
  // horizon runs to Aug 28 and nothing is entered past Mar 28. A single boolean
  // would have dropped the caveat from exactly the months that still need it.
  // The caveat must survive, and must name where the data actually stops.
  assert.ok(g.horizon.emptyFromLabel,
    "entering one more year must not silence the caveat for the year after");
  // That program departs Oct 2027 and its last cost lands in the departure
  // month, so the entered data stops at the end of October 2027 — not at the
  // fiscal year end, which is the intuitive-but-wrong answer. The horizon runs
  // ten months past it.
  assert.equal(g.horizon.emptyFromKey, "2027-11",
    "the data stops where the last program's money stops, not at a year end");
  assert.equal(g.horizon.emptyMonths, 10, "Nov 27 to Aug 28");
  assert.ok(g.warnings.some((w) => w.includes("Nov 27") && w.includes("no programs entered")),
    `the warning must name Nov 27 — got: ${g.warnings.join(" | ")}`);

  // A quiet month BETWEEN two seasons is a real forecast, not an absence, so
  // only the TRAILING run counts. May 27 sits between the two programs' booking
  // and balance months and has no program money at all; treating the first
  // empty month as the end of the data would have stopped there and written
  // off two years of entered forecast.
  assert.ok(!hasProgramMoney(g.months[13]), "May 27 is genuinely quiet");
  assert.notEqual(g.horizon.emptyFromKey, "2027-05",
    "a gap in the middle is not where the entered data stops");

  // That program's deposits land six months before departure — April 2027,
  // inside the tail. Under the old fiscal-only slot lookup they returned null
  // and were dropped silently, which is the failure that made an empty tail
  // look like a finding rather than a bug.
  assert.ok(g.months[12].cashIn > 0,
    "money belonging to a tail month must actually land there");
  console.log("✓ horizon block is accurate, and tail money is placed not dropped");
}

console.log("\nAll horizon tests passed.");

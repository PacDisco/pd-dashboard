import assert from "node:assert/strict";
import { buildForecast, recognitionMonthFor, fiscalSlotToDate, dateToFiscalSlot, } from "../cash-forecast/engine.mjs";
import { defaultAssumptions } from "../cash-forecast/model.mjs";
const near = (a, b, tol = 0.01, msg) => assert.ok(Math.abs(a - b) < tol, msg ?? `expected ${b}, got ${a}`);
/* ---------- fiscal calendar ---------- */
assert.deepEqual(fiscalSlotToDate(2026, 0), { year: 2026, month: 4 }, "slot 0 = Apr 2026");
assert.deepEqual(fiscalSlotToDate(2026, 8), { year: 2026, month: 12 }, "slot 8 = Dec 2026");
assert.deepEqual(fiscalSlotToDate(2026, 9), { year: 2027, month: 1 }, "slot 9 = Jan 2027");
assert.deepEqual(fiscalSlotToDate(2026, 11), { year: 2027, month: 3 }, "slot 11 = Mar 2027");
assert.equal(dateToFiscalSlot(2026, 2026, 4), 0);
assert.equal(dateToFiscalSlot(2026, 2027, 3), 11);
assert.equal(dateToFiscalSlot(2026, 2026, 3), null, "Mar 2026 is the prior fiscal year");
assert.equal(dateToFiscalSlot(2026, 2027, 4), null, "Apr 2027 is the next fiscal year");
console.log("✓ fiscal calendar");
/* ---------- recognition timing ---------- */
const rec = { Fall: 9, Spring: 1, Summer: 6 };
const prog = (over) => ({
    id: "p", name: "TEST", season: "Fall", startDate: "2026-10-05", endDate: "2026-12-10",
    price: 15500, currency: "NZD", costCurrency: "NZD",
    fixedCost: 100000, variableCostPerPax: 5000,
    paxForecast: 10, active: true, ...over,
});
assert.deepEqual(recognitionMonthFor(prog({ season: "Fall", startDate: "2026-10-05" }), rec), { year: 2026, month: 9 }, "Fall departing Oct 26 recognises Sept 26");
assert.deepEqual(recognitionMonthFor(prog({ season: "Fall", startDate: "2026-12-01" }), rec), { year: 2026, month: 9 }, "later Fall departure still recognises Sept 26");
assert.deepEqual(recognitionMonthFor(prog({ season: "Spring", startDate: "2027-02-10" }), rec), { year: 2027, month: 1 }, "Spring departing Feb 27 recognises Jan 27");
assert.deepEqual(recognitionMonthFor(prog({ season: "Summer", startDate: "2026-07-01" }), rec), { year: 2026, month: 6 }, "Summer departing Jul 26 recognises Jun 26");
// Edge: a program departing IN its own recognition month recognises THAT month.
//
// This assertion previously demanded the opposite — a look-back of twelve months
// — on the reasoning that recognition is "the month before the season starts".
// That reasoning is wrong at the boundary, and the test defended the bug: a Fall
// cohort departing in September had its revenue recognised in September of the
// PREVIOUS year, which put it outside the fiscal year altogether and dragged
// deferred revenue negative by the whole cohort's value to compensate.
assert.deepEqual(recognitionMonthFor(prog({ season: "Fall", startDate: "2026-09-15" }), rec), { year: 2026, month: 9 }, "departure in the recognition month recognises that month");
console.log("✓ recognition timing");
/* ---------- cash: deposits and balances ---------- */
function base() {
    const a = defaultAssumptions(2026);
    a.openingBalances = { NZD: 0, USD: 0 };
    a.baseMinimumBuffer = 0;
    a.defaultPaymentRules = {
        deposit: 1000,
        balanceDueDaysBeforeDeparture: 60,
        // Everyone books exactly 6 months out — makes the arithmetic checkable.
        bookingCurve: [{ monthsBefore: 6, share: 1 }],
    };
    // All program cost paid in the departure month.
    a.costPhasing = { offsets: [{ monthOffset: 0, share: 1 }] };
    return a;
}
{
    const a = base();
    // Set recognition explicitly rather than inheriting the default. The default
    // is Pacific Discovery's — Fall recognises in August, because their Fall
    // departs 1 September. This fixture departs in October, so September is its
    // month before. Pinning it here keeps the test about the MECHANICS of
    // recognition rather than about one organisation's calendar.
    a.recognitionMonths = { Fall: 9, Spring: 1, Summer: 6 };
    a.programs = [prog({
            id: "nza", name: "NZA", season: "Fall",
            startDate: "2026-10-01", endDate: "2026-12-01",
            price: 15500, paxForecast: 20, fixedCost: 142113, variableCostPerPax: 3557,
        })];
    const f = buildForecast(a);
    const by = (k) => f.months.find((m) => m.key === k);
    // Bookings 6 months before Oct 2026 = April 2026 → 20 × 1000 deposits.
    near(by("2026-04").depositsIn, 20_000, 0.01, "deposits land in the booking month");
    // Balance due 60 days before 1 Oct = 2 Aug 2026 → 20 × 14,500.
    near(by("2026-08").balancesIn, 290_000, 0.01, "balances land 60 days pre-departure");
    // Total cash in must equal pax × price exactly. Nothing leaks.
    near(f.totals.cashIn, 20 * 15500, 0.01, "cash in = pax × price");
    // Cost: 142,113 + 20 × 3,557 = 213,253, all in October.
    near(by("2026-10").programCostsOut, 213_253, 0.01, "program cost in the departure month");
    // Recognition: all of it in September, none of it spread.
    near(by("2026-09").recognisedRevenue, 310_000, 0.01, "recognised in Sept");
    near(f.totals.recognisedRevenue, 310_000, 0.01);
    assert.equal(f.months.filter((m) => m.recognisedRevenue > 0).length, 1, "recognition is a single event, not a spread");
    console.log("✓ deposit / balance / cost / recognition placement");
    // Deferred revenue: rises as cash arrives, drops to zero on recognition.
    near(by("2026-04").deferredRevenueBalance, 20_000, 0.01, "deferred after deposits");
    near(by("2026-08").deferredRevenueBalance, 310_000, 0.01, "deferred peaks pre-recognition");
    near(by("2026-09").deferredRevenueBalance, 0, 0.01, "deferred clears on recognition");
    near(by("2027-03").deferredRevenueBalance, 0, 0.01, "stays clear");
    console.log("✓ deferred revenue behaviour");
    // Roll-forward integrity: closing must chain, with no gaps.
    let running = a.openingBalances.NZD;
    for (const m of f.months) {
        assert.equal(m.opening, running, `${m.label} opening must equal prior closing`);
        running += m.net;
        near(m.closing, running, 0.01, `${m.label} closing`);
    }
    console.log("✓ balance chain has no breaks");
}
/* ---------- FX is a single source ---------- */
{
    const a = base();
    a.fxRates = { NZD: 1, USD: 1.65 };
    a.programs = [prog({
            id: "usd", name: "USDPROG", currency: "USD",
            price: 10_000, paxForecast: 10, fixedCost: 0, variableCostPerPax: 0,
            startDate: "2026-10-01",
        })];
    const f = buildForecast(a);
    near(f.totals.cashIn, 10 * 10_000 * 1.65, 0.01, "USD converted at the single stored rate");
    // A missing rate must exclude the program loudly, not silently treat it as 1:1.
    const b = base();
    b.fxRates = { NZD: 1 };
    b.programs = [prog({ id: "eur", name: "EURPROG", currency: "EUR", startDate: "2026-10-01" })];
    const g = buildForecast(b);
    near(g.totals.cashIn, 0, 0.01, "unknown currency contributes nothing");
    assert.ok(g.warnings.some((w) => w.includes("EUR")), "and says so");
    console.log("✓ FX single source + missing-rate guard");
}
/* ---------- cash collected before the year opens ---------- */
{
    const a = base();
    // Departs Apr 2026 — the first month of the year. Bookings 6 months out
    // (Oct 2025) and balance 60 days out (Feb 2026) both precede the year.
    a.programs = [prog({
            id: "early", name: "EARLY", season: "Summer",
            startDate: "2026-04-15", endDate: "2026-05-15",
            price: 10_000, paxForecast: 10, fixedCost: 0, variableCostPerPax: 0,
        })];
    const f = buildForecast(a);
    near(f.totals.cashIn, 0, 0.01, "no cash inside the year — it all arrived earlier");
    // Recognition (June 2025, prior year) also precedes the year, so the opening
    // deferred balance nets to zero rather than showing phantom liability.
    near(f.months[0].deferredRevenueBalance, 0, 0.01, "prior-year cash and recognition net off");
    console.log("✓ pre-fiscal-year collection handled");
}
/* ---------- normalisation and guards ---------- */
{
    const a = base();
    // Deliberately broken curve, like the workbook's Fall Mini at 101%.
    a.defaultPaymentRules.bookingCurve = [
        { monthsBefore: 6, share: 0.6 },
        { monthsBefore: 3, share: 0.41 },
    ];
    a.programs = [prog({
            id: "n", name: "NORM", price: 10_000, paxForecast: 10,
            fixedCost: 0, variableCostPerPax: 0, startDate: "2026-10-01",
        })];
    const f = buildForecast(a);
    near(f.totals.cashIn, 100_000, 0.01, "curve normalised — revenue still totals correctly");
    assert.ok(f.warnings.some((w) => w.includes("101")), "and the 101% is surfaced, not hidden");
    // Deposit larger than price must not manufacture cash.
    const b = base();
    b.defaultPaymentRules.deposit = 99_999;
    b.programs = [prog({
            id: "d", name: "DEP", price: 10_000, paxForecast: 10,
            fixedCost: 0, variableCostPerPax: 0, startDate: "2026-10-01",
        })];
    const g = buildForecast(b);
    near(g.totals.cashIn, 100_000, 0.01, "over-large deposit capped at price");
    assert.ok(g.warnings.some((w) => w.includes("deposit")), "and warned");
    console.log("✓ normalisation and guards");
}
/* ---------- negative cash is surfaced ---------- */
{
    const a = base();
    a.openingBalances = { NZD: -50_000, USD: 0 };
    a.monthlyOverheads = Array(12).fill(60_000);
    const f = buildForecast(a);
    assert.ok(f.warnings.some((w) => w.includes("negative")), "negative cash warned");
    assert.ok(f.totals.lowestClosing < 0);
    assert.equal(f.totals.lowestMonth, "Mar 27", "lowest point identified");
    console.log("✓ negative cash surfaced");
}
console.log("\nAll engine tests passed.");
/* ---------- price and cost currencies are independent ---------- */
{
    const a = base();
    a.fxRates = { NZD: 1, USD: 1.65 };
    // Pacific Discovery's real shape: sells in USD, pays suppliers in NZD.
    a.programs = [prog({
            id: "split", name: "SPLIT",
            currency: "USD", price: 15_500,
            costCurrency: "NZD", fixedCost: 142_113, variableCostPerPax: 3_557,
            paxForecast: 10, startDate: "2026-10-01",
        })];
    const f = buildForecast(a);
    near(f.totals.cashIn, 10 * 15_500 * 1.65, 0.01, "price converts at the USD rate");
    const c = f.programs[0];
    near(c.totalCost, 142_113 + 10 * 3_557, 0.01, "NZD costs are NOT multiplied by the USD rate");
    near(c.contribution, 10 * 15_500 * 1.65 - (142_113 + 10 * 3_557), 0.01, "margin uses both correctly");
    // The bug this guards against: one currency field applied to both would have
    // inflated costs by 65% and understated contribution by ~119k on this program.
    const wrongCost = (142_113 + 10 * 3_557) * 1.65;
    assert.ok(Math.abs(c.totalCost - wrongCost) > 100_000, "costs must not take the price's rate");
    console.log("✓ price and cost currencies convert independently");
}
console.log("\nAll engine tests passed (including split-currency).");
/* ---------- treasury: USD collected, converted only as NZD is needed ---------- */
{
    const a = base();
    a.baseCurrency = "NZD";
    a.settlementCurrency = "USD";
    a.fxRates = { NZD: 1, USD: 1.70 };
    a.openingBalances = { NZD: 100_000, USD: 0 };
    a.baseMinimumBuffer = 0;
    // 10 pax at USD 10,000, departing Oct. Costs NZD, all in the departure month.
    a.programs = [prog({
            id: "t", name: "TREASURY",
            currency: "USD", price: 10_000,
            costCurrency: "NZD", fixedCost: 0, variableCostPerPax: 0,
            paxForecast: 10, startDate: "2026-10-01",
        })];
    a.monthlyOverheads = Array(12).fill(20_000);
    const f = buildForecast(a);
    const by = (k) => f.months.find((m) => m.key === k);
    // Receipts are USD and must NOT appear in the NZD account.
    near(by("2026-04").fxIn, 10 * 1_000, 0.01, "deposits land in the USD account");
    near(by("2026-04").baseIn, 0, 0.01, "and not in the NZD account");
    near(by("2026-08").fxIn, 10 * 9_000, 0.01, "balances land in USD too");
    // April: NZD 100,000 opening less 20,000 overheads = 80,000, still above the
    // zero buffer, so nothing should be sold even though USD is sitting there.
    near(by("2026-04").fxConverted, 0, 0.01, "no conversion while NZD covers costs");
    near(by("2026-04").baseClosing, 80_000, 0.01);
    near(by("2026-04").fxClosing, 10_000, 0.01, "USD accumulates untouched");
    // NZD runs out during the year; conversions must appear exactly then.
    const firstConversion = f.months.find((m) => m.fxConverted > 0);
    assert.ok(firstConversion, "a conversion happens once NZD is exhausted");
    assert.equal(firstConversion.label, "Sep 26", "NZD lasts five months at 20k/mo from 100k");
    // Conversion must be sized to the shortfall, not the whole balance.
    near(firstConversion.baseClosing, 0, 0.01, "converts exactly enough to reach the buffer");
    near(firstConversion.baseFromConversion, firstConversion.fxConverted * 1.70, 0.01, "NZD received = USD sold × rate");
    assert.ok(firstConversion.fxClosing > 0, "and leaves the rest in USD");
    console.log("✓ conversion happens on demand and is sized to the shortfall");
    // Conservation: every USD received is either still held or was converted.
    const usdIn = f.months.reduce((s, m) => s + m.fxIn, 0);
    const usdConverted = f.months.reduce((s, m) => s + m.fxConverted, 0);
    near(usdIn - usdConverted, f.months[11].fxClosing, 0.01, "USD conserved across the year");
    console.log("✓ USD conserved");
    // The combined position must equal NZD cash plus USD marked at the rate.
    for (const m of f.months) {
        near(m.closing, m.baseClosing + m.fxClosing * 1.70, 0.01, `${m.label} combined position`);
    }
    console.log("✓ combined position is NZD cash + USD at the planning rate");
}
/* ---------- treasury: buffer is respected, shortfall is not hidden ---------- */
{
    const a = base();
    a.fxRates = { NZD: 1, USD: 1.70 };
    a.openingBalances = { NZD: 0, USD: 0 };
    a.baseMinimumBuffer = 50_000;
    a.monthlyOverheads = Array(12).fill(10_000);
    a.programs = [];
    const f = buildForecast(a);
    // No USD to sell, so the NZD account simply goes negative. It must NOT be
    // quietly floored at the buffer — that would be the workbook's plug problem
    // reinvented.
    near(f.months[0].baseClosing, -10_000, 0.01, "shortfall with no USD is left visible");
    near(f.months[0].fxConverted, 0, 0.01);
    assert.ok(f.warnings.some((w) => w.includes("negative")), "and is warned");
    console.log("✓ shortfall with nothing to convert stays visible");
}
/* ---------- treasury: buffer triggers conversion early ---------- */
{
    const a = base();
    a.fxRates = { NZD: 1, USD: 2.0 }; // round number keeps the arithmetic obvious
    a.openingBalances = { NZD: 60_000, USD: 100_000 };
    a.baseMinimumBuffer = 50_000;
    a.monthlyOverheads = [20_000, ...Array(11).fill(0)];
    a.programs = [];
    const f = buildForecast(a);
    const apr = f.months[0];
    // 60,000 − 20,000 = 40,000, which is 10,000 below the 50,000 buffer.
    // At 2.0, restoring it costs exactly 5,000 USD.
    near(apr.fxConverted, 5_000, 0.01, "converts exactly the buffer shortfall");
    near(apr.baseClosing, 50_000, 0.01, "buffer restored, not exceeded");
    near(apr.fxClosing, 95_000, 0.01, "rest of the USD left alone");
    console.log("✓ buffer sizing is exact");
}
console.log("\nAll treasury tests passed.");

/* ---------- actuals overlay: closed months replace forecast, and re-base it ---------- */

{
  const a = base();
  a.fxRates = { NZD: 1, USD: 2.0 };          // round rate keeps arithmetic checkable
  a.openingBalances = { NZD: 100_000, USD: 0 };
  a.baseMinimumBuffer = 0;
  a.monthlyOverheads = Array(12).fill(10_000);
  a.programs = [prog({
    id: "p1", name: "P1", currency: "USD", price: 10_000,
    costCurrency: "NZD", fixedCost: 0, variableCostPerPax: 0,
    paxForecast: 10, startDate: "2026-10-01",
  })];

  const pure = buildForecast(a);

  // April actually went differently: more cash in, and the bank ended somewhere
  // the forecast never predicted.
  const actuals = {
    "2026-04": {
      source: "Xero Bank Summary",
      byCurrency: {
        NZD: { received: 5_000, spent: 25_000, closing: 80_000 },
        USD: { received: 40_000, spent: 0, closing: 40_000 },
      },
    },
  };

  // Not locked yet → actuals must be ignored entirely.
  const unlocked = buildForecast(a, actuals);
  near(unlocked.months[0].baseClosing, pure.months[0].baseClosing, 0.01,
    "actuals must not apply until the month is locked");
  assert.equal(unlocked.months[0].isActual, false);
  assert.equal(unlocked.totals.actualMonths, 0);
  console.log("✓ actuals ignored until locked");

  a.actualsThroughMonth = "2026-04";
  const f = buildForecast(a, actuals);
  const apr = f.months[0], may = f.months[1];

  assert.equal(apr.isActual, true, "April is actual");
  assert.equal(may.isActual, false, "May is still forecast");
  assert.equal(f.totals.actualMonths, 1);

  near(apr.baseIn, 5_000, 0.01, "NZD received comes from Xero");
  near(apr.fxIn, 40_000, 0.01, "USD received comes from Xero");
  near(apr.baseOut, 25_000, 0.01, "NZD spent comes from Xero");
  near(apr.cashIn, 5_000 + 40_000 * 2.0, 0.01, "headline cash in is base-stated");
  near(apr.baseClosing, 80_000, 0.01, "closing is the real bank balance");
  near(apr.fxClosing, 40_000, 0.01);
  near(apr.closing, 80_000 + 40_000 * 2.0, 0.01, "combined position uses real balances");
  console.log("✓ closed month shows Xero figures, not forecast");

  // The conversion split is NOT derivable from a bank summary, so it must be
  // null rather than a plausible-looking number.
  assert.equal(apr.fxConverted, null, "conversion is unknowable from a bank summary");
  assert.equal(apr.baseFromConversion, null);
  console.log("✓ underivable rows are null, not invented");

  // THE POINT: May must start from April's ACTUAL closing, not the forecast one.
  near(may.baseOpening, 80_000, 0.01, "May re-bases onto the actual NZD closing");
  near(may.fxOpening, 40_000, 0.01, "and the actual USD closing");
  assert.ok(Math.abs(pure.months[1].baseOpening - 80_000) > 1,
    "test is meaningful: the pure forecast opened somewhere else");
  console.log("✓ forecast re-bases onto reality after a closed month");

  // Everything downstream shifts by the same amount the actual differed by.
  const delta = f.months[11].closing - pure.months[11].closing;
  assert.ok(Math.abs(delta) > 1, "the whole tail moves when reality differs");
  console.log("✓ the re-base carries through to March");
}

/* ---------- locking a month with no stored actuals must not fail silently ---------- */

{
  const a = base();
  a.programs = [];
  a.actualsThroughMonth = "2026-05";
  const f = buildForecast(a, { "2026-04": { byCurrency: { NZD: { received: 0, spent: 0, closing: 1 } } } });

  assert.equal(f.months[0].isActual, true, "April has figures");
  assert.equal(f.months[1].isActual, false, "May has none");
  assert.ok(f.warnings.some((w) => w.includes("May 26") && w.includes("no Xero figures")),
    "a locked month with no data must be called out");
  console.log("✓ locked-but-missing months are warned, not silently forecast");
}

/* ---------- a month that has not finished must not pass as closed ---------- */

{
  // Xero will happily report the first eight days of September. If that lands
  // in a closed month the total is understated and, worse, every later month
  // re-bases onto a balance that is three weeks stale.
  const a = base();
  a.programs = [];
  a.actualsThroughMonth = "2026-04";
  const f = buildForecast(a, {
    "2026-04": { partial: true, byCurrency: { NZD: { received: 5_000, spent: 1_000, closing: 4_000 } } },
  });

  assert.ok(f.warnings.some((w) => w.includes("Apr 26") && w.includes("has not finished")),
    "a part-month locked as actual must be called out");
  console.log("✓ a part-month locked as actual is warned about");

  // The same figures without the flag must NOT trip the warning, or the check
  // is just noise on every closed month.
  const clean = buildForecast(a, {
    "2026-04": { byCurrency: { NZD: { received: 5_000, spent: 1_000, closing: 4_000 } } },
  });
  assert.ok(!clean.warnings.some((w) => w.includes("has not finished")),
    "a finished month must not be warned about");
  console.log("✓ finished months are not warned about");
}

/* ---------- a closed month with no closing balance falls back to movement ---------- */

{
  const a = base();
  a.programs = [];
  a.openingBalances = { NZD: 10_000, USD: 0 };
  a.monthlyOverheads = Array(12).fill(0);
  a.actualsThroughMonth = "2026-04";
  const f = buildForecast(a, {
    "2026-04": { byCurrency: { NZD: { received: 3_000, spent: 1_000 } } },  // no closing
  });
  near(f.months[0].baseClosing, 12_000, 0.01,
    "without a closing balance, opening + received − spent is used");
  console.log("✓ missing closing balance degrades sensibly");
}

/* ---------- receipts split by season, so actuals have something to meet ---------- */

{
  // The actuals side can only ever report a season total: one part-paid invoice
  // per student means no payment says whether it was the deposit or the balance.
  // So the forecast must offer the same shape, and it must reconcile exactly —
  // a season breakdown that does not add back to cash in is worse than none.
  const a = base();
  const f = buildForecast(a);

  for (const m of f.months) {
    const summed = Object.values(m.receiptsBySeason).reduce((s, v) => s + v, 0);
    near(summed, m.cashIn, 0.01, `${m.label}: season receipts reconcile to cash in`);
  }
  console.log("✓ every month's season split adds back to cash in");

  const yearSum = Object.values(f.totals.receiptsBySeason).reduce((s, v) => s + v, 0);
  near(yearSum, f.totals.cashIn, 0.01, "year totals reconcile");
  console.log("✓ the year's season totals reconcile to total cash in");

  // Deposits and balances are accumulated in two separate places in the engine.
  // A season present in one and missing from the other would leave the month
  // total correct and the split wrong, which is why this is checked by season
  // rather than only in aggregate.
  const seasons = new Set(a.programs.filter((p) => p.active).map((p) => p.season));
  for (const season of seasons) {
    assert.ok(f.totals.receiptsBySeason[season] > 0,
      `${season} must contribute receipts somewhere in the year`);
  }
  console.log("✓ every active season appears in the split");

  // A program with no pax must not invent a season bucket.
  const b = base();
  b.programs = b.programs.map((p) => ({ ...p, paxForecast: p.season === "Summer" ? 0 : p.paxForecast }));
  const g = buildForecast(b);
  assert.equal(g.totals.receiptsBySeason.Summer, undefined,
    "a season with no pax contributes no bucket, rather than a zero row");
  console.log("✓ an empty season does not create a phantom row");
}

/* ---------- a program departing in its own recognition month ---------- */

{
  // The bug this catches cost a full year of Fall revenue. Searching back from
  // the month BEFORE departure means a Fall program departing 1 September skips
  // September 2026 and matches September 2025 — the revenue leaves the fiscal
  // year entirely, and deferred revenue goes negative by the same amount to
  // balance. The table looks plausible; only the deferred row gives it away.
  const oct = recognitionMonthFor({ season: "Fall", startDate: "2026-10-01" }, { Fall: 9 });
  assert.deepEqual(oct, { year: 2026, month: 9 }, "the normal case is unchanged");

  const sep = recognitionMonthFor({ season: "Fall", startDate: "2026-09-01" }, { Fall: 9 });
  assert.deepEqual(sep, { year: 2026, month: 9 },
    "departing in the recognition month recognises that month, not a year earlier");

  const midSep = recognitionMonthFor({ season: "Fall", startDate: "2026-09-15" }, { Fall: 9 });
  assert.deepEqual(midSep, { year: 2026, month: 9 }, "the day of the month is irrelevant");

  const dec = recognitionMonthFor({ season: "Fall", startDate: "2026-12-10" }, { Fall: 9 });
  assert.deepEqual(dec, { year: 2026, month: 9 }, "a later departure still recognises in September");
  console.log("✓ departing in the recognition month no longer jumps back a year");

  // End to end: the revenue must actually land in the year, and deferred must
  // not be dragged negative to compensate.
  const a = base();
  a.programs = [prog({
    id: "sep-fall", name: "September Fall", season: "Fall",
    startDate: "2026-09-01", endDate: "2026-11-15",
    price: 15_500, paxForecast: 20, fixedCost: 0, variableCostPerPax: 0,
  })];
  const f = buildForecast(a);

  assert.ok(f.totals.recognisedRevenue > 0, "Fall revenue is recognised inside the year");
  // With Pacific Discovery's real constant (Fall = August) a 1 September
  // departure recognises in August — the month before, which is what the rule
  // has always meant. Slot 4 is August; slot 0 is April.
  assert.equal(f.months[4].recognisedRevenue, f.totals.recognisedRevenue,
    "and it lands in August, the month before departure");
  assert.equal(f.months[5].recognisedRevenue, 0, "not September");

  // A positive opening is legitimate — deposits collected before 1 April for a
  // September departure. A NEGATIVE one is the signature of the bug: revenue
  // recognised in a prior year with none of its cash there to offset.
  assert.ok(f.totals.deferredOpening >= 0,
    `deferred opening must not be negative, got ${f.totals.deferredOpening}`);
  assert.ok(f.months.every((m) => m.deferredRevenueBalance > -1),
    "deferred revenue never goes negative for an in-year cohort");
  near(f.months[11].deferredRevenueBalance, 0, 0.01,
    "and it clears to zero once the cohort has recognised");
  console.log("✓ a September-departing Fall cohort recognises inside the year");
}

/* ---------- revenue leaving the year must be said out loud ---------- */

{
  // Legitimate for an genuinely earlier cohort, an error otherwise. Either way
  // it must not have to be inferred from a negative deferred balance.
  const a = base();
  a.programs = [prog({
    id: "old-fall", name: "Last year's Fall", season: "Fall",
    startDate: "2025-10-01", endDate: "2025-12-01",
    price: 15_500, paxForecast: 10, fixedCost: 0, variableCostPerPax: 0,
  })];
  const f = buildForecast(a);
  assert.ok(f.warnings.some((w) => w.includes("before this fiscal year")),
    "revenue recognised outside the year is warned about");
  console.log("✓ revenue recognised outside the year is warned about");
}

/* ---------- gross bank movements double-count a conversion ---------- */

{
  // A USD->NZD conversion appears twice in a bank summary: once as USD spent,
  // once as NZD received. Cash in and cash out are therefore GROSS and both
  // overstated. The balances and net movement are not, because the same amount
  // inflates both sides. This test pins that behaviour so nobody "fixes" the
  // net figure by mistake, and asserts it is stated rather than left to be
  // discovered by someone reconciling a month by hand.
  const a = base();
  a.programs = [];
  a.actualsThroughMonth = "2026-04";
  a.fxRates = { NZD: 1, USD: 1.7130 };
  a.planningRateSource = "manual";

  // The only real event: a student pays USD 22,575, all of it converted to NZD.
  const f = buildForecast(a, {
    "2026-04": {
      byCurrency: {
        USD: { received: 22_575, spent: 22_575, closing: 0 },
        NZD: { received: 38_671, spent: 0, closing: 38_671 },
      },
    },
  });
  const m = f.months[0];

  near(m.cashIn, 77_342, 1, "cash in counts the receipt AND the conversion landing");
  near(m.net, 38_671, 1, "net movement is right — the double count cancels");
  near(m.baseClosing, 38_671, 1, "and the balance is the bank's own figure");
  assert.equal(m.grossIncludesTransfers, true, "the month is flagged");
  assert.ok(f.warnings.some((w) => w.includes("gross bank movements") && w.includes("Apr 26")),
    "and it is said out loud, not left to be discovered by hand");
  console.log("✓ conversions inflate gross cash in/out, and that is stated");

  // A month with no conversion must not be flagged, or the warning is noise.
  const clean = buildForecast(a, {
    "2026-04": { byCurrency: { NZD: { received: 10_000, spent: 2_000, closing: 8_000 } } },
  });
  assert.equal(clean.months[0].grossIncludesTransfers, false);
  assert.ok(!clean.warnings.some((w) => w.includes("gross bank movements")));
  console.log("✓ a month without conversions is not flagged");
}

/* ---------- deferred revenue never eats gross bank movements ---------- */

{
  // On real data this row reached 2,951,924 by August, because a closed month
  // fed it GROSS bank receipts — which include this company moving its own money
  // from the USD account to the NZD account. The double count compounded every
  // month. Deferred is an accounting balance; a bank summary cannot produce one.
  const a = base();
  a.programs = [];
  a.actualsThroughMonth = "2026-04";
  a.fxRates = { NZD: 1, USD: 1.7135 };
  a.planningRateSource = "manual";

  const withTransfer = buildForecast(a, {
    "2026-04": {
      byCurrency: {
        USD: { received: 103_890, spent: 103_890, closing: 0 },
        NZD: { received: 178_016, spent: 0, closing: 178_016 },
      },
    },
  });
  const withoutTransfer = buildForecast(a, {
    "2026-04": { byCurrency: { NZD: { received: 0, spent: 0, closing: 0 } } },
  });

  assert.equal(
    withTransfer.months[0].deferredRevenueBalance,
    withoutTransfer.months[0].deferredRevenueBalance,
    "a month full of bank transfers must not move deferred revenue at all",
  );
  near(withTransfer.months[0].deferredRevenueBalance, 0, 0.01,
    "with no programs there is nothing to defer, whatever the bank did");
  console.log("✓ deferred revenue ignores gross bank movements in a closed month");

  // And it still tracks the forecast receipts it is supposed to track.
  const b = base();
  b.programs = [prog({
    id: "f", name: "F", season: "Fall", startDate: "2026-10-01", endDate: "2026-12-01",
    price: 15_500, paxForecast: 10, fixedCost: 0, variableCostPerPax: 0,
  })];
  b.recognitionMonths = { Fall: 9, Spring: 1, Summer: 6 };
  const f = buildForecast(b);
  near(f.months[0].deferredRevenueBalance, f.months[0].cashIn, 0.01,
    "in a forecast month it still follows the receipts");
  console.log("✓ and still follows forecast receipts when nothing is closed");
}

/* ---------- balance payments spread across months ---------- */

{
  // The point of the change: money arrives every month, not in two lumps a year.
  // The annual total must not move by a cent — only the timing.
  const single = base();
  single.programs = [prog({
    id: "f", name: "F", season: "Fall", startDate: "2026-10-01", endDate: "2026-12-01",
    price: 15_500, paxForecast: 20, fixedCost: 0, variableCostPerPax: 0,
  })];
  single.recognitionMonths = { Fall: 9, Spring: 1, Summer: 6 };

  const spread = JSON.parse(JSON.stringify(single));
  spread.defaultPaymentRules.balanceCurve = [
    { monthsBefore: 6, share: 0.03 }, { monthsBefore: 5, share: 0.04 },
    { monthsBefore: 4, share: 0.06 }, { monthsBefore: 3, share: 0.10 },
    { monthsBefore: 2, share: 0.30 }, { monthsBefore: 1, share: 0.37 },
    { monthsBefore: 0, share: 0.10 },
  ];

  const a = buildForecast(single);
  const b = buildForecast(spread);

  // No balanceCurve => exactly the old single-lump behaviour. A saved model that
  // predates this must not silently change.
  const lumpMonths = a.months.filter((m) => m.balancesIn > 0.5);
  assert.equal(lumpMonths.length, 1, "without a curve the balance is still one lump");
  assert.equal(lumpMonths[0].label, "Aug 26", "on the due date, 60 days before 1 Oct");
  console.log("✓ no balance curve means the old behaviour, unchanged");

  const spreadMonths = b.months.filter((m) => m.balancesIn > 0.5);
  assert.ok(spreadMonths.length >= 5, `the balance now lands across months, got ${spreadMonths.length}`);
  console.log(`✓ with a curve the balance lands across ${spreadMonths.length} months`);

  // THE INVARIANT: spreading moves money between months and never creates or
  // destroys any. If this drifts, the forecast is inventing revenue.
  near(b.totals.cashIn, a.totals.cashIn, 0.01, "total cash in is identical");
  near(b.totals.cashIn, 20 * 15_500, 0.01, "and still equals pax x price exactly");
  console.log("✓ spreading changes the timing and not one cent of the total");

  // The bulk really is inside 60 days — offsets 2, 1 and 0 around a 1 Oct
  // departure are August, September and October.
  const byLabel = (l) => b.months.find((m) => m.label === l).balancesIn;
  const near60 = byLabel("Aug 26") + byLabel("Sep 26") + byLabel("Oct 26");
  const allBalances = b.months.reduce((s, m) => s + m.balancesIn, 0);
  assert.ok(near60 / allBalances > 0.7,
    `the bulk must land within 60 days, got ${Math.round((near60 / allBalances) * 100)}%`);
  console.log("✓ the bulk lands within 60 days of departure");

  // Season receipts must still reconcile after the change.
  for (const m of b.months) {
    const summed = Object.values(m.receiptsBySeason).reduce((s, v) => s + v, 0);
    near(summed, m.cashIn, 0.01, `${m.label}: season split still reconciles`);
  }
  console.log("✓ the season split still reconciles month by month");
}

/* ---------- a curve reaching back before the year opens ---------- */

{
  // Early instalments for a program departing in April fall before 1 April, and
  // belong in the opening deferred balance rather than vanishing.
  const a = base();
  a.programs = [prog({
    id: "e", name: "Early", season: "Summer", startDate: "2026-06-01", endDate: "2026-07-01",
    price: 10_000, paxForecast: 10, fixedCost: 0, variableCostPerPax: 0,
  })];
  a.defaultPaymentRules.balanceCurve = [
    { monthsBefore: 6, share: 0.5 },  // December 2025 — before the year
    { monthsBefore: 1, share: 0.5 },  // May 2026 — inside it
  ];
  const f = buildForecast(a);

  assert.ok(f.totals.deferredOpening > 0,
    "cash collected before 1 April lands in the opening deferred balance");
  const inYear = f.months.reduce((s, m) => s + m.balancesIn, 0);
  assert.ok(inYear > 0 && inYear < 10 * 9_000,
    "only the in-year half of the balance shows in the table");
  console.log("✓ instalments before the year opens are not lost");
}

/* ---------- receipts split between USD and NZD ---------- */

{
  // Funds arrive in USD except for students who pay NZD directly. The NZD
  // portion lands in the base account already converted and never passes through
  // treasury — which cuts both the conversion volume and the rate exposure.
  const mk = (share) => {
    const a = base();
    a.baseMinimumBuffer = 0;
    a.openingBalances = { NZD: 0, USD: 0 };
    a.fxRates = { NZD: 1, USD: 1.7135 };
    a.planningRateSource = "manual";
    a.recognitionMonths = { Fall: 9, Spring: 1, Summer: 6 };
    a.defaultPaymentRules.nzdReceiptShare = share;
    // Real costs, so the NZD account actually goes short and the treasury block
    // has something to do. With no costs nothing ever converts and the test
    // would pass for the wrong reason.
    a.programs = [prog({
      id: "f", name: "F", season: "Fall", currency: "USD",
      startDate: "2026-10-01", endDate: "2026-12-01",
      price: 15_000, paxForecast: 20, fixedCost: 200_000, variableCostPerPax: 0,
    })];
    return buildForecast(a);
  };

  const allUsd = mk(0);
  const quarter = mk(0.25);
  const allNzd = mk(1);

  // THE INVARIANT: the headline rows are base-stated, and a student paying NZD
  // pays the NZD equivalent of the same price. So the top of the table must not
  // move by a cent, whatever the split.
  near(quarter.totals.cashIn, allUsd.totals.cashIn, 0.01, "cash in is unchanged at 25%");
  near(allNzd.totals.cashIn, allUsd.totals.cashIn, 0.01, "and unchanged at 100%");
  near(allUsd.totals.cashIn, 20 * 15_000 * 1.7135, 0.01, "and still pax x price x rate");
  console.log("✓ the currency split never moves the NZD-equivalent totals");

  // What DOES move: how much has to be converted.
  const usdIn = (f) => f.months.reduce((s, m) => s + m.fxIn, 0);
  near(usdIn(allUsd), 20 * 15_000, 0.01, "everything arrives as USD at 0%");
  near(usdIn(quarter), 20 * 15_000 * 0.75, 0.01, "three quarters at 25%");
  near(usdIn(allNzd), 0, 0.01, "nothing at 100%");
  assert.ok(allUsd.totals.fxConverted > 0,
    "the fixture must actually trigger conversion, or this proves nothing");
  assert.ok(allNzd.totals.fxConverted < allUsd.totals.fxConverted,
    `more NZD receipts means less conversion: ${Math.round(allNzd.totals.fxConverted)} vs ${Math.round(allUsd.totals.fxConverted)}`);
  near(allNzd.totals.fxConverted, 0, 0.01,
    "with every receipt in NZD there is nothing left to convert");
  console.log("✓ a higher NZD share means less USD to convert");

  // And the year ends in the same place, because the money is the same money.
  near(allNzd.totals.closingBalance, allUsd.totals.closingBalance, 1,
    "the closing position is the same either way at a fixed rate");
  console.log("✓ the closing position is unchanged at a fixed planning rate");

  // DECIDED: an NZD payment is the USD price converted at the day's rate, so it
  // carries the same rate risk. The share is an operational saving, not a hedge,
  // and the sensitivity MUST be unchanged by it. Pinned here because the obvious
  // "improvement" is to make exposure fall with the share — which would be wrong
  // unless PD starts quoting a fixed NZD price.
  const closeAt = (share, rate) => {
    const a = base();
    a.baseMinimumBuffer = 0;
    a.openingBalances = { NZD: 0, USD: 0 };
    a.fxRates = { NZD: 1, USD: rate };
    a.planningRateSource = "manual";
    a.recognitionMonths = { Fall: 9, Spring: 1, Summer: 6 };
    a.defaultPaymentRules.nzdReceiptShare = share;
    a.programs = [prog({
      id: "f", name: "F", season: "Fall", currency: "USD",
      startDate: "2026-10-01", endDate: "2026-12-01",
      price: 15_000, paxForecast: 20, fixedCost: 200_000, variableCostPerPax: 0,
    })];
    return buildForecast(a).totals.closingBalance;
  };
  const spreadAt = (share) => closeAt(share, 1.77) - closeAt(share, 1.67);
  near(spreadAt(0.5), spreadAt(0), 1,
    "rate exposure must NOT fall with the NZD share under the agreed model");
  assert.ok(spreadAt(0) > 1, "and the fixture must have real exposure to compare");
  console.log("✓ rate exposure is unchanged by the share — an NZD payment is not a hedge");

  // A program already priced in NZD ignores the share — there is nothing to split.
  const b = base();
  b.baseMinimumBuffer = 0;
  b.fxRates = { NZD: 1, USD: 1.7135 };
  b.planningRateSource = "manual";
  b.recognitionMonths = { Fall: 9, Spring: 1, Summer: 6 };
  b.defaultPaymentRules.nzdReceiptShare = 0.5;
  b.programs = [prog({
    id: "n", name: "N", season: "Fall", currency: "NZD",
    startDate: "2026-10-01", endDate: "2026-12-01",
    price: 25_000, paxForecast: 10, fixedCost: 0, variableCostPerPax: 0,
  })];
  const nz = buildForecast(b);
  near(nz.months.reduce((s, m) => s + m.fxIn, 0), 0, 0.01,
    "an NZD-priced program never touches the settlement account");
  near(nz.totals.cashIn, 10 * 25_000, 0.01, "and its receipts are counted once, at par");
  console.log("✓ an NZD-priced program is unaffected by the share");

  // Out of range is clamped rather than producing negative USD receipts.
  const silly = mk(2);
  near(silly.months.reduce((s, m) => s + m.fxIn, 0), 0, 0.01,
    "a share above 1 clamps instead of inverting the split");
  console.log("✓ an out-of-range share clamps");
}

console.log("\nAll actuals-overlay tests passed.");

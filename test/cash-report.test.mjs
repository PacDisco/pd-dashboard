// test/cash-report.test.mjs
//
// The fiscal-year report must describe THE YEAR ON ITS TITLE.
//
// forecast.totals covers the model's first fiscal year only. A report for the
// second year built from those totals would print FY26/27's cash in under an
// FY27/28 heading — plausible, formatted, and wrong. So every figure here is
// checked against that year's own twelve months, and balance rows are checked
// to be the 31 March figure rather than a sum of closing balances.
//
// Run: node test/cash-report.test.mjs

import assert from "node:assert/strict";
import { buildForecast } from "../cash-forecast/engine.mjs";
import { seedAssumptions } from "../cash-forecast/seed.mjs";
import { defaultAssumptions } from "../cash-forecast/model.mjs";
import { fiscalYearsIn, fiscalYearReport } from "../cash-forecast/report.mjs";

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b}`);
const sum = (xs) => xs.reduce((s, v) => s + v, 0);
const TODAY = { today: new Date("2026-10-12T00:00:00Z") };

/* ---------- which years can be exported ---------- */

{
  const f = buildForecast(seedAssumptions(2026), {}, TODAY);
  const years = fiscalYearsIn(f);
  assert.ok(years.length >= 2, "at least two whole years in a 24-month-plus horizon");
  assert.equal(years[0].startYear, 2026);
  assert.equal(years[0].label, "FY 2026/27");
  assert.equal(years[0].isModelYear, true);
  assert.equal(years[1].startYear, 2027);
  assert.equal(years.length, Math.floor(f.months.length / 12), "only complete years are offered");
  console.log(`✓ offers ${years.length} complete fiscal years: ${years.map((y) => y.label).join(", ")}`);
}

/* ---------- the model year matches the engine's own totals ---------- */

{
  const a = seedAssumptions(2026);
  const f = buildForecast(a, {}, TODAY);
  const r = fiscalYearReport(f, 2026, { programs: a.programs, buffer: a.baseMinimumBuffer });

  near(r.summary.cashIn, f.totals.cashIn, 0.01, "cash in = engine FY total");
  near(r.summary.cashOut, f.totals.cashOut, 0.01, "cash out = engine FY total");
  near(r.summary.closingBase, f.months[11].baseClosing, 0.01, "closing NZD is March");
  near(r.summary.totalPosition, f.totals.closingBalance, 0.01, "total position = engine closing");
  near(r.summary.lowestBase, f.totals.lowestBaseClosing, 0.01, "lowest NZD = engine lowest");
  assert.equal(r.summary.lowestBaseMonth, f.totals.lowestBaseMonth);
  near(r.summary.openingBase, f.months[0].baseOpening, 0.01, "opening is 1 April");

  assert.equal(r.columns.length, 12);
  assert.equal(r.columns[0].label, "Apr 26");
  assert.equal(r.columns[11].label, "Mar 27");

  // Flows sum, balances take March.
  const row = (label) => r.rows.find((x) => x.label === label);
  near(row("Cash in").total, sum(f.months.slice(0, 12).map((m) => m.cashIn)), 0.01, "flow row sums");
  near(row("NZD account").total, f.months[11].baseClosing, 0.01, "balance row is 31 March, not a sum");
  near(row("USD balance").total, f.months[11].fxClosing, 0.01, "USD balance is 31 March");
  assert.equal(row("NZD account").kind, "balance");
  assert.equal(row("Overheads").kind, "flow");
  assert.ok(row("Overheads").total <= 0, "costs are shown negative, as on the page");

  // The page's own identity: net movement = cash in - cash out, every month.
  const net = row("Net movement").values;
  const cin = row("Cash in").values; const cout = row("Cash out").values;
  net.forEach((v, i) => near(v, cin[i] + cout[i], 0.01, `net movement adds up in ${r.columns[i].label}`));

  // Model-year notes come from the engine, minus the runway caveat that
  // belongs to a later year.
  assert.ok(!r.notes.some((n) => /onward has no programs entered/.test(n.text)),
    "the runway caveat is not attached to the model year");

  // Programs: everything departing April 2026 – March 2027, and nothing else.
  assert.ok(r.programs.length > 0, "seeded programs depart in the model year");
  for (const p of r.programs) {
    assert.ok(p.startDate >= "2026-04-01" && p.startDate <= "2027-03-31", `${p.name} departs in FY26/27`);
  }
  near(r.programTotals.revenue, sum(r.programs.map((p) => p.revenue)), 0.01, "program total adds up");
  console.log("✓ the model year's figures match the engine and the table adds up");
}

/* ---------- a later year uses ITS OWN months ---------- */

{
  const a = seedAssumptions(2026);
  const f = buildForecast(a, {}, TODAY);
  const r = fiscalYearReport(f, 2027, { programs: a.programs, buffer: a.baseMinimumBuffer });
  const months = f.months.slice(12, 24);

  near(r.summary.cashOut, sum(months.map((m) => m.cashOut)), 0.01, "FY27/28 cash out is its own months");
  assert.notEqual(Math.round(r.summary.cashOut), Math.round(f.totals.cashOut),
    "and is not the model year's total relabelled");
  near(r.summary.openingBase, f.months[11].baseClosing, 0.01, "FY27/28 opens where FY26/27 closed");
  near(r.summary.closingBase, f.months[23].baseClosing, 0.01, "and closes on March 2028");
  assert.equal(r.columns[0].label, "Apr 27");
  assert.equal(r.fiscalYear.label, "FY 2027/28");
  assert.equal(r.fiscalYear.short, "FY27-28");

  // The seed has no FY27/28 programs — only the last of Spring's supplier
  // payments spill into April — so this year is overheads only and must say
  // so rather than present a falling balance as a forecast.
  assert.equal(r.fiscalYear.noPrograms, true);
  assert.equal(fiscalYearsIn(f)[1].noPrograms, true, "the picker flags it too");
  assert.equal(fiscalYearsIn(f)[0].noPrograms, false, "but not the model year");
  assert.equal(r.programs.length, 0);
  assert.ok(r.notes.some((n) => /No programs are entered for FY 2027\/28/.test(n.text)),
    "an empty year is labelled as missing inputs");
  console.log("✓ a later year is built from its own twelve months and flagged when empty");
}

/* ---------- a year that is not in the horizon is refused ---------- */

{
  const f = buildForecast(seedAssumptions(2026), {}, TODAY);
  assert.throws(() => fiscalYearReport(f, 2025), /not a complete year/);
  assert.throws(() => fiscalYearReport(f, 2026 + fiscalYearsIn(f).length), /not a complete year/);
  console.log("✓ a year outside the horizon is refused, not silently half-filled");
}

/* ---------- closed months: variance and the n/a conversions ---------- */

{
  const a = defaultAssumptions(2026);
  a.actualsThroughMonth = "2026-08";
  a.openingBalances = { NZD: -463_330, USD: 7_509 };
  a.fxRates = { NZD: 1, USD: 1.714 };
  a.planningRateSource = "manual";
  a.baseMinimumBuffer = 50_000;
  a.monthlyOverheads = Array(12).fill(70_000);
  a.programs = [];
  const actuals = {
    "2026-08": {
      source: "Xero Bank Summary",
      byCurrency: {
        NZD: { opening: -103_207, received: 885_907, spent: 806_470, closing: -23_770 },
        USD: { opening: 175_739, received: 412_523, spent: 358_587, closing: 229_675 },
      },
    },
  };
  const f = buildForecast(a, actuals, TODAY);
  const forecastOnly = buildForecast({ ...a, actualsThroughMonth: null }, {}, TODAY);
  const r = fiscalYearReport(f, 2026, { forecastOnly, programs: [] });

  assert.ok(r.summary.actualMonths > 0, "closed months are counted");
  assert.ok(r.columns.some((c) => c.isActual), "and marked on their columns");
  const variance = r.rows.find((x) => x.variance);
  assert.ok(variance, "a variance row appears when there are closed months");
  const aug = r.columns.findIndex((c) => c.key === "2026-08");
  near(variance.values[aug], f.months[aug].baseClosing - forecastOnly.months[aug].baseClosing, 0.01,
    "variance is actual less forecast on the NZD account");
  assert.equal(variance.values[aug + 1], null, "forecast months have no variance");
  assert.equal(variance.total, null,
    "no year figure: the last closed month's variance is not a 31 March variance");
  assert.equal(r.summary.latestVariance.label, "Aug 26", "the latest variance names its month");
  near(r.summary.latestVariance.value, variance.values[aug], 0.01, "and carries that month's figure");

  const conv = r.rows.find((x) => x.label === "USD converted");
  if (conv.values.some((v) => v === null)) {
    assert.equal(conv.partialTotal, true, "a total with n/a months in it is flagged as partial");
    assert.ok(r.notes.some((n) => /USD converted/.test(n.text)), "and explained");
  }

  // No variance row without a forecast-only run to compare against.
  const bare = fiscalYearReport(f, 2026, { programs: [] });
  assert.ok(!bare.rows.some((x) => x.variance), "no variance row without a comparison run");
  console.log("✓ closed months carry a variance row and flag partial totals");
}

console.log("\nCash report tests passed.");

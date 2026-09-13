// test/cash-seam.test.mjs
//
// Balances must carry across the actual/forecast boundary.
//
// THE BUG
// -------
// The dashboard displayed a table built from TWO engine runs joined at the lock
// month: the server's run supplied April to August, a local browser run with no
// actuals supplied September onward. Each run was internally correct. Joined,
// they were not — the local chain had never seen the real Xero figures, so it
// handed September an opening balance that did not exist.
//
// The visible symptom: August closed with 229,675 USD and September opened with
// none of it, converting only its own receipts, USD balance pinned at zero all
// year. About 394,000 NZD of cover absent from the forecast.
//
// What makes this worth a test of its own is that nothing looked wrong. Every
// figure was plausible, both halves reconciled internally, and the row the
// evidence sat in — a USD balance of zero — is exactly what you would expect of
// a company converting aggressively. It was found by arithmetic, not by looking.
//
// Run: node test/cash-seam.test.mjs

import assert from "node:assert/strict";
import { buildForecast } from "../cash-forecast/engine.mjs";
import { defaultAssumptions } from "../cash-forecast/model.mjs";

const near = (a, b, tol, msg) =>
  assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b}`);

const RATE = 1.714;

function model(over = {}) {
  const a = defaultAssumptions(2026);
  a.actualsThroughMonth = "2026-08";
  a.openingBalances = { NZD: -463_330, USD: 7_509 };
  a.fxRates = { NZD: 1, USD: RATE };
  a.planningRateSource = "manual";
  a.baseMinimumBuffer = 50_000;
  a.monthlyOverheads = Array(12).fill(70_000);
  a.programs = [];
  return { ...a, ...over };
}

// August closes holding real USD, on a bank summary that adds up.
const ACTUALS = {
  "2026-08": {
    source: "Xero Bank Summary",
    byCurrency: {
      NZD: { opening: -103_207, received: 885_907, spent: 806_470, closing: -23_770 },
      USD: { opening: 175_739, received: 412_523, spent: 358_587, closing: 229_675 },
    },
  },
};

/* ---------- the balance crosses the boundary ---------- */

{
  const f = buildForecast(model(), ACTUALS);
  const aug = f.months[4];
  const sep = f.months[5];

  near(aug.fxClosing, 229_675, 1, "August closes holding its real USD");
  near(sep.fxOpening, 229_675, 1, "and September opens with it");
  assert.equal(sep.fxOpening, aug.fxClosing, "exactly, not approximately");
  near(sep.baseOpening, aug.baseClosing, 0.01, "the NZD side carries too");
  console.log("✓ the closing balance of the last closed month opens the first forecast month");
}

/* ---------- and it is actually available to spend ---------- */

{
  const f = buildForecast(model(), ACTUALS);
  const sep = f.months[5];

  // There are no programs in this model, so September receives NO USD of its
  // own. Every dollar it converts therefore has to be carried-over balance —
  // which makes this assertion exact rather than a chosen threshold. Under the
  // bug it was zero, because the carried balance was not there to convert.
  near(sep.fxIn, 0, 0.01, "September receives no USD of its own in this model");
  assert.ok(sep.fxConverted > 0,
    `so anything converted must be carried balance, converted ${Math.round(sep.fxConverted)}`);
  assert.ok(sep.fxConverted <= 229_675 + 0.01,
    "and it cannot convert more than August left behind");
  near(sep.baseFromConversion, sep.fxConverted * RATE, 1,
    "and the NZD produced is the conversion at the planning rate");

  // The precise shape of the bug: converting only the month's OWN receipts.
  assert.notEqual(Math.round(sep.fxConverted), Math.round(sep.fxIn),
    "converting exactly the month's own receipts is the symptom, not the behaviour");
  console.log("✓ the carried USD is available to convert, not just the month's own receipts");
}

/* ---------- the whole chain is continuous ---------- */

{
  const f = buildForecast(model(), ACTUALS);
  for (let i = 1; i < f.months.length; i++) {
    const prev = f.months[i - 1], cur = f.months[i];
    near(cur.fxOpening, prev.fxClosing, 0.01,
      `${cur.label} opens where ${prev.label} closed (USD)`);
    near(cur.baseOpening, prev.baseClosing, 0.01,
      `${cur.label} opens where ${prev.label} closed (NZD)`);
  }
  console.log("✓ every month opens where the previous one closed, across the whole year");
}

/* ---------- a run WITHOUT actuals is not interchangeable with one that has them ---------- */

{
  // This is the assumption the dashboard was quietly making. If these two runs
  // agreed there would be no bug and no need for the server to send its actuals
  // to the browser — so assert that they genuinely differ, or the fix is
  // pointless and someone will remove it.
  const withActuals = buildForecast(model(), ACTUALS);
  const without = buildForecast(model(), {});

  const a = withActuals.months[5];
  const b = without.months[5];
  assert.notEqual(Math.round(a.fxOpening), Math.round(b.fxOpening),
    "the forecast tail depends on the actuals, so the two runs cannot be spliced");
  console.log("✓ a local run with no actuals produces a different tail — splicing is not safe");
}

/* ---------- no actuals at all is still a continuous chain ---------- */

{
  const f = buildForecast(model({ actualsThroughMonth: null }), {});
  near(f.months[0].fxOpening, 7_509, 0.01, "it starts from the typed opening");
  for (let i = 1; i < f.months.length; i++) {
    near(f.months[i].fxOpening, f.months[i - 1].fxClosing, 0.01,
      `${f.months[i].label} still opens where the previous closed`);
  }
  console.log("✓ an all-forecast year is continuous too");
}

console.log("\nAll seam tests passed.");

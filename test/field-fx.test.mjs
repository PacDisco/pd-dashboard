// test/field-fx.test.mjs
//
// Market rates for the planning-rate helper. Run: npm run test:fx
//
// The dangerous failure here is an inverted cross rate: it produces a
// plausible-looking number that is wrong by a factor of two or three, and it
// would be typed straight into a budget.

import assert from "node:assert/strict";
import {
  cleanCodes, crossRate, rateDrift, isDrifted, parseSpot, fetchSpot,
  DRIFT_THRESHOLD, _resetFxCache,
} from "../netlify/functions/_shared/field-fx.mjs";

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// Quoted against NZD: 1 NZD buys 0.58 USD, 1.28 FJD, 2.10 PEN.
const MARKET = { USD: 0.58, FJD: 1.28, PEN: 2.1 };

// ── cross rates ─────────────────────────────────────────────────────────────

test("the market base itself is 1 and needn't appear in the table", () => {
  assert.equal(crossRate(MARKET, "NZD", "USD", "NZD"), 0.58);
  assert.equal(crossRate(MARKET, "USD", "NZD", "NZD"), 1 / 0.58);
});

test("a cross rate between two quoted currencies is right way up", () => {
  // PEN per 1 USD: 1 USD is 1/0.58 NZD, which buys 2.10 of those → 3.62 PEN.
  const penPerUsd = crossRate(MARKET, "USD", "PEN", "NZD");
  assert.ok(Math.abs(penPerUsd - 3.6207) < 0.001, `got ${penPerUsd}`);
  // And the inverse really is the inverse — the classic silent bug.
  const usdPerPen = crossRate(MARKET, "PEN", "USD", "NZD");
  assert.ok(Math.abs(usdPerPen * penPerUsd - 1) < 1e-9);
});

test("the stored planning rate is leg units per 1 base unit", () => {
  // A USD leg storing rates.NZD is asking "how many USD is 1 NZD" — 0.58, and
  // USD 352.27 / 0.58 = NZD 607.36, which is what the export prints.
  const usdPerNzd = crossRate(MARKET, "NZD", "USD", "NZD");
  assert.equal(usdPerNzd, 0.58);
  assert.ok(Math.abs(352.27 / usdPerNzd - 607.36) < 0.01);
});

test("same currency both ways is 1, never a lookup", () => {
  assert.equal(crossRate(MARKET, "USD", "USD", "NZD"), 1);
  assert.equal(crossRate({}, "XYZ", "XYZ", "NZD"), 1);
});

test("a missing or junk leg gives null rather than a guess", () => {
  // A wrong cross rate looks exactly like a right one, so there is no
  // defensible fallback.
  assert.equal(crossRate(MARKET, "NZD", "GBP", "NZD"), null);
  assert.equal(crossRate({ USD: 0 }, "NZD", "USD", "NZD"), null);
  assert.equal(crossRate({ USD: "abc" }, "NZD", "USD", "NZD"), null);
  assert.equal(crossRate(MARKET, "US", "NZD", "NZD"), null);
  assert.equal(crossRate(null, "NZD", "USD", "NZD"), null);
});

// ── drift ───────────────────────────────────────────────────────────────────

test("drift is measured against the live rate and signed", () => {
  const d = rateDrift(0.58, 0.62);
  assert.ok(Math.abs(d.pct - (0.58 - 0.62) / 0.62) < 1e-12);
  assert.ok(d.pct < 0, "a stored rate below the market reads negative");
});

test("a stored rate that flatters the budget reads positive", () => {
  // Stored high → spend converts to fewer base units than it really costs.
  assert.ok(rateDrift(0.70, 0.58).pct > 0);
});

test("the threshold is a floor, not a strict greater-than", () => {
  assert.equal(isDrifted(1.05, 1.0), true, `${DRIFT_THRESHOLD} exactly should count`);
  assert.equal(isDrifted(1.0499, 1.0), false);
});

test("nothing is flagged when either side is missing or nonsense", () => {
  for (const [s, l] of [[null, 1], [1, null], [0, 1], [1, 0], [-1, 1], ["x", 1]]) {
    assert.equal(rateDrift(s, l), null, `${s} / ${l}`);
    assert.equal(isDrifted(s, l), false);
  }
});

// ── parsing ─────────────────────────────────────────────────────────────────

test("a Frankfurter body is read as it comes", () => {
  const p = parseSpot({ base: "NZD", date: "2026-09-22", rates: { USD: 0.58 } }, "NZD", "src");
  assert.equal(p.date, "2026-09-22");
  assert.deepEqual(p.rates, { USD: 0.58 });
});

test("junk codes and non-positive rates are dropped, not stored", () => {
  const p = parseSpot({ rates: { USD: 0.58, BITCOIN: 1, EUR: 0, GBP: -1, XX: 2 } }, "NZD", "s");
  assert.deepEqual(Object.keys(p.rates), ["USD"]);
});

test("a body with no usable rates is null, not an empty table", () => {
  assert.equal(parseSpot({}, "NZD", "s"), null);
  assert.equal(parseSpot({ rates: {} }, "NZD", "s"), null);
  assert.equal(parseSpot({ rates: { EUR: 0 } }, "NZD", "s"), null);
});

test("cleanCodes normalises, de-duplicates and rejects", () => {
  assert.deepEqual(cleanCodes([" usd ", "USD", "pen", "x", "", null, "1234"]), ["PEN", "USD"]);
});

// ── fetching ────────────────────────────────────────────────────────────────

const okRes = (body) => ({ ok: true, json: async () => body });

test("the primary source is used when it answers", async () => {
  _resetFxCache();
  const calls = [];
  const got = await fetchSpot("NZD", ["USD"], {
    fetchImpl: async (url) => { calls.push(url); return okRes({ base: "NZD", date: "2026-09-22", rates: { USD: 0.58 } }); },
  });
  assert.equal(calls.length, 1);
  assert.match(calls[0], /frankfurter/);
  assert.equal(got.rates.USD, 0.58);
});

test("it falls back rather than failing, and says which source answered", async () => {
  _resetFxCache();
  const got = await fetchSpot("NZD", ["USD"], {
    fetchImpl: async (url) => /frankfurter/.test(url)
      ? { ok: false, json: async () => ({}) }
      : okRes({ rates: { USD: 0.59, EUR: 0.5 } }),
  });
  assert.equal(got.rates.USD, 0.59);
  assert.match(got.source, /exchangerate/);
  assert.deepEqual(Object.keys(got.rates), ["USD"], "the fallback's other 160 currencies are dropped");
});

test("every source failing returns null instead of throwing", async () => {
  _resetFxCache();
  assert.equal(await fetchSpot("NZD", ["USD"], {
    fetchImpl: async () => { throw new Error("offline"); },
  }), null);
  _resetFxCache();
  assert.equal(await fetchSpot("NZD", ["USD"], {
    fetchImpl: async () => ({ ok: false, json: async () => ({}) }),
  }), null);
});

test("a second call inside the window doesn't hit the network again", async () => {
  _resetFxCache();
  let n = 0;
  const impl = { fetchImpl: async () => { n++; return okRes({ rates: { USD: 0.58 } }); } };
  await fetchSpot("NZD", ["USD"], impl);
  await fetchSpot("NZD", ["USD"], impl);
  assert.equal(n, 1, "one dashboard load, one call");
});

test("the cache expires", async () => {
  _resetFxCache();
  let n = 0;
  let clock = 0;
  const impl = { fetchImpl: async () => { n++; return okRes({ rates: { USD: 0.58 } }); }, now: () => clock };
  await fetchSpot("NZD", ["USD"], impl);
  clock = 7 * 60 * 60 * 1000;
  await fetchSpot("NZD", ["USD"], impl);
  assert.equal(n, 2);
});

test("asking for nothing, or only the base, makes no call at all", async () => {
  _resetFxCache();
  let n = 0;
  const impl = { fetchImpl: async () => { n++; return okRes({ rates: {} }); } };
  assert.equal(await fetchSpot("NZD", [], impl), null);
  assert.equal(await fetchSpot("NZD", ["NZD"], impl), null);
  assert.equal(await fetchSpot("NZD", ["nonsense"], impl), null);
  assert.equal(n, 0);
});

let failed = 0;
for (const [name, fn] of tests) {
  try { await fn(); console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.error(`  ✗ ${name}\n    ${err.message}`); }
}
console.log(`\n${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);

// test/lead-alerts-hours.test.mjs — available-hours rules for Lead Alerts.
// Run: npm run test:lead-alerts

import assert from "node:assert/strict";
import { isAvailable, nextAvailableAt, nextChangeAt, normalizeSchedule } from "../netlify/functions/_shared/lead-alerts-hours.mjs";

const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const T = (s) => Date.parse(s);
const week = (blocks) => ({ days: Array.from({ length: 7 }, (_, d) => blocks(d)) });
// Weekdays 9–5 in Denver. 2026-11-02 is a Monday; Denver is UTC-7 (MST) then.
const NINE_TO_FIVE = week((d) => (d >= 1 && d <= 5 ? [{ s: "09:00", e: "17:00" }] : []));
const DEN = "America/Denver";

test("null schedule = 24/7", () => {
  assert.equal(isAvailable(null, null, T("2026-11-01T03:00:00Z")), true);
  assert.equal(nextAvailableAt(null, null, 123), 123);
  assert.equal(nextChangeAt(null, null), null);
});

test("weekday 9–5 in the person's own zone", () => {
  assert.equal(isAvailable(NINE_TO_FIVE, DEN, T("2026-11-02T16:00:00Z")), true);   // Mon 9:00 MST
  assert.equal(isAvailable(NINE_TO_FIVE, DEN, T("2026-11-02T15:59:00Z")), false);  // Mon 8:59
  assert.equal(isAvailable(NINE_TO_FIVE, DEN, T("2026-11-03T00:00:00Z")), false);  // Mon 17:00 (end is exclusive)
  assert.equal(isAvailable(NINE_TO_FIVE, DEN, T("2026-11-01T18:00:00Z")), false);  // Sunday
});

test("overnight block runs into the next morning", () => {
  const nights = week((d) => (d === 5 ? [{ s: "20:00", e: "02:00" }] : []));       // Fri 8pm → Sat 2am
  assert.equal(isAvailable(nights, "UTC", T("2026-11-06T21:00:00Z")), true);
  assert.equal(isAvailable(nights, "UTC", T("2026-11-07T01:30:00Z")), true);
  assert.equal(isAvailable(nights, "UTC", T("2026-11-07T02:00:00Z")), false);
});

test("nextAvailableAt: a Saturday-night lead waits for Monday 9:00, to the minute", () => {
  assert.equal(nextAvailableAt(NINE_TO_FIVE, DEN, T("2026-11-01T05:13:00Z")), T("2026-11-02T16:00:00Z"));
  assert.equal(nextAvailableAt(NINE_TO_FIVE, DEN, T("2026-11-02T17:00:00Z")), T("2026-11-02T17:00:00Z"));
  const odd = week(() => [{ s: "07:40", e: "08:00" }]);
  assert.equal(nextAvailableAt(odd, "UTC", T("2026-11-02T00:00:00Z")), T("2026-11-02T07:40:00Z"));
  assert.equal(nextAvailableAt(week(() => []), "UTC", 0), null);
});

test("nextChangeAt: when the current state flips", () => {
  assert.equal(nextChangeAt(NINE_TO_FIVE, DEN, T("2026-11-02T18:00:00Z")), T("2026-11-03T00:00:00Z"));  // ends 17:00 MST
  assert.equal(nextChangeAt(NINE_TO_FIVE, DEN, T("2026-11-03T01:00:00Z")), T("2026-11-03T16:00:00Z"));  // starts Tue 9:00
});

test("DST: 9:00 local stays 9:00 local", () => {
  // US DST ends 2026-11-01; Fri 2026-10-30 Denver is MDT (UTC-6).
  assert.equal(nextAvailableAt(NINE_TO_FIVE, DEN, T("2026-10-30T14:00:00Z")), T("2026-10-30T15:00:00Z"));
});

test("normalizeSchedule validates and collapses 24/7", () => {
  assert.equal(normalizeSchedule(null), null);
  assert.equal(normalizeSchedule(week(() => [{ s: "00:00", e: "24:00" }])), null);
  assert.deepEqual(normalizeSchedule(NINE_TO_FIVE), NINE_TO_FIVE);
  assert.throws(() => normalizeSchedule({ days: [[]] }), /seven days/);
  assert.throws(() => normalizeSchedule(week(() => [{ s: "9am", e: "17:00" }])), /HH:MM/);
  assert.throws(() => normalizeSchedule(week(() => [{ s: "09:00", e: "09:00" }])), /same/);
});

let failed = 0;
for (const [name, fn] of tests) {
  try { await fn(); console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.error(`  ✗ ${name}\n    ${e.stack || e.message}`); }
}
console.log(failed ? `\n${failed} failed` : `\nall ${tests.length} passed`);
process.exit(failed ? 1 : 0);

// test/aircall.test.mjs — Aircall matching rules for Lead Alerts.
// Run: npm run test:lead-alerts

import assert from "node:assert/strict";
import { followUpFromCall, samePhone, toE164, toMs, tokensMatch } from "../netlify/functions/_shared/aircall.mjs";

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test("samePhone: formatting and country code don't matter", () => {
  assert.equal(samePhone("+1 (555) 010-0100", "5550100100"), true);
  assert.equal(samePhone("+15550100100", "+1 555 010 0100"), true);
  assert.equal(samePhone("+64 21 555 0199", "021 555 0199"), true);
  assert.equal(samePhone("+15550100100", "+15550100101"), false);
  assert.equal(samePhone("", "+15550100100"), false);
  assert.equal(samePhone("12345", "12345"), false, "too short to trust");
});

test("toE164", () => {
  assert.equal(toE164("+1 (555) 010-0100"), "+15550100100");
  assert.equal(toE164("555-010-0100"), "+15550100100");
  assert.equal(toE164("1 555 010 0100"), "+15550100100");
  assert.equal(toE164("0064 21 555 0199"), "+64215550199");
  assert.equal(toE164(""), null);
});

test("toMs: Aircall's unix seconds, or ms, or ISO", () => {
  assert.equal(toMs(1793000000), 1793000000000);
  assert.equal(toMs("1793000000"), 1793000000000);
  assert.equal(toMs(1793000000000), 1793000000000);
  assert.equal(toMs("2026-10-29T10:00:00Z"), Date.parse("2026-10-29T10:00:00Z"));
  assert.equal(toMs(null), null);
});

test("followUpFromCall: outbound counts, answered or not", () => {
  const base = { raw_digits: "+1 555-010-0100", started_at: 1793000000, user: { name: "Megan N" } };
  const answered = followUpFromCall({ ...base, direction: "outbound", answered_at: 1793000010, ended_at: 1793000250 });
  assert.equal(answered.how, "Called via Aircall · 4 min call");
  assert.equal(answered.by, "Megan N");
  assert.equal(answered.at, new Date(1793000000000).toISOString());
  assert.equal(followUpFromCall({ ...base, direction: "outbound" }).how, "Called via Aircall · no answer");
});

test("followUpFromCall: inbound only when answered", () => {
  const base = { raw_digits: "+15550100100", started_at: 1793000000, direction: "inbound" };
  assert.equal(followUpFromCall(base), null, "missed call isn't a follow-up");
  assert.match(followUpFromCall({ ...base, answered_at: 1793000005, ended_at: 1793000200 }).how, /^They called in · answered via Aircall · 3 min$/);
  assert.equal(followUpFromCall({ direction: "outbound" }), null, "no number → nothing to match");
});

test("tokensMatch is strict", () => {
  assert.equal(tokensMatch("abc", "abc"), true);
  assert.equal(tokensMatch("abc", "abd"), false);
  assert.equal(tokensMatch("", ""), false);
  assert.equal(tokensMatch(undefined, "abc"), false);
});

let failed = 0;
for (const [name, fn] of tests) {
  try { await fn(); console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.error(`  ✗ ${name}\n    ${e.stack || e.message}`); }
}
console.log(failed ? `\n${failed} failed` : `\nall ${tests.length} passed`);
process.exit(failed ? 1 : 0);

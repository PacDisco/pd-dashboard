// test/lead-alerts.test.mjs — pure logic for the Lead Alerts phone app.
// Run: npm run test:lead-alerts   (the database-backed scan test is
// test/lead-alerts.db.test.mjs)

import assert from "node:assert/strict";
import {
  appDetail, autoCloseReason, buildDigest, buildPush, buildReminder, newLeadSetAt, stats, suppressDuplicateLeads, hubspotUrl,
} from "../netlify/functions/_shared/lead-alerts.mjs";

const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const T = (s) => Date.parse(s);

test("newLeadSetAt: newest time the status was set to NEW", () => {
  assert.equal(newLeadSetAt([
    { value: "OPEN", timestamp: "2026-10-29T10:00:00Z" },
    { value: "NEW", timestamp: "2026-10-29T09:00:00Z" },
    { value: "NEW", timestamp: "2026-10-20T09:00:00Z" },
  ]), T("2026-10-29T09:00:00Z"));
  assert.equal(newLeadSetAt([{ value: "OPEN", timestamp: "2026-10-29T10:00:00Z" }]), null);
  assert.equal(newLeadSetAt(undefined), null);
});

test("suppressDuplicateLeads: an application/quiz within 3h swallows the HubSpot ping", () => {
  const leads = [
    { email: "A@x.com", at: T("2026-10-29T10:00:00Z") },
    { email: "b@x.com", at: T("2026-10-29T10:00:00Z") },
    { email: "c@x.com", at: T("2026-10-29T10:00:00Z") },
  ];
  const others = [
    { email: "a@x.com", at: T("2026-10-29T09:58:00Z") },   // same person, 2 min apart → drop
    { email: "c@x.com", at: T("2026-10-29T05:00:00Z") },   // 5h apart → keep
  ];
  assert.deepEqual(suppressDuplicateLeads(leads, others).map((l) => l.email), ["b@x.com", "c@x.com"]);
});

test("autoCloseReason: a logged contact after the alert closes it", () => {
  const ev = { occurred_at: "2026-10-29T10:00:00Z" };
  assert.equal(autoCloseReason(ev, { notes_last_contacted: "2026-10-29T10:20:00Z", hs_lead_status: "NEW" }).why, "Contact logged in HubSpot");
  assert.equal(autoCloseReason(ev, { notes_last_contacted: "2026-10-29T10:20:00Z" }, T("2026-10-29T11:00:00Z")).at, "2026-10-29T10:20:00.000Z");
  assert.equal(autoCloseReason(ev, { notes_last_contacted: "2026-10-28T10:20:00Z", hs_lead_status: "NEW" }), null);
});

test("autoCloseReason: lead status moved off NEW after the alert closes it; before doesn't", () => {
  const ev = { occurred_at: "2026-10-29T10:00:00Z" };
  const r = autoCloseReason(ev, { hs_lead_status: "ATTEMPTED_TO_CONTACT", hs_lead_status_changed_at: "2026-10-29T10:30:00Z" });
  assert.equal(r.why, "Lead status → attempted to contact");
  assert.equal(autoCloseReason(ev, { hs_lead_status: "OPEN", hs_lead_status_changed_at: "2026-10-29T09:00:00Z" }), null);
  assert.equal(autoCloseReason(ev, null), null);
});

test("buildPush: one alert names the person and the deadline", () => {
  const p = buildPush([{ id: "app1:1", type: "app_started", occurred_at: "2026-10-29T17:00:00Z", name: "Jane Doe", detail: "Fall 2027 · Semester" }], 3);
  assert.equal(p.title, "Application started: Jane Doe");
  assert.match(p.body, /Fall 2027 · Semester — follow up by \d{1,2}:\d{2}/);
  assert.equal(p.badge, 3);
  assert.equal(p.tag, "app1:1");
  assert.equal(p.url, "/lead-alerts/#app1%3A1");
});

test("buildPush: several alerts become one summary", () => {
  const evs = ["A", "B", "C", "D", "E", "F"].map((n, i) => ({ id: String(i), type: "quiz", occurred_at: "2026-10-29T17:00:00Z", name: n }));
  const p = buildPush(evs, 6);
  assert.equal(p.title, "6 new leads to follow up");
  assert.equal(p.body, "A, B, C, D +2 more");
});

test("buildReminder: says how long is left", () => {
  const now = T("2026-10-29T17:45:00Z");
  const r = buildReminder({ id: "q", type: "quiz", occurred_at: "2026-10-29T17:00:00Z", name: "Sam" }, 1, now);
  assert.equal(r.title, "Still waiting: Sam");
  assert.match(r.body, /Quiz completed 45 min ago — 15 min left in the hour/);
});

test("buildDigest: counts by kind, names the first few", () => {
  const e = (type, name) => ({ id: name, type, name, occurred_at: "2026-10-29T08:00:00Z" });
  const d = buildDigest([e("quiz", "A"), e("quiz", "B"), e("app_submitted", "C"), e("new_lead", "D")], 4);
  assert.equal(d.title, "While you were off: 4 leads waiting");
  assert.equal(d.body, "1 application, 2 quizzes, 1 new lead — A, B, C…");
  assert.equal(buildDigest([e("app_started", "Ana")], 1).title, "While you were off: Ana");
});

test("buildReminder: an off-hours lead counts from when her hours started", () => {
  const r = buildReminder({ id: "q", type: "quiz", occurred_at: "2026-10-29T03:00:00Z", name: "Nora" }, 1,
    T("2026-10-29T16:45:00Z"), T("2026-10-29T16:00:00Z"));
  assert.match(r.body, /your hours started 45 min ago — 15 min left/);
});

test("stats: an off-hours lead's hour starts with her hours", () => {
  const s = stats([{ occurredAt: "2026-10-29T03:00:00Z", clockStartAt: "2026-10-29T16:00:00Z", handledAt: "2026-10-29T16:20:00Z" }], T("2026-10-29T17:00:00Z"));
  assert.equal(s.medianMinutes, 20);
  assert.equal(s.withinHourPct, 100);
});

test("stats: open, overdue, median and within-the-hour", () => {
  const now = T("2026-10-29T12:00:00Z");
  const s = stats([
    { occurredAt: "2026-10-29T11:30:00Z" },                                         // open, not overdue
    { occurredAt: "2026-10-29T10:00:00Z" },                                         // open, overdue
    { occurredAt: "2026-10-29T09:00:00Z", handledAt: "2026-10-29T09:20:00Z" },      // 20 min
    { occurredAt: "2026-10-29T08:00:00Z", handledAt: "2026-10-29T09:30:00Z" },      // 90 min
    { occurredAt: "2026-10-29T07:00:00Z", handledAt: "2026-10-29T07:10:00Z" },      // 10 min
  ], now);
  assert.deepEqual(s, { open: 2, overdue: 1, medianMinutes: 20, withinHourPct: 67, handled: 3 });
});

test("appDetail + hubspotUrl", () => {
  assert.equal(appDetail({ program: "Southeast Asia Semester", term: "Fall", travel_year: "2027" }), "Southeast Asia Semester · Fall 2027");
  assert.equal(appDetail({ program: "", season: "Spring", travel_year: "" }), "Spring");
  assert.equal(hubspotUrl(null), null);
  assert.match(hubspotUrl("123"), /\/record\/0-1\/123$/);
});

let failed = 0;
for (const [name, fn] of tests) {
  try { await fn(); console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.error(`  ✗ ${name}\n    ${e.stack || e.message}`); }
}
console.log(failed ? `\n${failed} failed` : `\nall ${tests.length} passed`);
process.exit(failed ? 1 : 0);

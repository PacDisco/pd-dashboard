// test/tile-badges.test.mjs
//
// Landing-page "new submissions" bubbles. Run: npm run test:badges
//
// Covers the counting rule, the first-visit baseline, "opening clears it",
// and that people only get counts for dashboards they may open.

import assert from "node:assert/strict";
import { badgeLabel, countNew, latestCursor, _setStoreForTests, bumpBadgeCounter } from "../netlify/functions/_shared/tile-badges.mjs";
import { _setDepsForTests, SOURCES } from "../netlify/functions/_shared/tile-badge-sources.mjs";
import { BADGED_SLUGS, isDashboardRoot } from "../netlify/edge-functions/lib/tile-badges.js";

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// ── pure ────────────────────────────────────────────────────────────────────

test("times: counts keys newer than the cursor", () => {
  const snap = { kind: "times", keys: [5000, 4000, 3000, 2000], limit: 100 };
  assert.deepEqual(countNew(snap, 3000), { count: 2, capped: false });
  assert.deepEqual(countNew(snap, 5000), { count: 0, capped: false });
});

test("times: works on Jotform-style strings", () => {
  const snap = { kind: "times", keys: ["2026-10-15 09:00:01", "2026-10-14 23:59:59", "2026-10-02 10:00:00"], limit: 100 };
  assert.equal(countNew(snap, "2026-10-14 12:00:00").count, 2);
  assert.equal(latestCursor(snap), "2026-10-15 09:00:01");
});

test("times: null cursor (nothing recent when last opened) counts everything", () => {
  assert.equal(countNew({ kind: "times", keys: [3, 2, 1], limit: 100 }, null).count, 3);
  assert.equal(latestCursor({ kind: "times", keys: [] }), null);
});

test("times: no record → 0 (caller baselines)", () => {
  assert.equal(countNew({ kind: "times", keys: [3, 2, 1] }, undefined).count, 0);
});

test("times: a full page of new items is capped", () => {
  const keys = Array.from({ length: 100 }, (_, i) => 1000 - i);
  const n = countNew({ kind: "times", keys, limit: 100 }, 0);
  assert.deepEqual(n, { count: 100, capped: true });
  assert.equal(badgeLabel(n), "99+");
});

test("times: cursor of the wrong type is ignored, not mis-compared", () => {
  assert.equal(countNew({ kind: "times", keys: [5000] }, "2026-10-15 00:00:00").count, 0);
});

test("counter: difference, never negative", () => {
  assert.equal(countNew({ kind: "counter", value: 12 }, 9).count, 3);
  assert.equal(countNew({ kind: "counter", value: 2 }, 9).count, 0);
  assert.equal(latestCursor({ kind: "counter", value: 12 }), 12);
});

test("labels", () => {
  assert.equal(badgeLabel({ count: 0 }), "");
  assert.equal(badgeLabel({ count: 7 }), "7");
  assert.equal(badgeLabel({ count: 150 }), "99+");
});

test("dashboard root detection", () => {
  assert.ok(isDashboardRoot("/invoices", "invoices"));
  assert.ok(isDashboardRoot("/invoices/", "invoices"));
  assert.ok(isDashboardRoot("/invoices/index.html", "invoices"));
  assert.ok(isDashboardRoot("/Invoices/", "invoices"));
  assert.ok(!isDashboardRoot("/apply-form/quiz.html", "apply-form"));
  assert.ok(!isDashboardRoot("/invoices-old/", "invoices"));
});

test("every badged slug has a source and vice versa", () => {
  assert.deepEqual([...BADGED_SLUGS].sort(), Object.keys(SOURCES).sort());
});

// ── handler, end to end with fakes ──────────────────────────────────────────

function memStore() {
  const m = new Map();
  return {
    m,
    async get(k) { return m.has(k) ? JSON.parse(m.get(k)) : null; },
    async setJSON(k, v) { m.set(k, JSON.stringify(v)); },
  };
}

const jotformSubs = {}; // formId -> [created_at…]
let identity = { email: "amy@pacificdiscovery.org", app_metadata: { roles: ["admissions"] } };

globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.endsWith("/.netlify/identity/user")) {
    return new Response(JSON.stringify(identity), { status: identity ? 200 : 401 });
  }
  const m = u.match(/api\.jotform\.com\/form\/(\d+)\/submissions/);
  if (m) {
    const content = (jotformSubs[m[1]] || []).map((c, i) => ({ id: String(i), created_at: c, status: "ACTIVE" }));
    return new Response(JSON.stringify({ responseCode: 200, content }), { status: 200 });
  }
  return new Response("not found", { status: 404 });
};
process.env.URL = "https://dash.test";
process.env.JOTFORM_API_KEY = "k";
process.env.NETLIFY_DATABASE_URL = "postgres://fake";

let applicationTimes = [];
_setDepsForTests({
  fetchImpl: (...a) => globalThis.fetch(...a),
  sql: { query: async (text) => (/FROM applications/.test(text) ? applicationTimes.map((t) => ({ t: String(t) })) : []) },
});
const store = memStore();
_setStoreForTests(store);

const { default: handler, _clearSnapCacheForTests: clearCache } = await import("../netlify/functions/tile-badges.mjs");
const call = (method, body) => handler(new Request("https://dash.test/api/tile-badges", {
  method,
  headers: { cookie: "nf_jwt=tok-" + (identity?.email || "none"), "Content-Type": "application/json" },
  body: body ? JSON.stringify(body) : undefined,
}));

test("unauthenticated → 401", async () => {
  const saved = identity; identity = null;
  const res = await call("GET");
  identity = saved;
  assert.equal(res.status, 401);
});

test("first load baselines; new submissions then show; opening clears", async () => {
  applicationTimes = [1000, 900];
  jotformSubs["261337066421856"] = ["2026-10-10 10:00:00"];

  let r = await (await call("GET")).json();
  assert.equal(r.badges["apply-form"].count, 0, "baseline on first sight");
  assert.equal(r.badges["student-uploads"].count, 0);

  // Two applications and one upload arrive.
  applicationTimes = [3000, 2000, 1000, 900];
  jotformSubs["261337066421856"] = ["2026-10-15 08:00:00", "2026-10-10 10:00:00"];
  clearCache();
  r = await (await call("GET")).json();
  assert.equal(r.badges["apply-form"].count, 2);
  assert.equal(r.badges["apply-form"].label, "2");
  assert.equal(r.badges["student-uploads"].count, 1);

  // Opening Apply Form clears its bubble only.
  const seenRes = await call("POST", { slug: "apply-form" });
  assert.equal(seenRes.status, 200);
  r = await (await call("GET")).json();
  assert.equal(r.badges["apply-form"].count, 0);
  assert.equal(r.badges["student-uploads"].count, 1);
});

test("only dashboards the person may open are counted", async () => {
  const r = await (await call("GET")).json();
  // admissions (role fallback, no grants blob in tests) can open apply-form
  // and student-uploads, but not invoices or ue-applications (admin-only).
  assert.ok("apply-form" in r.badges);
  assert.ok(!("invoices" in r.badges));
  assert.ok(!("ue-applications" in r.badges));
});

test("marking a dashboard you can't open is refused", async () => {
  const res = await call("POST", { slug: "invoices" });
  assert.equal(res.status, 403);
});

test("bumpBadgeCounter increments and never throws", async () => {
  assert.equal(await bumpBadgeCounter("instructor-checkins", 1, store), 1);
  assert.equal(await bumpBadgeCounter("instructor-checkins", 1, store), 2);
  const broken = { get: async () => { throw new Error("down"); }, setJSON: async () => { throw new Error("down"); } };
  assert.equal(await bumpBadgeCounter("instructor-checkins", 1, broken), null);
});

// ── run ─────────────────────────────────────────────────────────────────────

let failed = 0;
for (const [name, fn] of tests) {
  try { await fn(); console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n    ${e.stack || e.message}`); }
}
console.log(failed ? `\n${failed} failed` : `\nall ${tests.length} passed`);
process.exit(failed ? 1 : 0);

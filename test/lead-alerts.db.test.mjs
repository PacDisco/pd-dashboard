/**
 * Database-backed test for the Lead Alerts scan: real PostgreSQL, fake HubSpot,
 * fake push. Covers go-live baseline, each alert type, the HubSpot de-dupe,
 * idempotency (a second scan never re-pings), the red-bubble count, reminders,
 * auto-closing from HubSpot activity, dead and revoked subscriptions, and the
 * summary notification.
 *
 * NOT part of `npm test` — it needs a database and the `pg` package:
 *
 *   initdb -D /tmp/pgd -U postgres --auth=trust
 *   pg_ctl -D /tmp/pgd -o "-k /tmp/pgrun -p 5433" start
 *   DATABASE_URL="postgres://postgres@localhost:5433/postgres?host=/tmp/pgrun" \
 *     node test/lead-alerts.db.test.mjs
 *
 * Runs in a throwaway schema that is dropped on the way out.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const URL_ = process.env.DATABASE_URL;
if (!URL_) { console.log("SKIP lead-alerts.db — set DATABASE_URL to a scratch PostgreSQL."); process.exit(0); }
let pg;
try { pg = require(process.env.PG_MODULE || "pg"); } catch { console.log("SKIP lead-alerts.db — `npm i pg` (not a site dependency)."); process.exit(0); }

process.env.HUBSPOT_TOKEN = "test-token";
const LA = await import("../netlify/functions/_shared/lead-alerts.mjs");

const client = new pg.Client({ connectionString: URL_ });
await client.connect();
const SCHEMA = `lead_alerts_test_${process.pid}`;
await client.query(`CREATE SCHEMA ${SCHEMA}`);
await client.query(`SET search_path TO ${SCHEMA}, public`);
for (const f of ["MIGRATION-apply.sql", "MIGRATION-quiz.sql"]) await client.query(fs.readFileSync(path.join(root, f), "utf8"));
const sql = { query: (t, p) => client.query(t, p).then((r) => r.rows) };
const one = async (t, p) => (await sql.query(t, p))[0];

// ── fakes ───────────────────────────────────────────────────────────────────
const hub = { leads: [], contacts: {}, activity: {} };   // leads: [{id, email, first, last, newAt}]
const pushes = [];
let pushFail = {};                                       // endpoint → statusCode
const fetchImpl = async (url, init) => {
  const body = JSON.parse(init.body);
  const ok = (j) => ({ ok: true, status: 200, json: async () => j, text: async () => JSON.stringify(j) });
  if (url.endsWith("/contacts/search")) {
    const f = body.filterGroups[0].filters;
    const emailIn = f.find((x) => x.propertyName === "email");
    if (emailIn) {
      return ok({ results: Object.entries(hub.contacts).filter(([, c]) => emailIn.values.includes(c.email))
        .map(([id, c]) => ({ id, properties: { email: c.email, phone: c.phone || "" } })) });
    }
    const since = Number(f.find((x) => x.propertyName === "lastmodifieddate").value);
    return ok({ results: hub.leads.filter((l) => l.newAt >= since).map((l) => ({ id: l.id })) });
  }
  if (url.endsWith("/contacts/batch/read")) {
    const ids = body.inputs.map((i) => i.id);
    if (body.properties.includes("notes_last_contacted")) {
      return ok({ results: ids.map((id) => ({ id, properties: hub.activity[id] || { hs_lead_status: "NEW" },
        propertiesWithHistory: { hs_lead_status: [{ value: (hub.activity[id] || {}).hs_lead_status || "NEW", timestamp: (hub.activity[id] || {}).changedAt || "2000-01-01T00:00:00Z" }] } })) });
    }
    return ok({ results: ids.map((id) => {
      const l = hub.leads.find((x) => x.id === id);
      return { id, properties: { email: l.email, firstname: l.first, lastname: l.last, recent_conversion_event_name: "Booklet download", hs_analytics_source: "PAID_SOCIAL" },
        propertiesWithHistory: { hs_lead_status: [{ value: "NEW", timestamp: new Date(l.newAt).toISOString() }] } };
    }) });
  }
  throw new Error("unexpected fetch " + url);
};
const push = async (sub, payload) => {
  if (pushFail[sub.endpoint]) throw Object.assign(new Error("push failed"), { statusCode: pushFail[sub.endpoint] });
  pushes.push({ to: sub.endpoint, ...JSON.parse(payload) });
};
const access = (email) => email !== "revoked@pd.org";
LA._setDepsForTests({ sql, fetchImpl, push, access });

const sub = (n) => ({ endpoint: `https://push.example/${n}`, keys: { p256dh: "p", auth: "a" } });
const ago = (min) => new Date(Date.now() - min * 60_000).toISOString();
const quiet = { warn() {}, log() {} };

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// ── scenario ────────────────────────────────────────────────────────────────
test("first scan sets the go-live baseline and alerts nothing that came before", async () => {
  await sql.query(`INSERT INTO applications (token_hash, email, first_name, created_at, step1_at) VALUES ('t0', 'old@x.com', 'Old', now() - interval '10 minutes', now() - interval '10 minutes')`);
  const r = await LA.runScan({ log: quiet });
  assert.equal(r.inserted, 0);
  assert.ok(await one(`SELECT value FROM lead_alert_state WHERE key = 'since'`));
  // Pretend we went live an hour ago so the rest of the scenario has room.
  await sql.query(`UPDATE lead_alert_state SET value = jsonb_build_object('at', (now() - interval '60 minutes')::text) WHERE key = 'since'`);
  await sql.query(`DELETE FROM applications`);
});

test("subscriptions are stored per phone", async () => {
  await LA.saveSubscription("Advisor@pd.org", ["admissions"], sub("phone"), "iPhone");
  await LA.saveSubscription("advisor@pd.org", ["admissions"], sub("laptop"), "Chrome");
  await LA.saveSubscription("revoked@pd.org", ["admissions"], sub("revoked"), "iPhone");
  await assert.rejects(LA.saveSubscription("a@pd.org", [], { endpoint: "http://insecure" }), /Invalid push subscription/);
  assert.equal((await LA.subscriptionsFor("advisor@pd.org")).length, 2);
});

test("application, quiz and HubSpot lead each alert once; the app's own HubSpot ping is folded in", async () => {
  await sql.query(`INSERT INTO applications (token_hash, email, first_name, last_name, program, term, travel_year, answers, created_at, step1_at)
                   VALUES ('t1', 'jane@x.com', 'Jane', 'Doe', 'Southeast Asia Semester', 'Fall', '2027', '{"phone":"+1 555 0100"}', now() - interval '5 minutes', now() - interval '5 minutes')`);
  await sql.query(`INSERT INTO quiz_responses (email, first_name, last_name, phone, archetype, created_at) VALUES ('sam@x.com', 'Sam', 'Lee', '+1 555 0200', 'The Explorer', now() - interval '3 minutes')`);
  hub.contacts["901"] = { email: "jane@x.com", phone: "" };
  hub.leads.push({ id: "901", email: "jane@x.com", first: "Jane", last: "Doe", newAt: Date.now() - 4 * 60_000 });   // pd-apply's reset → suppressed
  hub.leads.push({ id: "902", email: "kai@x.com", first: "Kai", last: "Moana", newAt: Date.now() - 2 * 60_000 });   // booklet download → alert
  hub.leads.push({ id: "903", email: "stale@x.com", first: "S", last: "T", newAt: Date.now() - 90 * 60_000 });      // before go-live → ignored

  const r = await LA.runScan({ log: quiet });
  assert.deepEqual(r.errors, []);
  assert.equal(r.inserted, 3);
  assert.equal(r.suppressed, 1);
  const rows = await sql.query(`SELECT id, type, name, phone, contact_id, detail FROM lead_alert_events ORDER BY occurred_at`);
  assert.deepEqual(rows.map((x) => x.type), ["app_started", "quiz", "new_lead"]);
  assert.equal(rows[0].contact_id, "901", "HubSpot id filled in by email");
  assert.equal(rows[0].phone, "+1 555 0100");
  assert.equal(rows[0].detail, "Southeast Asia Semester · Fall 2027");
  assert.equal(rows[1].detail, "Result: The Explorer");

  // 3 alerts → 3 separate notifications to each of the advisor's 2 devices; none to the revoked user.
  assert.equal(pushes.length, 6);
  assert.ok(pushes.every((p) => !p.to.endsWith("revoked")));
  assert.equal(await one(`SELECT count(*)::int AS n FROM lead_alert_subs WHERE email = 'revoked@pd.org'`).then((x) => x.n), 0, "revoked access → subscription removed");
  assert.deepEqual(pushes.filter((p) => p.to.endsWith("phone")).map((p) => p.badge), [3, 3, 3], "badge = unseen alerts");
  assert.ok(pushes.some((p) => p.title === "New lead: Kai Moana"));
});

test("a second scan is idempotent — nothing re-pings", async () => {
  pushes.length = 0;
  const r = await LA.runScan({ log: quiet });
  assert.equal(r.inserted, 0);
  assert.equal(pushes.length, 0);
});

test("opening the app clears the bubble; submitting the full application alerts again", async () => {
  await LA.markSeen("ADVISOR@pd.org");
  let feed = await LA.feedFor("advisor@pd.org");
  assert.equal(feed.newCount, 0);
  assert.equal(feed.events.length, 3);

  await sql.query(`UPDATE applications SET step2_at = now(), status = 'step2' WHERE token_hash = 't1'`);
  pushes.length = 0;
  await LA.runScan({ log: quiet });
  const p = pushes.find((x) => x.to.endsWith("phone"));
  assert.equal(p.title, "Application submitted: Jane Doe");
  assert.equal(p.badge, 1);
  feed = await LA.feedFor("advisor@pd.org");
  assert.equal(feed.newCount, 1);
  assert.equal(feed.events.find((e) => e.isNew).type, "app_submitted");
});

test("marking contacted closes it, undo reopens it", async () => {
  const id = (await one(`SELECT id FROM lead_alert_events WHERE type = 'quiz'`)).id;
  const done = await LA.setHandled(id, "Megan");
  assert.equal(done.handledBy, "Megan");
  assert.ok(done.handledAt);
  const again = await LA.setHandled(id, "Someone else");
  assert.equal(again.handledBy, "Megan", "first close wins");
  const undone = await LA.setHandled(id, "Megan", true);
  assert.equal(undone.handledAt, null);
  await LA.setHandled(id, "Megan");
});

test("HubSpot activity after the alert closes it automatically", async () => {
  hub.activity["902"] = { notes_last_contacted: new Date().toISOString(), hs_lead_status: "NEW" };
  const r = await LA.runScan({ log: quiet });
  assert.equal(r.autoClosed, 1);
  const row = await one(`SELECT handled_by, handled_how FROM lead_alert_events WHERE contact_id = '902'`);
  assert.deepEqual(row, { handled_by: "HubSpot", handled_how: "Contact logged in HubSpot" });
});

test("one reminder for an alert still open after 45 minutes", async () => {
  await sql.query(`INSERT INTO quiz_responses (email, first_name, created_at) VALUES ('slow@x.com', 'Slow', now() - interval '10 minutes')`);
  await LA.runScan({ log: quiet });
  // Time passes: it's now 50 minutes old and nobody has followed up.
  await sql.query(`UPDATE lead_alert_events SET occurred_at = now() - interval '50 minutes', detected_at = now() - interval '48 minutes' WHERE email = 'slow@x.com'`);
  pushes.length = 0;
  const r1 = await LA.runScan({ log: quiet });
  assert.equal(r1.reminders, 1);
  assert.ok(pushes.some((p) => p.title === "Still waiting: Slow"));
  pushes.length = 0;
  const r2 = await LA.runScan({ log: quiet });
  assert.equal(r2.reminders, 0);
  assert.equal(pushes.length, 0);
});

test("something first spotted late gets one ping, not a ping plus a reminder", async () => {
  await sql.query(`INSERT INTO quiz_responses (email, first_name, created_at) VALUES ('late@x.com', 'Late', now() - interval '55 minutes')`);
  pushes.length = 0;
  const r = await LA.runScan({ log: quiet });
  assert.equal(r.inserted, 1);
  assert.equal(r.reminders, 0);
  assert.equal(pushes.filter((p) => p.to.endsWith("phone")).length, 1);
});

test("a dead subscription (410) is removed", async () => {
  pushFail[sub("laptop").endpoint] = 410;
  const r = await LA.testPush("advisor@pd.org");
  assert.equal(r.sent, 1);
  assert.equal((await LA.subscriptionsFor("advisor@pd.org")).length, 1);
  pushFail = {};
});

test("more than three at once → one summary notification", async () => {
  for (let i = 0; i < 5; i++) {
    await sql.query(`INSERT INTO quiz_responses (email, first_name, created_at) VALUES ($1, $2, now() - interval '1 minute')`, [`b${i}@x.com`, `B${i}`]);
  }
  pushes.length = 0;
  await LA.runScan({ log: quiet });
  assert.equal(pushes.length, 1);
  assert.equal(pushes[0].title, "5 new leads to follow up");
});

test("stats + tile-badge times", async () => {
  const feed = await LA.feedFor("advisor@pd.org");
  assert.equal(feed.stats.handled, 2);
  assert.ok(feed.stats.open >= 6);
  const times = await LA.recentAlertTimes();
  assert.equal(times.length, feed.events.length);
});

test("outside her hours: nothing pushed; when they start, one digest; reminder 45 min into her day", async () => {
  // A zone where it's not 23:xx right now, and hours that start at the top of the next hour.
  const utcH = new Date().getUTCHours();
  const n = [0, 3, 6, 9, 12].find((k) => (utcH + k) % 24 <= 21);
  const tz = n === 0 ? "UTC" : `Etc/GMT-${n}`;
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", hour: "2-digit", weekday: "short" }).formatToParts(new Date());
  const h = Number(parts.find((x) => x.type === "hour").value);
  const dow = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.find((x) => x.type === "weekday").value);
  const start = `${String(h + 1).padStart(2, "0")}:00`;
  const days = Array.from({ length: 7 }, (_, d) => (d === dow ? [{ s: start, e: "24:00" }] : [{ s: "00:00", e: "24:00" }]));
  const tOn = Math.ceil((Date.now() + 1) / 3600_000) * 3600_000 + 60_000;   // 1 min after the next hour

  const prefs = await LA.savePrefs("advisor@pd.org", { tz, schedule: { days } });
  assert.equal(prefs.availableNow, false);
  assert.equal(prefs.nextChangeAt, new Date(tOn - 60_000).toISOString());
  await assert.rejects(LA.savePrefs("advisor@pd.org", { tz: "Mars/Olympus", schedule: null }), /time zone/);

  await sql.query(`INSERT INTO quiz_responses (email, first_name, last_name, created_at) VALUES ('night@x.com', 'Nora', 'Night', now())`);
  pushes.length = 0;
  const r1 = await LA.runScan({ log: quiet });
  assert.equal(r1.inserted, 1);
  assert.equal(pushes.filter((p) => p.to.endsWith("phone")).length, 0, "held while she's off");
  assert.equal(r1.pushed.held, 1);

  // Feed: its hour starts when her hours do.
  const feed = await LA.feedFor("advisor@pd.org");
  const ev = feed.events.find((e) => e.email === "night@x.com");
  assert.equal(ev.offHours, true);
  assert.equal(ev.dueAt, new Date(tOn - 60_000 + 3600_000).toISOString());

  pushes.length = 0;
  const r2 = await LA.runScan({ log: quiet, now: tOn });
  assert.equal(r2.digests, 1);
  const digest = pushes.filter((p) => p.to.endsWith("phone"));
  assert.equal(digest.length, 1);
  // Only what arrived while she was off — not the older open alerts she already had.
  assert.equal(digest[0].title, "While you were off: Nora Night");
  assert.match(digest[0].body, /^Quiz completed — still waiting for a follow-up$/);

  pushes.length = 0;
  const r3 = await LA.runScan({ log: quiet, now: tOn + 10 * 60_000 });
  assert.equal(r3.digests, 0, "digest only once");
  assert.equal(r3.reminders, 0);

  pushes.length = 0;
  const r4 = await LA.runScan({ log: quiet, now: tOn + 46 * 60_000 });
  assert.ok(r4.reminders >= 1);
  assert.ok(pushes.some((p) => p.to.endsWith("phone") && /still waiting/i.test(p.title)));

  const back = await LA.savePrefs("advisor@pd.org", { tz, schedule: null });
  assert.equal(back.always, true);
  assert.equal(back.availableNow, true);
});

let failed = 0;
try {
  for (const [name, fn] of tests) {
    try { await fn(); console.log(`  ✓ ${name}`); }
    catch (e) { failed++; console.error(`  ✗ ${name}\n    ${e.stack || e.message}`); }
  }
} finally {
  await client.query(`DROP SCHEMA ${SCHEMA} CASCADE`);
  await client.end();
}
console.log(failed ? `\n${failed} failed` : `\nall ${tests.length} passed`);
process.exit(failed ? 1 : 0);

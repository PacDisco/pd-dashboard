// npm run test:checkins
// Instructor check-ins: slot maths, config validation, access, the portal key,
// and the slots/book handlers end to end with Google + Blobs stubbed. No network.
import test from "node:test";
import assert from "node:assert/strict";
import {
  zonedToUtc, utcToZoned, localIso, weeklyOccurrences, candidateSlots, isFree, checkConfig,
  DEFAULT_CONFIG, portalKeyOk, signState, verifyState, publicPeople, _setStoreForTests,
} from "../netlify/functions/_shared/checkins.mjs";
import { requireManager } from "../netlify/functions/_shared/checkins-access.mjs";
import { applyAction } from "../netlify/functions/checkins-admin.mjs";
import slots from "../netlify/functions/checkins-slots.mjs";
import book, { checkBooking, buildEvent } from "../netlify/functions/checkins-book.mjs";
import mine from "../netlify/functions/checkins-mine.mjs";

const TZ = "Pacific/Auckland";
const KEY = "k".repeat(32);
process.env.INSTRUCTOR_PORTAL_KEY = KEY;
process.env.CHECKINS_GOOGLE_CLIENT_ID = "cid";
process.env.CHECKINS_GOOGLE_CLIENT_SECRET = "csecret";

// ── in-memory Blobs + Google stub ──
let DB = {};
_setStoreForTests({ get: async (k) => DB[k] ?? null, setJSON: async (k, v) => { DB[k] = structuredClone(v); } });
let BUSY = [], CALLS = [];
globalThis.fetch = async (url, init = {}) => {
  url = String(url); CALLS.push({ url, init });
  const r = (b, s = 200) => new Response(JSON.stringify(b), { status: s });
  if (url.includes("oauth2.googleapis.com/token")) return r({ access_token: "at", expires_in: 3600 });
  if (url.includes("/freeBusy")) return r({ calendars: { primary: { busy: BUSY } } });
  if (url.includes("/events") && (init.method || "GET") === "GET") return r({ items: [
    { id: "a", start: { dateTime: "2026-10-13T09:00:00+13:00" }, end: { dateTime: "2026-10-13T09:20:00+13:00" }, recurringEventId: "s", hangoutLink: "https://meet.google.com/x",
      extendedProperties: { private: { instructorEmail: "ana@gmail.com" } }, attendees: [{ email: "ana@gmail.com" }] },
    { id: "b", status: "cancelled", start: { dateTime: "2026-10-14T09:00:00+13:00" } },
  ] });
  if (url.includes("/events")) return r({ id: "ev1", hangoutLink: "https://meet.google.com/x" });
  throw new Error("unexpected fetch " + url);
};
const portal = (path, init = {}) => new Request(`https://dash.test${path}`, { ...init, headers: { "x-pd-service-key": KEY, "content-type": "application/json", ...(init.headers || {}) } });
const seed = (config = {}) => {
  DB.settings = {
    people: [
      { email: "jake@boulderdigitalmedia.com", name: "Jake", host: true, checkAvailability: true, refresh_token: "rt-host" },
      { email: "zach@pacificdiscovery.org", name: "Zach", host: false, checkAvailability: false },
    ],
    config: { ...DEFAULT_CONFIG, ...config },
  };
};

test("time zones and daylight saving", () => {
  assert.equal(new Date(zonedToUtc(2026, 10, 13, 9, 0, TZ)).toISOString(), "2026-10-12T20:00:00.000Z"); // NZDT
  assert.equal(new Date(zonedToUtc(2026, 4, 7, 9, 0, TZ)).toISOString(), "2026-04-06T21:00:00.000Z");   // NZST
  const occ = weeklyOccurrences(zonedToUtc(2026, 3, 24, 9, 0, TZ), 3, TZ).map((t) => localIso(utcToZoned(t, TZ)));
  assert.deepEqual(occ, ["2026-03-24T09:00:00", "2026-03-31T09:00:00", "2026-04-07T09:00:00"]);
});

test("candidate slots respect hours, step and notice", () => {
  const now = Date.parse("2026-10-08T00:00:00Z"); // Thu 13:00 NZDT
  const s = candidateSlots(DEFAULT_CONFIG, now).map((t) => localIso(utcToZoned(t, TZ)));
  assert.equal(s[0], "2026-10-13T09:00:00");
  assert.equal(s[1], "2026-10-13T09:30:00"); // 20 min + 10 buffer
  assert.ok(!s.some((x) => x.startsWith("2026-10-08"))); // today's Thu 13:00–16:00 window falls inside the 12h notice
  assert.equal(s.length, 24);
});

test("isFree pads by buffer", () => {
  const busy = [[1000 * 60 * 60, 1000 * 60 * 80]]; // 60–80 min
  assert.equal(isFree(busy, 85 * 60e3, 105 * 60e3, 10), false);
  assert.equal(isFree(busy, 90 * 60e3, 110 * 60e3, 10), true);
});

test("config validation", () => {
  assert.ok(checkConfig({ duration: 5 }).error);
  assert.ok(checkConfig({ hours: { 2: ["12:00-09:00"] } }).error);
  assert.ok(checkConfig({ hours: { 8: ["09:00-10:00"] } }).error);
  assert.ok(checkConfig({ tz: "Mars/Olympus" }).error);
  const ok = checkConfig({ hours: { 1: [" 09:00 - 11:00 ", ""], 3: [] }, duration: 30, calendarId: "abc@group.calendar.google.com" });
  assert.deepEqual(ok.config.hours, { 1: ["09:00-11:00"] });
  assert.equal(ok.config.duration, 30);
});

test("portal key and oauth state", () => {
  assert.equal(portalKeyOk(new Request("https://x", { headers: { "x-pd-service-key": KEY } })), true);
  assert.equal(portalKeyOk(new Request("https://x", { headers: { "x-pd-service-key": "nope" } })), false);
  assert.equal(portalKeyOk(new Request("https://x")), false);
  const st = signState({ email: "a@b.c" });
  assert.equal(verifyState(st).email, "a@b.c");
  assert.equal(verifyState(st.slice(0, -2) + "xx"), null);
  assert.equal(verifyState("garbage"), null);
});

test("refresh tokens never leave the server", () => {
  seed();
  assert.ok(!JSON.stringify(publicPeople(DB.settings)).includes("rt-host"));
});

test("manager access", async () => {
  const req = new Request("https://dash.test/api/checkins/admin");
  const inputs = async () => ({ grants: null, dashboard: { slug: "instructor-checkins", allowedRoles: ["admin", "programs", "operations"] } });
  assert.equal((await requireManager(req, "t", { verifiedUser: async () => null, accessInputs: inputs })).status, 401);
  assert.equal((await requireManager(req, "t", { verifiedUser: async () => ({ email: "a@x", roles: ["outreach"] }), accessInputs: inputs })).status, 403);
  const ok = await requireManager(req, "t", { verifiedUser: async () => ({ email: "a@x", roles: ["programs"], name: "A" }), accessInputs: inputs });
  assert.equal(ok.actor, "A");
});

test("admin actions", () => {
  seed();
  const s = DB.settings;
  assert.ok(applyAction(s, { action: "add", email: "bad" }));
  assert.equal(applyAction(s, { action: "add", email: "Megan@PacificDiscovery.org", name: "Megan" }), null);
  assert.equal(s.people.at(-1).email, "megan@pacificdiscovery.org");
  assert.ok(applyAction(s, { action: "setHost", email: "zach@pacificdiscovery.org" }), "can't host without a connection");
  assert.ok(applyAction(s, { action: "remove", email: "jake@boulderdigitalmedia.com" }), "can't remove the host");
  assert.equal(applyAction(s, { action: "config", config: { calendarId: "team@group.calendar.google.com" } }), null);
  assert.equal(s.config.calendarId, "team@group.calendar.google.com");
  assert.equal(applyAction(s, { action: "remove", email: "megan@pacificdiscovery.org" }), null);
});

test("slots handler", async () => {
  assert.equal((await slots(new Request("https://dash.test/api/checkins/slots"))).status, 403);
  DB = {};
  assert.equal((await slots(portal("/api/checkins/slots"))).status, 503);
  seed({ leadHours: 0, horizonDays: 21 });
  BUSY = [];
  const a = await (await slots(portal("/api/checkins/slots"))).json();
  assert.ok(a.slots.length > 0);
  BUSY = [{ start: a.slots[0], end: new Date(Date.parse(a.slots[0]) + 20 * 60e3).toISOString() }];
  const b = await (await slots(portal("/api/checkins/slots"))).json();
  assert.ok(!b.slots.includes(a.slots[0]));
  assert.ok(b.slots.includes(a.slots[1]));
});

test("book handler", async () => {
  seed({ leadHours: 0, horizonDays: 21 });
  BUSY = [];
  const { slots: open } = await (await slots(portal("/api/checkins/slots"))).json();
  const post = (body) => book(portal("/api/checkins/book", { method: "POST", body: JSON.stringify(body) }));

  assert.equal((await post({ start: open[0], name: "", email: "x" })).status, 400);
  assert.equal((await post({ start: "2026-10-13T20:07:00Z", name: "Ana", email: "ana@gmail.com" })).status, 409);

  BUSY = [{ start: open[0], end: new Date(Date.parse(open[0]) + 20 * 60e3).toISOString() }];
  assert.equal((await post({ start: open[0], name: "Ana", email: "ana@gmail.com" })).status, 409);

  BUSY = []; CALLS = [];
  const res = await post({ start: open[0], name: "Ana", email: "Ana@Gmail.com", notes: "hi", repeatWeeks: 6 });
  assert.equal(res.status, 200);
  const ev = JSON.parse(CALLS.find((c) => c.url.includes("/events")).init.body);
  assert.deepEqual(ev.attendees.map((a) => a.email), ["ana@gmail.com", "zach@pacificdiscovery.org"]);
  assert.deepEqual(ev.recurrence, ["RRULE:FREQ=WEEKLY;COUNT=6"]);
  assert.equal(ev.guestsCanModify, true);
  assert.equal(ev.start.timeZone, TZ);
  assert.ok(CALLS.find((c) => c.url.includes("/events")).url.includes("sendUpdates=all"));
});

test("pure booking helpers", () => {
  const cfg = { ...DEFAULT_CONFIG, leadHours: 0 };
  const now = Date.parse("2026-10-08T00:00:00Z");
  const start = candidateSlots(cfg, now)[0];
  const c = checkBooking({ start: new Date(start).toISOString(), name: "A", email: "a@b.co", repeatWeeks: 99 }, cfg, now);
  assert.equal(c.booking.repeat, cfg.maxRepeat);
  const ev = buildEvent(c.booking, cfg, []);
  assert.equal(ev.recurrence[0], `RRULE:FREQ=WEEKLY;COUNT=${cfg.maxRepeat}`);
});

test("mine handler filters to one instructor", async () => {
  seed(); CALLS = [];
  assert.equal((await mine(new Request("https://dash.test/api/checkins/mine?email=ana@gmail.com"))).status, 403);
  assert.equal((await mine(portal("/api/checkins/mine"))).status, 400);
  const d = await (await mine(portal("/api/checkins/mine?email=Ana@Gmail.com"))).json();
  assert.equal(d.checkins.length, 1);
  assert.equal(d.checkins[0].recurring, true);
  const q = new URL(CALLS.find((c) => c.url.includes("/events")).url).searchParams.getAll("privateExtendedProperty");
  assert.deepEqual(q, ["source=instructor-portal", "instructorEmail=ana@gmail.com"]);
});

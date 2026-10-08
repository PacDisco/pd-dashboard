// netlify/functions/_shared/checkins.mjs
//
// Instructor check-ins: Google Calendar plumbing, slot maths and storage.
// See INSTRUCTOR-CHECKINS.md.
//
// Each connected staff member signs in with their own Google account (any
// domain) via /api/checkins/oauth. Their refresh token is kept in Netlify Blobs
// (store "instructor-checkins", key "settings") and used to read THEIR OWN
// free/busy, so no calendar sharing between Workspace domains is needed. The
// host's token also creates the events.
//
// No googleapis here on purpose: four REST calls, and plain fetch keeps the
// bundle small and the tests trivially mockable (stub globalThis.fetch).

import crypto from "node:crypto";
import { getStore } from "@netlify/blobs";

// ───────────────────────────── settings ─────────────────────────────

export const DEFAULT_CONFIG = Object.freeze({
  calendarId: "primary",              // a calendar the host can write to
  hours: { 2: ["09:00-12:00"], 4: ["13:00-16:00"] }, // ISO weekday → windows, in tz
  tz: "Pacific/Auckland",
  duration: 20,                       // minutes
  buffer: 10,                         // minutes kept clear around other meetings
  leadHours: 12,                      // minimum notice
  horizonDays: 14,                    // how far ahead instructors can book
  maxRepeat: 12,                      // longest weekly series
  title: "Instructor weekly check-in",
});

let _storeOverride = null;
export function _setStoreForTests(s) { _storeOverride = s; }

function store() {
  if (_storeOverride) return _storeOverride;
  try {
    return getStore({ name: "instructor-checkins", consistency: "strong" });
  } catch {
    const siteID = process.env.NETLIFY_SITE_ID || process.env.SITE_ID;
    const token = process.env.NETLIFY_BLOBS_TOKEN || process.env.NETLIFY_API_TOKEN;
    return getStore({ name: "instructor-checkins", consistency: "strong", siteID, token });
  }
}

/** { people: [{ email, name, host, checkAvailability, refresh_token?, connectedAt? }], config } */
export async function getSettings() {
  const raw = (await store().get("settings", { type: "json" })) || {};
  return {
    people: Array.isArray(raw.people) ? raw.people : [],
    config: { ...DEFAULT_CONFIG, ...(raw.config || {}) },
  };
}
export async function saveSettings(settings) {
  await store().setJSON("settings", settings);
}

export const hostOf = (settings) => settings.people.find((p) => p.host && p.refresh_token) || null;

/** Never send refresh tokens to a browser. */
export const publicPeople = (settings) =>
  settings.people.map(({ refresh_token, ...p }) => ({ ...p, connected: !!refresh_token }));

/** Validate a config patch from the settings page. Returns { config } or { error }. */
export function checkConfig(patch, current = DEFAULT_CONFIG) {
  const c = { ...current };
  const intIn = (k, lo, hi) => {
    if (patch[k] === undefined) return null;
    const n = Number(patch[k]);
    if (!Number.isInteger(n) || n < lo || n > hi) return `${k} must be a whole number from ${lo} to ${hi}`;
    c[k] = n; return null;
  };
  const errs = [
    intIn("duration", 10, 120), intIn("buffer", 0, 60), intIn("leadHours", 0, 168),
    intIn("horizonDays", 1, 60), intIn("maxRepeat", 1, 26),
  ].filter(Boolean);
  if (patch.title !== undefined) {
    const t = String(patch.title).trim();
    if (!t || t.length > 120) errs.push("title must be 1–120 characters"); else c.title = t;
  }
  if (patch.calendarId !== undefined) {
    const id = String(patch.calendarId).trim();
    if (!id || id.length > 300) errs.push("calendar is invalid"); else c.calendarId = id;
  }
  if (patch.tz !== undefined) {
    try { new Intl.DateTimeFormat("en", { timeZone: patch.tz }); c.tz = patch.tz; }
    catch { errs.push("time zone is invalid"); }
  }
  if (patch.hours !== undefined) {
    const out = {};
    const WIN = /^([01]\d|2[0-3]):([0-5]\d)-([01]\d|2[0-3]):([0-5]\d)$/;
    for (const [day, wins] of Object.entries(patch.hours || {})) {
      if (!/^[1-7]$/.test(day) || !Array.isArray(wins)) { errs.push("hours are invalid"); break; }
      const clean = wins.map((w) => String(w).replace(/\s/g, "")).filter(Boolean);
      for (const w of clean) {
        const m = WIN.exec(w);
        if (!m || +m[1] * 60 + +m[2] >= +m[3] * 60 + +m[4]) errs.push(`"${w}" isn't a valid time range (use 09:00-12:00)`);
      }
      if (clean.length) out[day] = clean;
    }
    c.hours = out;
  }
  return errs.length ? { error: errs[0] } : { config: c };
}

// ───────────────────────────── Google ─────────────────────────────

export function googleCreds() {
  const clientId = process.env.CHECKINS_GOOGLE_CLIENT_ID;
  const clientSecret = process.env.CHECKINS_GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error("CHECKINS_GOOGLE_CLIENT_ID / CHECKINS_GOOGLE_CLIENT_SECRET not set");
  return { clientId, clientSecret };
}

const _tokens = new Map();
export async function accessToken(person) {
  const hit = _tokens.get(person.email);
  if (hit && hit.rt === person.refresh_token && hit.exp > Date.now() + 60_000) return hit.token;
  const { clientId, clientSecret } = googleCreds();
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: person.refresh_token, grant_type: "refresh_token" }),
  });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(`Google token refresh failed for ${person.email}: ${d.error_description || d.error || res.status}`);
    err.code = d.error === "invalid_grant" ? "revoked" : "token";
    err.email = person.email;
    throw err;
  }
  _tokens.set(person.email, { token: d.access_token, rt: person.refresh_token, exp: Date.now() + d.expires_in * 1000 });
  return d.access_token;
}

async function gapi(person, path, init = {}) {
  const token = await accessToken(person);
  const res = await fetch(`https://www.googleapis.com/calendar/v3${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init.headers || {}) },
  });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(`Google Calendar ${path.split("?")[0]} failed for ${person.email}: ${d.error?.message || res.status}`);
    err.status = res.status;
    throw err;
  }
  return d;
}

/** Busy intervals [startMs, endMs] across every connected person who blocks times. */
export async function busyIntervals(settings, timeMin, timeMax) {
  const all = [];
  const CHUNK = 50 * 86400_000; // freeBusy rejects very long ranges
  const blockers = settings.people.filter((p) => p.refresh_token && (p.checkAvailability || p.host));
  for (const p of blockers) {
    const ids = p.host && settings.config.calendarId !== "primary" ? ["primary", settings.config.calendarId] : ["primary"];
    for (let s = timeMin; s < timeMax; s += CHUNK) {
      const d = await gapi(p, "/freeBusy", {
        method: "POST",
        body: JSON.stringify({
          timeMin: new Date(s).toISOString(),
          timeMax: new Date(Math.min(s + CHUNK, timeMax)).toISOString(),
          items: ids.map((id) => ({ id })),
        }),
      });
      for (const cal of Object.values(d.calendars || {})) {
        if (cal.errors?.length) throw new Error(`freeBusy error for ${p.email}: ${cal.errors[0].reason}`);
        for (const b of cal.busy || []) all.push([Date.parse(b.start), Date.parse(b.end)]);
      }
    }
  }
  return all;
}

export const isFree = (busy, start, end, bufferMin) => {
  const pad = bufferMin * 60_000;
  return !busy.some(([bs, be]) => start < be + pad && end > bs - pad);
};

/** Calendars the host can write to, for the settings dropdown. */
export async function hostCalendars(host) {
  const d = await gapi(host, "/users/me/calendarList?minAccessRole=writer&maxResults=100");
  return (d.items || []).map((c) => ({ id: c.id, name: c.summaryOverride || c.summary, primary: !!c.primary }));
}

/** Upcoming check-ins booked through the portal (one row per occurrence). */
export async function upcomingCheckins(settings, { days = 28, instructorEmail = "" } = {}) {
  const host = hostOf(settings);
  if (!host) return [];
  const now = Date.now();
  const q = new URLSearchParams({
    timeMin: new Date(now - 3600_000).toISOString(),
    timeMax: new Date(now + days * 86400_000).toISOString(),
    singleEvents: "true", orderBy: "startTime", maxResults: "100",
    privateExtendedProperty: "source=instructor-portal",
  });
  if (instructorEmail) q.append("privateExtendedProperty", `instructorEmail=${instructorEmail.toLowerCase()}`);
  const d = await gapi(host, `/calendars/${encodeURIComponent(settings.config.calendarId)}/events?${q}`);
  return (d.items || []).filter((e) => e.status !== "cancelled").map((e) => ({
    id: e.id,
    title: e.summary,
    start: e.start?.dateTime || e.start?.date,
    end: e.end?.dateTime || e.end?.date,
    instructor: e.extendedProperties?.private?.instructorEmail || "",
    guests: (e.attendees || []).map((a) => ({ email: a.email, status: a.responseStatus })),
    recurring: !!e.recurringEventId,
    meet: e.hangoutLink || null,
    link: e.htmlLink,
  }));
}

export async function createEvent(host, calendarId, event) {
  return gapi(host, `/calendars/${encodeURIComponent(calendarId)}/events?conferenceDataVersion=1&sendUpdates=all`, {
    method: "POST", body: JSON.stringify(event),
  });
}

// ───────────────────────────── time zones ─────────────────────────────

function tzOffsetMs(ts, tz) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    }).formatToParts(new Date(ts)).map((x) => [x.type, x.value])
  );
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(ts / 1000) * 1000;
}
/** Wall-clock time in tz → UTC ms. */
export function zonedToUtc(y, m, d, hh, mm, tz) {
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  let ts = guess - tzOffsetMs(guess, tz);
  const o2 = tzOffsetMs(ts, tz);
  if (guess - o2 !== ts) ts = guess - o2;
  return ts;
}
/** UTC ms → wall clock in tz. */
export function utcToZoned(ts, tz) {
  const s = new Date(ts + tzOffsetMs(ts, tz));
  return { y: s.getUTCFullYear(), m: s.getUTCMonth() + 1, d: s.getUTCDate(), hh: s.getUTCHours(), mm: s.getUTCMinutes() };
}
const addDays = (y, m, d, n) => {
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
};
const isoWeekday = (y, m, d) => new Date(Date.UTC(y, m - 1, d)).getUTCDay() || 7;
const p2 = (n) => String(n).padStart(2, "0");
export const localIso = ({ y, m, d, hh, mm }) => `${y}-${p2(m)}-${p2(d)}T${p2(hh)}:${p2(mm)}:00`;

/** Every slot start (UTC ms) the weekly hours allow, before checking calendars. */
export function candidateSlots(cfg, now = Date.now()) {
  const today = utcToZoned(now, cfg.tz);
  const earliest = now + cfg.leadHours * 3600_000;
  const out = [];
  for (let i = 0; i <= cfg.horizonDays; i++) {
    const day = addDays(today.y, today.m, today.d, i);
    for (const win of cfg.hours[isoWeekday(day.y, day.m, day.d)] || []) {
      const [from, to] = win.split("-").map((t) => t.split(":").map(Number));
      const endMins = to[0] * 60 + to[1];
      for (let mins = from[0] * 60 + from[1]; mins + cfg.duration <= endMins; mins += cfg.duration + cfg.buffer) {
        const ts = zonedToUtc(day.y, day.m, day.d, Math.floor(mins / 60), mins % 60, cfg.tz);
        if (ts >= earliest) out.push(ts);
      }
    }
  }
  return out;
}

/** Weekly occurrences at the same wall-clock time in tz (survives daylight saving). */
export function weeklyOccurrences(startTs, count, tz) {
  const z = utcToZoned(startTs, tz);
  return Array.from({ length: count }, (_, i) => {
    const d = addDays(z.y, z.m, z.d, i * 7);
    return zonedToUtc(d.y, d.m, d.d, z.hh, z.mm, tz);
  });
}

// ───────────────────────────── HTTP ─────────────────────────────

export function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers },
  });
}

/**
 * The portal calls slots/book server-to-server with the same shared secret as
 * /api/instructor-checklist. Constant-time; refuses a weak or missing key.
 */
export function portalKeyOk(req) {
  const expected = process.env.INSTRUCTOR_PORTAL_KEY || "";
  if (expected.length < 24) return false;
  const got = req.headers.get("x-pd-service-key") || "";
  const a = crypto.createHash("sha256").update(got).digest();
  const b = crypto.createHash("sha256").update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

// Signed OAuth state, so only a signed-in manager can start a calendar connection.
const stateKey = () => `checkins-oauth:${googleCreds().clientSecret}`;
export function signState(payload) {
  const body = Buffer.from(JSON.stringify({ ...payload, t: Date.now() })).toString("base64url");
  return `${body}.${crypto.createHmac("sha256", stateKey()).update(body).digest("base64url")}`;
}
export function verifyState(state) {
  const [body, sig] = String(state || "").split(".");
  if (!body || !sig) return null;
  const expect = crypto.createHmac("sha256", stateKey()).update(body).digest("base64url");
  if (sig.length !== expect.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return null;
  try {
    const d = JSON.parse(Buffer.from(body, "base64url").toString());
    return Date.now() - d.t < 15 * 60_000 ? d : null;
  } catch { return null; }
}

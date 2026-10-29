// netlify/functions/_shared/lead-alerts.mjs
//
// Lead Alerts — the phone app that pings admissions the moment a Pacific
// Discovery lead does something worth a same-hour follow-up. See LEAD-ALERTS.md.
//
// WHAT RAISES AN ALERT
//   app_started    a row appears in Neon `applications` (pd-apply, step 1 done)
//   app_submitted  `applications.step2_at` is set (full application submitted)
//   quiz           a row appears in Neon `quiz_responses`
//   new_lead       a Pacific Discovery contact's hs_lead_status becomes NEW in
//                  HubSpot (booklet download, popup, Zapier, manual, …)
//
//   A new_lead alert is dropped when the same email already has an
//   application/quiz alert within ±3 hours — pd-apply resets the lead status
//   to NEW itself, so without this every application would ping twice.
//
// "FOLLOWED UP"
//   An alert is closed when the advisor taps "Contacted", or automatically when
//   HubSpot shows a logged call/email/meeting after the alert
//   (notes_last_contacted) or the lead status moves off NEW.
//
// AVAILABLE HOURS
//   Each person sets when they want alerts (default 24/7). Outside those hours
//   nothing is pushed to their phones; the moment their hours start, one
//   "while you were off" notification lists every alert that came in and is
//   still open. Their 60-minute clock for those starts when their hours do.
//
// STORAGE (Neon, NETLIFY_DATABASE_URL — tables auto-created, see
// MIGRATION-lead-alerts.sql)
//   lead_alert_events   one row per alert (id is deterministic → idempotent)
//   lead_alert_subs     Web Push subscriptions, one per phone/browser
//   lead_alert_seen     per person: when they last opened the app
//   lead_alert_prefs    per person: time zone + available hours, on/off state
//   lead_alert_reminders  which "still waiting" reminders went to whom
//   lead_alert_state    key/value (the go-live baseline)

import { neon } from "@neondatabase/serverless";
import webpush from "web-push";
import fs from "node:fs/promises";
import path from "node:path";
import { getStore } from "@netlify/blobs";
import { canAccess, normalizeGrants } from "../../edge-functions/lib/dashboard-access.js";
import { aircallConfigured, dial, ensureWebhook, findUserId, followUpFromCall, samePhone, toE164, tokensMatch } from "./aircall.mjs";
import { isAvailable, nextAvailableAt, nextChangeAt, normalizeSchedule, validTz } from "./lead-alerts-hours.mjs";

export const SLUG = "lead-alerts";
export const TYPES = {
  app_submitted: { label: "Application submitted", short: "Application", rank: 0, digest: ["application", "applications"] },
  app_started:   { label: "Application started",   short: "Started app", rank: 1, digest: ["started application", "started applications"] },
  quiz:          { label: "Quiz completed",        short: "Quiz",        rank: 2, digest: ["quiz", "quizzes"] },
  new_lead:      { label: "New lead",              short: "New lead",    rank: 3, digest: ["new lead", "new leads"] },
};

export const FOLLOW_UP_MIN = 60;                                   // the promise
export const REMIND_AFTER_MIN = num(process.env.LEAD_ALERTS_REMIND_MIN, 45); // 0 = off
export const LOOKBACK_HOURS = 24;     // how far back each scan looks (covers outages)
export const SUPPRESS_HOURS = 3;      // new_lead vs app/quiz for the same email
export const FEED_DAYS = 7;
const AUTO_CLOSE_HOURS = 72;          // only check HubSpot activity for alerts this recent
const PORTAL_ID = process.env.HUBSPOT_PORTAL_ID || "3855728";

function num(v, d) { const n = Number(v); return Number.isFinite(n) && v !== "" && v != null ? n : d; }

// ── dependencies (swappable in tests) ───────────────────────────────────────

let _sql = null;
let _fetch = (...a) => fetch(...a);
let _push = null;           // (subscription, payloadString) => Promise
let _access = null;         // async (email, roles) => boolean

export function _setDepsForTests({ sql, fetchImpl, push, access } = {}) {
  if (sql !== undefined) _sql = sql;
  if (fetchImpl) _fetch = fetchImpl;
  if (push !== undefined) _push = push;
  if (access !== undefined) _access = access;
  _schemaReady = null;
}

export function db() {
  if (_sql) return _sql;
  const url = process.env.NETLIFY_DATABASE_URL;
  if (!url) throw new Error("NETLIFY_DATABASE_URL not configured");
  _sql = neon(url);
  return _sql;
}

const q = (text, params = []) => db().query(text, params).then((r) => (Array.isArray(r) ? r : r?.rows || []));

// ── schema ──────────────────────────────────────────────────────────────────

export const SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS lead_alert_events (
     id            TEXT PRIMARY KEY,
     type          TEXT NOT NULL,
     occurred_at   TIMESTAMPTZ NOT NULL,
     detected_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
     email         TEXT,
     name          TEXT,
     phone         TEXT,
     contact_id    TEXT,
     detail        TEXT,
     source        TEXT,
     ref_id        TEXT,
     pushed_at     TIMESTAMPTZ,
     reminded_at   TIMESTAMPTZ,
     handled_at    TIMESTAMPTZ,
     handled_by    TEXT,
     handled_how   TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS lead_alert_events_detected_idx ON lead_alert_events (detected_at DESC)`,
  `CREATE INDEX IF NOT EXISTS lead_alert_events_email_idx ON lead_alert_events (lower(email), occurred_at)`,
  `CREATE TABLE IF NOT EXISTS lead_alert_subs (
     endpoint      TEXT PRIMARY KEY,
     email         TEXT NOT NULL,
     roles         JSONB NOT NULL DEFAULT '[]'::jsonb,
     subscription  JSONB NOT NULL,
     user_agent    TEXT,
     created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
     last_ok_at    TIMESTAMPTZ,
     fail_count    INTEGER NOT NULL DEFAULT 0
   )`,
  `CREATE TABLE IF NOT EXISTS lead_alert_seen (
     email    TEXT PRIMARY KEY,
     seen_at  TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE IF NOT EXISTS lead_alert_prefs (
     email          TEXT PRIMARY KEY,
     tz             TEXT,
     schedule       JSONB,
     online         BOOLEAN NOT NULL DEFAULT true,
     online_since   TIMESTAMPTZ,
     offline_since  TIMESTAMPTZ,
     updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  `ALTER TABLE lead_alert_prefs ADD COLUMN IF NOT EXISTS aircall_email TEXT`,
  `ALTER TABLE lead_alert_prefs ADD COLUMN IF NOT EXISTS aircall_user_id TEXT`,
  `CREATE TABLE IF NOT EXISTS lead_alert_reminders (
     event_id  TEXT NOT NULL,
     email     TEXT NOT NULL,
     sent_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
     PRIMARY KEY (event_id, email)
   )`,
  `CREATE TABLE IF NOT EXISTS lead_alert_state (
     key         TEXT PRIMARY KEY,
     value       JSONB,
     updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
];

let _schemaReady = null;
export function ensureSchema() {
  if (!_schemaReady) {
    _schemaReady = (async () => { for (const s of SCHEMA_SQL) await q(s); })()
      .catch((e) => { _schemaReady = null; throw e; });
  }
  return _schemaReady;
}

// ── pure helpers ────────────────────────────────────────────────────────────

export const clean = (s) => (s == null ? "" : String(s).trim());
export const fullName = (f, l) => [clean(f), clean(l)].filter(Boolean).join(" ");
const iso = (t) => (t instanceof Date ? t.toISOString() : t ? new Date(t).toISOString() : null);

export function hubspotUrl(contactId) {
  return contactId ? `https://app.hubspot.com/contacts/${PORTAL_ID}/record/0-1/${contactId}` : null;
}

/** "Fall 2027 · Semester" style detail for an application row. */
export function appDetail(r) {
  const when = [clean(r.term) || clean(r.season), clean(r.travel_year)].filter(Boolean).join(" ");
  return [clean(r.program), when].filter(Boolean).join(" · ");
}

/** The newest time hs_lead_status was set to NEW, from propertiesWithHistory. */
export function newLeadSetAt(history) {
  const list = Array.isArray(history) ? history : [];
  let best = null;
  for (const h of list) {
    if (String(h?.value || "").toUpperCase() !== "NEW" || !h.timestamp) continue;
    const t = Date.parse(h.timestamp);
    if (Number.isFinite(t) && (best == null || t > best)) best = t;
  }
  return best;
}

/**
 * Drop new_lead candidates whose email already has (or is about to get) an
 * application/quiz alert within SUPPRESS_HOURS. `others` are {email, at(ms)}.
 */
export function suppressDuplicateLeads(leads, others, hours = SUPPRESS_HOURS) {
  const win = hours * 3600_000;
  const byEmail = new Map();
  for (const o of others) {
    const k = clean(o.email).toLowerCase();
    if (!k) continue;
    if (!byEmail.has(k)) byEmail.set(k, []);
    byEmail.get(k).push(o.at);
  }
  return leads.filter((l) => {
    const ts = byEmail.get(clean(l.email).toLowerCase());
    return !ts || !ts.some((t) => Math.abs(t - l.at) <= win);
  });
}

/**
 * Should this open alert be closed, given the contact's current HubSpot props?
 * Returns { why, at } (at = when the follow-up happened, ISO) or null.
 */
export function autoCloseReason(event, props, now = Date.now()) {
  if (!props) return null;
  const at = Date.parse(event.occurred_at);
  const contacted = Date.parse(props.notes_last_contacted || "");
  if (Number.isFinite(contacted) && contacted > at) {
    return { why: "Contact logged in HubSpot", at: new Date(Math.min(contacted, now)).toISOString() };
  }
  const status = clean(props.hs_lead_status);
  if (status && status.toUpperCase() !== "NEW") {
    // Only trust a status change that happened after the alert.
    const changed = Date.parse(props.hs_lead_status_changed_at || "");
    if (Number.isFinite(changed) && changed <= at) return null;
    const when = Number.isFinite(changed) ? Math.min(changed, now) : now;
    return { why: `Lead status → ${status.replace(/_/g, " ").toLowerCase()}`, at: new Date(when).toISOString() };
  }
  return null;
}

/** Notification text for one subscriber's batch of new alerts. */
export function buildPush(events, badge, { now = Date.now(), tz } = {}) {
  const url = "/lead-alerts/";
  if (events.length === 1) {
    const e = events[0];
    const t = TYPES[e.type] || { label: "Lead" };
    const due = new Date(Date.parse(e.occurred_at) + FOLLOW_UP_MIN * 60_000);
    const bits = [e.detail, e.source].filter(Boolean).join(" · ");
    return {
      title: `${t.label}: ${e.name || e.email || "someone"}`,
      body: `${bits ? bits + " — " : ""}follow up by ${fmtTime(due, tz)}`,
      tag: e.id, url: `${url}#${encodeURIComponent(e.id)}`, badge,
    };
  }
  const names = events.slice(0, 4).map((e) => e.name || e.email).filter(Boolean);
  const more = events.length - names.length;
  return {
    title: `${events.length} new leads to follow up`,
    body: names.join(", ") + (more > 0 ? ` +${more} more` : ""),
    tag: `batch-${now}`, url, badge,
  };
}

export function buildReminder(events, badge, now = Date.now(), startMs = null) {
  const list = Array.isArray(events) ? events : [events];
  if (list.length > 1) {
    return {
      title: `${list.length} leads still waiting`,
      body: list.slice(0, 4).map((e) => e.name || e.email).filter(Boolean).join(", ") + (list.length > 4 ? ` +${list.length - 4} more` : ""),
      tag: `remind-${now}`, url: "/lead-alerts/", badge, renotify: true,
    };
  }
  const e = list[0];
  const occurred = Date.parse(e.occurred_at);
  const base = Math.max(occurred, startMs || 0);
  const mins = Math.round((now - base) / 60_000);
  const left = FOLLOW_UP_MIN - mins;
  const since = base > occurred ? `came in while you were off; your hours started ${mins} min ago` : `${mins} min ago`;
  return {
    title: `Still waiting: ${e.name || e.email || "a lead"}`,
    body: `${(TYPES[e.type] || {}).label || "Lead"} ${since} — ${left > 0 ? `${left} min left in the hour` : "past the hour"}`,
    tag: e.id, url: `/lead-alerts/#${encodeURIComponent(e.id)}`, badge, renotify: true,
  };
}

/** The "while you were off" notification sent when someone's hours start. */
export function buildDigest(events, badge, { now = Date.now() } = {}) {
  if (events.length === 1) {
    const e = events[0];
    const t = TYPES[e.type] || { label: "Lead" };
    return {
      title: `While you were off: ${e.name || e.email || "1 lead"}`,
      body: `${t.label}${e.detail ? " · " + e.detail : ""} — still waiting for a follow-up`,
      tag: `digest-${now}`, url: `/lead-alerts/#${encodeURIComponent(e.id)}`, badge,
    };
  }
  const counts = {};
  for (const e of events) counts[e.type] = (counts[e.type] || 0) + 1;
  const parts = Object.keys(TYPES).filter((k) => counts[k]).map((k) => `${counts[k]} ${TYPES[k].digest[counts[k] > 1 ? 1 : 0]}`);
  const names = events.slice(0, 3).map((e) => e.name || e.email).filter(Boolean);
  return {
    title: `While you were off: ${events.length} leads waiting`,
    body: `${parts.join(", ")} — ${names.join(", ")}${events.length > names.length ? "…" : ""}`,
    tag: `digest-${now}`, url: "/lead-alerts/", badge,
  };
}

// Times in notifications are written in the advisor's zone. Admissions follows
// US families, so default to US Pacific; override with LEAD_ALERTS_TZ.
export function fmtTime(d, tz = process.env.LEAD_ALERTS_TZ || "America/Los_Angeles") {
  try {
    return new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone: tz }).format(d);
  } catch {
    return new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" }).format(d);
  }
}

// ── HubSpot ─────────────────────────────────────────────────────────────────

function hsToken() {
  return process.env.HUBSPOT_TOKEN || process.env.HUBSPOT_PRIVATE_APP_TOKEN || "";
}

async function hs(pathname, body) {
  const token = hsToken();
  if (!token) throw new Error("HUBSPOT_TOKEN not set");
  const res = await _fetch(`https://api.hubapi.com${pathname}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(9000),
  });
  if (!res.ok) throw new Error(`HubSpot ${pathname}: HTTP ${res.status} ${(await res.text().catch(() => "")).slice(0, 200)}`);
  return res.json();
}

const LEAD_PROPS = ["email", "firstname", "lastname", "phone", "mobilephone", "recent_conversion_event_name", "hs_analytics_source"];

/** Pacific Discovery contacts whose lead status was set to NEW after `sinceMs`. */
export async function hubspotNewLeads(sinceMs) {
  const search = await hs("/crm/v3/objects/contacts/search", {
    filterGroups: [{ filters: [
      { propertyName: "company_tag", operator: "EQ", value: "Pacific Discovery" },
      { propertyName: "hs_lead_status", operator: "EQ", value: "NEW" },
      { propertyName: "lastmodifieddate", operator: "GTE", value: String(sinceMs) },
    ] }],
    properties: ["hs_object_id"],
    sorts: [{ propertyName: "lastmodifieddate", direction: "DESCENDING" }],
    limit: 100,
  });
  const ids = (search.results || []).map((r) => String(r.id));
  if (!ids.length) return [];
  const read = await hs("/crm/v3/objects/contacts/batch/read", {
    inputs: ids.map((id) => ({ id })),
    properties: LEAD_PROPS,
    propertiesWithHistory: ["hs_lead_status"],
  });
  const out = [];
  for (const r of read.results || []) {
    const at = newLeadSetAt(r.propertiesWithHistory?.hs_lead_status);
    if (at == null || at <= sinceMs) continue;
    const p = r.properties || {};
    out.push({
      id: `hs:${r.id}:${at}`,
      type: "new_lead",
      at,
      email: clean(p.email),
      name: fullName(p.firstname, p.lastname),
      phone: clean(p.mobilephone) || clean(p.phone),
      contact_id: String(r.id),
      detail: clean(p.recent_conversion_event_name),
      source: prettySource(p.hs_analytics_source),
      ref_id: String(r.id),
    });
  }
  return out;
}

function prettySource(s) {
  const v = clean(s);
  if (!v) return "";
  return v.replace(/_/g, " ").toLowerCase().replace(/^\w/, (c) => c.toUpperCase());
}

/** email(lower) → { id, phone } for contacts we don't have an id for yet. */
export async function hubspotByEmail(emails) {
  const list = [...new Set(emails.map((e) => clean(e).toLowerCase()).filter(Boolean))].slice(0, 100);
  if (!list.length) return new Map();
  const res = await hs("/crm/v3/objects/contacts/search", {
    filterGroups: [{ filters: [{ propertyName: "email", operator: "IN", values: list }] }],
    properties: ["email", "phone", "mobilephone"],
    limit: 100,
  });
  const map = new Map();
  for (const r of res.results || []) {
    const p = r.properties || {};
    map.set(clean(p.email).toLowerCase(), { id: String(r.id), phone: clean(p.mobilephone) || clean(p.phone) });
  }
  return map;
}

/** id → { notes_last_contacted, hs_lead_status, hs_lead_status_changed_at } */
export async function hubspotActivity(ids) {
  const list = [...new Set(ids.filter(Boolean))].slice(0, 100);
  if (!list.length) return new Map();
  const res = await hs("/crm/v3/objects/contacts/batch/read", {
    inputs: list.map((id) => ({ id })),
    properties: ["notes_last_contacted", "hs_lead_status"],
    propertiesWithHistory: ["hs_lead_status"],
  });
  const map = new Map();
  for (const r of res.results || []) {
    const hist = r.propertiesWithHistory?.hs_lead_status || [];
    const latest = hist.map((h) => Date.parse(h.timestamp)).filter(Number.isFinite).sort((a, b) => b - a)[0];
    map.set(String(r.id), {
      ...(r.properties || {}),
      hs_lead_status_changed_at: latest ? new Date(latest).toISOString() : null,
    });
  }
  return map;
}

// ── Neon sources ────────────────────────────────────────────────────────────

const PHONE_SQL = `coalesce(nullif(answers->>'phone',''), nullif(answers->>'mobilephone',''), nullif(answers->>'homePhone',''))`;

export async function neonCandidates(sinceIso) {
  const [started, submitted, quizzes] = await Promise.all([
    q(`SELECT id, email, first_name, last_name, program, term, season, travel_year,
              hubspot_contact_id, ${PHONE_SQL} AS phone,
              coalesce(step1_at, created_at) AS t
         FROM applications
        WHERE coalesce(step1_at, created_at) > $1 AND status <> 'withdrawn'
        ORDER BY 1 LIMIT 200`, [sinceIso]),
    q(`SELECT id, email, first_name, last_name, program, term, season, travel_year,
              hubspot_contact_id, ${PHONE_SQL} AS phone, step2_at AS t
         FROM applications
        WHERE step2_at > $1 AND status <> 'withdrawn'
        ORDER BY 1 LIMIT 200`, [sinceIso]),
    q(`SELECT id, email, first_name, last_name, phone, archetype, hubspot_contact_id, created_at AS t
         FROM quiz_responses
        WHERE created_at > $1
        ORDER BY 1 LIMIT 200`, [sinceIso]),
  ]);
  const ms = (t) => (t instanceof Date ? t.getTime() : Date.parse(t));
  return [
    ...started.map((r) => ({ id: `app1:${r.id}`, type: "app_started", at: ms(r.t), email: clean(r.email),
      name: fullName(r.first_name, r.last_name), phone: clean(r.phone), contact_id: clean(r.hubspot_contact_id) || null,
      detail: appDetail(r), source: "", ref_id: String(r.id) })),
    ...submitted.map((r) => ({ id: `app2:${r.id}`, type: "app_submitted", at: ms(r.t), email: clean(r.email),
      name: fullName(r.first_name, r.last_name), phone: clean(r.phone), contact_id: clean(r.hubspot_contact_id) || null,
      detail: appDetail(r), source: "", ref_id: String(r.id) })),
    ...quizzes.map((r) => ({ id: `quiz:${r.id}`, type: "quiz", at: ms(r.t), email: clean(r.email),
      name: fullName(r.first_name, r.last_name), phone: clean(r.phone), contact_id: clean(r.hubspot_contact_id) || null,
      detail: clean(r.archetype) ? `Result: ${clean(r.archetype)}` : "", source: "", ref_id: String(r.id) })),
  ].filter((c) => Number.isFinite(c.at));
}

// ── access ──────────────────────────────────────────────────────────────────

function dashboardsStore() {
  try {
    return getStore({ name: "dashboards", consistency: "strong" });
  } catch {
    const siteID = process.env.NETLIFY_SITE_ID || process.env.SITE_ID;
    const token = process.env.NETLIFY_BLOBS_TOKEN || process.env.NETLIFY_API_TOKEN;
    if (siteID && token) return getStore({ name: "dashboards", consistency: "strong", siteID, token });
    return null;
  }
}

async function loadManifest() {
  for (const root of [process.cwd(), "/var/task", "/opt/build/repo"]) {
    try {
      const data = JSON.parse(await fs.readFile(path.join(root, "dashboards.discovery.json"), "utf8"));
      if (Array.isArray(data?.dashboards)) return data.dashboards;
    } catch {}
  }
  return [];
}

/**
 * Returns (email, roles) => may this person use Lead Alerts? Same rule as the
 * edge gate (per-person grants, admin always, legacy role fallback). Loaded
 * once per call site so a batch of pushes reads the grants blob once.
 */
export async function accessChecker() {
  if (_access) return _access;
  const store = dashboardsStore();
  const [manifest, overrides, grantsRaw] = await Promise.all([
    loadManifest(),
    store ? store.get("permissions", { type: "json" }).catch(() => null) : null,
    store ? store.get("grants", { type: "json" }).catch(() => null) : null,
  ]);
  const grants = grantsRaw ? normalizeGrants(grantsRaw) : null;
  let dashboard = manifest.find((d) => String(d.slug).toLowerCase() === SLUG);
  const o = (overrides?.dashboards || []).find((d) => d.slug === SLUG);
  if (dashboard && o && Array.isArray(o.allowedRoles)) dashboard = { ...dashboard, allowedRoles: o.allowedRoles };
  return (email, roles) => {
    const r = Array.isArray(roles) ? roles : [];
    if (r.includes("admin")) return true;
    if (!dashboard) return false;
    return canAccess({ email, roles: r, slug: SLUG, dashboard, grants });
  };
}

// ── push ────────────────────────────────────────────────────────────────────

export function vapidPublicKey() {
  return clean(process.env.VAPID_PUBLIC_KEY);
}

let _vapidSet = false;
async function sendPush(subscription, payload) {
  if (_push) return _push(subscription, payload);
  if (!_vapidSet) {
    const pub = vapidPublicKey(), priv = clean(process.env.VAPID_PRIVATE_KEY);
    if (!pub || !priv) throw Object.assign(new Error("VAPID keys not configured"), { fatal: true });
    webpush.setVapidDetails(clean(process.env.VAPID_SUBJECT) || "mailto:admissions@pacificdiscovery.org", pub, priv);
    _vapidSet = true;
  }
  // Urgency high so phones in doze still get it promptly; TTL 1h because a
  // lead alert that arrives later than that has missed its point.
  return webpush.sendNotification(subscription, payload, { TTL: 3600, urgency: "high" });
}

/** How many alerts each email hasn't seen yet (the red bubble). */
export async function unseenCounts(emails) {
  const list = [...new Set(emails.map((e) => clean(e).toLowerCase()))];
  if (!list.length) return new Map();
  const rows = await q(
    `SELECT u.email,
            (SELECT count(*) FROM lead_alert_events e
              WHERE e.detected_at > coalesce(s.seen_at, now() - interval '${FEED_DAYS} days'))::int AS n
       FROM unnest($1::text[]) AS u(email)
       LEFT JOIN lead_alert_seen s ON s.email = u.email`, [list]);
  return new Map(rows.map((r) => [r.email, Number(r.n) || 0]));
}

/** email(lower) → prefs row (missing = 24/7 defaults). */
export async function loadPrefs(emails) {
  const list = [...new Set(emails.map((e) => clean(e).toLowerCase()))];
  if (!list.length) return new Map();
  const rows = await q(`SELECT * FROM lead_alert_prefs WHERE email = ANY($1::text[])`, [list]);
  return new Map(rows.map((r) => [r.email, r]));
}

/**
 * Deliver one notification per subscriber. `makePayload(email, badge, prefs)`
 * returns the payload object (or null to skip). Dead subscriptions are removed.
 *   onlyEmail     deliver to this person's devices only
 *   respectHours  hold back from people outside their available hours (default)
 */
export async function pushToAll(makePayload, { onlyEmail = null, respectHours = true, now = Date.now() } = {}) {
  const subs = await q(`SELECT endpoint, email, roles, subscription FROM lead_alert_subs`);
  if (!subs.length) return { sent: 0, failed: 0, removed: 0, held: 0 };
  const may = await accessChecker();
  const allowed = subs.filter((s) => may(s.email, s.roles));
  const only = onlyEmail ? clean(onlyEmail).toLowerCase() : null;
  const targets = allowed.filter((s) => !only || s.email === only);
  const [counts, prefs] = await Promise.all([
    unseenCounts(targets.map((s) => s.email)),
    loadPrefs(targets.map((s) => s.email)),
  ]);
  let sent = 0, failed = 0, removed = 0, held = 0;
  await Promise.all(targets.map(async (s) => {
    const pref = prefs.get(s.email);
    if (respectHours && pref && !isAvailable(pref.schedule, pref.tz, now)) { held++; return; }
    const payload = makePayload(s.email, counts.get(s.email.toLowerCase()) || 0, pref);
    if (!payload) return;
    try {
      await sendPush(s.subscription, JSON.stringify(payload));
      sent++;
      await q(`UPDATE lead_alert_subs SET last_ok_at = now(), fail_count = 0 WHERE endpoint = $1`, [s.endpoint]);
    } catch (e) {
      if (e.fatal) throw e;
      failed++;
      const gone = e.statusCode === 404 || e.statusCode === 410;
      if (gone) {
        removed++;
        await q(`DELETE FROM lead_alert_subs WHERE endpoint = $1`, [s.endpoint]);
      } else {
        console.warn(`[lead-alerts] push to ${s.email} failed: ${e.statusCode || ""} ${e.message}`);
        await q(`UPDATE lead_alert_subs SET fail_count = fail_count + 1 WHERE endpoint = $1`, [s.endpoint]);
      }
    }
  }));
  // Subscriptions belonging to people who lost access are removed, so a
  // revoked advisor stops receiving lead names on their lock screen.
  const revoked = subs.filter((s) => !allowed.includes(s));
  for (const s of revoked) await q(`DELETE FROM lead_alert_subs WHERE endpoint = $1`, [s.endpoint]);
  return { sent, failed, removed: removed + revoked.length, held };
}

// ── available hours ─────────────────────────────────────────────────────────

/**
 * Track each person going off/on. When their hours start, send them ONE
 * notification listing every alert that arrived while they were off and is
 * still open. Runs at the top of every scan (every 2 min), so the digest lands
 * within ~2 minutes of their hours starting.
 */
export async function availabilityPass(now = Date.now(), report = {}) {
  const rows = await q(`SELECT * FROM lead_alert_prefs WHERE schedule IS NOT NULL OR online = false`);
  for (const p of rows) {
    const onNow = isAvailable(p.schedule, p.tz, now);
    if (p.online && !onNow) {
      await q(`UPDATE lead_alert_prefs SET online = false, offline_since = $2 WHERE email = $1 AND online = true`,
        [p.email, new Date(now).toISOString()]);
    } else if (!p.online && onNow) {
      if (await availabilityFor(p, now)) report.digests = (report.digests || 0) + 1;
    }
  }
}

/**
 * Per person, only while they're on: one "still waiting" nudge per open alert,
 * REMIND_AFTER_MIN after they were first told about it — the later of when it
 * was spotted and when their hours started (so a 2am lead is reminded about
 * 45 minutes into their morning, not at 2:45am).
 */
async function reminderPass(now, report) {
  if (!(REMIND_AFTER_MIN > 0)) return;
  const subs = await q(`SELECT DISTINCT email FROM lead_alert_subs`);
  if (!subs.length) return;
  const prefs = await loadPrefs(subs.map((s) => s.email));
  const cutoff = new Date(now - REMIND_AFTER_MIN * 60_000).toISOString();
  const floor = new Date(now - FOLLOW_UP_MIN * 2 * 60_000).toISOString();
  for (const { email } of subs) {
    const p = prefs.get(email);
    if (p && !isAvailable(p.schedule, p.tz, now)) continue;
    const start = p?.online_since ? iso(p.online_since) : "1970-01-01T00:00:00.000Z";
    const due = await q(
      `SELECT e.* FROM lead_alert_events e
        WHERE e.handled_at IS NULL
          AND greatest(e.detected_at, $2::timestamptz) <= $3
          AND greatest(e.detected_at, $2::timestamptz) > $4
          AND NOT EXISTS (SELECT 1 FROM lead_alert_reminders r WHERE r.event_id = e.id AND r.email = $1)
        ORDER BY e.occurred_at`, [email, start, cutoff, floor]);
    if (!due.length) continue;
    const claimed = await q(
      `INSERT INTO lead_alert_reminders (event_id, email)
       SELECT unnest($1::text[]), $2 ON CONFLICT DO NOTHING RETURNING event_id`, [due.map((e) => e.id), email]);
    const ids = new Set(claimed.map((r) => r.event_id));
    const list = due.filter((e) => ids.has(e.id)).map((e) => ({ ...e, occurred_at: iso(e.occurred_at) }));
    if (!list.length) continue;
    const startMs = p?.online_since ? Date.parse(iso(p.online_since)) : null;
    await pushToAll((em, badge) => buildReminder(list.length === 1 ? list[0] : list, badge, now, startMs), { onlyEmail: email, now });
    report.reminders = (report.reminders || 0) + list.length;
  }
}

/**
 * Save someone's hours (schedule null = 24/7). Records whether they're on
 * right now; if saving switches them on, they get the "while you were off"
 * digest straight away.
 */
export async function savePrefs(email, { tz, schedule }, now = Date.now()) {
  await ensureSchema();
  if (!validTz(tz)) throw Object.assign(new Error("Unknown time zone"), { status: 400 });
  let sched;
  try { sched = normalizeSchedule(schedule); }
  catch (e) { throw Object.assign(new Error(e.message), { status: 400 }); }
  const key = clean(email).toLowerCase();
  const prev = (await q(`SELECT * FROM lead_alert_prefs WHERE email = $1`, [key]))[0];
  const wasOn = prev ? prev.online : true;
  const onNow = isAvailable(sched, tz, now);
  const nowIso = new Date(now).toISOString();
  // Write the new hours but keep the old on/off state; the availability pass
  // then does the transition (and the digest) exactly as a scan would.
  await q(`INSERT INTO lead_alert_prefs (email, tz, schedule, online, online_since, offline_since, updated_at)
           VALUES ($1, $2, $3::jsonb, $4, $5, $6, now())
           ON CONFLICT (email) DO UPDATE SET tz = EXCLUDED.tz, schedule = EXCLUDED.schedule, updated_at = now()`,
    [key, tz, sched ? JSON.stringify(sched) : null, wasOn, iso(prev?.online_since) || (wasOn ? nowIso : null), iso(prev?.offline_since)]);
  if (onNow !== wasOn) {
    // Only this person: run the transition for their row.
    const rows = await q(`SELECT * FROM lead_alert_prefs WHERE email = $1`, [key]);
    if (onNow) {
      await q(`UPDATE lead_alert_prefs SET online = false WHERE email = $1`, [key]);   // ensure the guarded flip runs
      await availabilityFor(rows[0], now);
    } else {
      await q(`UPDATE lead_alert_prefs SET online = false, offline_since = $2 WHERE email = $1`, [key, nowIso]);
    }
  }
  return prefsFor(key, now);
}

async function availabilityFor(row, now) {
  // Same as availabilityPass, scoped to one row (used when saving hours).
  const flipped = await q(`UPDATE lead_alert_prefs SET online = true, online_since = $2
                            WHERE email = $1 AND online = false RETURNING offline_since`,
    [row.email, new Date(now).toISOString()]);
  if (!flipped.length) return false;
  const offSince = flipped[0].offline_since ? iso(flipped[0].offline_since) : new Date(now - 24 * 3600_000).toISOString();
  const waiting = await q(
    `SELECT * FROM lead_alert_events WHERE handled_at IS NULL AND detected_at >= $1
       AND occurred_at > now() - interval '${FEED_DAYS} days' ORDER BY occurred_at DESC LIMIT 100`, [offSince]);
  if (!waiting.length) return false;
  const list = waiting.map((e) => ({ ...e, occurred_at: iso(e.occurred_at) }));
  await pushToAll((email, badge) => buildDigest(list, badge, { now }), { onlyEmail: row.email, now });
  return true;
}

export async function prefsFor(email, now = Date.now()) {
  await ensureSchema();
  const p = (await loadPrefs([email])).get(clean(email).toLowerCase());
  const schedule = p?.schedule || null;
  const tz = p?.tz || null;
  const change = nextChangeAt(schedule, tz, now);
  return {
    tz, schedule, always: !schedule,
    availableNow: isAvailable(schedule, tz, now),
    nextChangeAt: change ? new Date(change).toISOString() : null,
  };
}

// ── the scan ────────────────────────────────────────────────────────────────

async function baseline() {
  const rows = await q(`SELECT value FROM lead_alert_state WHERE key = 'since'`);
  if (rows[0]?.value?.at) return Date.parse(rows[0].value.at);
  // First run ever: start from now, so going live doesn't fire a day of alerts.
  const at = new Date().toISOString();
  await q(`INSERT INTO lead_alert_state (key, value) VALUES ('since', $1::jsonb) ON CONFLICT (key) DO NOTHING`,
    [JSON.stringify({ at })]);
  const again = await q(`SELECT value FROM lead_alert_state WHERE key = 'since'`);
  return Date.parse(again[0]?.value?.at || at);
}

async function insertEvents(cands) {
  if (!cands.length) return [];
  const rows = await q(
    `INSERT INTO lead_alert_events (id, type, occurred_at, email, name, phone, contact_id, detail, source, ref_id)
     SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(
       id text, type text, occurred_at timestamptz, email text, name text, phone text,
       contact_id text, detail text, source text, ref_id text)
     ON CONFLICT (id) DO NOTHING
     RETURNING *`,
    [JSON.stringify(cands.map((c) => ({
      id: c.id, type: c.type, occurred_at: new Date(c.at).toISOString(), email: c.email || null,
      name: c.name || null, phone: c.phone || null, contact_id: c.contact_id || null,
      detail: c.detail || null, source: c.source || null, ref_id: c.ref_id || null,
    })))]);
  return rows;
}

/**
 * One pass: find new activity, store it, push it, send reminders, and close
 * alerts HubSpot shows were followed up. Safe to run concurrently/repeatedly
 * — event ids are deterministic and inserts are ON CONFLICT DO NOTHING, and a
 * push only goes out for rows this pass actually inserted.
 */
export async function runScan({ now = Date.now(), log = console } = {}) {
  await ensureSchema();
  const since = await baseline();
  const from = Math.max(since, now - LOOKBACK_HOURS * 3600_000);
  const report = { from: new Date(from).toISOString(), inserted: 0, suppressed: 0, pushed: null, reminders: 0, digests: 0, autoClosed: 0, errors: [] };

  // 0. Anyone whose hours just started gets one "while you were off" digest
  //    (before this pass's new alerts, which go out to them individually).
  try { await availabilityPass(now, report); }
  catch (e) { report.errors.push(`hours: ${e.message}`); }

  // 1. Applications + quiz (Neon). These are the primary signal.
  let neonC = [];
  try { neonC = await neonCandidates(new Date(from).toISOString()); }
  catch (e) { report.errors.push(`neon: ${e.message}`); }

  // 2. HubSpot "New lead". Look back a little further than `from` on
  //    lastmodifieddate (search indexing lags) but only keep NEW-sets after `from`.
  let leads = [];
  if (hsToken()) {
    try { leads = await hubspotNewLeads(from); }
    catch (e) { report.errors.push(`hubspot: ${e.message}`); }
  }

  // 3. Suppress HubSpot leads already covered by an app/quiz alert (stored or new).
  if (leads.length) {
    const emails = [...new Set(leads.map((l) => l.email.toLowerCase()).filter(Boolean))];
    const stored = emails.length ? await q(
      `SELECT lower(email) AS email, occurred_at FROM lead_alert_events
        WHERE type <> 'new_lead' AND lower(email) = ANY($1::text[])
          AND occurred_at > $2`, [emails, new Date(from - SUPPRESS_HOURS * 3600_000).toISOString()]) : [];
    const others = [
      ...neonC.map((c) => ({ email: c.email, at: c.at })),
      ...stored.map((r) => ({ email: r.email, at: Date.parse(r.occurred_at) })),
    ];
    const kept = suppressDuplicateLeads(leads, others);
    report.suppressed = leads.length - kept.length;
    leads = kept;
  }

  // 4. Fill in HubSpot ids/phones for app/quiz rows pd-apply hasn't synced yet.
  const needIds = neonC.filter((c) => !c.contact_id || !c.phone);
  if (needIds.length && hsToken()) {
    try {
      const found = await hubspotByEmail(needIds.map((c) => c.email));
      for (const c of needIds) {
        const f = found.get(c.email.toLowerCase());
        if (!f) continue;
        c.contact_id = c.contact_id || f.id;
        c.phone = c.phone || f.phone;
      }
    } catch (e) { report.errors.push(`hubspot lookup: ${e.message}`); }
  }

  // 5. Store. Only rows inserted by THIS pass get pushed.
  const fresh = await insertEvents([...neonC, ...leads]);
  report.inserted = fresh.length;

  // 6. Push the new ones: one notification each for up to 3, else a summary.
  if (fresh.length) {
    fresh.sort((a, b) => Date.parse(a.occurred_at) - Date.parse(b.occurred_at));
    const asClient = fresh.map((e) => ({ ...e, occurred_at: iso(e.occurred_at) }));
    const batches = asClient.length <= 3 ? asClient.map((e) => [e]) : [asClient.slice().reverse()];
    try {
      report.pushed = { sent: 0, failed: 0, removed: 0, held: 0 };
      for (const b of batches) {
        const r = await pushToAll((email, badge, pref) => buildPush(b, badge, { now, tz: pref?.tz || undefined }), { now });
        for (const k of Object.keys(report.pushed)) report.pushed[k] += r[k] || 0;
      }
      await q(`UPDATE lead_alert_events SET pushed_at = now() WHERE id = ANY($1::text[])`, [fresh.map((e) => e.id)]);
    } catch (e) { report.errors.push(`push: ${e.message}`); }
  }

  // 7. Close alerts HubSpot shows were followed up.
  try {
    const open = await q(
      `SELECT id, occurred_at, contact_id FROM lead_alert_events
        WHERE handled_at IS NULL AND contact_id IS NOT NULL
          AND occurred_at > $1
        ORDER BY occurred_at DESC LIMIT 100`, [new Date(now - AUTO_CLOSE_HOURS * 3600_000).toISOString()]);
    if (open.length && hsToken()) {
      const act = await hubspotActivity(open.map((o) => o.contact_id));
      for (const o of open) {
        const done = autoCloseReason({ occurred_at: iso(o.occurred_at) }, act.get(String(o.contact_id)), now);
        if (!done) continue;
        await q(`UPDATE lead_alert_events SET handled_at = $3, handled_by = 'HubSpot', handled_how = $2
                  WHERE id = $1 AND handled_at IS NULL`, [o.id, done.why, done.at]);
        report.autoClosed++;
      }
    }
  } catch (e) { report.errors.push(`auto-close: ${e.message}`); }

  // 8. "Still waiting" reminders, per person, only while they're on.
  try { await reminderPass(now, report); }
  catch (e) { report.errors.push(`reminders: ${e.message}`); }

  if (report.errors.length) log.warn?.("[lead-alerts] scan errors:", report.errors.join(" | "));
  return report;
}

// ── feed ────────────────────────────────────────────────────────────────────

export function toClient(r) {
  return {
    id: r.id,
    type: r.type,
    label: (TYPES[r.type] || {}).label || r.type,
    occurredAt: iso(r.occurred_at),
    detectedAt: iso(r.detected_at),
    email: r.email || "",
    name: r.name || "",
    phone: r.phone || "",
    detail: r.detail || "",
    source: r.source || "",
    hubspotUrl: hubspotUrl(r.contact_id),
    // Opens the record with HubSpot's email composer, so the email goes out
    // from her connected inbox and is logged on the contact.
    hubspotEmailUrl: r.contact_id ? `${hubspotUrl(r.contact_id)}?interaction=email` : null,
    handledAt: iso(r.handled_at),
    handledBy: r.handled_by || "",
    handledHow: r.handled_how || "",
  };
}

export async function feedFor(email, now = Date.now()) {
  await ensureSchema();
  const key = clean(email).toLowerCase();
  const [rows, seenRows, prefs] = await Promise.all([
    q(`SELECT * FROM lead_alert_events
        WHERE occurred_at > now() - interval '${FEED_DAYS} days'
        ORDER BY occurred_at DESC LIMIT 300`),
    q(`SELECT seen_at FROM lead_alert_seen WHERE email = $1`, [key]),
    prefsFor(key, now),
  ]);
  const seenAt = seenRows[0]?.seen_at ? iso(seenRows[0].seen_at) : null;
  const events = rows.map(toClient);
  const seenMs = seenAt ? Date.parse(seenAt) : -Infinity;
  for (const e of events) {
    e.isNew = Date.parse(e.detectedAt) > seenMs;
    // The hour starts when this person's hours do: something that came in at
    // 2am is due an hour after they start, not an hour after 2am.
    const occurred = Date.parse(e.occurredAt);
    const start = nextAvailableAt(prefs.schedule, prefs.tz, occurred) ?? occurred;
    e.clockStartAt = new Date(start).toISOString();
    e.dueAt = new Date(start + FOLLOW_UP_MIN * 60_000).toISOString();
    e.offHours = start > occurred + 60_000;
  }
  return { events, seenAt, newCount: events.filter((e) => e.isNew).length, stats: stats(events, now), prefs };
}

export function stats(events, now = Date.now()) {
  const startOf = (e) => Date.parse(e.clockStartAt || e.occurredAt);
  const open = events.filter((e) => !e.handledAt);
  const overdue = open.filter((e) => now - startOf(e) > FOLLOW_UP_MIN * 60_000);
  const mins = events.filter((e) => e.handledAt)
    .map((e) => Math.max(0, (Date.parse(e.handledAt) - startOf(e)) / 60_000))
    .filter((m) => Number.isFinite(m))
    .sort((a, b) => a - b);
  const median = mins.length ? mins[Math.floor((mins.length - 1) / 2)] : null;
  const withinHour = mins.length ? mins.filter((m) => m <= FOLLOW_UP_MIN).length / mins.length : null;
  return { open: open.length, overdue: overdue.length, medianMinutes: median == null ? null : Math.round(median), withinHourPct: withinHour == null ? null : Math.round(withinHour * 100), handled: mins.length };
}

export async function markSeen(email) {
  await ensureSchema();
  await q(`INSERT INTO lead_alert_seen (email, seen_at) VALUES ($1, now())
           ON CONFLICT (email) DO UPDATE SET seen_at = now()`, [clean(email).toLowerCase()]);
}

export async function setHandled(id, by, undo = false) {
  await ensureSchema();
  const rows = undo
    ? await q(`UPDATE lead_alert_events SET handled_at = NULL, handled_by = NULL, handled_how = NULL WHERE id = $1 RETURNING *`, [id])
    : await q(`UPDATE lead_alert_events SET handled_at = now(), handled_by = $2, handled_how = 'Marked contacted'
                WHERE id = $1 AND handled_at IS NULL RETURNING *`, [id, by]);
  if (rows[0]) return toClient(rows[0]);
  const cur = await q(`SELECT * FROM lead_alert_events WHERE id = $1`, [id]);
  return cur[0] ? toClient(cur[0]) : null;
}

export async function saveSubscription(email, roles, sub, ua) {
  await ensureSchema();
  if (!sub || typeof sub.endpoint !== "string" || !/^https:\/\//.test(sub.endpoint) || !sub.keys?.p256dh || !sub.keys?.auth) {
    throw Object.assign(new Error("Invalid push subscription"), { status: 400 });
  }
  await q(`INSERT INTO lead_alert_subs (endpoint, email, roles, subscription, user_agent)
           VALUES ($1, $2, $3::jsonb, $4::jsonb, $5)
           ON CONFLICT (endpoint) DO UPDATE SET email = EXCLUDED.email, roles = EXCLUDED.roles,
             subscription = EXCLUDED.subscription, user_agent = EXCLUDED.user_agent, fail_count = 0`,
    [sub.endpoint, clean(email).toLowerCase(), JSON.stringify(roles || []), JSON.stringify(sub), clean(ua).slice(0, 300)]);
}

export async function removeSubscription(email, endpoint) {
  await ensureSchema();
  await q(`DELETE FROM lead_alert_subs WHERE endpoint = $1 AND email = $2`, [clean(endpoint), clean(email).toLowerCase()]);
}

export async function subscriptionsFor(email) {
  await ensureSchema();
  return q(`SELECT endpoint, user_agent, created_at, last_ok_at, fail_count FROM lead_alert_subs WHERE email = $1 ORDER BY created_at DESC`,
    [clean(email).toLowerCase()]);
}

export async function testPush(email) {
  await ensureSchema();
  const key = clean(email).toLowerCase();
  const subs = await q(`SELECT endpoint, subscription FROM lead_alert_subs WHERE email = $1`, [key]);
  const counts = await unseenCounts([key]);
  let sent = 0; const errors = [];
  for (const s of subs) {
    try {
      await sendPush(s.subscription, JSON.stringify({
        title: "Lead Alerts is working",
        body: "You'll get a notification like this for every new lead, application and quiz.",
        tag: "test", url: "/lead-alerts/", badge: counts.get(key) || 0,
      }));
      sent++;
    } catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410) await q(`DELETE FROM lead_alert_subs WHERE endpoint = $1`, [s.endpoint]);
      errors.push(e.statusCode ? `HTTP ${e.statusCode}` : e.message);
    }
  }
  return { sent, devices: subs.length, errors };
}

/** Times (epoch ms) of recent alerts, for the landing-page tile bubble. */
export async function recentAlertTimes(limit = 100, days = 45) {
  await ensureSchema();
  const rows = await q(`SELECT (extract(epoch FROM detected_at) * 1000)::bigint AS t FROM lead_alert_events
                         WHERE detected_at > now() - interval '${Number(days)} days'
                         ORDER BY detected_at DESC LIMIT ${Number(limit)}`);
  return rows.map((r) => Number(r.t)).filter(Number.isFinite);
}

// ── Aircall ─────────────────────────────────────────────────────────────────

async function stateGet(key) {
  const rows = await q(`SELECT value FROM lead_alert_state WHERE key = $1`, [key]);
  return rows[0]?.value ?? null;
}
async function stateSet(key, value) {
  await q(`INSERT INTO lead_alert_state (key, value, updated_at) VALUES ($1, $2::jsonb, now())
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [key, JSON.stringify(value)]);
}

export async function aircallStatus() {
  await ensureSchema();
  const hook = await stateGet("aircall_webhook");
  return {
    configured: aircallConfigured(),
    webhook: !!(hook?.token || process.env.AIRCALL_WEBHOOK_TOKEN),
    lastCallAt: hook?.lastCallAt || null,
    // Aircall doesn't document a link that opens its iPhone app; override if
    // a different one turns out to work.
    iosUrl: clean(process.env.AIRCALL_IOS_URL) || "aircall://",
  };
}

/** Admin: create/find the Aircall webhook and remember its token. */
export async function connectAircall(siteUrl) {
  await ensureSchema();
  if (!siteUrl) throw Object.assign(new Error("Site URL unknown (URL env var)"), { status: 500 });
  const w = await ensureWebhook(siteUrl);
  if (!w.token) throw Object.assign(new Error("Aircall didn't return a webhook token"), { status: 502 });
  const prev = (await stateGet("aircall_webhook")) || {};
  await stateSet("aircall_webhook", { ...prev, id: w.id, token: w.token, url: w.url, connectedAt: new Date().toISOString() });
  return { id: w.id, url: w.url, created: w.created };
}

export async function webhookTokenOk(given) {
  if (process.env.AIRCALL_WEBHOOK_TOKEN && tokensMatch(given, process.env.AIRCALL_WEBHOOK_TOKEN)) return true;
  await ensureSchema();
  const hook = await stateGet("aircall_webhook");
  return tokensMatch(given, hook?.token);
}

/**
 * A finished Aircall call: close every open alert (last 7 days) whose phone
 * matches the other party. Returns the ids closed.
 */
export async function closeFromAircallCall(call) {
  await ensureSchema();
  const f = followUpFromCall(call);
  if (!f) return [];
  const open = await q(
    `SELECT id, phone, occurred_at FROM lead_alert_events
      WHERE handled_at IS NULL AND phone IS NOT NULL AND phone <> ''
        AND occurred_at > now() - interval '${FEED_DAYS} days'`);
  const hits = open.filter((e) => samePhone(e.phone, f.phone) && Date.parse(f.at) >= Date.parse(iso(e.occurred_at)) - 5 * 60_000);
  const closed = [];
  for (const e of hits) {
    const at = new Date(Math.max(Date.parse(f.at), Date.parse(iso(e.occurred_at)))).toISOString();
    const r = await q(`UPDATE lead_alert_events SET handled_at = $2, handled_by = $3, handled_how = $4
                        WHERE id = $1 AND handled_at IS NULL RETURNING id`, [e.id, at, f.by, f.how]);
    if (r.length) closed.push(e.id);
  }
  const hook = (await stateGet("aircall_webhook")) || {};
  await stateSet("aircall_webhook", { ...hook, lastCallAt: new Date().toISOString() });
  return closed;
}

/**
 * "Send to Aircall on my computer": fill the advisor's Aircall desktop app
 * with this lead's number. Her Aircall user is found by her login email, or
 * by the Aircall email she saved if that's different.
 */
export async function dialForEvent(email, eventId, aircallEmail) {
  await ensureSchema();
  const key = clean(email).toLowerCase();
  const ev = (await q(`SELECT phone, name FROM lead_alert_events WHERE id = $1`, [eventId]))[0];
  if (!ev) throw Object.assign(new Error("Alert not found"), { status: 404 });
  const to = toE164(ev.phone);
  if (!to) throw Object.assign(new Error("No phone number for this lead"), { status: 400 });

  let pref = (await q(`SELECT aircall_email, aircall_user_id FROM lead_alert_prefs WHERE email = $1`, [key]))[0];
  const wantEmail = clean(aircallEmail).toLowerCase() || pref?.aircall_email || key;
  let userId = (!aircallEmail && pref?.aircall_user_id) || null;
  if (!userId) {
    userId = await findUserId(wantEmail);
    if (!userId) throw Object.assign(new Error(`No Aircall user with the email ${wantEmail}.`), { status: 404, needsAircallEmail: true });
    await q(`INSERT INTO lead_alert_prefs (email, aircall_email, aircall_user_id) VALUES ($1, $2, $3)
             ON CONFLICT (email) DO UPDATE SET aircall_email = EXCLUDED.aircall_email, aircall_user_id = EXCLUDED.aircall_user_id`,
      [key, wantEmail, userId]);
  }
  await dial(userId, to);
  return { to, name: ev.name };
}

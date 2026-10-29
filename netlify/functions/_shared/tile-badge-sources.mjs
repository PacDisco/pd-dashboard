// netlify/functions/_shared/tile-badge-sources.mjs
//
// What counts as a "new submission" for each badged dashboard tile.
// Each source returns a snapshot — see _shared/tile-badges.mjs for the shapes.
//
// ADDING A DASHBOARD
//   1. add an entry to SOURCES below
//   2. add its slug to BADGED_SLUGS in netlify/edge-functions/lib/tile-badges.js
//      (that's what records "they opened it")
//
// Jotform form IDs here mirror the ones each dashboard reads; if a dashboard
// swaps forms, change it here too.

import { neon } from "@neondatabase/serverless";
import { readStats } from "./popups-store.mjs";
import { LOOKBACK_DAYS, MAX_KEYS, jotformStamp, readCounter } from "./tile-badges.mjs";
import { recentAlertTimes } from "./lead-alerts.mjs";

// ── source kinds ────────────────────────────────────────────────────────────

/** New submissions on one or more Jotform forms. */
const jotform = (...formIds) => ({ type: "jotform", formIds });

/**
 * New rows in a Neon table. `query(sql)` must return rows with a numeric `t`
 * (epoch ms), newest first, limited to the lookback window and MAX_KEYS.
 */
const neonRows = (envVars, query) => ({ type: "neon", envVars, query });

/** A running total kept in the tile-badges blob store (bumpBadgeCounter). */
const counter = (slug) => ({ type: "custom", snapshot: async () => ({ kind: "counter", value: await readCounter(slug) }) });

const WINDOW = `interval '${LOOKBACK_DAYS} days'`;

export const SOURCES = {
  // Online applications from apply.pacificdiscovery.org (pd-apply writes the row).
  "apply-form": neonRows(["NETLIFY_DATABASE_URL"], (sql) => sql.query(
    `SELECT (extract(epoch FROM created_at) * 1000)::bigint AS t
       FROM applications
      WHERE created_at > now() - ${WINDOW}
      ORDER BY created_at DESC LIMIT ${MAX_KEYS}`)),

  // Expenses / withdrawals instructors log in the field app. The two legs of
  // an exchange share a group_id and count once.
  "field-budget": neonRows(["FIELD_BUDGET_DATABASE_URL", "NETLIFY_DATABASE_URL"], (sql) => sql.query(
    `SELECT (extract(epoch FROM max(received_at)) * 1000)::bigint AS t
       FROM entries
      WHERE received_at > now() - ${WINDOW}
      GROUP BY coalesce(group_id, id)
      ORDER BY t DESC LIMIT ${MAX_KEYS}`)),

  // Bookings land in Google Calendar, so checkins-book.mjs bumps a counter.
  "instructor-checkins": counter("instructor-checkins"),

  "instructor-field-reports": jotform("250887973978080"),

  // PD Program Instructor Application (same form instructors.js syncs from).
  "instructors": jotform("241888714639876"),

  // Invoices that arrived by email (the Gmail Apps Script webhook). Uploads and
  // manual entries are made by someone already in the dashboard.
  "invoices": neonRows(["NETLIFY_DATABASE_URL"], (sql) => sql.query(
    `SELECT (extract(epoch FROM created_at) * 1000)::bigint AS t
       FROM payments
      WHERE source = 'email' AND created_at > now() - ${WINDOW}
      ORDER BY created_at DESC LIMIT ${MAX_KEYS}`)),

  // Lead Alerts: every alert the phone app raised (new lead, application, quiz).
  // The app is outside the edge gate (it's a PWA with its own sign-in), so it
  // clears this bubble itself by POSTing /api/tile-badges when opened.
  "lead-alerts": {
    type: "custom",
    snapshot: async () => ({ kind: "times", keys: await recentAlertTimes(MAX_KEYS, LOOKBACK_DAYS), limit: MAX_KEYS }),
  },

  // Website popup sign-ups: the per-popup submit counts popup-submit.mjs keeps.
  "popups": {
    type: "custom",
    snapshot: async () => {
      const stats = await readStats();
      const value = Object.values(stats || {}).reduce((n, s) => n + (Number(s?.submits) || 0), 0);
      return { kind: "counter", value };
    },
  },

  // Jotform Sign documents — same three forms sign-inbox/index.html lists.
  "sign-inbox": jotform("261608232937056", "240655314816052", "251468552846063"),

  "student-uploads": jotform("261337066421856"),

  "ue-applications": jotform("251396787451873"),
};

// ── snapshot ────────────────────────────────────────────────────────────────

const _sqlByUrl = new Map();
function sqlFor(envVars) {
  const url = envVars.map((k) => process.env[k]).find(Boolean);
  if (!url) throw new Error(`${envVars.join(" / ")} not configured`);
  if (!_sqlByUrl.has(url)) _sqlByUrl.set(url, neon(url));
  return _sqlByUrl.get(url);
}

let _fetch = (...a) => fetch(...a);
let _sqlOverride = null;
export function _setDepsForTests({ fetchImpl, sql } = {}) {
  if (fetchImpl) _fetch = fetchImpl;
  _sqlOverride = sql || null;
}

async function jotformKeys(formId, now) {
  const apiKey = process.env.JOTFORM_API_KEY;
  if (!apiKey) throw new Error("JOTFORM_API_KEY not set");
  const q = new URLSearchParams({
    apiKey,
    limit: String(MAX_KEYS),
    orderby: "created_at",
    direction: "DESC",
    // The window keeps the result "recent" whatever order Jotform returns;
    // a day of timezone slop on a 45-day window doesn't matter.
    filter: JSON.stringify({
      "created_at:gt": jotformStamp(now - LOOKBACK_DAYS * 86400_000),
      "status:ne": "DELETED",
    }),
  });
  const res = await _fetch(`https://api.jotform.com/form/${formId}/submissions?${q}`, {
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`Jotform ${formId}: HTTP ${res.status}`);
  const j = await res.json();
  if (j.responseCode && j.responseCode !== 200) throw new Error(`Jotform ${formId}: ${j.message || j.responseCode}`);
  return (j.content || [])
    .filter((s) => s && s.status !== "DELETED" && s.created_at)
    .map((s) => String(s.created_at));
}

/** Current snapshot for one source. Throws on upstream failure. */
export async function snapshot(slug, now = Date.now()) {
  const src = SOURCES[slug];
  if (!src) throw new Error(`no badge source for ${slug}`);

  if (src.type === "custom") return src.snapshot();

  if (src.type === "jotform") {
    const lists = await Promise.all(src.formIds.map((id) => jotformKeys(id, now)));
    const keys = lists.flat().sort().reverse().slice(0, MAX_KEYS * src.formIds.length);
    return { kind: "times", keys, limit: MAX_KEYS };
  }

  if (src.type === "neon") {
    const sql = _sqlOverride || sqlFor(src.envVars);
    const res = await src.query(sql);
    const rows = Array.isArray(res) ? res : (res?.rows || []);
    const keys = rows.map((r) => Number(r.t)).filter(Number.isFinite).sort((a, b) => b - a);
    return { kind: "times", keys, limit: MAX_KEYS };
  }

  throw new Error(`unknown badge source type for ${slug}`);
}

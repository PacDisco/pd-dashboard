// netlify/functions/lead-sources.mjs
//
// API behind /lead-sources/ — "where did our leads REALLY come from?"
//
// HubSpot's Original Source says "Offline Sources" for every contact created
// by Zapier / Make / the CRM API, which hid the real channel for most quiz and
// application leads. This joins three things per lead:
//   1. HubSpot's Original Source (+ drill-downs, recovered for Offline records
//      with the same rules as the Sales Funnel dashboard)
//   2. pd-apply's own first-party record of the visit (quiz_responses /
//      applications .attribution — UTMs, ad click ids, landing page, referrer)
//      and the pd_first_* / pd_last_* properties it writes to the contact
//   3. what the lead did next (quiz result, application started / complete / paid)
// and picks the best "real source" with realSource() from attribution-kit.mjs.
//
// Routes:
//   GET  ?from=YYYY-MM-DD&to=YYYY-MM-DD   → { leads, truncated, range }
//   POST { action: "setup" }              create the pd_* contact properties in HubSpot
//
// Env: HUBSPOT_TOKEN (crm.objects.contacts.read; crm.schemas.contacts.write for
// setup), NETLIFY_DATABASE_URL (shared with pd-apply).

import { neon } from "@neondatabase/serverless";
import { requireDashboard, json } from "./_shared/apply-form-access.mjs";
import { realSource, classify, ATTRIBUTION_PROPERTIES, HUBSPOT_SOURCE_LABELS } from "../../lead-sources/attribution-kit.mjs";
import { recoverOffline } from "./sales-funnel-data.mjs";

export const SLUG = "lead-sources";
const ROLES = ["admin", "admissions", "outreach"];
const HS = "https://api.hubapi.com";
const MAX_CONTACTS = 4000;

let _sql;
function db() {
  if (!_sql) {
    const url = process.env.NETLIFY_DATABASE_URL;
    if (!url) throw new Error("NETLIFY_DATABASE_URL not configured");
    _sql = neon(url);
  }
  return _sql;
}
export function __setSql(fn) { _sql = fn; }
let _fetch = (...a) => fetch(...a);
export function __setFetch(fn) { _fetch = fn; }

const token = () => process.env.HUBSPOT_TOKEN || process.env.HUBSPOT_PRIVATE_APP_TOKEN || "";

async function hs(path, { method = "GET", body } = {}) {
  for (let i = 0; i < 5; i += 1) {
    const r = await _fetch(`${HS}${path}`, { method, headers: { Authorization: `Bearer ${token()}`, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    if (r.status === 429 || r.status >= 500) { await new Promise((res) => setTimeout(res, 500 * 2 ** i)); continue; }
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(`HubSpot ${path.split("?")[0]} → ${r.status}: ${data.message || ""}`), { status: r.status, body: data });
    return data;
  }
  throw new Error("HubSpot kept rate-limiting — try a shorter date range.");
}

export const CONTACT_PROPS = [
  "email", "firstname", "lastname", "createdate", "lifecyclestage", "company_tag", "hs_lead_status",
  "hs_analytics_source", "hs_analytics_source_data_1", "hs_analytics_source_data_2",
  "original_source_drill_down_3", "original_source_drill_down_4", "original_source_drill_down_5",
  "how_did_you_find_us_", "hs_analytics_first_url", "hs_analytics_first_referrer",
  "pd_first_channel", "pd_first_source", "pd_first_medium", "pd_first_campaign", "pd_first_landing_page", "pd_first_referrer",
  "pd_last_channel", "pd_last_source", "pd_last_campaign", "pd_first_conversion", "pd_last_conversion", "pd_quiz_archetype",
];

const dayMs = 86400000;
function parseRange(url) {
  const to = /^\d{4}-\d{2}-\d{2}$/.test(url.searchParams.get("to") || "") ? url.searchParams.get("to") : new Date().toISOString().slice(0, 10);
  const from = /^\d{4}-\d{2}-\d{2}$/.test(url.searchParams.get("from") || "") ? url.searchParams.get("from") : new Date(Date.parse(to) - 89 * dayMs).toISOString().slice(0, 10);
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T23:59:59.999Z`);
  if (!(end >= start) || end - start > 400 * dayMs) throw Object.assign(new Error("Pick a range of up to about a year."), { status: 400 });
  return { from, to, start, end };
}

async function contactsCreated(start, end) {
  const out = [];
  let after;
  for (;;) {
    const data = await hs("/crm/v3/objects/contacts/search", {
      method: "POST",
      body: {
        filterGroups: [{ filters: [{ propertyName: "createdate", operator: "BETWEEN", value: String(start), highValue: String(end) }] }],
        properties: CONTACT_PROPS, sorts: [{ propertyName: "createdate", direction: "DESCENDING" }], limit: 100, ...(after ? { after } : {}),
      },
    });
    out.push(...(data.results || []));
    after = data.paging?.next?.after;
    if (!after || out.length >= MAX_CONTACTS) return { contacts: out, truncated: !!after };
    // The search API also stops at 10,000 results.
    if (Number(after) >= 9900) return { contacts: out, truncated: true };
  }
}

async function contactsByEmail(emails) {
  const out = [];
  for (let i = 0; i < emails.length; i += 100) {
    const data = await hs("/crm/v3/objects/contacts/batch/read", { method: "POST", body: { idProperty: "email", properties: CONTACT_PROPS, inputs: emails.slice(i, i + 100).map((id) => ({ id })) } });
    out.push(...(data.results || []));
  }
  return out;
}

async function siteRecords(start, end) {
  const s = new Date(start).toISOString(); const e = new Date(end).toISOString();
  const safe = async (q, params) => { try { return await db().query(q, params); } catch (err) { if (/does not exist/.test(err.message)) return []; throw err; } };
  const quizzes = await safe(`SELECT lower(email) AS email, created_at, archetype, attribution FROM quiz_responses WHERE created_at BETWEEN $1 AND $2`, [s, e]);
  const apps = await safe(`SELECT lower(email) AS email, created_at, status, step2_at, paid_at, program, attribution FROM applications WHERE created_at BETWEEN $1 AND $2 AND status <> 'withdrawn'`, [s, e]);
  // Parents' contacts are created from the application — they're not leads.
  const par = await safe(`SELECT lower(answers->>'parent1Email') AS a, lower(answers->>'parent2Email') AS b FROM applications`, []);
  const parents = new Set(par.flatMap((r) => [r.a, r.b]).filter(Boolean));
  return { quizzes, apps, parents };
}

const pick = (t) => (t ? { utm_source: t.utm_source, utm_medium: t.utm_medium, utm_campaign: t.utm_campaign, landing: t.landing, referrer: t.referrer, gclid: t.gclid ? 1 : undefined, fbclid: t.fbclid ? 1 : undefined, ts: t.ts } : null);

/** Pure: merge HubSpot contacts + pd-apply rows into one row per lead. */
export function buildLeads(contacts, { quizzes = [], apps = [], parents = new Set() } = {}, { start = 0, end = Infinity } = {}) {
  const site = new Map();
  const touch = (email) => { if (!site.has(email)) site.set(email, { quiz: null, app: null, first: null, firstAt: Infinity, last: null }); return site.get(email); };
  for (const q of quizzes) {
    const x = touch(q.email);
    const at = Date.parse(q.created_at);
    if (!x.quiz || at < Date.parse(x.quiz.at)) x.quiz = { at: q.created_at, archetype: q.archetype };
    if (q.attribution?.first && at < x.firstAt) { x.first = q.attribution.first; x.firstAt = at; }
    if (q.attribution?.last) x.last = q.attribution.last;
  }
  for (const a of apps) {
    const x = touch(a.email);
    const at = Date.parse(a.created_at);
    const stage = a.paid_at ? "paid" : a.step2_at ? "complete" : "started";
    const rank = { started: 1, complete: 2, paid: 3 };
    if (!x.app || rank[stage] > rank[x.app.stage]) x.app = { at: a.created_at, stage, program: a.program };
    if (a.attribution?.first && at < x.firstAt) { x.first = a.attribution.first; x.firstAt = at; }
    if (a.attribution?.last) x.last = a.attribution.last;
  }
  const byEmail = new Map();
  for (const c of contacts) {
    const email = String(c.properties?.email || "").toLowerCase();
    if (email) byEmail.set(email, c);
  }
  const emails = new Set([...byEmail.keys()].filter((e) => {
    const d = Date.parse(byEmail.get(e).properties.createdate || "");
    return !(d < start || d > end);
  }));
  for (const e of site.keys()) emails.add(e);

  const leads = [];
  for (const email of emails) {
    const c = byEmail.get(email);
    const p = c?.properties || {};
    const x = site.get(email) || null;
    const rs = realSource({ contact: p, siteFirst: x?.first || null, recover: recoverOffline });
    const created = p.createdate || x?.quiz?.at || x?.app?.at || null;
    leads.push({
      id: c?.id || null,
      email,
      name: [p.firstname, p.lastname].filter(Boolean).join(" "),
      created,
      brand: p.company_tag || "",
      lifecycle: p.lifecyclestage || "",
      hubspot: HUBSPOT_SOURCE_LABELS[p.hs_analytics_source] || p.hs_analytics_source || "",
      hubspotDetail: [p.hs_analytics_source_data_1, p.hs_analytics_source_data_2].filter(Boolean).join(" › "),
      howFound: p.how_did_you_find_us_ || "",
      real: rs,
      site: x?.first ? { ...classify(x.first), touch: pick(x.first) } : p.pd_first_channel ? { channel: p.pd_first_channel, source: p.pd_first_source || "", medium: p.pd_first_medium || "", campaign: p.pd_first_campaign || "", touch: { landing: p.pd_first_landing_page, referrer: p.pd_first_referrer } } : null,
      latest: x?.last ? classify(x.last) : p.pd_last_channel ? { channel: p.pd_last_channel, source: p.pd_last_source || "", campaign: p.pd_last_campaign || "" } : null,
      quiz: x?.quiz ? x.quiz.archetype || "taken" : p.pd_quiz_archetype || "",
      app: x?.app?.stage || "",
      program: x?.app?.program || "",
      parent: parents.has(email) && !x,
      conversion: p.pd_first_conversion || (x?.quiz ? "Gap year quiz" : x?.app ? "Application (step 1)" : ""),
    });
  }
  leads.sort((a, b) => String(b.created || "").localeCompare(String(a.created || "")));
  return leads;
}

async function setup() {
  const created = []; const existing = []; const failed = [];
  try {
    await hs("/crm/v3/properties/contacts/groups", { method: "POST", body: { name: "pd_attribution", label: "Pacific Discovery attribution", displayOrder: -1 } });
  } catch (err) { if (err.status !== 409) failed.push({ name: "pd_attribution (group)", error: err.message }); }
  let have = new Set();
  try { have = new Set(((await hs("/crm/v3/properties/contacts")).results || []).map((p) => p.name)); } catch { /* try anyway */ }
  for (const p of ATTRIBUTION_PROPERTIES) {
    if (have.has(p.name)) { existing.push(p.name); continue; }
    const type = p.type || "string";
    const body = {
      name: p.name, label: p.label, groupName: "pd_attribution", type,
      fieldType: p.fieldType || (type === "string" ? "text" : type),
      description: "Written by apply.pacificdiscovery.org (quiz + application). See the Lead Sources dashboard.",
      ...(p.options ? { options: p.options.map((o, i) => ({ label: o, value: o, displayOrder: i, hidden: false })) } : {}),
    };
    try { await hs("/crm/v3/properties/contacts", { method: "POST", body }); created.push(p.name); }
    catch (err) { if (err.status === 409) existing.push(p.name); else failed.push({ name: p.name, error: err.message }); }
  }
  return { created, existing, failed };
}

export default async (req, context, deps = {}) => {
  const user = await requireDashboard(req, SLUG, ROLES, deps);
  if (user instanceof Response) return user;
  try {
    if (!token()) return json({ error: "HUBSPOT_TOKEN is not set on the dashboard site." }, 500);
    if (req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      if (body.action === "setup") {
        if (!user.isAdmin && !(user.roles || []).some((r) => ["admissions"].includes(r))) return json({ error: "Only an admin can change HubSpot properties." }, 403);
        return json(await setup());
      }
      return json({ error: "Unknown action" }, 400);
    }
    const url = new URL(req.url);
    const range = parseRange(url);
    const [{ contacts, truncated }, siteRows] = await Promise.all([contactsCreated(range.start, range.end), siteRecords(range.start, range.end)]);
    const known = new Set(contacts.map((c) => String(c.properties?.email || "").toLowerCase()));
    const missing = [...new Set([...siteRows.quizzes, ...siteRows.apps].map((r) => r.email))].filter((e) => e && !known.has(e));
    const extra = missing.length ? await contactsByEmail(missing) : [];
    const leads = buildLeads([...contacts, ...extra], siteRows, { start: range.start, end: range.end });
    return json({ range: { from: range.from, to: range.to }, truncated, leads, generatedAt: new Date().toISOString() });
  } catch (err) {
    console.error("[lead-sources]", err);
    return json({ error: err.message || "Server error" }, err.status && err.status < 500 ? err.status : 500);
  }
};

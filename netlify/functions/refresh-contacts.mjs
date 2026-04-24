/**
 * netlify/functions/refresh-contacts.mjs
 *
 * Pulls Pacific Discovery "New Lead" contacts from HubSpot and writes the
 * normalized dataset to Netlify Blobs under the key "snapshot".
 *
 * Runs:
 *   - Automatically every 4 hours (cron "0 * / 4 * * *")   [see config below]
 *   - On demand via HTTP GET/POST to /.netlify/functions/refresh-contacts
 *
 * Env required: HUBSPOT_TOKEN (Private App access token).
 *
 * Returns JSON:
 *   { ok: true, total, generatedAt, durationMs }
 * on success, or { ok: false, error } on failure.
 */

import { getStore } from "@netlify/blobs";

export const config = {
  schedule: "0 */4 * * *"
};

const PORTAL_ID = 3855728;
const STORE_NAME = "pd-dashboard";
const BLOB_KEY = "snapshot";

const CONTACT_PROPERTIES = [
  "firstname", "lastname", "email", "phone", "hubspot_owner_id",
  "lifecyclestage", "hs_lead_status", "createdate", "lastmodifieddate",
  "jobtitle", "company", "country", "city", "state",
  "which_pacific_discovery_program_did_you_join_", "program_interest",
  "program_dates", "pacific_discovery_outreach_group",
  "how_did_you_hear_about_pacific_discovery",
  "num_associated_deals", "total_revenue", "recent_deal_amount",
  "recent_deal_close_date", "hs_last_sales_activity_timestamp",
  "num_notes", "num_contacted_notes", "hs_analytics_num_visits",
  "hs_full_name_or_email"
];

const LIFECYCLE_LABELS = {
  subscriber: "Subscriber",
  lead: "Lead",
  marketingqualifiedlead: "Marketing Qualified Lead",
  salesqualifiedlead: "Sales Qualified Lead",
  opportunity: "Opportunity",
  customer: "Customer",
  "177210199": "Alumni",
  other: "Other",
  evangelist: "Evangelist"
};

const LEAD_STATUS_LABELS = {
  NEW: "New lead",
  "Qualifying call": "Qualifying call/email",
  Admissions: "Admissions",
  "Application Started": "Application Started",
  "Interview Complete": "Interview Complete",
  Unsuccessful: "Unsuccessful",
  Converted: "Customer",
  Alumni: "Alumni",
  Parent: "Parent",
  UNQUALIFIED: "Unqualified",
  Opportunity: "Opportunity",
  "Marketing Qualified": "Marketing Qualified",
  "Sales Qualified": "Sales Qualified",
  "Opted out": "Opted out",
  Subscriber: "Subscriber"
};

// ---- HubSpot helpers -------------------------------------------------------

function requireToken() {
  const t = process.env.HUBSPOT_TOKEN;
  if (!t) throw new Error("HUBSPOT_TOKEN env var is not set on this Netlify site.");
  return t;
}

async function hsFetch(url, options = {}, token) {
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`HubSpot ${res.status} ${res.statusText}: ${body.slice(0, 400)}`);
  }
  return res.json();
}

async function searchContacts(token) {
  const all = [];
  let after = "0";
  let total = null;
  while (true) {
    const body = {
      filterGroups: [{
        filters: [
          { propertyName: "company_tag", operator: "EQ", value: "Pacific Discovery" },
          { propertyName: "hs_lead_status", operator: "EQ", value: "NEW" }
        ]
      }],
      properties: CONTACT_PROPERTIES,
      sorts: [{ propertyName: "createdate", direction: "DESCENDING" }],
      limit: 100,
      after
    };
    const data = await hsFetch(
      "https://api.hubapi.com/crm/v3/objects/contacts/search",
      { method: "POST", body: JSON.stringify(body) },
      token
    );
    if (total === null) total = data.total;
    all.push(...(data.results || []));
    if (!data.paging?.next?.after) break;
    after = data.paging.next.after;
    if (total != null && all.length >= total) break;
  }
  return all;
}

async function fetchOwners(token) {
  const map = {};
  let after;
  while (true) {
    const url = new URL("https://api.hubapi.com/crm/v3/owners");
    url.searchParams.set("limit", "100");
    if (after) url.searchParams.set("after", after);
    const data = await hsFetch(url.toString(), {}, token);
    for (const o of data.results || []) {
      const name = [o.firstName, o.lastName].filter(Boolean).join(" ").trim() || o.email || String(o.id);
      map[String(o.id)] = name;
    }
    if (!data.paging?.next?.after) break;
    after = data.paging.next.after;
  }
  return map;
}

// ---- Row normalization -----------------------------------------------------

const toInt = v => { if (v == null || v === "") return 0; const n = parseInt(v, 10); return isNaN(n) ? 0 : n; };
const toFloat = v => { if (v == null || v === "") return 0; const n = parseFloat(v); return isNaN(n) ? 0 : n; };
const toFloatOrNull = v => { if (v == null || v === "") return null; const n = parseFloat(v); return isNaN(n) ? null : n; };

function normalize(contact, owners) {
  const p = contact.properties || {};
  const ownerId = p.hubspot_owner_id || "";
  const lc = p.lifecyclestage || "";
  const ls = p.hs_lead_status || "";
  return {
    id: Number(contact.id),
    name: p.hs_full_name_or_email || `${p.firstname || ""} ${p.lastname || ""}`.trim(),
    firstname: p.firstname || "",
    lastname: p.lastname || "",
    email: p.email || "",
    phone: p.phone || "",
    company: p.company || "",
    jobtitle: p.jobtitle || "",
    country: p.country || "",
    city: p.city || "",
    state: p.state || "",
    owner_id: ownerId,
    owner_name: owners[ownerId] || ownerId || "",
    lifecyclestage: lc,
    lifecycle_label: LIFECYCLE_LABELS[lc] || lc,
    hs_lead_status: ls,
    lead_status_label: LEAD_STATUS_LABELS[ls] || ls,
    createdate: p.createdate || "",
    lastmodifieddate: p.lastmodifieddate || "",
    program_joined: p.which_pacific_discovery_program_did_you_join_ || "",
    program_interest: p.program_interest || "",
    program_dates: p.program_dates || "",
    outreach_group: p.pacific_discovery_outreach_group || "",
    heard_about: p.how_did_you_hear_about_pacific_discovery || "",
    num_associated_deals: toInt(p.num_associated_deals),
    total_revenue: toFloat(p.total_revenue),
    recent_deal_amount: toFloatOrNull(p.recent_deal_amount),
    recent_deal_close_date: p.recent_deal_close_date || "",
    hs_last_sales_activity_timestamp: p.hs_last_sales_activity_timestamp || "",
    num_notes: toInt(p.num_notes),
    num_contacted_notes: toInt(p.num_contacted_notes),
    hs_analytics_num_visits: toInt(p.hs_analytics_num_visits)
  };
}

// ---- Handler ---------------------------------------------------------------

export default async (req, context) => {
  const started = Date.now();
  try {
    const token = requireToken();
    const contacts = await searchContacts(token);
    const owners = await fetchOwners(token);
    const rows = contacts.map(c => normalize(c, owners));

    const payload = {
      generatedAt: new Date().toISOString(),
      filters: { company_tag: "Pacific Discovery", hs_lead_status: "NEW" },
      total: rows.length,
      portalId: PORTAL_ID,
      rows
    };

    const store = getStore(STORE_NAME);
    await store.setJSON(BLOB_KEY, payload);

    const out = {
      ok: true,
      total: rows.length,
      generatedAt: payload.generatedAt,
      durationMs: Date.now() - started
    };
    console.log("refresh-contacts:", out);
    return new Response(JSON.stringify(out), {
      headers: { "content-type": "application/json", "cache-control": "no-store" }
    });
  } catch (err) {
    const msg = err?.message || String(err);
    console.error("refresh-contacts failed:", msg);
    return new Response(JSON.stringify({ ok: false, error: msg }), {
      status: 500,
      headers: { "content-type": "application/json", "cache-control": "no-store" }
    });
  }
};

// netlify/functions/refresh-hot-leads.mjs
//
// Scheduled Netlify Function that pulls "hot" LEADS (contacts) from HubSpot
// and writes a JSON feed the frontend dashboard reads.
//
// Primary object: CONTACTS (filtered to company_tag = "Pacific Discovery ").
// Enrichment: primary associated DEAL, used to determine bucket + amount.
//
// Trigger: daily via netlify.toml `[functions."refresh-hot-leads"] schedule`
// Output: Netlify Blobs ("hot-leads" / "hot-leads.json").
//
// Env vars required:
//   HUBSPOT_TOKEN
//
// HubSpot private-app scopes:
//   crm.objects.contacts.read
//   crm.objects.deals.read
//   crm.objects.owners.read
//   crm.schemas.deals.read      (to list pipelines + stages)
//   crm.schemas.contacts.read

import { getStore } from "@netlify/blobs";

// ----------------------------- CONFIG ---------------------------------------

const CONFIG = {
  // Brand filter on the contact. The enum definition shows the option with a
  // trailing space, but actual stored values are "Pacific Discovery" (clean).
  // Verified against live data: 8,359 contacts match in a 14-day window.
  companyTagValue: "Pacific Discovery",

  // Pre-filter contacts by lifecyclestage so the function doesn't pull
  // newsletter subscribers / alumni / random "other" contacts.
  contactLifecycleStages: [
    "lead",
    "marketingqualifiedlead",
    "salesqualifiedlead",
    "opportunity",
    "customer",
  ],

  // Pre-filter on hs_lead_status to only pull contacts who are already in
  // (or past) the applicant stage. This is what narrows 5,500 PD contacts
  // down to ~hundreds and keeps the function well under HubSpot's 4 req/s
  // search limit. Leave empty to skip this filter entirely.
  contactLeadStatuses: [
    "Application Started",
    "Admissions",
    "Interview Complete",
    "Opportunity",
    "Converted",
  ],

  // Only deals in pipelines whose NAME matches one of these patterns are used
  // to classify a lead's bucket. Contacts with no matching deal fall back to
  // contact-level lifecyclestage / hs_lead_status.
  pipelineNamePatterns: [
    /semester/i,       // Fall/Spring/Gap/Mini Semester
    /minimester/i,
    /mini[-_ ]?mester/i,
    /summer/i,
  ],

  // Stage-label classification (deal-side).
  dealStageBuckets: [
    { bucket: "Sale",        hot: true,  patterns: [/deposit (received|paid|processed)/i, /awaiting deposit/i, /^deposit$/i] },
    { bucket: "Opportunity", hot: true,  patterns: [/application fee/i, /app.*fee/i, /interview/i, /^opportunity$/i] },
    { bucket: "Applicant",   hot: true,  patterns: [/application started/i, /applicant/i, /^admissions$/i] },
    { bucket: "SQL",         hot: false, patterns: [/sales qualified/i, /^sql$/i, /qualifying/i] },
    { bucket: "MQL",         hot: false, patterns: [/marketing qualified/i, /^mql$/i, /^new lead$/i, /^new$/i] },
    { bucket: "Closed Won",  hot: false, patterns: [/closed ?won/i, /payment complete/i] },
    { bucket: "Closed Lost", hot: false, patterns: [/closed ?lost/i, /unsuccessful/i, /lost/i] },
  ],

  // Contact-side fallback classification (used when contact has no matching deal).
  contactFallbackBuckets: [
    { bucket: "Opportunity", hot: true,  when: c => c.lifecyclestage === "opportunity" || /opportunity|interview/i.test(c.hs_lead_status || "") },
    { bucket: "Applicant",   hot: true,  when: c => /application started|admissions|applicant/i.test(c.hs_lead_status || "") },
    { bucket: "SQL",         hot: false, when: c => c.lifecyclestage === "salesqualifiedlead" || /sales qualified/i.test(c.hs_lead_status || "") },
    { bucket: "MQL",         hot: false, when: c => c.lifecyclestage === "marketingqualifiedlead" || /marketing qualified/i.test(c.hs_lead_status || "") },
  ],

  // A contact is "recent" if lastmodifieddate is within this many days.
  recencyDays: 14,

  // Portal ID used to build HubSpot UI links.
  portalId: "3855728",

  // Pagination
  pageSize: 100,
  maxContacts: 5000,
};

const HUBSPOT_BASE = "https://api.hubapi.com";

// ----------------------------- HELPERS --------------------------------------

function hubspotHeaders() {
  const token = process.env.HUBSPOT_TOKEN;
  if (!token) throw new Error("HUBSPOT_TOKEN env var is missing");
  return {
    "Authorization": `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Auto-retries 429 (rate limit) and 5xx with exponential backoff + jitter.
// HubSpot Search API limit is 4 req/s; other endpoints are more permissive.
async function hubspotFetch(path, init = {}, attempt = 0) {
  const url = path.startsWith("http") ? path : `${HUBSPOT_BASE}${path}`;
  const res = await fetch(url, { ...init, headers: { ...hubspotHeaders(), ...(init.headers || {}) } });

  if (res.status === 429 || res.status >= 500) {
    if (attempt >= 6) {
      const body = await res.text();
      throw new Error(`HubSpot ${res.status} on ${path} after ${attempt} retries: ${body.slice(0, 300)}`);
    }
    // Honor Retry-After if provided, else exponential backoff.
    const retryAfter = Number(res.headers.get("retry-after"));
    const wait = Number.isFinite(retryAfter) && retryAfter > 0
      ? retryAfter * 1000
      : Math.min(16000, 500 * 2 ** attempt) + Math.floor(Math.random() * 250);
    await sleep(wait);
    return hubspotFetch(path, init, attempt + 1);
  }

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`HubSpot ${res.status} on ${path}: ${body.slice(0, 500)}`);
  }
  return res.json();
}

function classifyDealStage(stageLabel) {
  for (const b of CONFIG.dealStageBuckets) if (b.patterns.some(p => p.test(stageLabel))) return b;
  return { bucket: "Other", hot: false };
}

function classifyContactFallback(contactProps) {
  for (const b of CONFIG.contactFallbackBuckets) if (b.when(contactProps)) return b;
  return { bucket: "Other", hot: false };
}

function matchesPipelineName(label) {
  return CONFIG.pipelineNamePatterns.some(p => p.test(label));
}

function daysBetween(a, b) {
  if (!a || !b) return null;
  const ms = new Date(b).getTime() - new Date(a).getTime();
  return Math.max(0, Math.round(ms / 86400000));
}

// ----------------------------- DATA FETCH -----------------------------------

async function listPipelinesAndStages() {
  const data = await hubspotFetch("/crm/v3/pipelines/deals");
  return (data.results || []).map(p => ({
    id: p.id,
    label: p.label,
    stages: (p.stages || []).map(s => ({ id: s.id, label: s.label, displayOrder: s.displayOrder })),
  }));
}

async function searchPDContacts() {
  const sinceMs = Date.now() - CONFIG.recencyDays * 86400000;
  const contactProps = [
    "firstname", "lastname", "email",
    "lifecyclestage", "hs_lead_status", "company_tag",
    "hubspot_owner_id",
    "lastmodifieddate", "notes_last_updated", "hs_last_sales_activity_date",
    "hs_object_id",
  ];
  const out = [];
  let after = undefined;

  do {
    const body = {
      limit: CONFIG.pageSize,
      after,
      sorts: [{ propertyName: "lastmodifieddate", direction: "DESCENDING" }],
      properties: contactProps,
      filterGroups: [{
        filters: [
          { propertyName: "company_tag",       operator: "EQ",  value: CONFIG.companyTagValue },
          { propertyName: "lastmodifieddate",  operator: "GTE", value: String(sinceMs) },
          { propertyName: "lifecyclestage",    operator: "IN",  values: CONFIG.contactLifecycleStages },
          ...(CONFIG.contactLeadStatuses.length
            ? [{ propertyName: "hs_lead_status", operator: "IN", values: CONFIG.contactLeadStatuses }]
            : []),
        ],
      }],
    };
    const data = await hubspotFetch("/crm/v3/objects/contacts/search", {
      method: "POST",
      body: JSON.stringify(body),
    });
    out.push(...(data.results || []));
    after = data.paging?.next?.after;
    // HubSpot Search API is capped at 4 req/s; 300ms between pages keeps us
    // well under even with burst allowances in flight.
    if (after) await sleep(300);
  } while (after && out.length < CONFIG.maxContacts);

  return out;
}

async function batchGetDealsForContacts(contactIds) {
  const map = {};
  if (!contactIds.length) return map;
  for (let i = 0; i < contactIds.length; i += 100) {
    const chunk = contactIds.slice(i, i + 100);
    const data = await hubspotFetch("/crm/v4/associations/contacts/deals/batch/read", {
      method: "POST",
      body: JSON.stringify({ inputs: chunk.map(id => ({ id })) }),
    });
    for (const row of data.results || []) {
      map[row.from.id] = (row.to || []).map(t => String(t.toObjectId));
    }
  }
  return map;
}

async function batchReadDeals(dealIds) {
  const byId = {};
  if (!dealIds.length) return byId;
  const props = [
    "dealname", "pipeline", "dealstage", "amount",
    "hs_lastmodifieddate", "createdate", "hs_date_entered_current_stage", "closedate",
  ];
  for (let i = 0; i < dealIds.length; i += 100) {
    const chunk = dealIds.slice(i, i + 100);
    const data = await hubspotFetch("/crm/v3/objects/deals/batch/read", {
      method: "POST",
      body: JSON.stringify({ properties: props, inputs: chunk.map(id => ({ id })) }),
    });
    for (const d of data.results || []) byId[d.id] = d;
  }
  return byId;
}

async function fetchOwners(ownerIds) {
  if (!ownerIds.size) return {};
  const map = {};
  let after = undefined;
  for (let i = 0; i < 5; i++) {
    const qs = new URLSearchParams({ limit: "100" });
    if (after) qs.set("after", after);
    const data = await hubspotFetch(`/crm/v3/owners/?${qs.toString()}`);
    for (const o of data.results || []) {
      map[o.id] = `${o.firstName ?? ""} ${o.lastName ?? ""}`.trim() || o.email || o.id;
    }
    after = data.paging?.next?.after;
    if (!after) break;
  }
  return map;
}

// ----------------------------- PICK PRIMARY DEAL ---------------------------

function pickPrimaryDeal(dealIds, dealsById, stageById) {
  // Prefer a deal that (a) is in a matched pipeline and (b) is in a hot bucket.
  // Within that, prefer the one with the furthest-along bucket (Sale > Opp > Applicant).
  // Ties broken by most recently modified.
  const bucketRank = { "Sale": 0, "Opportunity": 1, "Applicant": 2, "Other": 99 };
  let best = null;
  let bestScore = [99, 99, 0]; // [bucketRank, pipelineMatched(0=yes), -lastMod]

  for (const id of dealIds) {
    const deal = dealsById[id];
    if (!deal) continue;
    const pipelineId = deal.properties.pipeline;
    const ps = stageById.get(`${pipelineId}:${deal.properties.dealstage}`);
    if (!ps) continue;
    const pipelineMatched = matchesPipelineName(ps.pipeline.label) ? 0 : 1;
    const cls = classifyDealStage(ps.stage.label);
    const rank = bucketRank[cls.bucket] ?? 99;
    const lastMod = new Date(deal.properties.hs_lastmodifieddate || 0).getTime();

    const score = [rank, pipelineMatched, -lastMod];
    // Lexicographic compare
    if (score[0] < bestScore[0]
        || (score[0] === bestScore[0] && score[1] < bestScore[1])
        || (score[0] === bestScore[0] && score[1] === bestScore[1] && score[2] < bestScore[2])) {
      best = { deal, pipeline: ps.pipeline, stage: ps.stage, bucket: cls.bucket, hot: cls.hot, pipelineMatched: pipelineMatched === 0 };
      bestScore = score;
    }
  }
  return best;
}

// ----------------------------- MAIN -----------------------------------------

export default async () => {
  const startedAt = new Date();

  // 1. Fetch pipelines + stages for deal lookups.
  const allPipelines = await listPipelinesAndStages();
  const stageById = new Map();
  for (const p of allPipelines) for (const s of p.stages) stageById.set(`${p.id}:${s.id}`, { pipeline: p, stage: s });

  // 2. Search contacts with company_tag = Pacific Discovery, recently modified.
  const contacts = await searchPDContacts();

  // 3. Fetch their associated deals.
  const contactIds = contacts.map(c => c.id);
  const contactToDeals = await batchGetDealsForContacts(contactIds);
  const allDealIds = [...new Set(Object.values(contactToDeals).flat())];
  const dealsById = await batchReadDeals(allDealIds);

  // 4. Owner name lookup (contact owners; deal owners not needed per row).
  const ownerIds = new Set(contacts.map(c => c.properties.hubspot_owner_id).filter(Boolean));
  const ownerMap = await fetchOwners(ownerIds);

  // 5. Build lead records.
  const nowIso = startedAt.toISOString();
  const records = [];

  for (const c of contacts) {
    const props = c.properties;
    const dealIds = contactToDeals[c.id] || [];
    const primary = pickPrimaryDeal(dealIds, dealsById, stageById);

    // Determine bucket: prefer deal-side classification when deal is in a
    // matched (PD semester/mini/summer) pipeline. Otherwise fall back to
    // contact-level lifecyclestage/hs_lead_status.
    let bucket, hot, stageLabel, pipelineLabel, pipelineId, amount = null, dealId = null, dealName = null, daysInStage = null;
    if (primary && primary.pipelineMatched && primary.hot) {
      bucket = primary.bucket;
      hot = true;
      stageLabel = primary.stage.label;
      pipelineLabel = primary.pipeline.label;
      pipelineId = primary.pipeline.id;
      dealId = primary.deal.id;
      dealName = primary.deal.properties.dealname;
      amount = primary.deal.properties.amount ? Number(primary.deal.properties.amount) : null;
      daysInStage = daysBetween(primary.deal.properties.hs_date_entered_current_stage, nowIso);
    } else {
      const cls = classifyContactFallback(props);
      bucket = cls.bucket;
      hot = cls.hot;
      stageLabel = props.hs_lead_status || props.lifecyclestage || "—";
      // If there is a deal at all, surface its pipeline/amount for context.
      if (primary) {
        pipelineLabel = primary.pipeline.label;
        pipelineId = primary.pipeline.id;
        dealId = primary.deal.id;
        dealName = primary.deal.properties.dealname;
        amount = primary.deal.properties.amount ? Number(primary.deal.properties.amount) : null;
      }
    }

    if (!hot) continue;

    const name = `${props.firstname ?? ""} ${props.lastname ?? ""}`.trim() || props.email || `Contact ${c.id}`;
    const lastActivity = props.hs_last_sales_activity_date || props.notes_last_updated || props.lastmodifieddate;

    records.push({
      contactId: c.id,
      name,
      email: props.email || null,
      bucket,
      stageLabel,
      pipelineId: pipelineId ?? null,
      pipelineLabel: pipelineLabel ?? null,
      amount,
      owner: ownerMap[props.hubspot_owner_id] || null,
      lastActivity,
      daysSinceTouch: daysBetween(lastActivity, nowIso),
      daysInStage,
      dealId,
      dealName,
      contactUrl: `https://app.hubspot.com/contacts/${CONFIG.portalId}/record/0-1/${c.id}?utm_source=hot_leads_dashboard`,
      dealUrl: dealId
        ? `https://app.hubspot.com/contacts/${CONFIG.portalId}/record/0-3/${dealId}?utm_source=hot_leads_dashboard`
        : null,
    });
  }

  // 6. Sort: hottest first, then freshest.
  const bucketRank = { "Sale": 0, "Opportunity": 1, "Applicant": 2 };
  records.sort((a, b) => {
    const rd = (bucketRank[a.bucket] ?? 99) - (bucketRank[b.bucket] ?? 99);
    if (rd) return rd;
    return new Date(b.lastActivity || 0) - new Date(a.lastActivity || 0);
  });

  // 7. Summary.
  const summary = {
    generatedAt: startedAt.toISOString(),
    recencyDays: CONFIG.recencyDays,
    companyTag: CONFIG.companyTagValue.trim(),
    pipelinesScanned: allPipelines.filter(p => matchesPipelineName(p.label)).map(p => ({ id: p.id, label: p.label })),
    counts: {
      total: records.length,
      Sale: records.filter(r => r.bucket === "Sale").length,
      Opportunity: records.filter(r => r.bucket === "Opportunity").length,
      Applicant: records.filter(r => r.bucket === "Applicant").length,
    },
    totalPipelineValue: records.reduce((s, r) => s + (r.amount || 0), 0),
    contactsScanned: contacts.length,
  };

  const payload = { summary, records };

  // 8. Persist to Netlify Blobs.
  const store = getStore({ name: "hot-leads", consistency: "strong" });
  await store.setJSON("hot-leads.json", payload);

  return new Response(JSON.stringify({ ok: true, ...summary.counts, contactsScanned: summary.contactsScanned }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};

// Netlify scheduled function config — daily at 06:30 UTC.
export const config = {
  schedule: "30 6 * * *",
};

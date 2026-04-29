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

  // Pre-filter contacts by lifecyclestage. "customer" is excluded because
  // this list is for mining still-to-close leads — customers have already
  // paid a deposit.
  contactLifecycleStages: [
    "lead",
    "marketingqualifiedlead",
    "salesqualifiedlead",
    "opportunity",
  ],

  // Pre-filter on hs_lead_status. "Converted" is excluded for the same
  // reason — converted contacts have already paid. We want leads still in
  // flight: Application Started, Admissions, Interview Complete, Opportunity.
  contactLeadStatuses: [
    "Application Started",
    "Admissions",
    "Interview Complete",
    "Opportunity",
  ],

  // ---- SQL SCORING ----
  // Score-based SQL identification. A contact is flagged "SQL" if their
  // composite engagement score meets sqlThreshold. Scoring is tuned for
  // Pacific Discovery's sales cycle and is the easiest thing to tune as
  // you learn which contacts are real SQLs vs noise.
  //
  // Threshold = 50 forces multiple engagements. No single signal hits 50 on
  // its own (max per signal is 30), so a contact must accumulate at least
  // two real engagement events (or one strong event + multiple weak ones).
  // Common combinations:
  //   Form submission (30) + email reply (25)          = 55  ✓
  //   Meeting booked (25) + email reply (25)           = 50  ✓
  //   Meeting (25) + form (30)                         = 55  ✓
  //   Form (30) + email click (15) + pageview (10)     = 55  ✓
  //   Form alone (30)                                  = 30  ✗
  //   Meeting alone (25)                               = 25  ✗
  sqlThreshold: 50,

  // "Near-SQL" triage band. Contacts scoring >= this but < sqlThreshold show
  // up in a separate bucket — they're MQLs who are accumulating real signals
  // and are candidates for admissions to push over the line. Hidden from the
  // main "All" view in the dashboard; surfaced via a dedicated chip.
  nearSqlMinThreshold: 30,
  sqlLifecycleStages: ["lead", "marketingqualifiedlead", "salesqualifiedlead"],
  sqlScoring: {
    formSubmissionLast14Days: 30,
    multipleUniqueForms: 10,           // >= 2 unique forms submitted (lifetime)
    meetingBookedEver: 35,             // Bumped from 25 — by far the most predictive
                                       // signal in real "hot lead" data. Detects via
                                       // engagements_last_meeting_booked_medium OR a
                                       // "Meetings Link:" conversion event.
    applyNowFormBonus: 15,             // Apply Now / Registration form is high-intent.
                                       // Stacks on top of formSubmissionLast14Days.
    salesEmailRepliedLast14Days: 30,   // Bumped from 25 — replies are rare and decisive.
    salesEmailClickedLast14Days: 15,
    salesEmailOpenedLast7Days: 10,
    threePlusSessionsLast14Days: 15,
    pageviewLast7Days: 10,
    hasOwner: 5,
    householdLastnameMatch: 20,        // Shared lastname with a contact in the current
                                       // pull who has a deal. Catches parents whose
                                       // student is actively progressing.
  },

  // ---- APPLICANT PIPELINE ----
  // A deal in a pipeline whose name matches these patterns -> Applicant bucket
  // (any stage except closed-won/closed-lost). Exact expected name: "PD Applications".
  applicantPipelinePatterns: [
    /^pd\s+applications?$/i,
  ],

  // ---- OPPORTUNITY PIPELINES ----
  // Deals in any pipeline matching these patterns count for Opportunity only
  // if the stage label also matches opportunityStagePatterns below. These are
  // the "initial 5" program pipelines. Patterns are deliberately tight to
  // avoid matching archived per-term pipelines (e.g., "Hawaii High School
  // Summer 2022") or high-school pipelines.
  opportunityPipelinePatterns: [
    /^fall\s+semester$/i,
    /^fall\s+mini\s*(-?\s*)?semester$/i,
    /^spring\s+semester$/i,
    /^spring\s+mini\s*(-?\s*)?semester$/i,
    /^summer\s+program(s)?$/i,
  ],

  // If your actual pipeline names differ, override opportunityPipelinePatterns
  // above OR set explicit pipeline IDs here (takes precedence over patterns).
  // You can find a pipeline's ID at Settings -> Objects -> Deals -> Pipelines
  // (it's in the URL when you click a pipeline).
  opportunityPipelineIds: [],  // e.g., ["74958084", "74958085", "694619955"]

  // Stage labels that qualify as Opportunity inside the 5 program pipelines.
  opportunityStagePatterns: [
    /^application received/i,
    /^interview$/i,
    /^interview complete$/i,
  ],

  // Stage patterns that disqualify a deal from being "hot" even if pipeline
  // matches (deposit/closed excluded; applicant-pipeline closed states; etc.).
  excludedStagePatterns: [
    /closed ?won/i,
    /closed ?lost/i,
    /unsuccessful/i,
    /deposit (received|paid|processed)/i,
    /payment complete/i,
    /college\s*credit/i,  // College Credit stage is not a normal applicant/opp
  ],


  // NOTE: Applicant and Opportunity are now deal-driven only (see
  // applicantPipelinePatterns / opportunityPipelinePatterns above). There is
  // no contact-level fallback for them — a contact without a matching deal
  // cannot be classified as Applicant or Opportunity. Score-based SQL below
  // still applies independently.

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

// Pipeline / stage predicates.
const isApplicantPipeline  = label => CONFIG.applicantPipelinePatterns.some(p => p.test(label || ""));
// Allow explicit pipeline ID override, else fall back to name regexes.
const isOpportunityPipeline = (label, id) => {
  if (CONFIG.opportunityPipelineIds?.length) {
    return CONFIG.opportunityPipelineIds.includes(String(id));
  }
  return CONFIG.opportunityPipelinePatterns.some(p => p.test(label || ""));
};
const isOpportunityStage   = label => CONFIG.opportunityStagePatterns.some(p => p.test(label || ""));
const isExcludedStage      = label => CONFIG.excludedStagePatterns.some(p => p.test(label || ""));
const matchesAnyWatchedPipeline = label => isApplicantPipeline(label) || isOpportunityPipeline(label);

// Classify a deal by pipeline + stage label into a bucket.
//   - Deal in PD Applications pipeline (non-closed stage)  => Applicant
//   - Deal in one of the 5 program pipelines, stage is App Received / Interview / Interview Complete => Opportunity
//   - Otherwise -> "Other" (excluded from the hot list)
function classifyDeal(pipelineLabel, stageLabel, pipelineId) {
  if (isExcludedStage(stageLabel)) return { bucket: "Excluded", hot: false };
  if (isApplicantPipeline(pipelineLabel)) return { bucket: "Applicant", hot: true };
  if (isOpportunityPipeline(pipelineLabel, pipelineId) && isOpportunityStage(stageLabel)) {
    return { bucket: "Opportunity", hot: true };
  }
  return { bucket: "Other", hot: false };
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
    "lastmodifieddate", "notes_last_contacted", "notes_last_updated",
    "program_interest",
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

// Pull contacts who sit earlier in the funnel (lead/MQL/SQL lifecyclestage)
// and show at least one engagement signal. This is the candidate pool for
// score-based SQL identification. We use 4 filterGroups (OR'd together) so
// any ONE of form/meeting/sales-email-click/reply qualifies for evaluation.
async function searchSQLCandidates() {
  const sinceMs14 = Date.now() - 14 * 86400000;
  const sinceIso14 = new Date(sinceMs14).toISOString();
  const baseFilters = [
    { propertyName: "company_tag",    operator: "EQ", value: CONFIG.companyTagValue },
    { propertyName: "lifecyclestage", operator: "IN", values: CONFIG.sqlLifecycleStages },
  ];
  const filterGroups = [
    { filters: [...baseFilters, { propertyName: "recent_conversion_date",      operator: "GTE", value: sinceIso14 }] },
    { filters: [...baseFilters, { propertyName: "hs_sales_email_last_replied",  operator: "GTE", value: sinceIso14 }] },
    { filters: [...baseFilters, { propertyName: "hs_sales_email_last_clicked",  operator: "GTE", value: sinceIso14 }] },
    { filters: [...baseFilters, { propertyName: "engagements_last_meeting_booked_medium", operator: "HAS_PROPERTY" }] },
  ];
  const properties = [
    "firstname", "lastname", "email",
    "lifecyclestage", "hs_lead_status", "company_tag",
    "hubspot_owner_id",
    "lastmodifieddate", "notes_last_updated",
    "hs_last_sales_activity_timestamp", "notes_last_contacted",
    "program_interest",
    // Engagement signals used for scoring:
    "recent_conversion_date", "num_conversion_events", "num_unique_conversion_events",
    "recent_conversion_event_name", "first_conversion_event_name",
    "hs_sales_email_last_replied", "hs_sales_email_last_clicked", "hs_sales_email_last_opened",
    "hs_analytics_num_visits", "hs_analytics_last_visit_timestamp", "hs_analytics_num_page_views",
    "engagements_last_meeting_booked_medium",
  ];

  const out = [];
  let after = undefined;
  do {
    const body = {
      limit: CONFIG.pageSize,
      after,
      sorts: [{ propertyName: "lastmodifieddate", direction: "DESCENDING" }],
      properties,
      filterGroups,
    };
    const data = await hubspotFetch("/crm/v3/objects/contacts/search", {
      method: "POST",
      body: JSON.stringify(body),
    });
    out.push(...(data.results || []));
    after = data.paging?.next?.after;
    if (after) await sleep(300);
  } while (after && out.length < CONFIG.maxContacts);
  return out;
}

function computeSQLScore(props, context = {}) {
  const now = Date.now();
  const within = (iso, days) => iso && (now - new Date(iso).getTime()) <= days * 86400000;
  const weights = CONFIG.sqlScoring;
  const breakdown = {};
  let score = 0;
  const add = (key, points) => { if (points > 0) { score += points; breakdown[key] = points; } };

  // Form submitted in last 14 days
  if (within(props.recent_conversion_date, 14)) add("form_last_14d", weights.formSubmissionLast14Days);
  if (Number(props.num_unique_conversion_events || 0) >= 2) add("multi_forms", weights.multipleUniqueForms);

  // Meeting booked — checks both the engagement property AND the conversion-
  // event name (which is what HubSpot's Meetings tool actually populates for
  // most leads in this data set).
  const recentConv = props.recent_conversion_event_name || "";
  const firstConv  = props.first_conversion_event_name || "";
  const isMeetingsLinkConv = /meetings link/i.test(recentConv) || /meetings link/i.test(firstConv);
  if (props.engagements_last_meeting_booked_medium || isMeetingsLinkConv) {
    add("meeting_booked", weights.meetingBookedEver);
  }

  // Apply Now / Registration form (high-intent) — bonus on top of any form submission.
  const isApplyNow = /apply now|registration form/i.test(recentConv) || /apply now|registration form/i.test(firstConv);
  if (isApplyNow) add("apply_now_form", weights.applyNowFormBonus);

  // Sales email engagement
  if (within(props.hs_sales_email_last_replied, 14)) add("email_replied_14d", weights.salesEmailRepliedLast14Days);
  if (within(props.hs_sales_email_last_clicked, 14)) add("email_clicked_14d", weights.salesEmailClickedLast14Days);
  if (within(props.hs_sales_email_last_opened, 7))  add("email_opened_7d",   weights.salesEmailOpenedLast7Days);

  // Web behavior
  if (Number(props.hs_analytics_num_visits || 0) >= 3 && within(props.hs_analytics_last_visit_timestamp, 14)) {
    add("sessions_3_14d", weights.threePlusSessionsLast14Days);
  }
  if (within(props.hs_analytics_last_visit_timestamp, 7)) add("pageview_7d", weights.pageviewLast7Days);

  // Has an admissions owner
  if (props.hubspot_owner_id) add("has_owner", weights.hasOwner);

  // Household signal — same lastname as a contact in this data pull who has a
  // deal. Catches parents like Boris Lieberman / Laura Keller whose own
  // engagement looks light but whose student is in the funnel.
  const lastname = (props.lastname || "").trim().toLowerCase();
  if (lastname && context.householdLastnames?.has(lastname)) {
    add("household_match", weights.householdLastnameMatch);
  }

  // Top contributing signal for display
  const topSignal = Object.entries(breakdown).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  return { score, breakdown, topSignal };
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
    "pd_program",
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
  // Pick the contact's most-progressed hot deal.
  // Rank: Opportunity (0) > Applicant (1) > other (99). Ties go to most-recent.
  const bucketRank = { "Opportunity": 0, "Applicant": 1, "Other": 99, "Excluded": 99 };
  let best = null;
  let bestScore = [99, 0]; // [bucketRank, -lastMod]

  for (const id of dealIds) {
    const deal = dealsById[id];
    if (!deal) continue;
    const pipelineId = deal.properties.pipeline;
    const ps = stageById.get(`${pipelineId}:${deal.properties.dealstage}`);
    if (!ps) continue;
    const cls = classifyDeal(ps.pipeline.label, ps.stage.label, ps.pipeline.id);
    const rank = bucketRank[cls.bucket] ?? 99;
    const lastMod = new Date(deal.properties.hs_lastmodifieddate || 0).getTime();

    const score = [rank, -lastMod];
    if (score[0] < bestScore[0]
        || (score[0] === bestScore[0] && score[1] < bestScore[1])) {
      best = { deal, pipeline: ps.pipeline, stage: ps.stage, bucket: cls.bucket, hot: cls.hot };
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

  // 2a. Applicant/Opportunity candidates (pre-filtered by hs_lead_status).
  const applicantOppContacts = await searchPDContacts();
  // 2b. SQL candidates: earlier-funnel contacts with engagement signals.
  const sqlCandidateContacts = await searchSQLCandidates();

  // Merge + dedup by contact id. If a contact appears in both searches, we
  // keep the Applicant/Opportunity version (more authoritative classification).
  const byId = new Map();
  for (const c of sqlCandidateContacts) byId.set(c.id, c);
  for (const c of applicantOppContacts) byId.set(c.id, c);
  const contacts = [...byId.values()];

  // Build a set of contact IDs that came from the SQL candidate pool so we
  // know whether to attempt SQL scoring on fallback contacts.
  const sqlCandidateIds = new Set(sqlCandidateContacts.map(c => c.id));

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

  // Pre-build household lastname set: contacts in the current pull who have
  // at least one associated deal. SQL candidates sharing a lastname with this
  // set get a "parent of an active student" bonus during scoring.
  const householdLastnames = new Set();
  for (const c of contacts) {
    const ids = contactToDeals[c.id] || [];
    if (ids.length > 0) {
      const ln = (c.properties.lastname || "").trim().toLowerCase();
      if (ln && ln.length >= 2) householdLastnames.add(ln);
    }
  }

  for (const c of contacts) {
    const props = c.properties;
    const dealIds = contactToDeals[c.id] || [];
    const primary = pickPrimaryDeal(dealIds, dealsById, stageById);

    // Determine bucket:
    //   1. Deal-side classification if contact has a hot deal in a matched pipeline.
    //   2. Otherwise, contact-level fallback (Applicant/Opportunity via hs_lead_status).
    //   3. Otherwise, try SQL scoring — if score >= threshold, bucket = "SQL".
    let bucket, hot, stageLabel, pipelineLabel, pipelineId;
    let amount = null, dealId = null, dealName = null, daysInStage = null;
    let sqlScore = null, sqlBreakdown = null, sqlTopSignal = null;

    if (primary && primary.hot) {
      // Deal-based classification: Applicant or Opportunity.
      bucket = primary.bucket;
      hot = true;
      stageLabel = primary.stage.label;
      pipelineLabel = primary.pipeline.label;
      pipelineId = primary.pipeline.id;
      dealId = primary.deal.id;
      dealName = primary.deal.properties.dealname;
      amount = primary.deal.properties.amount ? Number(primary.deal.properties.amount) : null;
      daysInStage = daysBetween(primary.deal.properties.hs_date_entered_current_stage, nowIso);
    } else if (sqlCandidateIds.has(c.id) && dealIds.length === 0) {
      // Score-based classification — a contact is only eligible if they have
      // NO associated deals. The moment a deal exists, they belong in
      // Applicant/Opportunity (deal-driven) or they're past the hot list.
      const scored = computeSQLScore(props, { householdLastnames });
      if (scored.score >= CONFIG.sqlThreshold) {
        bucket = "SQL";
        hot = true;
      } else if (scored.score >= CONFIG.nearSqlMinThreshold) {
        bucket = "Near-SQL";  // MQL triage band — real signals, not yet SQL
        hot = true;
      }
      if (hot) {
        stageLabel = props.hs_lead_status || props.lifecyclestage || "—";
        sqlScore = scored.score;
        sqlBreakdown = scored.breakdown;
        sqlTopSignal = scored.topSignal;
      }
    }

    if (!hot) continue;

    const name = `${props.firstname ?? ""} ${props.lastname ?? ""}`.trim() || props.email || `Contact ${c.id}`;
    // "Days since touch" = days since a logged, two-way communication.
    // notes_last_contacted fires on logged calls, emails, meetings (and
    // WhatsApp messages if your HubSpot WhatsApp integration logs them as
    // engagement records). We fall back to notes_last_updated (adds notes
    // and tasks) and finally to any property change, with an epoch-zero
    // sanity filter because HubSpot sometimes returns 1970-01-01 for nulls.
    const validDate = d => d && new Date(d).getTime() > new Date("2000-01-01").getTime();
    const lastActivity = [
      props.notes_last_contacted,
      props.notes_last_updated,
      props.lastmodifieddate,
    ].find(validDate) || null;

    // Program interest: prefer deal's pd_program (more specific), fall back
    // to contact's program_interest (initial enquiry target).
    const programInterest =
      (primary?.deal?.properties?.pd_program || "").trim() ||
      (props.program_interest || "").trim() ||
      null;

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
      programInterest,
      dealId,
      dealName,
      sqlScore,
      sqlTopSignal,
      sqlBreakdown,
      contactUrl: `https://app.hubspot.com/contacts/${CONFIG.portalId}/record/0-1/${c.id}?utm_source=hot_leads_dashboard`,
      dealUrl: dealId
        ? `https://app.hubspot.com/contacts/${CONFIG.portalId}/record/0-3/${dealId}?utm_source=hot_leads_dashboard`
        : null,
    });
  }

  // 6. Sort: Opportunity > Applicant > SQL > Near-SQL (closer to close first).
  // Within SQL/Near-SQL, sort by score descending. Elsewhere by freshness.
  const bucketRank = { "Opportunity": 0, "Applicant": 1, "SQL": 2, "Near-SQL": 3 };
  records.sort((a, b) => {
    const rd = (bucketRank[a.bucket] ?? 99) - (bucketRank[b.bucket] ?? 99);
    if (rd) return rd;
    if ((a.bucket === "SQL" || a.bucket === "Near-SQL") && a.bucket === b.bucket) {
      return (b.sqlScore || 0) - (a.sqlScore || 0);
    }
    return new Date(b.lastActivity || 0) - new Date(a.lastActivity || 0);
  });

  // 7. Summary.
  const summary = {
    generatedAt: startedAt.toISOString(),
    recencyDays: CONFIG.recencyDays,
    companyTag: CONFIG.companyTagValue.trim(),
    pipelinesScanned: {
      applicant: allPipelines.filter(p => isApplicantPipeline(p.label)).map(p => ({ id: p.id, label: p.label })),
      opportunity: allPipelines.filter(p => isOpportunityPipeline(p.label, p.id)).map(p => ({ id: p.id, label: p.label })),
    },
    counts: {
      total: records.length,
      Opportunity: records.filter(r => r.bucket === "Opportunity").length,
      Applicant: records.filter(r => r.bucket === "Applicant").length,
      SQL: records.filter(r => r.bucket === "SQL").length,
      "Near-SQL": records.filter(r => r.bucket === "Near-SQL").length,
    },
    totalPipelineValue: records.reduce((s, r) => s + (r.amount || 0), 0),
    contactsScanned: contacts.length,
    sqlThreshold: CONFIG.sqlThreshold,
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

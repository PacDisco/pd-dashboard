// netlify/functions/conversion-metrics.mjs
//
// On-demand conversion-metric counts for a given date range. Called by the
// dashboard's "Conversion Metrics" section whenever the user changes the
// period or toggles compare. Each call returns four raw counts plus three
// derived rates for the specified window.
//
// Query params:
//   start  millisecond epoch (inclusive start of period)
//   end    millisecond epoch (inclusive end of period)
//
// Response (200):
//   {
//     start, end,
//     contactsCreated,        // PD contacts whose createdate is in window
//     applicationsCreated,    // Deals in PD Applications pipeline created in window
//     opportunitiesCreated,   // Deals in opp pipelines that entered App Fee
//                             // Received stage during window
//     salesClosed,            // Deals in opp pipelines currently at sale stage,
//                             // entered current stage during window
//     contactsToSales:      { num, den, rate },
//     applicationsToSales:  { num, den, rate },
//     opportunitiesToSales: { num, den, rate },
//   }
//
// Env: HUBSPOT_TOKEN

const HUBSPOT_BASE = "https://api.hubapi.com";
const COMPANY_TAG = "Pacific Discovery";

// Keep these in sync with refresh-hot-leads.mjs CONFIG.
const APPLICANT_PIPELINE_PATTERNS = [/^pd\s+applications?$/i];
const OPPORTUNITY_PIPELINE_PATTERNS = [
  /^fall\s+semester$/i,
  /^fall\s+mini\s*(-?\s*)?semester$/i,
  /^spring\s+semester$/i,
  /^spring\s+mini\s*(-?\s*)?semester$/i,
  /^summer\s+program(s)?$/i,
];
const APP_FEE_STAGE_PATTERNS = [
  /application\s*fee\s*received/i,
  /application\s*fee\s*paid/i,
];
const SALE_STAGE_PATTERNS = [
  /deposit\s*(paid|received|processed)/i,
  /closed\s*won/i,
  /payment\s*complete/i,
];
// Stages that disqualify a deal from Applications / Opportunities denominators.
// Intentionally NARROW: Closed Lost / Unsuccessful deals ARE counted in the
// denominators (they really did apply / become opportunities — they just
// didn't close). The rate reflects reality as a result. Only non-normal-funnel
// stages like College Credit are dropped.
const EXCLUDED_STAGE_PATTERNS = [
  /college\s*credit/i,
];

function hubspotHeaders() {
  const token = process.env.HUBSPOT_TOKEN;
  if (!token) throw new Error("HUBSPOT_TOKEN env var missing");
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

async function hubspot(path, init = {}) {
  const res = await fetch(`${HUBSPOT_BASE}${path}`, { ...init, headers: { ...hubspotHeaders(), ...(init.headers || {}) } });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`HubSpot ${res.status} on ${path}: ${body.slice(0, 300)}`);
  }
  return res.json();
}

const matches = (label, patterns) => patterns.some(r => r.test(label || ""));

async function listPipelines() {
  const data = await hubspot("/crm/v3/pipelines/deals");
  return (data.results || []).map(p => ({
    id: p.id,
    label: p.label,
    stages: (p.stages || []).map(s => ({ id: s.id, label: s.label })),
  }));
}

export default async (req) => {
  try {
    const url = new URL(req.url);
    const startMs = Number(url.searchParams.get("start"));
    const endMs   = Number(url.searchParams.get("end"));
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) {
      return new Response(
        JSON.stringify({ error: "start and end must be ms timestamps with end >= start" }),
        { status: 400, headers: { "content-type": "application/json" } },
      );
    }

    const pipelines = await listPipelines();
    const applicantPipelineIds = pipelines.filter(p => matches(p.label, APPLICANT_PIPELINE_PATTERNS)).map(p => p.id);
    const opportunityPipelineIds = pipelines.filter(p => matches(p.label, OPPORTUNITY_PIPELINE_PATTERNS)).map(p => p.id);

    const appFeeStages = [];
    const saleStageIdSet = new Set();
    const excludedStageIdSet = new Set();
    // Scan excluded stages across BOTH applicant and opportunity pipelines,
    // because deals in either can end up at Closed Lost / College Credit.
    for (const p of pipelines) {
      const isOpp = matches(p.label, OPPORTUNITY_PIPELINE_PATTERNS);
      const isApp = matches(p.label, APPLICANT_PIPELINE_PATTERNS);
      if (!isOpp && !isApp) continue;
      for (const s of p.stages) {
        if (matches(s.label, EXCLUDED_STAGE_PATTERNS)) excludedStageIdSet.add(s.id);
        if (isOpp) {
          if (matches(s.label, APP_FEE_STAGE_PATTERNS)) appFeeStages.push({ pipelineId: p.id, stageId: s.id });
          if (matches(s.label, SALE_STAGE_PATTERNS)) saleStageIdSet.add(s.id);
        }
      }
    }
    const saleStageIds = [...saleStageIdSet];
    const excludedStageIds = [...excludedStageIdSet];

    const GTE = (name, v) => ({ propertyName: name, operator: "GTE", value: String(v) });
    const LTE = (name, v) => ({ propertyName: name, operator: "LTE", value: String(v) });

    async function countContacts(filters) {
      const data = await hubspot("/crm/v3/objects/contacts/search", {
        method: "POST",
        body: JSON.stringify({
          limit: 1,
          filterGroups: [{ filters: [
            { propertyName: "company_tag", operator: "EQ", value: COMPANY_TAG },
            ...filters,
          ]}],
        }),
      });
      return data.total || 0;
    }

    async function countDeals(filterGroups) {
      const data = await hubspot("/crm/v3/objects/deals/search", {
        method: "POST",
        body: JSON.stringify({ limit: 1, filterGroups }),
      });
      return data.total || 0;
    }

    // Run the four counts in parallel — HubSpot's search rate limit (4 req/s)
    // comfortably accommodates four simultaneous calls.
    const [contactsCreated, applicationsCreated, opportunitiesCreated, salesClosed] = await Promise.all([
      // 1. PD contacts created in window
      countContacts([GTE("createdate", startMs), LTE("createdate", endMs)]),

      // 2. Applications (deals in PD Applications pipeline created in window,
      //    excluding deals now at Closed Lost / Unsuccessful / College Credit).
      applicantPipelineIds.length
        ? countDeals([{ filters: [
            { propertyName: "pipeline", operator: "IN", values: applicantPipelineIds },
            GTE("createdate", startMs), LTE("createdate", endMs),
            ...(excludedStageIds.length
              ? [{ propertyName: "dealstage", operator: "NOT_IN", values: excludedStageIds }]
              : []),
          ]}])
        : Promise.resolve(0),

      // 3. Opportunities: deals that entered App Fee Received stage in window,
      //    excluding deals now at Closed Lost / Unsuccessful / College Credit.
      //    One filterGroup per pipeline/stage pair (OR across groups).
      //    HubSpot allows up to 5 filterGroups per search.
      (async () => {
        if (!appFeeStages.length) return 0;
        let total = 0;
        const exclusion = excludedStageIds.length
          ? [{ propertyName: "dealstage", operator: "NOT_IN", values: excludedStageIds }]
          : [];
        for (let i = 0; i < appFeeStages.length; i += 5) {
          const chunk = appFeeStages.slice(i, i + 5);
          const fg = chunk.map(p => ({ filters: [
            { propertyName: "pipeline", operator: "EQ", value: p.pipelineId },
            GTE(`hs_v2_date_entered_${p.stageId}`, startMs),
            LTE(`hs_v2_date_entered_${p.stageId}`, endMs),
            ...exclusion,
          ]}));
          total += await countDeals(fg);
        }
        return total;
      })(),

      // 4. Sales: deals currently at a sale stage, entered current stage in window.
      saleStageIds.length && opportunityPipelineIds.length
        ? countDeals([{ filters: [
            { propertyName: "pipeline",  operator: "IN", values: opportunityPipelineIds },
            { propertyName: "dealstage", operator: "IN", values: saleStageIds },
            GTE("hs_v2_date_entered_current_stage", startMs),
            LTE("hs_v2_date_entered_current_stage", endMs),
          ]}])
        : Promise.resolve(0),
    ]);

    const pct = (num, den) => den > 0 ? Math.round((num / den) * 1000) / 10 : null;

    return new Response(JSON.stringify({
      start: startMs,
      end: endMs,
      contactsCreated,
      applicationsCreated,
      opportunitiesCreated,
      salesClosed,
      contactsToSales:      { num: salesClosed, den: contactsCreated,      rate: pct(salesClosed, contactsCreated) },
      applicationsToSales:  { num: salesClosed, den: applicationsCreated,  rate: pct(salesClosed, applicationsCreated) },
      opportunitiesToSales: { num: salesClosed, den: opportunitiesCreated, rate: pct(salesClosed, opportunitiesCreated) },
    }), {
      status: 200,
      headers: {
        "content-type": "application/json",
        // Cache briefly; most "click a preset" scenarios will be cache hits.
        "cache-control": "public, max-age=300",
      },
    });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 500, headers: { "content-type": "application/json" } },
    );
  }
};

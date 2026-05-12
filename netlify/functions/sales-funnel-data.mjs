// netlify/functions/sales-funnel-data.mjs
//
// Returns monthly funnel data for the Pacific Discovery sales pipelines,
// with optional breakdown by acquisition source.
//
// Two source-attribution modes:
//   - hubspot:  hs_analytics_source on the associated contact (Original Source)
//   - jotform:  how_did_you_find_us_ on the associated contact (Jotform answer)
//
// The response includes:
//   - Totals (months, opportunities, sales, contacts, traffic, etc.)
//   - trafficByChannel: { "<HubSpot Original Source label>": [monthly sessions, ...] }
//     so the dashboard can show Traffic stage per-source in HubSpot mode
//   - bySource.hubspot[sourceValue]: same shape, filtered to deals whose primary
//     contact's hs_analytics_source = sourceValue
//   - bySource.jotform[sourceValue]: same, filtered by how_did_you_find_us_

const HUBSPOT_TOKEN = process.env.HUBSPOT_PRIVATE_APP_TOKEN || process.env.HUBSPOT_TOKEN;
const HS_BASE = "https://api.hubapi.com";

const ANALYTICS_VIEW_ID = "16405";

const STAGES = {
  af: ["143518986", "143518993", "143476012", "143502767", "1015966368"],
  dp: ["143518989", "143518996", "143476015", "143502770", "1015966371"],
  cw: ["143518991", "143518998", "143476017", "143502772", "1015966373"],
};

const EXCLUDE_SUBSTRINGS = ["college credit", "test account", "meg test"];
const EXCLUDE_EXACT = ["SAS", "Bali Summer", "Australia Summer 2027"];

// Source attribution properties on the contact record
const SOURCE_PROPS = {
  hubspot: "hs_analytics_source",
  jotform: "how_did_you_find_us_",
};

// Human-readable labels for HubSpot Original Source enum values
const HUBSPOT_SOURCE_LABELS = {
  ORGANIC_SEARCH:  "Organic Search",
  PAID_SEARCH:     "Paid Search",
  EMAIL_MARKETING: "Email Marketing",
  SOCIAL_MEDIA:    "Organic Social",
  REFERRALS:       "Referrals",
  OTHER_CAMPAIGNS: "Other Campaigns",
  DIRECT_TRAFFIC:  "Direct Traffic",
  OFFLINE:         "Offline Sources",
  PAID_SOCIAL:     "Paid Social",
  AI_REFERRALS:    "AI Referrals",
};

const UNKNOWN_LABEL = "(Unknown)";

// -------- Helpers --------

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function isExcluded(dealname) {
  if (!dealname) return true;
  const lower = dealname.toLowerCase();
  for (const s of EXCLUDE_SUBSTRINGS) if (lower.includes(s)) return true;
  if (EXCLUDE_EXACT.includes(dealname)) return true;
  return false;
}

function monthsBetween(fromYM, toYM) {
  const [fy, fm] = fromYM.split("-").map(Number);
  const [ty, tm] = toYM.split("-").map(Number);
  const out = [];
  let y = fy, m = fm;
  while (y < ty || (y === ty && m <= tm)) {
    out.push(`${y}-${String(m).padStart(2, "0")}`);
    m++;
    if (m > 12) { m = 1; y++; }
  }
  return out;
}

function monthRange(ym) {
  const [y, m] = ym.split("-").map(Number);
  const start = `${y}-${String(m).padStart(2, "0")}-01`;
  const ny = m === 12 ? y + 1 : y;
  const nm = m === 12 ? 1 : m + 1;
  const end = `${ny}-${String(nm).padStart(2, "0")}-01`;
  return [start, end];
}

function defaultRange() {
  const now = new Date();
  const to = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  const back = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 12, 1));
  const from = `${back.getUTCFullYear()}-${String(back.getUTCMonth() + 1).padStart(2, "0")}`;
  return { from, to };
}

async function hsPost(path, body, retries = 3) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const res = await fetch(`${HS_BASE}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${HUBSPOT_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (res.ok) return res.json();
    if (res.status === 429 && attempt < retries) {
      const wait = 1000 * Math.pow(2, attempt);
      console.warn(`HubSpot rate-limited (attempt ${attempt + 1}); waiting ${wait}ms`);
      await sleep(wait);
      continue;
    }
    const txt = await res.text();
    throw new Error(`HubSpot ${path} ${res.status}: ${txt}`);
  }
}

// Search deals where any of `stageIds` was entered within [start, end),
// fetching associated contacts as well.
async function searchStageEntries(stageIds, startISO, endISO) {
  const filterGroups = stageIds.map((sid) => ({
    filters: [
      {
        propertyName: `hs_v2_date_entered_${sid}`,
        operator: "BETWEEN",
        value: startISO,
        highValue: endISO,
      },
    ],
  }));

  const properties = [
    "dealname",
    "pipeline",
    "dealstage",
    ...STAGES.af.map((s) => `hs_v2_date_entered_${s}`),
    ...STAGES.dp.map((s) => `hs_v2_date_entered_${s}`),
    ...STAGES.cw.map((s) => `hs_v2_date_entered_${s}`),
  ];

  const all = [];
  let after = undefined;
  for (let page = 0; page < 10; page++) {
    const body = {
      filterGroups,
      properties,
      associations: ["contacts"],
      limit: 100,
      sorts: [{ propertyName: "hs_lastmodifieddate", direction: "DESCENDING" }],
    };
    if (after) body.after = after;
    const data = await hsPost("/crm/v3/objects/deals/search", body);
    for (const r of data.results || []) all.push(r);
    after = data.paging?.next?.after;
    if (!after) break;
  }
  return all;
}

function earliestStageDate(deal, stageIds) {
  let earliest = null;
  for (const sid of stageIds) {
    const d = deal.properties?.[`hs_v2_date_entered_${sid}`];
    if (d && (!earliest || d < earliest)) earliest = d;
  }
  return earliest;
}

// Batch-fetch contact source properties by contact ID.
async function fetchContactSources(contactIds) {
  const unique = Array.from(new Set(contactIds.map(String)));
  if (unique.length === 0) return new Map();

  const props = [SOURCE_PROPS.hubspot, SOURCE_PROPS.jotform];
  const map = new Map();

  for (let i = 0; i < unique.length; i += 100) {
    const batch = unique.slice(i, i + 100);
    const body = {
      properties: props,
      inputs: batch.map((id) => ({ id })),
    };
    const data = await hsPost("/crm/v3/objects/contacts/batch/read", body);
    for (const c of data.results || []) {
      map.set(String(c.id), {
        hubspot: c.properties?.[SOURCE_PROPS.hubspot] || null,
        jotform: c.properties?.[SOURCE_PROPS.jotform] || null,
      });
    }
    if (i + 100 < unique.length) await sleep(150);
  }
  return map;
}

function primaryContactId(deal) {
  const assocs = deal.associations?.contacts?.results || [];
  return assocs.length ? String(assocs[0].id) : null;
}

function hubspotSourceLabel(raw) {
  if (!raw) return UNKNOWN_LABEL;
  return HUBSPOT_SOURCE_LABELS[raw] || raw;
}

// PD-tagged contacts with source fields for each month
async function fetchPdContacts(startISO, endISO) {
  const props = ["createdate", SOURCE_PROPS.hubspot, SOURCE_PROPS.jotform];
  const all = [];
  let after = undefined;
  for (let page = 0; page < 30; page++) {
    const body = {
      filterGroups: [
        {
          filters: [
            { propertyName: "company_tag", operator: "EQ", value: "Pacific Discovery" },
            {
              propertyName: "createdate",
              operator: "BETWEEN",
              value: startISO,
              highValue: endISO,
            },
          ],
        },
      ],
      properties: props,
      limit: 100,
      sorts: [{ propertyName: "createdate", direction: "DESCENDING" }],
    };
    if (after) body.after = after;
    const data = await hsPost("/crm/v3/objects/contacts/search", body);
    for (const r of data.results || []) {
      all.push({
        createdate: r.properties?.createdate,
        hubspot: r.properties?.[SOURCE_PROPS.hubspot] || null,
        jotform: r.properties?.[SOURCE_PROPS.jotform] || null,
      });
    }
    after = data.paging?.next?.after;
    if (!after) break;
    if (page >= 1) await sleep(200);
  }
  return all;
}

// ============================================================
// Traffic — HubSpot Analytics filtered by Analytics View 16405
// ============================================================
//
// Maps HubSpot Analytics response channel fields to HubSpot Original Source labels:
//   organicSearch  → "Organic Search"
//   paidSearch     → "Paid Search"
//   paidSocial     → "Paid Social"
//   socialMedia    → "Organic Social"
//   emailMarketing → "Email Marketing"
//   directTraffic  → "Direct Traffic"
//   referrals      → "Referrals"
//   otherCampaigns → "Other Campaigns"
//
// AI Referrals & Offline Sources aren't broken out in the v2 response,
// so contacts/deals from those sources will show 0 traffic when filtered.
const CHANNEL_FIELD_TO_LABEL = {
  organicSearch:  "Organic Search",
  paidSearch:     "Paid Search",
  paidSocial:     "Paid Social",
  socialMedia:    "Organic Social",
  emailMarketing: "Email Marketing",
  directTraffic:  "Direct Traffic",
  referrals:      "Referrals",
  otherCampaigns: "Other Campaigns",
};

async function getTraffic(months) {
  const [firstISO] = monthRange(months[0]);
  const [, lastISO] = monthRange(months[months.length - 1]);
  const lastDate = new Date(lastISO);
  lastDate.setUTCDate(lastDate.getUTCDate() - 1);
  const fmt = (iso) => iso.replace(/-/g, "").slice(0, 8);
  const start = fmt(firstISO);
  const end = fmt(lastDate.toISOString());

  const url =
    `${HS_BASE}/analytics/v2/reports/sessions/monthly` +
    `?start=${start}&end=${end}&filterId=${ANALYTICS_VIEW_ID}`;

  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}` },
    });
    if (!res.ok) {
      return {
        counts: months.map(() => 0),
        byChannel: {},
        source: res.status === 401 || res.status === 403 ? "scope-missing" : "error",
      };
    }
    const data = await res.json();
    const parsed = parseSessions(data, months);
    const hasAny = parsed.counts.some((c) => c > 0);
    return {
      counts: parsed.counts,
      byChannel: parsed.byChannel,
      source: hasAny ? "hubspot" : "empty",
    };
  } catch (err) {
    console.warn("Analytics fetch threw:", err.message);
    return { counts: months.map(() => 0), byChannel: {}, source: "error" };
  }
}

function parseSessions(data, months) {
  const DEVICE_FIELDS = ["mobile", "desktop", "others"];
  const monthlyTotal = {};
  const monthlyByChannel = {};

  for (const [dateKey, value] of Object.entries(data || {})) {
    const ym = dateKey.slice(0, 7);
    if (!Array.isArray(value)) continue;

    const sessionsRow = value.find((b) => b.breakdown === "sessions");
    if (!sessionsRow) continue;

    const total = DEVICE_FIELDS.reduce((s, f) => s + (sessionsRow[f] || 0), 0);
    monthlyTotal[ym] = (monthlyTotal[ym] || 0) + total;

    for (const [field, label] of Object.entries(CHANNEL_FIELD_TO_LABEL)) {
      const n = sessionsRow[field] || 0;
      if (!monthlyByChannel[label]) monthlyByChannel[label] = {};
      monthlyByChannel[label][ym] = (monthlyByChannel[label][ym] || 0) + n;
    }
  }

  const counts = months.map((m) => monthlyTotal[m] || 0);
  const byChannel = {};
  for (const [label, byMonth] of Object.entries(monthlyByChannel)) {
    byChannel[label] = months.map((m) => byMonth[m] || 0);
  }
  return { counts, byChannel };
}

// -------- Main handler --------

export default async (req) => {
  if (!HUBSPOT_TOKEN) {
    return new Response(
      JSON.stringify({ error: "HUBSPOT_PRIVATE_APP_TOKEN not configured" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }

  try {
    const url = new URL(req.url);
    const def = defaultRange();
    const fromYM = url.searchParams.get("from") || def.from;
    const toYM = url.searchParams.get("to") || def.to;
    const months = monthsBetween(fromYM, toYM);

    const [windowStart] = monthRange(months[0]);
    const [, windowEnd] = monthRange(months[months.length - 1]);

    // Phase 1: deal stage queries with associated contact IDs
    const [afDeals, dpDeals, cwDeals] = await Promise.all([
      searchStageEntries(STAGES.af, windowStart, windowEnd),
      searchStageEntries(STAGES.dp, windowStart, windowEnd),
      searchStageEntries(STAGES.cw, windowStart, windowEnd),
    ]);

    // Phase 2: batch-resolve source properties for every contact ID referenced
    const allContactIds = new Set();
    for (const list of [afDeals, dpDeals, cwDeals]) {
      for (const d of list) {
        if (isExcluded(d.properties?.dealname)) continue;
        const cid = primaryContactId(d);
        if (cid) allContactIds.add(cid);
      }
    }
    await sleep(300);
    const sourceMap = await fetchContactSources([...allContactIds]);

    function dealSource(deal, mode) {
      const cid = primaryContactId(deal);
      if (!cid) return UNKNOWN_LABEL;
      const entry = sourceMap.get(cid);
      if (!entry) return UNKNOWN_LABEL;
      if (mode === "hubspot") return hubspotSourceLabel(entry.hubspot);
      return entry.jotform || UNKNOWN_LABEL;
    }

    // -------- Bucket builders --------
    const emptyArr = () => months.map(() => 0);
    const makeBucketMap = () => ({ hubspot: {}, jotform: {} });
    const ensure = (bucket, mode, label) => {
      if (!bucket[mode][label]) bucket[mode][label] = emptyArr();
      return bucket[mode][label];
    };

    const monthOf = (iso) => (iso ? iso.slice(0, 7) : null);
    const idxOf = (ym) => months.indexOf(ym);

    // Opportunities
    const oppsTotal = emptyArr();
    const oppsBySource = makeBucketMap();
    const seenAfDeal = new Set();
    for (const d of afDeals) {
      if (isExcluded(d.properties?.dealname)) continue;
      const date = earliestStageDate(d, STAGES.af);
      const ym = monthOf(date);
      const idx = idxOf(ym);
      if (idx < 0) continue;
      const key = d.id + ym;
      if (seenAfDeal.has(key)) continue;
      seenAfDeal.add(key);
      oppsTotal[idx]++;
      const hsLabel = dealSource(d, "hubspot");
      const jfLabel = dealSource(d, "jotform");
      ensure(oppsBySource, "hubspot", hsLabel)[idx]++;
      ensure(oppsBySource, "jotform", jfLabel)[idx]++;
    }

    // Sales via DP
    const salesDpTotal = emptyArr();
    const salesDpBySource = makeBucketMap();
    for (const d of dpDeals) {
      if (isExcluded(d.properties?.dealname)) continue;
      const date = earliestStageDate(d, STAGES.dp);
      const ym = monthOf(date);
      const idx = idxOf(ym);
      if (idx < 0) continue;
      salesDpTotal[idx]++;
      const hsLabel = dealSource(d, "hubspot");
      const jfLabel = dealSource(d, "jotform");
      ensure(salesDpBySource, "hubspot", hsLabel)[idx]++;
      ensure(salesDpBySource, "jotform", jfLabel)[idx]++;
    }

    // Sales skipped DP
    const salesSkipTotal = emptyArr();
    const salesSkipBySource = makeBucketMap();
    const skippedNames = Object.fromEntries(months.map((m) => [m, []]));
    function hasAnyDp(deal) {
      for (const sid of STAGES.dp) {
        if (deal.properties?.[`hs_v2_date_entered_${sid}`]) return true;
      }
      return false;
    }
    for (const d of cwDeals) {
      if (isExcluded(d.properties?.dealname)) continue;
      if (hasAnyDp(d)) continue;
      const date = earliestStageDate(d, STAGES.cw);
      const ym = monthOf(date);
      const idx = idxOf(ym);
      if (idx < 0) continue;
      salesSkipTotal[idx]++;
      skippedNames[ym].push({ name: d.properties.dealname, cw_date: date });
      const hsLabel = dealSource(d, "hubspot");
      const jfLabel = dealSource(d, "jotform");
      ensure(salesSkipBySource, "hubspot", hsLabel)[idx]++;
      ensure(salesSkipBySource, "jotform", jfLabel)[idx]++;
    }

    // Contacts — fetch actual contacts (with source fields) per month
    await sleep(300);
    const contactsTotal = emptyArr();
    const contactsBySource = makeBucketMap();

    for (let i = 0; i < months.length; i += 3) {
      const batch = months.slice(i, i + 3);
      const results = await Promise.all(
        batch.map(async (m) => {
          const [s, e] = monthRange(m);
          return { month: m, contacts: await fetchPdContacts(s, e) };
        })
      );
      for (const { month, contacts } of results) {
        const idx = idxOf(month);
        if (idx < 0) continue;
        contactsTotal[idx] += contacts.length;
        for (const c of contacts) {
          const hsLabel = hubspotSourceLabel(c.hubspot);
          const jfLabel = c.jotform || UNKNOWN_LABEL;
          ensure(contactsBySource, "hubspot", hsLabel)[idx]++;
          ensure(contactsBySource, "jotform", jfLabel)[idx]++;
        }
      }
      if (i + 3 < months.length) await sleep(250);
    }

    // Traffic
    const trafficResult = await getTraffic(months);

    // Totals derived
    const totalSales = months.map((_, i) => salesDpTotal[i] + salesSkipTotal[i]);

    // Build totalSales by source = salesDp + salesSkip per source
    const totalSalesBySource = makeBucketMap();
    for (const mode of ["hubspot", "jotform"]) {
      const labels = new Set([
        ...Object.keys(salesDpBySource[mode]),
        ...Object.keys(salesSkipBySource[mode]),
      ]);
      for (const label of labels) {
        const a = salesDpBySource[mode][label] || emptyArr();
        const b = salesSkipBySource[mode][label] || emptyArr();
        totalSalesBySource[mode][label] = a.map((v, i) => v + (b[i] || 0));
      }
    }

    // Collect all source labels per mode for the UI
    const sourceLabels = { hubspot: new Set(), jotform: new Set() };
    for (const mode of ["hubspot", "jotform"]) {
      for (const bucket of [contactsBySource, oppsBySource, salesDpBySource, salesSkipBySource]) {
        for (const label of Object.keys(bucket[mode])) {
          sourceLabels[mode].add(label);
        }
      }
    }

    return new Response(
      JSON.stringify({
        months,
        // Totals
        traffic: trafficResult.counts,
        trafficByChannel: trafficResult.byChannel,
        trafficSource: trafficResult.source,
        trafficViewId: ANALYTICS_VIEW_ID,
        contacts: contactsTotal,
        opportunities: oppsTotal,
        salesViaDp: salesDpTotal,
        salesSkipDp: salesSkipTotal,
        totalSales,
        skippedDeals: skippedNames,
        // Source breakdowns
        bySource: {
          hubspot: {
            labels: [...sourceLabels.hubspot].sort(),
            contacts: contactsBySource.hubspot,
            opportunities: oppsBySource.hubspot,
            salesViaDp: salesDpBySource.hubspot,
            salesSkipDp: salesSkipBySource.hubspot,
            totalSales: totalSalesBySource.hubspot,
          },
          jotform: {
            labels: [...sourceLabels.jotform].sort(),
            contacts: contactsBySource.jotform,
            opportunities: oppsBySource.jotform,
            salesViaDp: salesDpBySource.jotform,
            salesSkipDp: salesSkipBySource.jotform,
            totalSales: totalSalesBySource.jotform,
          },
        },
        generatedAt: new Date().toISOString(),
      }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
          "Access-Control-Allow-Origin": "*",
        },
      }
    );
  } catch (err) {
    console.error(err);
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
};

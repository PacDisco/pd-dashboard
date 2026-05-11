// netlify/functions/sales-funnel-data.mjs
//
// Returns monthly funnel data for the Pacific Discovery sales pipelines.
// Traffic comes live from HubSpot Analytics v2 (sessions/monthly).
//
// Query params (all optional):
//   from=YYYY-MM   (default: 13 months ago)
//   to=YYYY-MM     (default: current month)
//
// Response shape:
//   {
//     months: ["2025-04", ...],
//     traffic:       [8519, ...],          // sessions from HubSpot Analytics
//     trafficSource: "hubspot" | "scope-missing" | "endpoint-gone" | "empty" | "error",
//     contacts:      [259, ...],           // PD-tagged contacts created
//     opportunities: [4, ...],             // entered Application Fee Received
//     salesViaDp:    [4, ...],             // entered Deposit Paid
//     salesSkipDp:   [1, ...],             // entered Closed Won w/o ever entering DP
//     totalSales:    [5, ...],
//     skippedDeals:  { "2025-04": [{name, cw_date}], ... }
//   }
//
// Required private-app scopes:
//   crm.objects.deals.read
//   crm.objects.contacts.read
//   crm.schemas.deals.read
//   crm.schemas.contacts.read
//   business-intelligence       ← for traffic data

const HUBSPOT_TOKEN = process.env.HUBSPOT_PRIVATE_APP_TOKEN || process.env.HUBSPOT_TOKEN;
const HS_BASE = "https://api.hubapi.com";

// Stage IDs (Application Fee Received, Deposit Paid, Closed Won)
// Order: Fall Semester, Fall Mini, Spring Semester, Spring Mini, Summer Program
const STAGES = {
  af: ["143518986", "143518993", "143476012", "143502767", "1015966368"],
  dp: ["143518989", "143518996", "143476015", "143502770", "1015966371"],
  cw: ["143518991", "143518998", "143476017", "143502772", "1015966373"],
};

const EXCLUDE_SUBSTRINGS = ["college credit", "test account", "meg test"];
const EXCLUDE_EXACT = ["SAS", "Bali Summer", "Australia Summer 2027"];

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

async function countPdContacts(startISO, endISO) {
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
    properties: ["firstname"],
    limit: 1,
  };
  const data = await hsPost("/crm/v3/objects/contacts/search", body);
  return data.total ?? 0;
}

// ============================================================
// Traffic — HubSpot Analytics API
// ============================================================
//
// Endpoint: GET /analytics/v2/reports/sessions/monthly?start=YYYYMMDD&end=YYYYMMDD
// Required scope: business-intelligence
//
// Response shape (monthly aggregation):
//   { "YYYY-MM-01": { "visits": N, "visitors": N, ... }, ... }
async function getTraffic(months) {
  const [firstISO] = monthRange(months[0]);
  const [, lastISO] = monthRange(months[months.length - 1]);

  // HubSpot expects inclusive end; subtract 1 day from our exclusive end
  const lastDate = new Date(lastISO);
  lastDate.setUTCDate(lastDate.getUTCDate() - 1);

  const fmt = (iso) => iso.replace(/-/g, "").slice(0, 8);
  const start = fmt(firstISO);
  const end = fmt(lastDate.toISOString());

  // Try /sessions/monthly first (cleanest, single object response)
  // Fall back to /sources/monthly if that 404s.
  const candidates = [
    `${HS_BASE}/analytics/v2/reports/sessions/monthly?start=${start}&end=${end}`,
    `${HS_BASE}/analytics/v2/reports/sources/monthly?start=${start}&end=${end}`,
  ];

  let lastError = null;
  for (const url of candidates) {
    try {
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}` },
      });

      if (res.status === 401 || res.status === 403) {
        const txt = await res.text().catch(() => "");
        console.warn(`HubSpot Analytics auth/scope error: ${res.status}`, txt);
        lastError = "scope-missing";
        break; // no point trying other endpoints
      }
      if (res.status === 404) {
        // Try next candidate
        lastError = "endpoint-gone";
        continue;
      }
      if (!res.ok) {
        const txt = await res.text().catch(() => "");
        console.warn(`HubSpot Analytics ${res.status}:`, txt);
        lastError = "error";
        continue;
      }

      const data = await res.json();
      const byMonth = {};

      // /sessions/monthly returns {"YYYY-MM-01": {visits, visitors, ...}}
      // /sources/monthly returns {"YYYY-MM-01": [{breakdown, visits, ...}, ...]}
      for (const [dateKey, value] of Object.entries(data || {})) {
        const ym = dateKey.slice(0, 7);
        if (Array.isArray(value)) {
          // sources breakdown — sum visits across all sources
          let total = 0;
          for (const row of value) total += row.visits || 0;
          byMonth[ym] = (byMonth[ym] || 0) + total;
        } else if (value && typeof value === "object") {
          // direct sessions object
          byMonth[ym] = (byMonth[ym] || 0) + (value.visits || 0);
        }
      }

      const counts = months.map((m) => byMonth[m] || 0);
      const hasAny = counts.some((c) => c > 0);
      return { counts, source: hasAny ? "hubspot" : "empty" };
    } catch (err) {
      console.warn(`HubSpot Analytics fetch threw for ${url}:`, err.message);
      lastError = "error";
    }
  }

  return { counts: months.map(() => 0), source: lastError || "error" };
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

    const [afDeals, dpDeals, cwDeals] = await Promise.all([
      searchStageEntries(STAGES.af, windowStart, windowEnd),
      searchStageEntries(STAGES.dp, windowStart, windowEnd),
      searchStageEntries(STAGES.cw, windowStart, windowEnd),
    ]);

    const empty = () => Object.fromEntries(months.map((m) => [m, 0]));
    const opps = empty();
    const salesDp = empty();
    const salesSkip = empty();
    const skippedNames = Object.fromEntries(months.map((m) => [m, []]));

    const monthOf = (iso) => (iso ? iso.slice(0, 7) : null);

    const seenAf = new Set();
    for (const d of afDeals) {
      if (isExcluded(d.properties?.dealname)) continue;
      const date = earliestStageDate(d, STAGES.af);
      const ym = monthOf(date);
      if (ym && months.includes(ym) && !seenAf.has(d.id + ym)) {
        opps[ym]++;
        seenAf.add(d.id + ym);
      }
    }

    for (const d of dpDeals) {
      if (isExcluded(d.properties?.dealname)) continue;
      const date = earliestStageDate(d, STAGES.dp);
      const ym = monthOf(date);
      if (ym && months.includes(ym)) salesDp[ym]++;
    }

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
      if (ym && months.includes(ym)) {
        salesSkip[ym]++;
        skippedNames[ym].push({ name: d.properties.dealname, cw_date: date });
      }
    }

    await sleep(300);
    const contactCounts = [];
    for (let i = 0; i < months.length; i += 3) {
      const batch = months.slice(i, i + 3);
      const counts = await Promise.all(
        batch.map((m) => {
          const [s, e] = monthRange(m);
          return countPdContacts(s, e);
        })
      );
      contactCounts.push(...counts);
      if (i + 3 < months.length) await sleep(250);
    }

    const trafficResult = await getTraffic(months);

    const oppsArr = months.map((m) => opps[m]);
    const dpArr = months.map((m) => salesDp[m]);
    const skipArr = months.map((m) => salesSkip[m]);
    const totalSales = months.map((_, i) => dpArr[i] + skipArr[i]);

    return new Response(
      JSON.stringify({
        months,
        traffic: trafficResult.counts,
        trafficSource: trafficResult.source,
        contacts: contactCounts,
        opportunities: oppsArr,
        salesViaDp: dpArr,
        salesSkipDp: skipArr,
        totalSales,
        skippedDeals: skippedNames,
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

// netlify/functions/sales-funnel-data.mjs
//
// Returns monthly funnel data for the Pacific Discovery sales pipelines,
// with optional breakdown by acquisition source AND sub-source detail.
//
// Two source-attribution modes:
//   - hubspot:  hs_analytics_source on the associated contact (Original Source)
//   - jotform:  how_did_you_find_us_ on the associated contact (Jotform answer)
//
// Three Jotform primaries have sub-detail fields:
//   - "Gap Year Advisor or Independent Educational Consultant" → advisor_name
//   - "Gap Year Fair, College Fair, High School Event or similar" → event_name_and_location
//   - "Word of Mouth" → word_of_mouth_referral_name
//
// Exclusions:
//   - Deal name contains "college credit", "test account", "meg test"
//   - Deal name exactly matches "SAS", "Bali Summer", "Australia Summer 2027"
//   - pd_program = "College Credit Program"

const HUBSPOT_TOKEN = process.env.HUBSPOT_PRIVATE_APP_TOKEN || process.env.HUBSPOT_TOKEN;
const HS_BASE = "https://api.hubapi.com";

const ANALYTICS_VIEW_ID = "16405";

// Jotform: the PD application form(s) carry the real "How did you find us?"
// answer, which often is NOT synced to the HubSpot how_did_you_find_us_
// property. We pull it straight from Jotform and match by participant email.
const JOTFORM_API_KEY = process.env.JOTFORM_API_KEY;
const JOTFORM_APP_FORM_IDS = (process.env.JOTFORM_APP_FORM_IDS || "240277257210046")
  .split(",").map((x) => x.trim()).filter(Boolean);

const STAGES = {
  af: ["143518986", "143518993", "143476012", "143502767", "1015966368"],
  dp: ["143518989", "143518996", "143476015", "143502770", "1015966371"],
  cw: ["143518991", "143518998", "143476017", "143502772", "1015966373"],
};

const EXCLUDE_SUBSTRINGS = ["college credit", "test account", "meg test"];
const EXCLUDE_EXACT = ["SAS", "Bali Summer", "Australia Summer 2027"];
const EXCLUDE_PD_PROGRAMS = new Set(["College Credit Program"]);

const SOURCE_PROPS = {
  hubspot: "hs_analytics_source",
  jotform: "how_did_you_find_us_",
};

// dd3 ≈ utm_source, dd4 ≈ utm_medium, dd5 ≈ utm_campaign — but see the note
// above recoverOffline(); HubSpot writes its own categories here too.
const DRILLDOWN_PROPS = [
  "original_source_drill_down_3",
  "original_source_drill_down_4",
  "original_source_drill_down_5",
];

// Jotform primaries that have a detail field on the contact record
const JOTFORM_DETAIL_FIELDS = {
  "Gap Year Advisor or Independent Educational Consultant": "advisor_name",
  "Gap Year Fair, College Fair, High School Event or similar": "event_name_and_location",
  "Word of Mouth": "word_of_mouth_referral_name",
};

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

// Jotform mode has two very different kinds of "no answer", and collapsing
// them into one (Unknown) bar is what made that panel unreadable: it put the
// ~1,600 leads who were never asked the question in the same bucket as the
// handful of applicants who left it blank. They mean opposite things.
const NO_APPLICATION_LABEL = "(No application on file)";
const APPLICATION_BLANK_LABEL = "(Application left blank)";

// ============================================================
// Offline recovery — original_source_drill_down_3/4/5
//
// Records created through Zapier arrive without the tracking cookie, so
// HubSpot stamps Original Source = OFFLINE and the real channel is lost from
// hs_analytics_source. It is NOT lost from the drill-downs: the form posts
// utm_source / utm_medium / utm_campaign through to drill_down_3 / 4 / 5, and
// HubSpot writes its own values there for email sends, referring domains and
// list imports.
//
// Over the twelve months to Aug 2026 that recovers the true channel on 459 of
// 1,093 Offline PD leads (42%). The remaining 634 have no drill-down at all
// and are reported as unrecovered rather than guessed at — see OFFLINE_RULES
// below for exactly what each rule claims.
//
// drill_down_3 is not consistently utm_source. Sometimes it IS the source
// ("adwords", "chatgpt.com"); sometimes it is a HubSpot-side category with the
// vendor in drill_down_4 ("Recruitment" / "TeenLife", "referrals" /
// "gooverseas.com"). Every rule therefore reads dd3 and dd4 together.
// ============================================================

// Evaluated in order; first match wins. `test` receives lowercased dd3/dd4.
const OFFLINE_RULES = [
  {
    channel: "Paid Search",
    test: (d3, d4) =>
      ["adwords", "google", "googleads", "google-ads", "google_ads", "paid search", "paidsearch"].includes(d3) ||
      (d3 === "landing page" && /search|cpc|ppc|paid/.test(d4)),
  },
  {
    channel: "Paid Social",
    test: (d3, d4) =>
      /^(facebook|fb|ig|instagram|meta|facebook\.com|instagram\.com|paid social|paidsocial)$/.test(d3) &&
      /paid|cpc|ppc|social/.test(d4),
  },
  {
    channel: "Organic Social",
    test: (d3) =>
      /^(facebook|fb|ig|instagram|meta|facebook\.com|instagram\.com|tiktok|linkedin|youtube|pinterest|reddit)$/.test(d3),
  },
  {
    channel: "Email Marketing",
    test: (d3, d4) =>
      /^(hs_email|email|newsletter|mailchimp|klaviyo)$/.test(d3) || d4 === "email",
  },
  {
    channel: "AI Referrals",
    test: (d3) =>
      /^(chatgpt\.com|chat\.openai\.com|perplexity\.ai|gemini\.google\.com|copilot\.microsoft\.com|claude\.ai|you\.com|bard\.google\.com)$/.test(d3),
  },
  {
    channel: "Organic Search",
    test: (d3) => /^(bing|bing\.com|duckduckgo|duckduckgo\.com|yahoo|ecosia\.org|organic)$/.test(d3),
  },
  {
    channel: "Referrals",
    // "referrals"/"recruitment" put the partner in dd4; a bare domain in dd3
    // (gooverseas.com, studiekeuzemaken.nl) is itself the referrer. Named
    // partners are listed so they survive a rename of the dd3 category.
    test: (d3, d4) =>
      ["referrals", "referral", "recruitment", "partner", "teenlife", "gooverseas", "goabroad"].includes(d3) ||
      d4 === "referral" ||
      /\.(com|org|net|nl|co|edu|io|au|nz|uk|de|fr|es|ca)$/.test(d3),
  },
];

const OFFLINE_UNRECOVERED = "Not recoverable";

// Returns { channel, detail } for an Offline record, or null when the
// drill-downs are empty. `detail` is the most specific true thing available —
// the referring domain, the campaign, or the raw source — never a guess.
function recoverOffline(dd3, dd4, dd5) {
  const raw3 = (dd3 || "").trim();
  const raw4 = (dd4 || "").trim();
  const raw5 = (dd5 || "").trim();
  if (!raw3 && !raw4) return null;

  const d3 = raw3.toLowerCase();
  const d4 = raw4.toLowerCase();

  let channel = null;
  for (const rule of OFFLINE_RULES) {
    if (rule.test(d3, d4)) { channel = rule.channel; break; }
  }

  // Detail: prefer the referring domain / vendor over the category name,
  // then the campaign, then the bare source.
  let detail;
  if (channel === "Referrals") {
    detail = raw4 && raw4.toLowerCase() !== "referral" ? raw4 : raw3;
  } else if (channel === "Paid Search" || channel === "Paid Social" || channel === "Email Marketing") {
    detail = raw5 || raw3;
  } else {
    detail = raw3 || raw4;
  }

  return {
    // An unmatched drill-down is reported under its own raw value rather than
    // being swept into "Other Campaigns" — an invented channel is worse than a
    // visibly unmapped one, and this is how new rules get noticed.
    channel: channel || `Unmapped: ${raw3 || raw4}`,
    detail: detail || raw3 || raw4,
    raw: [raw3, raw4].filter(Boolean).join(" › "),
  };
}

// -------- Helpers --------

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function isExcluded(deal) {
  const props = deal.properties || {};
  const name = props.dealname;
  if (!name) return true;
  const lower = name.toLowerCase();
  for (const s of EXCLUDE_SUBSTRINGS) if (lower.includes(s)) return true;
  if (EXCLUDE_EXACT.includes(name)) return true;
  if (props.pd_program && EXCLUDE_PD_PROGRAMS.has(props.pd_program)) return true;
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
    "pd_program",
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

async function fetchContactSources(contactIds) {
  const unique = Array.from(new Set(contactIds.map(String)));
  if (unique.length === 0) return new Map();

  const props = [
    "email",
    SOURCE_PROPS.hubspot,
    SOURCE_PROPS.jotform,
    ...DRILLDOWN_PROPS,
    ...Object.values(JOTFORM_DETAIL_FIELDS),
  ];
  const map = new Map();

  for (let i = 0; i < unique.length; i += 100) {
    const batch = unique.slice(i, i + 100);
    const body = {
      properties: props,
      inputs: batch.map((id) => ({ id })),
    };
    const data = await hsPost("/crm/v3/objects/contacts/batch/read", body);
    for (const c of data.results || []) {
      const p = c.properties || {};
      map.set(String(c.id), {
        email: p.email || null,
        hubspot: p[SOURCE_PROPS.hubspot] || null,
        jotform: p[SOURCE_PROPS.jotform] || null,
        dd3: p[DRILLDOWN_PROPS[0]] || null,
        dd4: p[DRILLDOWN_PROPS[1]] || null,
        dd5: p[DRILLDOWN_PROPS[2]] || null,
        advisor_name: p.advisor_name || null,
        event_name_and_location: p.event_name_and_location || null,
        word_of_mouth_referral_name: p.word_of_mouth_referral_name || null,
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

// Resolve the "Student"-labeled contact for each deal via v4 associations.
// Pacific Discovery deals associate the student AND parents/guardians. Parents
// are almost always OFFLINE, so taking the first associated contact corrupts
// source attribution. The student carries the real acquisition source.
// Falls back to the first associated contact when no Student label is present.
async function fetchDealStudentContacts(dealIds) {
  const unique = Array.from(new Set(dealIds.map(String)));
  const map = new Map();
  for (let i = 0; i < unique.length; i += 100) {
    const batch = unique.slice(i, i + 100);
    let data;
    try {
      data = await hsPost("/crm/v4/associations/deals/contacts/batch/read", {
        inputs: batch.map((id) => ({ id })),
      });
    } catch (err) {
      console.warn("v4 deal->contact association read failed:", err.message);
      continue;
    }
    for (const row of data.results || []) {
      const dealId = String(row.from?.id ?? "");
      const tos = row.to || [];
      let chosen = null;
      for (const t of tos) {
        const labels = (t.associationTypes || []).map((a) => (a.label || "").toLowerCase());
        if (labels.some((l) => l.includes("student"))) {
          chosen = String(t.toObjectId);
          break;
        }
      }
      if (!chosen && tos.length) chosen = String(tos[0].toObjectId);
      if (dealId && chosen) map.set(dealId, chosen);
    }
    if (i + 100 < unique.length) await sleep(150);
  }
  return map;
}

function hubspotSourceLabel(raw) {
  if (!raw) return UNKNOWN_LABEL;
  return HUBSPOT_SOURCE_LABELS[raw] || raw;
}

// The self-reported answer, or the reason there isn't one.
function jotformLabel(entry) {
  if (!entry) return NO_APPLICATION_LABEL;
  if (entry.jotform) return entry.jotform;
  return entry.hasApplication ? APPLICATION_BLANK_LABEL : NO_APPLICATION_LABEL;
}

async function fetchPdContacts(startISO, endISO) {
  const props = [
    "createdate",
    "email",
    SOURCE_PROPS.hubspot,
    SOURCE_PROPS.jotform,
    ...DRILLDOWN_PROPS,
    ...Object.values(JOTFORM_DETAIL_FIELDS),
  ];
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
      const p = r.properties || {};
      all.push({
        createdate: p.createdate,
        email: p.email || null,
        hubspot: p[SOURCE_PROPS.hubspot] || null,
        jotform: p[SOURCE_PROPS.jotform] || null,
        dd3: p[DRILLDOWN_PROPS[0]] || null,
        dd4: p[DRILLDOWN_PROPS[1]] || null,
        dd5: p[DRILLDOWN_PROPS[2]] || null,
        advisor_name: p.advisor_name || null,
        event_name_and_location: p.event_name_and_location || null,
        word_of_mouth_referral_name: p.word_of_mouth_referral_name || null,
      });
    }
    after = data.paging?.next?.after;
    if (!after) break;
    if (page >= 1) await sleep(200);
  }
  return all;
}

// ============================================================
// Jotform "How did you find us?" — pulled directly from the application
// form submissions and keyed by participant email. Questions are matched by
// label text so this survives form re-versioning.
// ============================================================
function jfAnswerToString(a) {
  if (a == null) return null;
  if (typeof a === "string") return a.trim() || null;
  if (Array.isArray(a)) return a.filter(Boolean).join(", ") || null;
  if (typeof a === "object") {
    const v = Object.values(a).filter((x) => x !== "" && x != null);
    return v.length ? v.join(" ").trim() : null;
  }
  return String(a);
}

async function fetchJotformAttribution() {
  // Map<emailLower, { primary, advisor, event, wordOfMouth }>
  const map = new Map();
  if (!JOTFORM_API_KEY) {
    console.warn("JOTFORM_API_KEY not set — skipping Jotform attribution enrichment");
    return map;
  }
  for (const formId of JOTFORM_APP_FORM_IDS) {
    let offset = 0;
    for (let page = 0; page < 30; page++) {
      const url = `https://api.jotform.com/form/${formId}/submissions` +
        `?apiKey=${JOTFORM_API_KEY}&limit=100&offset=${offset}`;
      let data;
      try {
        const res = await fetch(url);
        if (!res.ok) { console.warn(`Jotform form ${formId} ${res.status}`); break; }
        data = await res.json();
      } catch (err) {
        console.warn("Jotform fetch threw:", err.message);
        break;
      }
      const content = data.content || [];
      for (const sub of content) {
        const answers = sub.answers || {};
        let email = null, primary = null, advisor = null, event = null, wom = null;
        for (const qid of Object.keys(answers)) {
          const q = answers[qid] || {};
          const t = (q.text || "").toLowerCase();
          const val = jfAnswerToString(q.answer);
          if (!val) continue;
          if (t.includes("participant") && t.includes("email")) email = val.toLowerCase();
          else if (t.includes("how did you find")) primary = val;
          else if (t.includes("advisor") && t.includes("consultant")) advisor = val;
          else if (t.includes("name and location of the event")) event = val;
          else if (t.includes("word of mouth referral")) wom = val;
        }
        if (!email) continue;
        const prev = map.get(email) || {};
        map.set(email, {
          primary: primary || prev.primary || null,
          advisor: advisor || prev.advisor || null,
          event: event || prev.event || null,
          wordOfMouth: wom || prev.wordOfMouth || null,
        });
      }
      if (content.length < 100) break;
      offset += 100;
    }
  }
  return map;
}

// Overwrite a contact's Jotform fields with the answer from their application
// submission (matched by email). HubSpot values are kept only as a fallback.
function enrichJotform(entry, jotformMap) {
  if (!entry) return entry;
  const email = (entry.email || "").trim().toLowerCase();
  if (!email) return entry;
  const jf = jotformMap.get(email);
  // hasApplication records whether this person is even in the population the
  // question was put to. Without it the panel can't tell "didn't answer" from
  // "was never asked", and the second dwarfs the first roughly 4:1.
  if (!jf) {
    entry.hasApplication = Boolean(entry.jotform);
    return entry;
  }
  entry.hasApplication = true;
  if (jf.primary) entry.jotform = jf.primary;
  if (jf.advisor) entry.advisor_name = jf.advisor;
  if (jf.event) entry.event_name_and_location = jf.event;
  if (jf.wordOfMouth) entry.word_of_mouth_referral_name = jf.wordOfMouth;
  return entry;
}

// ============================================================
// Traffic — HubSpot Analytics filtered by Analytics View 16405
// ============================================================
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

    // Kick off the Jotform attribution pull in parallel with HubSpot work.
    const jotformMapPromise = fetchJotformAttribution();

    // Phase 1: deal stage queries with associated contact IDs
    const [afDeals, dpDeals, cwDeals] = await Promise.all([
      searchStageEntries(STAGES.af, windowStart, windowEnd),
      searchStageEntries(STAGES.dp, windowStart, windowEnd),
      searchStageEntries(STAGES.cw, windowStart, windowEnd),
    ]);

    // Phase 2a: resolve the Student-labeled contact for each deal so parents/
    // guardians (usually OFFLINE) don't drive the deal's source attribution.
    const allDealIds = new Set();
    for (const list of [afDeals, dpDeals, cwDeals]) {
      for (const d of list) {
        if (isExcluded(d)) continue;
        allDealIds.add(String(d.id));
      }
    }
    const dealStudentMap = await fetchDealStudentContacts([...allDealIds]);

    // The contact whose source represents the deal: the Student, falling back
    // to the first associated contact when no Student label exists.
    function dealContactId(deal) {
      return dealStudentMap.get(String(deal.id)) || primaryContactId(deal);
    }

    // Phase 2b: batch-resolve source properties for every student contact referenced
    const allContactIds = new Set();
    for (const list of [afDeals, dpDeals, cwDeals]) {
      for (const d of list) {
        if (isExcluded(d)) continue;
        const cid = dealContactId(d);
        if (cid) allContactIds.add(cid);
      }
    }
    await sleep(300);
    const sourceMap = await fetchContactSources([...allContactIds]);

    // Override deal-contact Jotform answers with the real values from Jotform.
    const jotformMap = await jotformMapPromise;
    for (const entry of sourceMap.values()) enrichJotform(entry, jotformMap);

    function dealSource(deal, mode) {
      const cid = dealContactId(deal);
      if (!cid) return UNKNOWN_LABEL;
      const entry = sourceMap.get(cid);
      if (!entry) return UNKNOWN_LABEL;
      if (mode === "hubspot") return hubspotSourceLabel(entry.hubspot);
      return jotformLabel(entry);
    }

    // Sub-source detail value (advisor / event / referrer) for a deal
    function dealSubSource(deal, jotformPrimary) {
      const fieldName = JOTFORM_DETAIL_FIELDS[jotformPrimary];
      if (!fieldName) return null;
      const cid = dealContactId(deal);
      if (!cid) return UNKNOWN_LABEL;
      const entry = sourceMap.get(cid);
      if (!entry) return UNKNOWN_LABEL;
      const v = (entry[fieldName] || "").trim();
      return v || UNKNOWN_LABEL;
    }

    // -------- Bucket builders --------
    const emptyArr = () => months.map(() => 0);
    const makeBucketMap = () => ({ hubspot: {}, jotform: {} });
    const ensure = (bucket, mode, label) => {
      if (!bucket[mode][label]) bucket[mode][label] = emptyArr();
      return bucket[mode][label];
    };

    // Sub-source bucket: { "<primary>": { "<detail>": [...] } }
    const makeSubBucket = () => {
      const map = {};
      for (const primary of Object.keys(JOTFORM_DETAIL_FIELDS)) {
        map[primary] = {};
      }
      return map;
    };
    const ensureSub = (bucket, primary, detail) => {
      if (!bucket[primary]) return null;
      if (!bucket[primary][detail]) bucket[primary][detail] = emptyArr();
      return bucket[primary][detail];
    };

    const monthOf = (iso) => (iso ? iso.slice(0, 7) : null);
    const idxOf = (ym) => months.indexOf(ym);

    // -------- Offline breakout --------
    // One accumulator per population. `total` is every Offline record;
    // `recovered` + `unrecovered` always sum to it, so the page can state what
    // share of the Offline bar it has actually explained.
    const makeOffline = () => ({
      total: emptyArr(),
      recovered: emptyArr(),
      unrecovered: emptyArr(),
      byChannel: {},
      byDetail: {},
      byRaw: {},
    });
    const bump = (obj, key, idx) => {
      if (!obj[key]) obj[key] = emptyArr();
      obj[key][idx]++;
    };
    function recordOffline(acc, entry, idx) {
      acc.total[idx]++;
      const rec = recoverOffline(entry.dd3, entry.dd4, entry.dd5);
      if (!rec) {
        acc.unrecovered[idx]++;
        bump(acc.byChannel, OFFLINE_UNRECOVERED, idx);
        return;
      }
      acc.recovered[idx]++;
      bump(acc.byChannel, rec.channel, idx);
      bump(acc.byDetail, rec.detail, idx);
      bump(acc.byRaw, rec.raw, idx);
    }
    const offlineContacts = makeOffline();
    const offlineOpps = makeOffline();
    const offlineSales = makeOffline();

    // How many leads in each month are even in the application population —
    // the denominator the self-reported panel is really working from.
    const applicationsMatched = emptyArr();

    // Offline recovery for a deal, via its student contact.
    function recordOfflineDeal(acc, deal, idx) {
      const cid = dealContactId(deal);
      const entry = cid ? sourceMap.get(cid) : null;
      if (!entry) return;
      if (hubspotSourceLabel(entry.hubspot) !== "Offline Sources") return;
      recordOffline(acc, entry, idx);
    }

    // Opportunities
    const oppsTotal = emptyArr();
    const oppsBySource = makeBucketMap();
    const oppsBySubSource = makeSubBucket();
    const seenAfDeal = new Set();
    for (const d of afDeals) {
      if (isExcluded(d)) continue;
      const date = earliestStageDate(d, STAGES.af);
      const ym = monthOf(date);
      const idx = idxOf(ym);
      if (idx < 0) continue;
      const key = d.id + ym;
      if (seenAfDeal.has(key)) continue;
      seenAfDeal.add(key);
      oppsTotal[idx]++;
      recordOfflineDeal(offlineOpps, d, idx);
      const hsLabel = dealSource(d, "hubspot");
      const jfLabel = dealSource(d, "jotform");
      ensure(oppsBySource, "hubspot", hsLabel)[idx]++;
      ensure(oppsBySource, "jotform", jfLabel)[idx]++;
      const subArr = ensureSub(oppsBySubSource, jfLabel, dealSubSource(d, jfLabel));
      if (subArr) subArr[idx]++;
    }

    // Sales via DP
    const salesDpTotal = emptyArr();
    const salesDpBySource = makeBucketMap();
    const salesDpBySubSource = makeSubBucket();
    for (const d of dpDeals) {
      if (isExcluded(d)) continue;
      const date = earliestStageDate(d, STAGES.dp);
      const ym = monthOf(date);
      const idx = idxOf(ym);
      if (idx < 0) continue;
      salesDpTotal[idx]++;
      recordOfflineDeal(offlineSales, d, idx);
      const hsLabel = dealSource(d, "hubspot");
      const jfLabel = dealSource(d, "jotform");
      ensure(salesDpBySource, "hubspot", hsLabel)[idx]++;
      ensure(salesDpBySource, "jotform", jfLabel)[idx]++;
      const subArr = ensureSub(salesDpBySubSource, jfLabel, dealSubSource(d, jfLabel));
      if (subArr) subArr[idx]++;
    }

    // Sales skipped DP
    const salesSkipTotal = emptyArr();
    const salesSkipBySource = makeBucketMap();
    const salesSkipBySubSource = makeSubBucket();
    const skippedNames = Object.fromEntries(months.map((m) => [m, []]));
    function hasAnyDp(deal) {
      for (const sid of STAGES.dp) {
        if (deal.properties?.[`hs_v2_date_entered_${sid}`]) return true;
      }
      return false;
    }
    for (const d of cwDeals) {
      if (isExcluded(d)) continue;
      if (hasAnyDp(d)) continue;
      const date = earliestStageDate(d, STAGES.cw);
      const ym = monthOf(date);
      const idx = idxOf(ym);
      if (idx < 0) continue;
      salesSkipTotal[idx]++;
      recordOfflineDeal(offlineSales, d, idx);
      skippedNames[ym].push({ name: d.properties.dealname, cw_date: date });
      const hsLabel = dealSource(d, "hubspot");
      const jfLabel = dealSource(d, "jotform");
      ensure(salesSkipBySource, "hubspot", hsLabel)[idx]++;
      ensure(salesSkipBySource, "jotform", jfLabel)[idx]++;
      const subArr = ensureSub(salesSkipBySubSource, jfLabel, dealSubSource(d, jfLabel));
      if (subArr) subArr[idx]++;
    }

    // Contacts
    await sleep(300);
    const contactsTotal = emptyArr();
    const contactsBySource = makeBucketMap();
    const contactsBySubSource = makeSubBucket();

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
          enrichJotform(c, jotformMap);
          const hsLabel = hubspotSourceLabel(c.hubspot);
          const jfLabel = jotformLabel(c);
          if (c.hasApplication) applicationsMatched[idx]++;
          if (hsLabel === "Offline Sources") recordOffline(offlineContacts, c, idx);
          ensure(contactsBySource, "hubspot", hsLabel)[idx]++;
          ensure(contactsBySource, "jotform", jfLabel)[idx]++;
          const fieldName = JOTFORM_DETAIL_FIELDS[jfLabel];
          if (fieldName) {
            const detail = (c[fieldName] || "").trim() || UNKNOWN_LABEL;
            const subArr = ensureSub(contactsBySubSource, jfLabel, detail);
            if (subArr) subArr[idx]++;
          }
        }
      }
      if (i + 3 < months.length) await sleep(250);
    }

    const trafficResult = await getTraffic(months);

    const totalSales = months.map((_, i) => salesDpTotal[i] + salesSkipTotal[i]);

    // totalSales by source = salesDp + salesSkip per source
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

    // totalSales by sub-source (per Jotform primary)
    const totalSalesBySubSource = makeSubBucket();
    for (const primary of Object.keys(JOTFORM_DETAIL_FIELDS)) {
      const dpDetails = salesDpBySubSource[primary] || {};
      const skipDetails = salesSkipBySubSource[primary] || {};
      const labels = new Set([...Object.keys(dpDetails), ...Object.keys(skipDetails)]);
      for (const label of labels) {
        const a = dpDetails[label] || emptyArr();
        const b = skipDetails[label] || emptyArr();
        totalSalesBySubSource[primary][label] = a.map((v, i) => v + (b[i] || 0));
      }
    }

    // Collect labels
    const sourceLabels = { hubspot: new Set(), jotform: new Set() };
    for (const mode of ["hubspot", "jotform"]) {
      for (const bucket of [contactsBySource, oppsBySource, salesDpBySource, salesSkipBySource]) {
        for (const label of Object.keys(bucket[mode])) {
          sourceLabels[mode].add(label);
        }
      }
    }

    const subSourceLabels = {};
    for (const primary of Object.keys(JOTFORM_DETAIL_FIELDS)) {
      const set = new Set();
      for (const bucket of [contactsBySubSource, oppsBySubSource, salesDpBySubSource, salesSkipBySubSource]) {
        for (const label of Object.keys(bucket[primary] || {})) {
          set.add(label);
        }
      }
      subSourceLabels[primary] = [...set].sort();
    }

    return new Response(
      JSON.stringify({
        months,
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
        offline: {
          contacts: offlineContacts,
          opportunities: offlineOpps,
          totalSales: offlineSales,
          unrecoveredLabel: OFFLINE_UNRECOVERED,
          drilldownProps: DRILLDOWN_PROPS,
        },
        applications: {
          // Leads matched to a submitted application form, per month. The
          // self-reported panel can only speak for these.
          matched: applicationsMatched,
          formIds: JOTFORM_APP_FORM_IDS,
          available: jotformMap.size > 0,
          noApplicationLabel: NO_APPLICATION_LABEL,
          blankLabel: APPLICATION_BLANK_LABEL,
        },
        bySubSource: {
          detailFieldsByPrimary: JOTFORM_DETAIL_FIELDS,
          labels: subSourceLabels,
          contacts: contactsBySubSource,
          opportunities: oppsBySubSource,
          salesViaDp: salesDpBySubSource,
          salesSkipDp: salesSkipBySubSource,
          totalSales: totalSalesBySubSource,
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

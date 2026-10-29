// netlify/functions/_shared/meta-leads.mjs
//
// Reads Meta (Facebook / Instagram) instant lead form submissions from the
// Graph API so they can be attached to HubSpot contacts as PDFs.
//
// HubSpot's own Lead Ads sync still creates the contact — this never creates
// or changes a contact. It only needs the lead's answers, which HubSpot's
// sync doesn't expose as a file.
//
// Env:
//   META_LEADS_TOKEN     a token that can read the Page's leads. Easiest: a
//                        System User in Business Settings with the Page
//                        assigned, and the permissions leads_retrieval,
//                        pages_show_list, pages_read_engagement,
//                        pages_manage_ads, ads_read. A Page token
//                        works too. (Falls back to META_PAGE_ACCESS_TOKEN.)
//   META_PAGE_IDS        comma-separated Facebook Page ids that run the forms.
//   META_GRAPH_VERSION   optional, default v21.0.

const GRAPH = "https://graph.facebook.com";

let _fetch = fetch;
export function __setFetch(f) { _fetch = f; }

export function metaConfig(env = process.env) {
  const token = env.META_LEADS_TOKEN || env.META_PAGE_ACCESS_TOKEN || "";
  const pages = String(env.META_PAGE_IDS || env.META_PAGE_ID || "").split(",").map((s) => s.trim()).filter(Boolean);
  return { token, pages, version: env.META_GRAPH_VERSION || "v21.0", enabled: !!(token && pages.length) };
}

async function graph(url, token) {
  const u = new URL(url.startsWith("http") ? url : `${GRAPH}/${url.replace(/^\//, "")}`);
  if (!u.searchParams.has("access_token")) u.searchParams.set("access_token", token);
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await _fetch(u.toString(), { signal: AbortSignal.timeout(15_000) });
    const data = await res.json().catch(() => ({}));
    if (res.ok) return data;
    const code = data?.error?.code;
    // 4 / 17 / 32 / 613 are Meta's rate limits.
    if ([4, 17, 32, 613].includes(code) && attempt < 2) { await new Promise((r) => setTimeout(r, 1500 * (attempt + 1))); continue; }
    const e = new Error(`Meta ${res.status}${code ? ` (code ${code})` : ""}: ${data?.error?.message || "request failed"}`);
    e.status = res.status;
    e.code = code;
    throw e;
  }
}

async function pageAll(url, token, maxPages = 20) {
  const out = [];
  let next = url;
  for (let i = 0; i < maxPages && next; i++) {
    const data = await graph(next, token);
    out.push(...(data?.data || []));
    next = data?.paging?.next || null;
  }
  return out;
}

/**
 * A system-user / user token reads a Page's forms through that Page's own
 * token. Ask for it; if the token already IS a Page token, use it as-is.
 */
async function pageToken(pageId, cfg) {
  try {
    const d = await graph(`${cfg.version}/${pageId}?fields=access_token`, cfg.token);
    return d?.access_token || cfg.token;
  } catch {
    return cfg.token;
  }
}

/**
 * Every lead created after `sinceMs` on every form of every configured Page.
 * @returns {{ leads: object[], forms: number, errors: string[] }}
 */
export async function listMetaLeads({ sinceMs, deadline = Date.now() + 15_000, cfg = metaConfig() }) {
  const out = { leads: [], forms: 0, errors: [] };
  if (!cfg.enabled) return out;
  const since = Math.floor(sinceMs / 1000);
  for (const pageId of cfg.pages) {
    if (Date.now() > deadline) break;
    let token;
    let forms = [];
    try {
      token = await pageToken(pageId, cfg);
      forms = await pageAll(`${cfg.version}/${pageId}/leadgen_forms?fields=id,name,status,questions{key,label,type}&limit=100`, token, 5);
    } catch (e) { out.errors.push(`Page ${pageId}: ${e.message}`); continue; }
    for (const form of forms) {
      if (Date.now() > deadline) break;
      out.forms++;
      const filtering = encodeURIComponent(JSON.stringify([{ field: "time_created", operator: "GREATER_THAN", value: since }]));
      try {
        const leads = await pageAll(
          `${cfg.version}/${form.id}/leads?fields=id,created_time,field_data,ad_id,ad_name,adset_name,campaign_name,form_id,platform,is_organic&filtering=${filtering}&limit=100`,
          token, 10);
        for (const l of leads) out.leads.push(toLead(l, form, pageId));
      } catch (e) { out.errors.push(`Form ${form.name || form.id}: ${e.message}`); }
    }
  }
  return out;
}

/** Graph lead + its form → the row stored in meta_leads. */
export function toLead(l, form = {}, pageId = null) {
  const field = (n) => ((l.field_data || []).find((f) => f.name === n)?.values || [])[0] || "";
  return {
    id: String(l.id),
    page_id: pageId,
    form_id: String(l.form_id || form.id || ""),
    form_name: form.name || null,
    created_time: new Date(l.created_time).toISOString(),
    email: String(field("email") || field("work_email") || "").trim().toLowerCase() || null,
    field_data: l.field_data || [],
    questions: (form.questions || []).map((q) => ({ key: q.key, label: q.label })),
    ad_name: l.ad_name || null,
    adset_name: l.adset_name || null,
    campaign_name: l.campaign_name || null,
    platform: l.platform || null,
    is_organic: !!l.is_organic,
  };
}

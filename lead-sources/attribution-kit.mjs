// attribution-kit.mjs — shared by the browser, the pd-apply functions and the
// dashboard (pinned copy in pd-dashboard/lead-sources/). Pure functions only.
//
//   sanitizeAttribution(raw)          what the browser sent → safe, bounded object
//   classify(touch)                   one touch → { channel, source, medium, campaign, clickId }
//   attributionContactProps(attr, existing, { conversion })
//                                     → HubSpot contact properties (first-touch
//                                       props only when the contact has none yet)
//   ATTRIBUTION_PROPERTIES            the custom contact properties (for setup)
//   CHANNELS                          channel labels, same wording as HubSpot's

export const CHANNELS = [
  'Organic Search', 'Paid Search', 'Paid Social', 'Organic Social', 'Email Marketing',
  'AI Referrals', 'Referrals', 'Other Campaigns', 'Direct Traffic', 'Offline Sources',
];

export const TOUCH_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term',
  'gclid', 'gbraid', 'wbraid', 'msclkid', 'fbclid', 'ttclid', 'li_fat_id', 'landing', 'referrer', 'ts'];

const str = (v, n) => (v == null ? '' : String(v).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n));

function cleanTouch(t) {
  if (!t || typeof t !== 'object') return null;
  const out = {};
  for (const k of TOUCH_KEYS) {
    const v = str(t[k], k === 'landing' ? 300 : k === 'referrer' ? 250 : 200);
    if (v) out[k] = v;
  }
  return Object.keys(out).length ? out : null;
}

/**
 * Accepts the new shape { first, last, hutk, pageUri, pageName } and the old
 * flat one ({ utm_source, …, landing, referrer }) — which becomes both touches.
 */
export function sanitizeAttribution(raw) {
  const a = raw && typeof raw === 'object' ? raw : {};
  const flat = cleanTouch(a);
  const first = cleanTouch(a.first) || flat;
  const last = cleanTouch(a.last) || flat || first;
  const out = {};
  if (first) out.first = first;
  if (last) out.last = last;
  const hutk = str(a.hutk, 64);
  if (/^[a-f0-9]{32}$/i.test(hutk)) out.hutk = hutk.toLowerCase();
  const pageUri = str(a.pageUri, 300);
  if (/^https?:\/\//i.test(pageUri)) out.pageUri = pageUri;
  const pageName = str(a.pageName, 120);
  if (pageName) out.pageName = pageName;
  // Flat copies for the hidden utm_* fields and older readers.
  for (const k of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'gclid', 'fbclid']) {
    if (last?.[k]) out[k] = last[k];
  }
  if (last?.landing) out.landing = last.landing;
  if (last?.referrer) out.referrer = last.referrer;
  return out;
}

export function hostOf(u) {
  try { return new URL(u).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; }
}

const SEARCH = /(^|\.)(google\.[a-z.]+|bing\.com|duckduckgo\.com|search\.yahoo\.com|yahoo\.com|ecosia\.org|baidu\.com|yandex\.[a-z]+|search\.brave\.com|startpage\.com|qwant\.com|naver\.com)$/;
const SOCIAL = /(^|\.)(facebook\.com|fb\.com|fb\.me|instagram\.com|t\.co|twitter\.com|x\.com|linkedin\.com|lnkd\.in|tiktok\.com|youtube\.com|youtu\.be|pinterest\.[a-z.]+|reddit\.com|threads\.net|snapchat\.com|whatsapp\.com)$/;
const AI = /(^|\.)(chatgpt\.com|chat\.openai\.com|openai\.com|perplexity\.ai|gemini\.google\.com|copilot\.microsoft\.com|claude\.ai|you\.com|bard\.google\.com|meta\.ai|deepseek\.com)$/;
const WEBMAIL = /(^|\.)(mail\.google\.com|outlook\.live\.com|outlook\.office\.com|outlook\.office365\.com|mail\.yahoo\.com|mail\.aol\.com)$/;
const SOCIAL_SRC = /^(facebook|fb|ig|instagram|meta|tiktok|linkedin|youtube|pinterest|reddit|twitter|x|snapchat|threads)(\.com)?$/;
const SEARCH_SRC = /^(google|googleads|adwords|google_ads|google-ads|bing|microsoft|yahoo|duckduckgo)(\.com)?$/;

/** The channel a single touch belongs to (HubSpot's channel names). */
export function classify(touch) {
  const t = touch || {};
  const src = str(t.utm_source, 200).toLowerCase();
  const med = str(t.utm_medium, 200).toLowerCase();
  const campaign = str(t.utm_campaign, 200);
  const refHost = hostOf(t.referrer);
  const clickId = t.gclid ? `gclid:${t.gclid}` : t.gbraid ? `gbraid:${t.gbraid}` : t.wbraid ? `wbraid:${t.wbraid}`
    : t.msclkid ? `msclkid:${t.msclkid}` : t.ttclid ? `ttclid:${t.ttclid}` : t.li_fat_id ? `li_fat_id:${t.li_fat_id}` : t.fbclid ? `fbclid:${t.fbclid}` : '';
  const out = (channel, source, medium) => ({ channel, source: source || '', medium: medium || med || '', campaign, clickId });
  const paidMed = /^(cpc|ppc|paid|paidsearch|paid_search|paid-search|sem|cpm|cpv|display|banner|paid_social|paidsocial|paid-social|social_paid|social-paid|ads?)$/.test(med) || /paid|cpc|ppc/.test(med);

  if (t.gclid || t.gbraid || t.wbraid) return out('Paid Search', src || 'google', med || 'cpc');
  if (t.msclkid) return out('Paid Search', src || 'bing', med || 'cpc');
  if (t.ttclid) return out('Paid Social', src || 'tiktok', med || 'paid');
  if (t.li_fat_id && paidMed) return out('Paid Social', src || 'linkedin', med);
  if (src || med) {
    if (/social/.test(med) && paidMed) return out('Paid Social', src);
    if (paidMed && (SOCIAL_SRC.test(src) || /social/.test(med))) return out('Paid Social', src);
    if (paidMed && (SEARCH_SRC.test(src) || !src)) return out('Paid Search', src);
    if (paidMed) return out('Other Campaigns', src);
    if (/^(e-?mail|newsletter)$/.test(med) || /^(hs_email|email|newsletter|mailchimp|klaviyo|hubspot_email)$/.test(src)) return out('Email Marketing', src);
    if (/social/.test(med) || SOCIAL_SRC.test(src)) return out('Organic Social', src);
    if (AI.test(src) || /^(chatgpt|perplexity|claude|gemini|copilot)/.test(src)) return out('AI Referrals', src);
    if (/^(organic|seo)$/.test(med)) return out('Organic Search', src);
    if (/^(referral|affiliate|partner|partners)$/.test(med)) return out('Referrals', src || refHost);
    return out('Other Campaigns', src);
  }
  if (t.fbclid) return out('Organic Social', refHost || 'facebook.com', 'social');
  if (refHost) {
    if (AI.test(refHost)) return out('AI Referrals', refHost, 'referral');
    if (SEARCH.test(refHost)) return out('Organic Search', refHost.split('.')[0], 'organic');
    if (SOCIAL.test(refHost)) return out('Organic Social', refHost, 'social');
    if (WEBMAIL.test(refHost)) return out('Email Marketing', refHost, 'email');
    return out('Referrals', refHost, 'referral');
  }
  return out('Direct Traffic', '', '');
}

/** Custom contact properties this site writes (created by Lead Sources → HubSpot setup). */
const touchProps = (p, label) => [
  { name: `pd_${p}_channel`, label: `${label} channel`, type: 'enumeration', fieldType: 'select', options: CHANNELS },
  { name: `pd_${p}_source`, label: `${label} source` },
  { name: `pd_${p}_medium`, label: `${label} medium` },
  { name: `pd_${p}_campaign`, label: `${label} campaign` },
  { name: `pd_${p}_content`, label: `${label} content` },
  { name: `pd_${p}_term`, label: `${label} term` },
  { name: `pd_${p}_click_id`, label: `${label} ad click id` },
  { name: `pd_${p}_landing_page`, label: `${label} landing page` },
  { name: `pd_${p}_referrer`, label: `${label} referring site` },
  { name: `pd_${p}_touch_date`, label: `${label} date`, type: 'date', fieldType: 'date' },
];
export const ATTRIBUTION_PROPERTIES = [
  ...touchProps('first', 'PD first touch'),
  ...touchProps('last', 'PD latest touch'),
  { name: 'pd_first_conversion', label: 'PD first conversion (form)' },
  { name: 'pd_last_conversion', label: 'PD latest conversion (form)' },
  { name: 'pd_last_conversion_date', label: 'PD latest conversion date', type: 'date', fieldType: 'date' },
  { name: 'pd_quiz_archetype', label: 'PD quiz result' },
  { name: 'pd_quiz_date', label: 'PD quiz date', type: 'date', fieldType: 'date' },
  { name: 'pd_quiz_answers', label: 'PD quiz answers', fieldType: 'textarea' },
];
export const FIRST_TOUCH_PROPS = ATTRIBUTION_PROPERTIES.filter((p) => p.name.startsWith('pd_first_')).map((p) => p.name);

function touchToProps(prefix, touch) {
  if (!touch) return {};
  const c = classify(touch);
  return {
    [`pd_${prefix}_channel`]: c.channel,
    [`pd_${prefix}_source`]: c.source,
    [`pd_${prefix}_medium`]: c.medium,
    [`pd_${prefix}_campaign`]: c.campaign,
    [`pd_${prefix}_content`]: touch.utm_content || '',
    [`pd_${prefix}_term`]: touch.utm_term || '',
    [`pd_${prefix}_click_id`]: c.clickId,
    [`pd_${prefix}_landing_page`]: touch.landing || '',
    [`pd_${prefix}_referrer`]: touch.referrer || '',
    [`pd_${prefix}_touch_date`]: /^\d{4}-\d{2}-\d{2}$/.test(touch.ts || '') ? touch.ts : '',
  };
}

/**
 * HubSpot properties for one conversion. `existing` = the contact's current
 * values (at least the pd_first_* ones): first touch is never overwritten.
 * Plain utm_* / gclid / fbclid are included too — portals that have those
 * properties get them, the others drop them silently (see withPropRetry).
 */
export function attributionContactProps(attr, existing = {}, { conversion, date } = {}) {
  const a = attr || {};
  const props = {};
  const hasFirst = !!(existing.pd_first_channel || existing.pd_first_source || existing.pd_first_landing_page);
  if (!hasFirst && a.first) Object.assign(props, touchToProps('first', a.first));
  if (a.last) Object.assign(props, touchToProps('last', a.last));
  const day = date || new Date().toISOString().slice(0, 10);
  if (conversion) {
    if (!existing.pd_first_conversion) props.pd_first_conversion = conversion;
    props.pd_last_conversion = conversion;
    props.pd_last_conversion_date = day;
  }
  const last = a.last || {};
  for (const k of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'gclid', 'fbclid']) {
    if (last[k]) props[k] = last[k];
  }
  return Object.fromEntries(Object.entries(props).filter(([, v]) => v !== '' && v != null));
}

/**
 * The best answer to "where did this lead really come from?".
 *   site     — this site's first-touch cookie (quiz / application) or pd_first_* on the contact
 *   hubspot  — HubSpot's Original Source, when it isn't Offline
 *   recovered— Offline in HubSpot, but the drill-downs name the channel (recover() is passed in)
 * HubSpot wins over the site when it saw an earlier, non-direct visit the cookie missed.
 */
export const HUBSPOT_SOURCE_LABELS = {
  ORGANIC_SEARCH: 'Organic Search', PAID_SEARCH: 'Paid Search', EMAIL_MARKETING: 'Email Marketing',
  SOCIAL_MEDIA: 'Organic Social', REFERRALS: 'Referrals', OTHER_CAMPAIGNS: 'Other Campaigns',
  DIRECT_TRAFFIC: 'Direct Traffic', OFFLINE: 'Offline Sources', PAID_SOCIAL: 'Paid Social', AI_REFERRALS: 'AI Referrals',
};

export function realSource({ contact = {}, siteFirst = null, recover = null } = {}) {
  const hsRaw = contact.hs_analytics_source || '';
  const hs = HUBSPOT_SOURCE_LABELS[hsRaw] || (hsRaw ? hsRaw : '');
  const hsDetail = [contact.hs_analytics_source_data_1, contact.hs_analytics_source_data_2].filter(Boolean).join(' › ');
  let site = null;
  if (siteFirst) { const c = classify(siteFirst); site = { channel: c.channel, detail: [c.source, c.campaign].filter(Boolean).join(' › ') }; }
  else if (contact.pd_first_channel) site = { channel: contact.pd_first_channel, detail: [contact.pd_first_source, contact.pd_first_campaign].filter(Boolean).join(' › ') };

  const hsGood = hs && hs !== 'Offline Sources';
  if (hsGood && hs !== 'Direct Traffic') return { channel: hs, detail: hsDetail, basis: 'hubspot', hubspot: hs };
  if (site && site.channel !== 'Direct Traffic') return { ...site, basis: 'site', hubspot: hs };
  if (hs === 'Offline Sources' && recover) {
    const r = recover(contact.original_source_drill_down_3, contact.original_source_drill_down_4, contact.original_source_drill_down_5);
    if (r && !/^Unmapped/.test(r.channel)) return { channel: r.channel, detail: r.detail, basis: 'recovered', hubspot: hs };
  }
  if (hsGood) return { channel: hs, detail: hsDetail, basis: 'hubspot', hubspot: hs };
  if (site) return { ...site, basis: 'site', hubspot: hs };
  if (hs === 'Offline Sources') return { channel: 'Unknown (offline)', detail: [contact.hs_analytics_source_data_1, contact.hs_analytics_source_data_2].filter(Boolean).join(' › '), basis: 'none', hubspot: hs };
  return { channel: 'Unknown', detail: '', basis: 'none', hubspot: hs };
}

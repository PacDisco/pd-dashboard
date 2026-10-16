// referral-kit.mjs — the referral form: validation, HubSpot mapping, lint.
// Shared by the referral page + API in pd-apply (public/referral-kit.mjs) and
// the dashboard editor (apply-form/referral-kit.mjs). Pure functions only.
// Until pd-apply has it, THIS copy is the source: copy it to
// pd-apply/public/referral-kit.mjs, then scripts/sync-form-kit.mjs keeps the
// two in step.
//
// A referral form is a form-kit schema with two steps:
//   "referrer"  who is making the referral   → the REFERRER's HubSpot contact
//   "friend"    who they're referring        → the REFERRED person's contact
// A field's `hubspot.contact` mapping writes to the contact of its own step.
//
// Core fields (keys the flow relies on — the editor won't let you delete them):
//   referrerType (radio), referrerName (fullname), referrerEmail (email),
//   friendName (fullname), friendEmail (email), consent (checkbox)
//
// settings: introTitle, introBody, submitLabel, thanksTitle, thanksBody,
//           anotherLabel, hubspotFormGuid (the referrer's form submission),
//           leadStatus (for the referred contact), associationLabel,
//           howFoundProperty / howFoundValue (optional, referred contact),
//           notifyEmails (optional, comma separated)

import { allFields, stepFields, valueText, isEmptyValue, lintSchema as lintForm } from './form-kit.mjs';

export const REFERRAL_FORM_ID = 'pd-referral';
export const REFERRAL_STEPS = ['referrer', 'friend'];
export const CORE_FIELDS = {
  referrerType: { step: 'referrer', type: 'radio' },
  referrerName: { step: 'referrer', type: 'fullname' },
  referrerEmail: { step: 'referrer', type: 'email' },
  friendName: { step: 'friend', type: 'fullname' },
  friendEmail: { step: 'friend', type: 'email' },
  consent: { step: 'friend', type: 'checkbox' },
};
export const DEFAULT_ASSOCIATION_LABEL = 'Referred by';

/** HubSpot contact properties the referral writes (created by "Set up HubSpot" in the dashboard). */
export const REFERRAL_PROPERTIES = [
  { name: 'pd_referred_by', label: 'PD referred by' },
  { name: 'pd_referred_by_email', label: 'PD referred by (email)' },
  { name: 'pd_referrer_type', label: 'PD referrer type' },
  { name: 'pd_referral_date', label: 'PD referral date', type: 'date', fieldType: 'date' },
  { name: 'pd_referral_details', label: 'PD referral details', fieldType: 'textarea' },
  { name: 'pd_referrals_made', label: 'PD referrals made', fieldType: 'textarea' },
];

const norm = (s) => String(s ?? '').trim().toLowerCase();
const nameText = (v) => (v && typeof v === 'object' ? `${v.first || ''} ${v.last || ''}`.trim() : String(v || '').trim());

/** Problems with one submission beyond per-field validation. */
export function referralErrors(values) {
  const out = {};
  const a = norm(values?.referrerEmail); const b = norm(values?.friendEmail);
  if (a && b && a === b) out.friendEmail = 'Use your friend’s own email address, not yours.';
  return out;
}

/** "Question: answer" lines for one step. */
export function stepText(schema, values, step) {
  const lines = [];
  for (const field of stepFields(schema, step)) {
    if (field.type === 'html' || field.type === 'hidden' || field.key === 'consent' || /^(referrer|friend)(Name|Email)$/.test(field.key)) continue;
    const v = values?.[field.key];
    if (isEmptyValue(field, v)) continue;
    lines.push(`${field.label}: ${valueText(field, v)}`);
  }
  return lines.join('\n');
}

function mapped(schema, values, step) {
  const props = {};
  for (const { field, step: s } of allFields(schema)) {
    if (s !== step) continue;
    const map = field.hubspot?.contact; const v = values?.[field.key];
    if (!map || v == null || v === '') continue;
    if (typeof map === 'object' && field.type === 'fullname') { if (map.first) props[map.first] = v.first || ''; if (map.last) props[map.last] = v.last || ''; }
    else if (typeof map === 'string') props[map] = field.type === 'checkbox' && Array.isArray(v) ? v.join(';') : valueText(field, v);
  }
  return props;
}

/**
 * Both contacts' properties. pd-apply creates/updates each contact (never
 * moving lifecycle backwards, never overwriting a lead status someone set),
 * then associates referred → referrer with settings.associationLabel.
 *   referrer: submitted through the HubSpot form WITH the visitor cookie (it's
 *             their visit), so Original Source is their real channel.
 *   referred: created through the API WITHOUT the cookie — the referrer's
 *             browsing history must not be pinned on their friend.
 */
export function referralContacts(schema, values, { date } = {}) {
  const st = schema?.settings || {};
  const day = date || new Date().toISOString().slice(0, 10);
  const rName = values?.referrerName || {}; const fName = values?.friendName || {};
  const referrerName = nameText(rName);
  const referrer = {
    email: String(values?.referrerEmail || '').trim(),
    firstname: rName.first || '', lastname: rName.last || '',
    ...(values?.referrerPhone ? { phone: valueText({ type: 'phone' }, values.referrerPhone) } : {}),
    company_tag: 'Pacific Discovery',
    pd_referrer_type: String(values?.referrerType || ''),
    ...mapped(schema, values, 'referrer'),
  };
  const referred = {
    email: String(values?.friendEmail || '').trim(),
    firstname: fName.first || '', lastname: fName.last || '',
    ...(values?.friendPhone ? { phone: valueText({ type: 'phone' }, values.friendPhone) } : {}),
    company_tag: 'Pacific Discovery',
    pd_referred_by: referrerName,
    pd_referred_by_email: referrer.email,
    pd_referrer_type: String(values?.referrerType || ''),
    pd_referral_date: day,
    pd_referral_details: [`Referred by ${referrerName} <${referrer.email}> (${values?.referrerType || '—'})`, stepText(schema, values, 'referrer'), '', stepText(schema, values, 'friend')].join('\n').slice(0, 65000),
    ...(st.howFoundProperty && st.howFoundValue ? { [st.howFoundProperty]: st.howFoundValue } : {}),
    ...(st.leadStatus ? { hs_lead_status: st.leadStatus } : {}),
    ...mapped(schema, values, 'friend'),
  };
  // One line per referral, appended (by pd-apply) to the referrer's pd_referrals_made.
  const madeLine = `${day}: ${nameText(fName)} <${referred.email}>`;
  return { referrer, referred, madeLine, associationLabel: st.associationLabel || DEFAULT_ASSOCIATION_LABEL };
}

/** What the browser needs (no integration details). */
export function publicReferral(schema) {
  const steps = (schema.steps || []).map((st) => ({
    ...st,
    sections: (st.sections || []).map((sec) => ({ ...sec, fields: (sec.fields || []).map(({ hubspot, ...f }) => f) })),
  }));
  const { hubspotFormGuid, leadStatus, associationLabel, howFoundProperty, howFoundValue, notifyEmails, ...settings } = schema.settings || {};
  return { kind: 'referral', title: schema.title, settings, steps, programs: [], terms: [], lists: schema.lists || {} };
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function lintReferral(schema) {
  const out = [];
  const err = (message) => out.push({ level: 'error', message });
  const warn = (message) => out.push({ level: 'warn', message });
  if (!schema || schema.kind !== 'referral') { err('This is not a referral form.'); return out; }
  for (const k of REFERRAL_STEPS) if (!(schema.steps || []).find((s) => s.key === k)) err(`The form needs its "${k}" page.`);
  const where = new Map(allFields(schema).map((x) => [x.field.key, x]));
  for (const [key, want] of Object.entries(CORE_FIELDS)) {
    const hit = where.get(key);
    if (!hit) { err(`The form must keep the "${key}" field — the referral relies on it.`); continue; }
    if (hit.step !== want.step) err(`"${hit.field.label}" must stay on the ${want.step === 'referrer' ? '“About you”' : '“Who you’re referring”'} page.`);
    if (hit.field.type !== want.type) err(`"${hit.field.label}" must stay a ${want.type} field.`);
    if (key !== 'consent' && !hit.field.required) err(`"${hit.field.label}" must be required.`);
    if (key === 'consent' && !hit.field.required) warn('The “they know you’re passing on their details” box isn’t required.');
    if (hit.field.showIf) err(`"${hit.field.label}" can't be conditional.`);
  }
  if (!(where.get('referrerType')?.field.options || []).length) err('Add at least one option to “I am a…”.');
  const st = schema.settings || {};
  if (st.howFoundProperty && !st.howFoundValue) warn('“How did you find us” property is set but has no value.');
  for (const e of String(st.notifyEmails || '').split(',').map((s) => s.trim()).filter(Boolean)) if (!EMAIL_RE.test(e)) err(`"${e}" isn't an email address.`);
  if (!st.hubspotFormGuid) warn('No HubSpot form ID yet — the referrer’s Original Source will say “Offline sources”.');
  for (const l of lintForm({ ...schema, programs: [], terms: [] })) {
    if (/^The form must keep the "/.test(l.message) || /has no price|"PD Program"/.test(l.message)) continue; // application-only checks
    out.push(l);
  }
  return out;
}

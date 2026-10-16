// node test/referral-kit.test.mjs — referral form: lint, HubSpot mapping, API checks (no DB).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { lintReferral, referralContacts, referralErrors, publicReferral } from '../apply-form/referral-kit.mjs';
import { checkReferral, referralHubspotSetup, __setHubspotFetch } from '../netlify/functions/apply-forms.mjs';
import { validateStep } from '../apply-form/form-kit.mjs';

const seed = JSON.parse(readFileSync(new URL('../apply-form/referral-seed.json', import.meta.url)));
const T = seed.steps[0].sections[0].fields[0].options;
const values = { referrerType: T[2], referrerName: { first: 'Ann', last: 'Lee' }, referrerEmail: 'ann@school.org', referrerOrg: 'Boulder High',
  friendName: { first: 'Cal', last: 'Diaz' }, friendEmail: 'cal@x.org', relationship: 'Student I advise', interests: ['Summer program'], consent: [seed.steps[1].sections[0].fields.at(-1).options[0]] };
let n = 0; const t = async (name, fn) => { await fn(); n++; console.log('  ✓', name); };
const errs = (s) => lintReferral(s).filter((l) => l.level === 'error').map((l) => l.message);

await t('seed is valid and publishable', () => { assert.equal(checkReferral(seed), null); assert.deepEqual(errs(seed), []); });
await t('core fields are protected', () => {
  const s = structuredClone(seed); s.steps[1].sections[0].fields = s.steps[1].sections[0].fields.filter((f) => f.key !== 'friendEmail');
  assert.match(errs(s).join(), /friendEmail/);
  const m = structuredClone(seed); const f = m.steps[0].sections[0].fields.find((x) => x.key === 'referrerEmail'); f.required = false;
  assert.match(errs(m).join(), /must be required/);
  const mv = structuredClone(seed); mv.steps[1].sections[0].fields.push(mv.steps[0].sections[0].fields.splice(2, 1)[0]);
  assert.match(errs(mv).join(), /must stay on/);
  const bad = structuredClone(seed); bad.settings.notifyEmails = 'a@x.org, nope';
  assert.match(errs(bad).join(), /"nope"/);
  assert.match(checkReferral({ ...seed, kind: 'quiz' }), /kind/);
});
await t('conditional questions follow the referrer type', () => {
  const v = validateStep(seed, 'referrer', { ...values, referrerOrg: '' });
  assert.ok(v.errors.referrerOrg, 'org required for partners');
  assert.ok(!validateStep(seed, 'referrer', { ...values, referrerType: T[0], referrerOrg: '' }).errors.referrerOrg);
});
await t('same email for both is refused', () => { assert.ok(referralErrors({ referrerEmail: 'A@x.org', friendEmail: 'a@x.org ' }).friendEmail); });
await t('HubSpot mapping: two contacts, details, settings', () => {
  const s = structuredClone(seed); s.settings.howFoundProperty = 'how_did_you_find_us_'; s.settings.howFoundValue = 'Referral';
  s.steps[0].sections[0].fields.find((f) => f.key === 'referrerOrg').hubspot = { contact: 'company' };
  const c = referralContacts(s, values, { date: '2026-10-16' });
  assert.equal(c.referrer.email, 'ann@school.org'); assert.equal(c.referrer.company, 'Boulder High'); assert.equal(c.referrer.pd_referrer_type, T[2]);
  assert.equal(c.referred.email, 'cal@x.org'); assert.equal(c.referred.pd_referred_by, 'Ann Lee'); assert.equal(c.referred.how_did_you_find_us_, 'Referral');
  assert.equal(c.referred.hs_lead_status, 'NEW'); assert.equal(c.referred.company, undefined, 'referrer-page mapping stays on the referrer');
  assert.match(c.referred.pd_referral_details, /School or organisation: Boulder High/); assert.doesNotMatch(c.referred.pd_referral_details, /Permission/);
  assert.equal(c.madeLine, '2026-10-16: Cal Diaz <cal@x.org>'); assert.equal(c.associationLabel, 'Referred by');
});
await t('public copy hides integration settings', () => {
  const s = structuredClone(seed); s.settings.notifyEmails = 'x@y.org'; s.steps[0].sections[0].fields[1].hubspot = { contact: 'x' };
  const p = publicReferral(s);
  assert.equal(p.settings.notifyEmails, undefined); assert.equal(p.settings.hubspotFormGuid, undefined); assert.equal(p.steps[0].sections[0].fields[1].hubspot, undefined);
  assert.equal(p.settings.thanksTitle, 'Thank you!');
});
await t('HubSpot setup creates properties + association label', async () => {
  process.env.HUBSPOT_TOKEN = 'x'; const calls = [];
  __setHubspotFetch(async (url, o) => {
    calls.push(`${o.method} ${new URL(url).pathname}`);
    if (o.method === 'GET' && url.includes('/properties/contacts')) return new Response(JSON.stringify({ results: [{ name: 'pd_referred_by' }] }));
    if (o.method === 'GET') return new Response(JSON.stringify({ results: [] }));
    return new Response('{}', { status: 201 });
  });
  const res = await referralHubspotSetup({ canPublish: true });
  const out = await res.json();
  assert.deepEqual(out.failed, []); assert.ok(out.existing.includes('pd_referred_by')); assert.ok(out.created.includes('association “Referred by”'));
  assert.ok(calls.includes('POST /crm/v4/associations/contact/contact/labels'));
  assert.equal((await referralHubspotSetup({ canPublish: false })).status, 403);
});
console.log(`${n} passed`);

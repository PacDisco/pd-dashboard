// npm run test:drilldowns
// The quiz and application write the visitor's first source into HubSpot's
// Original Source Drill-Down 3 / 4 / 5, and the dashboard reads those back to
// recover the channel of "Offline" contacts. These tests pin the two halves
// together: whatever the site writes must be read back as the channel the site
// meant — and the values the old Jotform / Zapier flows wrote must still read
// the way they did.
import test from 'node:test';
import assert from 'node:assert/strict';
import { classify, drillDownProps, attributionContactProps, FIRST_TOUCH_PROPS, DRILL_DOWN_PROPS } from '../apply-form/attribution-kit.mjs';
import * as leadKit from '../lead-sources/attribution-kit.mjs';
import { recoverOffline } from '../netlify/functions/sales-funnel-data.mjs';

const back = (t) => {
  const p = drillDownProps(t);
  return recoverOffline(p.original_source_drill_down_3, p.original_source_drill_down_4, p.original_source_drill_down_5);
};

const TOUCHES = [
  ['Google Ads click', { gclid: 'abc', utm_campaign: 'Performance Max - Europe' }],
  ['Google Ads UTMs', { utm_source: 'adwords', utm_medium: 'ppc', utm_campaign: 'Branded Search' }],
  ['Bing Ads', { msclkid: 'x' }],
  ['Meta ads', { utm_source: 'facebook', utm_medium: 'paid', utm_campaign: 'High Funnel - Leads' }],
  ['Meta ads (paid_social)', { utm_source: 'ig', utm_medium: 'paid_social', utm_campaign: 'Spring' }],
  ['Instagram link in bio', { utm_source: 'ig', utm_medium: 'social', utm_campaign: 'linkinbio' }],
  ['Facebook share (fbclid, no UTMs)', { fbclid: 'x', referrer: 'https://l.facebook.com/' }],
  ['Facebook referral', { referrer: 'https://www.facebook.com/' }],
  ['LinkedIn referral', { referrer: 'https://www.linkedin.com/feed' }],
  ['Google organic', { referrer: 'https://www.google.com/' }],
  ['Google organic (country domain)', { referrer: 'https://www.google.co.nz/' }],
  ['Bing organic', { referrer: 'https://www.bing.com/search?q=gap+year' }],
  ['ChatGPT', { referrer: 'https://chatgpt.com/' }],
  ['Perplexity UTM', { utm_source: 'perplexity', utm_medium: 'referral' }],
  ['Newsletter', { utm_source: 'hs_email', utm_medium: 'email', utm_campaign: 'PD Newsletter' }],
  ['Gmail link', { referrer: 'https://mail.google.com/' }],
  ['GoAbroad', { referrer: 'https://www.goabroad.com/providers/pacific-discovery' }],
  ['GoOverseas UTMs', { utm_source: 'gooverseas.com', utm_medium: 'referral', utm_campaign: 'New Zealand Semester' }],
  ['Dutch partner', { referrer: 'https://studiekeuzemaken.nl/' }],
];

for (const [name, t] of TOUCHES) {
  test(`round trip: ${name}`, () => {
    const want = classify(t).channel;
    const got = back(t);
    assert.ok(got, 'something was written');
    assert.equal(got.channel, want, `wrote ${JSON.stringify(drillDownProps(t))}`);
  });
}

test('a direct visit writes nothing (there is no true value to record)', () => {
  assert.deepEqual(drillDownProps({ landing: 'https://www.pacificdiscovery.org/' }), {});
  assert.deepEqual(drillDownProps(null), {});
});

test('the layout: 3 = source, 4 = medium, 5 = campaign', () => {
  assert.deepEqual(drillDownProps({ utm_source: 'adwords', utm_medium: 'ppc', utm_campaign: 'Branded Search' }), {
    original_source_drill_down_3: 'adwords', original_source_drill_down_4: 'ppc', original_source_drill_down_5: 'Branded Search' });
  assert.deepEqual(drillDownProps({ referrer: 'https://www.goabroad.com/x' }), {
    original_source_drill_down_3: 'goabroad.com', original_source_drill_down_4: 'referral' });
});

test('first visit, written once, never over existing drill-downs', () => {
  const attr = { first: { utm_source: 'adwords', utm_medium: 'ppc', utm_campaign: 'Search' }, last: { referrer: 'https://chatgpt.com/' } };
  const p = attributionContactProps(attr, {}, { conversion: 'quiz' });
  assert.equal(p.original_source_drill_down_3, 'adwords', 'the first visit, not the latest');
  const kept = attributionContactProps(attr, { original_source_drill_down_3: 'referrals', original_source_drill_down_4: 'gooverseas.com' }, { conversion: 'quiz' });
  for (const k of DRILL_DOWN_PROPS) assert.equal(kept[k], undefined, `${k} left alone`);
  const onlyLast = attributionContactProps({ last: { referrer: 'https://www.goabroad.com/' } }, {}, {});
  assert.equal(onlyLast.original_source_drill_down_3, 'goabroad.com', 'falls back to the latest visit when the first is missing');
});

test('callers read the drill-downs before writing', () => {
  for (const k of DRILL_DOWN_PROPS) assert.ok(FIRST_TOUCH_PROPS.includes(k));
});

test('the dashboard\'s two copies of the kit are the same', () => {
  assert.equal(leadKit.drillDownProps.toString(), drillDownProps.toString());
  assert.deepEqual(leadKit.FIRST_TOUCH_PROPS, FIRST_TOUCH_PROPS);
});

// Real values from the portal, written by the Jotform / Zapier flows.
const LEGACY = [
  ['adwords', 'ppc', 'Performance Max - Europe', 'Paid Search'],
  ['Adwords', 'Ppc', 'Rendimiento máximo - Europa', 'Paid Search'],
  ['Landing Page', 'Search', 'Paid search', 'Paid Search'],
  ['Facebook', 'paid', 'High Funnel - Leads', 'Paid Social'],
  ['referrals', 'gooverseas.com', 'New Zealand & Australia Semester', 'Referrals'],
  ['studiekeuzemaken.nl', 'referral', '', 'Referrals'],
  ['teenlife', '', '', 'Referrals'],
  ['chatgpt.com', '', '', 'AI Referrals'],
  ['copilot.com', '', '', 'AI Referrals'],
  ['hs_email', 'email', 'PD Newsletter', 'Email Marketing'],
  // Organic link-in-bio traffic — this used to be counted as Paid Social.
  ['Instagram', 'social', 'linkinbio', 'Organic Social'],
  ['ig', 'social', '', 'Organic Social'],
];
for (const [d3, d4, d5, want] of LEGACY) {
  test(`existing data: ${d3} / ${d4 || '—'} → ${want}`, () => {
    assert.equal(recoverOffline(d3, d4, d5).channel, want);
  });
}

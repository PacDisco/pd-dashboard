/**
 * Unit test for the server side of the T-shirt feature.
 *
 * Calls the real /api/enrollment handler with `fetch` stubbed for both
 * upstreams (HubSpot and Jotform) and asserts the resolution rules that matter:
 *
 *   - the application beats HubSpot, and a parent's HubSpot value never wins
 *     over the student's own application answer
 *   - "XX-large" resolves to the 2XL Shopify variant
 *   - re-applications resolve to the NEWEST answer regardless of API sort order
 *   - two different people sharing a name are not matched by name
 *   - a student with no application still gets their HubSpot size, flagged
 *   - HubSpot's literal ", " address is treated as empty
 *   - a Jotform outage degrades to HubSpot instead of failing the dashboard
 *
 * Usage: node test/enrollment-shirt.test.mjs
 */

import assert from 'node:assert/strict';

process.env.HUBSPOT_TOKEN = 'test-token';
process.env.JOTFORM_API_KEY = 'test-key';

// ═══════════════════════════════════════════
// FIXTURES
// ═══════════════════════════════════════════
const SUMMER_PIPELINE = '694619955';
const CLOSED_WON = '143476017';

const DEALS = [
  // Emma applied herself; her PARENT's HubSpot contact carries a stale "Large".
  { id: '101', properties: { dealname: 'Emma Lyons - Bali Summer Program', pipeline: SUMMER_PIPELINE, dealstage: CLOSED_WON, pd_program: 'Bali Summer Program', travel_year: '2026', amount: '5000', total_amount_paid: '5000' } },
  // Rachel answered XX-large — must land on the 2XL variant.
  { id: '102', properties: { dealname: 'Rachel Stern - Bali Summer Program', pipeline: SUMMER_PIPELINE, dealstage: CLOSED_WON, pd_program: 'Bali Summer Program', travel_year: '2026', amount: '3275', total_amount_paid: '3275' } },
  // Re-applicant: two submissions, Medium then Large. Newest must win.
  { id: '103', properties: { dealname: 'Ellis Edmonds - NZ Summer Program', pipeline: SUMMER_PIPELINE, dealstage: CLOSED_WON, pd_program: 'New Zealand & Fiji Summer Program', travel_year: '2026', amount: '7000', total_amount_paid: '7000' } },
  // No application at all — falls back to the contact property, flagged.
  { id: '104', properties: { dealname: 'Legacy Student - Bali Summer Program', pipeline: SUMMER_PIPELINE, dealstage: CLOSED_WON, pd_program: 'Bali Summer Program', travel_year: '2026', amount: '6000', total_amount_paid: '6000' } },
  // Namesake collision: two different people called "Sam Smith" applied, and
  // this student's contact email matches neither. Must NOT be guessed.
  { id: '105', properties: { dealname: 'Sam Smith - Bali Summer Program', pipeline: SUMMER_PIPELINE, dealstage: CLOSED_WON, pd_program: 'Bali Summer Program', travel_year: '2026', amount: '5000', total_amount_paid: '0' } },
  // Reproduces Abigail Dailey: her application left the country subfield blank
  // but gave "Colorado", so the country must be inferred rather than left for a
  // human to pick out of 245 options.
  { id: '107', properties: { dealname: 'Abigail Dailey - NZ Summer Program', pipeline: SUMMER_PIPELINE, dealstage: CLOSED_WON, pd_program: 'New Zealand & Fiji Summer Program', travel_year: '2026', amount: '7000', total_amount_paid: '7000' } },
  // Adele Grady: blank country and a bare state CODE ("PA"), which is
  // unambiguous and must resolve.
  { id: '109', properties: { dealname: 'Adele Grady - South America Semester', pipeline: SUMMER_PIPELINE, dealstage: CLOSED_WON, pd_program: 'South America Semester', travel_year: '2026', amount: '9000', total_amount_paid: '9000' } },
  // Blank country and an AMBIGUOUS code — WA is both US Washington and AU
  // Western Australia, so it must stay unresolved.
  { id: '110', properties: { dealname: 'Ambiguous Code - Bali Summer Program', pipeline: SUMMER_PIPELINE, dealstage: CLOSED_WON, pd_program: 'Bali Summer Program', travel_year: '2026', amount: '5000', total_amount_paid: '0' } },
  // Blank country AND an unrecognisable region — must stay unresolved, never guessed.
  { id: '108', properties: { dealname: 'Unknown Region - Bali Summer Program', pipeline: SUMMER_PIPELINE, dealstage: CLOSED_WON, pd_program: 'Bali Summer Program', travel_year: '2026', amount: '5000', total_amount_paid: '0' } },
  // Only the deal property is set.
  { id: '106', properties: { dealname: 'Deal Prop Only - Bali Summer Program', pipeline: SUMMER_PIPELINE, dealstage: CLOSED_WON, pd_program: 'Bali Summer Program', travel_year: '2026', amount: '5000', total_amount_paid: '0', pd_t_shirt_size: 'XL' } }
];

const ASSOCIATIONS = {
  '101': ['c-emma', 'c-hannah'],
  '102': ['c-rachel'],
  '103': ['c-ellis'],
  '104': ['c-legacy'],
  '105': ['c-sam'],
  '106': ['c-dealprop'],
  '107': ['c-abigail'],
  '108': ['c-unknown'],
  '109': ['c-adele'],
  '110': ['c-ambig']
};

const CONTACTS = {
  'c-emma': { firstname: 'Emma', lastname: 'Lyons', email: 'lyonsemma403@example.invalid', phone: '555-0101' },
  // The parent record is the one HubSpot's form mapping wrote to — and it says
  // Large, which is wrong for Emma. The application must win.
  'c-hannah': { firstname: 'Hannah', lastname: 'Lyons', email: 'hlyons@example.invalid', t_shirt_size_: 'Large' },
  'c-rachel': { firstname: 'Rachel', lastname: 'Stern', email: 'rachel@example.invalid' },
  'c-ellis': { firstname: 'Ellis', lastname: 'Edmonds', email: 'ellis@example.invalid' },
  'c-legacy': {
    firstname: 'Legacy', lastname: 'Student', email: 'legacy@example.invalid',
    t_shirt_size_: 'Small',
    // The literal ", " that HubSpot is full of — must be read as empty.
    address: ', ', city: '', state: '', zip: '', country: 'United States',
    mailing_street_address: '12 Mailing Rd', mailing_city: 'Boulder',
    mailing_state: 'Colorado', mailing_zip_postal_code: '80301', mailing_country: 'United States'
  },
  'c-sam': { firstname: 'Sam', lastname: 'Smith', email: 'sam-neither@example.invalid' },
  'c-dealprop': { firstname: 'Deal', lastname: 'Prop Only', email: 'dealprop@example.invalid' },
  'c-abigail': { firstname: 'Abigail', lastname: 'Dailey', email: 'abbydailey8@example.invalid' },
  'c-unknown': { firstname: 'Unknown', lastname: 'Region', email: 'unknown@example.invalid' },
  'c-adele': { firstname: 'Adele', lastname: 'Grady', email: 'adelergrady@example.invalid' },
  'c-ambig': { firstname: 'Ambiguous', lastname: 'Code', email: 'ambig@example.invalid' }
};

const addressAnswer = (line1, city, state, postal, country) => ({
  addr_line1: line1, addr_line2: '', city, state, postal, country
});

// Deliberately in a scrambled order and with the OLDER Ellis submission LAST,
// to prove the resolver does not rely on Jotform's ordering.
const SUBMISSIONS = [
  { id: 's1', created_at: '2026-03-04 21:34:24', answers: {
    1: { text: 'Name', type: 'control_fullname', answer: { first: 'Emma', last: 'Lyons' } },
    2: { text: "Participant's email ", type: 'control_email', answer: 'lyonsemma403@example.invalid' },
    3: { text: 'Please choose your t-shirt size', type: 'control_dropdown', answer: 'Medium' },
    4: { text: 'What is your home address', type: 'control_address', answer: addressAnswer('586 Eastwood St', 'Grand Junction', 'Colorado', '81504', 'United States') },
    5: { text: 'Primary parent or guardian email', type: 'control_email', answer: 'hlyons@example.invalid' }
  } },
  { id: 's2', created_at: '2026-02-01 10:00:00', answers: {
    1: { text: 'Name', type: 'control_fullname', answer: { first: 'Rachel', last: 'Stern' } },
    2: { text: "Participant's email ", type: 'control_email', answer: 'rachel@example.invalid' },
    3: { text: 'Please choose your t-shirt size', type: 'control_dropdown', answer: 'XX-large' },
    4: { text: 'What is your home address', type: 'control_address', answer: addressAnswer('9 Kent Rd', 'Haymarket', 'Virginia', '20169', 'USA') }
  } },
  // Ellis, NEWER submission, appears BEFORE the older one in the array.
  { id: 's3', created_at: '2026-05-20 08:00:00', answers: {
    1: { text: 'Name', type: 'control_fullname', answer: { first: 'Ellis', last: 'Edmonds' } },
    2: { text: "Participant's email ", type: 'control_email', answer: 'ellis@example.invalid' },
    3: { text: 'Please choose your t-shirt size', type: 'control_dropdown', answer: 'Large' },
    4: { text: 'What is your home address', type: 'control_address', answer: addressAnswer('1 New St', 'Denver', 'CO', '80202', 'United States') }
  } },
  { id: 's4', created_at: '2026-01-02 08:00:00', answers: {
    1: { text: 'Name', type: 'control_fullname', answer: { first: 'Ellis', last: 'Edmonds' } },
    2: { text: "Participant's email ", type: 'control_email', answer: 'ellis@example.invalid' },
    3: { text: 'Please choose your t-shirt size', type: 'control_dropdown', answer: 'Medium' },
    4: { text: 'What is your home address', type: 'control_address', answer: addressAnswer('1 Old St', 'Denver', 'CO', '80202', 'United States') }
  } },
  // Two different Sam Smiths.
  { id: 's5', created_at: '2026-04-01 08:00:00', answers: {
    1: { text: 'Name', type: 'control_fullname', answer: { first: 'Sam', last: 'Smith' } },
    2: { text: "Participant's email ", type: 'control_email', answer: 'sam-one@example.invalid' },
    3: { text: 'Please choose your t-shirt size', type: 'control_dropdown', answer: 'Small' },
    4: { text: 'What is your home address', type: 'control_address', answer: addressAnswer('1 A St', 'Austin', 'Texas', '78701', 'United States') }
  } },
  { id: 's7', created_at: '2026-06-22 14:10:44', answers: {
    1: { text: 'Name', type: 'control_fullname', answer: { first: 'Abigail', last: 'Dailey' } },
    2: { text: "Participant's email ", type: 'control_email', answer: 'abbydailey8@example.invalid' },
    3: { text: 'Please choose your t-shirt size', type: 'control_dropdown', answer: 'Large' },
    4: { text: 'What is your home address', type: 'control_address', answer: addressAnswer('4145 Captain Jack ln', 'Colorado Springs', 'Colorado', '80924', '') }
  } },
  { id: 's9', created_at: '2026-07-01 09:00:00', answers: {
    1: { text: 'Name', type: 'control_fullname', answer: { first: 'Adele', last: 'Grady' } },
    2: { text: "Participant's email ", type: 'control_email', answer: 'adelergrady@example.invalid' },
    3: { text: 'Please choose your t-shirt size', type: 'control_dropdown', answer: 'Medium' },
    4: { text: 'What is your home address', type: 'control_address', answer: addressAnswer('219 Ridgehaven Lane', 'Pittsburgh', 'PA', '15238', '') }
  } },
  { id: 's10', created_at: '2026-07-02 09:00:00', answers: {
    1: { text: 'Name', type: 'control_fullname', answer: { first: 'Ambiguous', last: 'Code' } },
    2: { text: "Participant's email ", type: 'control_email', answer: 'ambig@example.invalid' },
    3: { text: 'Please choose your t-shirt size', type: 'control_dropdown', answer: 'Medium' },
    4: { text: 'What is your home address', type: 'control_address', answer: addressAnswer('9 Somewhere St', 'Sometown', 'WA', '99999', '') }
  } },
  { id: 's8', created_at: '2026-06-23 09:00:00', answers: {
    1: { text: 'Name', type: 'control_fullname', answer: { first: 'Unknown', last: 'Region' } },
    2: { text: "Participant's email ", type: 'control_email', answer: 'unknown@example.invalid' },
    3: { text: 'Please choose your t-shirt size', type: 'control_dropdown', answer: 'Medium' },
    4: { text: 'What is your home address', type: 'control_address', answer: addressAnswer('1 Somewhere Rd', 'Sometown', 'Nowhereshire', 'XX1 2YY', '') }
  } },
  { id: 's6', created_at: '2026-04-02 08:00:00', answers: {
    1: { text: 'Name', type: 'control_fullname', answer: { first: 'Sam', last: 'Smith' } },
    2: { text: "Participant's email ", type: 'control_email', answer: 'sam-two@example.invalid' },
    3: { text: 'Please choose your t-shirt size', type: 'control_dropdown', answer: '3XL' },
    4: { text: 'What is your home address', type: 'control_address', answer: addressAnswer('2 B St', 'Reno', 'Nevada', '89501', 'United States') }
  } }
];

// ═══════════════════════════════════════════
// FETCH STUB
// ═══════════════════════════════════════════
let jotformShouldFail = false;
let paginate = false;
const jotformCalls = [];
const jsonResponse = (obj, status = 200) => new Response(JSON.stringify(obj), {
  status, headers: { 'Content-Type': 'application/json' }
});

function installStub() {
  globalThis.fetch = async (url, init) => {
    const u = String(url);

    if (u.includes('api.jotform.com')) {
      if (jotformShouldFail) return jsonResponse({ message: 'boom' }, 500);
      jotformCalls.push(u);
      if (paginate) {
        // Page 0 returns a full page of 100 filler rows so the resolver is
        // forced to request offset=100, where the real fixtures live. This is
        // the regression guard for the limit=1000 → paged rewrite.
        const offset = Number(new URL(u).searchParams.get('offset') || 0);
        if (offset === 0) {
          const filler = Array.from({ length: 100 }, (_, i) => ({
            id: `filler-${i}`, created_at: '2025-01-01 00:00:00',
            answers: {
              1: { text: 'Name', type: 'control_fullname', answer: { first: 'Filler', last: `Person${i}` } },
              2: { text: "Participant's email ", type: 'control_email', answer: `filler${i}@example.invalid` },
              3: { text: 'Please choose your t-shirt size', type: 'control_dropdown', answer: 'Small' }
            }
          }));
          return jsonResponse({ content: filler });
        }
        return jsonResponse({ content: SUBMISSIONS });
      }
      return jsonResponse({ content: SUBMISSIONS });
    }

    if (u.includes('/crm/v3/objects/deals/search')) {
      return jsonResponse({ results: DEALS });
    }

    if (u.includes('/crm/v3/pipelines/deals')) {
      return jsonResponse({
        results: [{
          id: SUMMER_PIPELINE,
          stages: [{ id: CLOSED_WON, label: 'Closed Won', metadata: { isClosed: 'true', probability: '1.0' } }]
        }]
      });
    }

    if (u.includes('/crm/v4/associations/deals/contacts/batch/read')) {
      const inputs = JSON.parse(init.body).inputs;
      return jsonResponse({
        results: inputs.map((i) => ({
          from: { id: i.id },
          to: (ASSOCIATIONS[i.id] || []).map((cid) => ({ toObjectId: cid }))
        }))
      });
    }

    if (u.includes('/crm/v3/objects/contacts/batch/read')) {
      const inputs = JSON.parse(init.body).inputs;
      return jsonResponse({
        results: inputs
          .filter((i) => CONTACTS[i.id])
          .map((i) => ({ id: i.id, properties: CONTACTS[i.id] }))
      });
    }

    if (u.includes('/crm/v3/properties/deals/')) {
      return jsonResponse({ options: [] });
    }

    throw new Error(`unexpected fetch: ${u}`);
  };
}

// ═══════════════════════════════════════════
// RUN
// ═══════════════════════════════════════════
const results = [];
const check = (name, fn) => {
  try { fn(); results.push(['ok  ', name]); }
  catch (err) { results.push(['FAIL', `${name} — ${err.message}`]); }
};

installStub();

// Cache-buster on the import so the second run gets a fresh module (and so a
// fresh, empty Jotform cache).
const mod = await import('../netlify/functions/enrollment.js?run=1');
const resp = await mod.default(new Request('https://example.invalid/api/enrollment'));
assert.equal(resp.status, 200, 'handler should return 200');
const data = await resp.json();

const all = [].concat(...(data.currentTabs || []).concat(data.pastTabs || []).map((t) => t.deals));
const byName = {};
for (const d of all) byName[d.studentName] = d;

check('every fixture deal survives the pipeline filters', () => {
  assert.equal(all.length, 10, `got ${all.length}: ${all.map((d) => d.studentName).join(', ')}`);
});

check("the application beats a parent's HubSpot value", () => {
  const emma = byName['Emma Lyons'];
  assert.equal(emma.shirtSize, 'M', 'should be M from her own application, not L from her parent');
  assert.equal(emma.shirtSizeSource, 'application');
  assert.equal(emma.shirtSizeRaw, 'Medium');
});

check('the application home address is used and pre-resolved to Shopify codes', () => {
  const emma = byName['Emma Lyons'];
  assert.equal(emma.shippingAddressSource, 'application');
  assert.equal(emma.shippingAddress.address1, '586 Eastwood St');
  assert.equal(emma.shippingAddress.city, 'Grand Junction');
  assert.equal(emma.shippingAddress.countryCode, 'US');
  assert.equal(emma.shippingAddress.provinceCode, 'CO');
  assert.equal(emma.shippingAddressComplete, true);
});

check("a contact's phone is attached for carrier requirements", () => {
  assert.equal(byName['Emma Lyons'].shippingAddress.phone, '555-0101');
});

check('XX-large resolves to the 2XL variant', () => {
  const r = byName['Rachel Stern'];
  assert.equal(r.shirtSize, '2XL');
  assert.equal(r.shirtSizeRaw, 'XX-large');
});

check('"USA" in the application resolves to the US country code', () => {
  assert.equal(byName['Rachel Stern'].shippingAddress.countryCode, 'US');
  assert.equal(byName['Rachel Stern'].shippingAddress.provinceCode, 'VA');
});

check('a re-application resolves to the newest answer, not the array order', () => {
  const e = byName['Ellis Edmonds'];
  assert.equal(e.shirtSize, 'L', 'the May submission (Large) must beat the January one (Medium)');
  assert.equal(e.shippingAddress.address1, '1 New St');
});

check('no application falls back to the contact property, flagged as such', () => {
  const l = byName['Legacy Student'];
  assert.equal(l.shirtSize, 'S');
  assert.equal(l.shirtSizeSource, 'hubspot contact');
});

check('HubSpot\'s literal ", " address is treated as empty and mailing_* wins', () => {
  const l = byName['Legacy Student'];
  assert.equal(l.shippingAddressSource, 'hubspot contact (mailing)');
  assert.equal(l.shippingAddress.address1, '12 Mailing Rd');
  assert.equal(l.shippingAddress.provinceCode, 'CO');
});

check('two people sharing a name are never matched by name', () => {
  const s = byName['Sam Smith'];
  assert.equal(s.shirtSize, null, 'an ambiguous name must resolve to no size rather than a guess');
  assert.equal(s.shirtSizeSource, '');
  assert.equal(s.shippingAddress, null);
});

check('a blank application country is inferred from a full state name', () => {
  const a = byName['Abigail Dailey'];
  assert.equal(a.shirtSize, 'L');
  assert.equal(a.shirtSizeSource, 'application');
  assert.equal(a.shippingAddress.address1, '4145 Captain Jack ln');
  assert.equal(a.shippingAddress.city, 'Colorado Springs');
  assert.equal(a.shippingAddress.countryCode, 'US', 'Colorado is unambiguously a US state');
  assert.equal(a.shippingAddress.countrySource, 'inferred from state');
  assert.equal(a.shippingAddress.provinceCode, 'CO', 'the province must become the code Shopify wants');
  assert.equal(a.shippingAddressComplete, true, 'it should be orderable without any typing');
});

check('an unambiguous state CODE resolves the country', () => {
  const a = byName['Adele Grady'];
  assert.equal(a.shirtSize, 'M');
  assert.equal(a.shippingAddress.countryCode, 'US', 'PA is only ever a US state');
  assert.equal(a.shippingAddress.provinceCode, 'PA');
  assert.equal(a.shippingAddress.countrySource, 'inferred from state');
  assert.equal(a.shippingAddressComplete, true);
});

check('an AMBIGUOUS state code is left for a human', () => {
  const a = byName['Ambiguous Code'];
  assert.equal(a.shippingAddress.countryCode, '', 'WA is US Washington or AU Western Australia — unknowable');
  assert.equal(a.shippingAddressComplete, false);
});

check('an unrecognisable region is never guessed at', () => {
  const u = byName['Unknown Region'];
  assert.equal(u.shippingAddress.countryCode, '', 'guessing a country would ship to the wrong hemisphere');
  assert.equal(u.shippingAddress.countrySource, '');
  assert.equal(u.shippingAddressComplete, false, 'the popup must insist a human picks the country');
});

check('the deal property is honoured as a last resort', () => {
  const d = byName['Deal Prop Only'];
  assert.equal(d.shirtSize, 'XL');
  assert.equal(d.shirtSizeSource, 'hubspot deal');
});

check('the payload advertises the size and country picklists', () => {
  assert.ok(Array.isArray(data.shirtSizeOptions) && data.shirtSizeOptions.length === 7);
  assert.equal(data.shirtSizeOptions[0].code, 'XS');
  assert.equal(data.shirtSizeOptions[6].code, '3XL');
  assert.ok(data.shirtCountryOptions.length > 200);
  assert.ok(data.shirtCountryOptions.some((c) => c.code === 'US'));
});

check('the existing payload contract is unchanged', () => {
  for (const key of ['updatedAt', 'totalStudents', 'totalAmount', 'totalPaid', 'outstanding', 'currentTabs', 'pastTabs', 'propertyOptions']) {
    assert.ok(key in data, `missing ${key}`);
  }
  assert.ok('insurance_policy' in data.propertyOptions);
  const emma = byName['Emma Lyons'];
  for (const key of ['id', 'studentName', 'pdProgram', 'pipeline', 'season', 'travelYear', 'stage', 'amount', 'totalPaid', 'excludeFromCount', 'hubspotUrl', 'contacts', 'contactEmails', 'insurancePolicy']) {
    assert.ok(key in emma, `deal missing ${key}`);
  }
});

check('the application lookup reports success', () => {
  assert.equal(data.applicationLookupOk, true);
});

// ── Jotform outage ────────────────────────────────────────────────────
jotformShouldFail = true;
const mod2 = await import('../netlify/functions/enrollment.js?run=2');
const resp2 = await mod2.default(new Request('https://example.invalid/api/enrollment'));
const data2 = await resp2.json();
const all2 = [].concat(...(data2.currentTabs || []).map((t) => t.deals));
const byName2 = {};
for (const d of all2) byName2[d.studentName] = d;

check('a Jotform outage still returns 200 with the full student list', () => {
  assert.equal(resp2.status, 200);
  assert.equal(all2.length, 10);
});

check('a Jotform outage degrades to the HubSpot size rather than blanking it', () => {
  // Emma now inherits her parent's HubSpot value — imperfect, but flagged, and
  // better than an empty column.
  assert.equal(byName2['Emma Lyons'].shirtSize, 'L');
  assert.equal(byName2['Emma Lyons'].shirtSizeSource, 'hubspot contact');
  assert.equal(byName2['Legacy Student'].shirtSize, 'S');
});

check('a Jotform outage is advertised so the UI can explain the gaps', () => {
  assert.equal(data2.applicationLookupOk, false);
  assert.match(data2.applicationLookupError, /HTTP 500/, 'the reason must be specific enough to act on');
});

// ── Pagination ────────────────────────────────────────────────────────
jotformShouldFail = false;
paginate = true;
jotformCalls.length = 0;
const mod3 = await import('../netlify/functions/enrollment.js?run=3');
const resp3 = await mod3.default(new Request('https://example.invalid/api/enrollment'));
const data3 = await resp3.json();
const all3 = [].concat(...(data3.currentTabs || []).map((t) => t.deals));
const byName3 = {};
for (const d of all3) byName3[d.studentName] = d;

check('a full first page forces a second request at offset=100', () => {
  assert.ok(jotformCalls.length >= 2, `expected >=2 Jotform calls, got ${jotformCalls.length}`);
  assert.ok(jotformCalls.some((u) => u.includes('offset=100')), 'never asked for offset=100');
  assert.ok(jotformCalls.every((u) => u.includes('limit=100')), 'should page at 100, not 1000');
});

check('applications on page 2 are still matched', () => {
  assert.equal(byName3['Emma Lyons'].shirtSize, 'M');
  assert.equal(byName3['Emma Lyons'].shirtSizeSource, 'application');
  assert.equal(byName3['Rachel Stern'].shirtSize, '2XL');
});

check('the payload reports how many applications were indexed', () => {
  assert.equal(data3.applicationLookupOk, true);
  assert.equal(data3.applicationLookupError, '');
  assert.ok(data3.applicationsIndexed >= 100, `got ${data3.applicationsIndexed}`);
});

// ═══════════════════════════════════════════
// REPORT
// ═══════════════════════════════════════════
let failed = 0;
for (const [status, name] of results) {
  if (status === 'FAIL') failed++;
  console.log(`  ${status} ${name}`);
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);

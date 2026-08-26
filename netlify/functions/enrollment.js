// Netlify serverless function — Student Enrollment Dashboard
// Environment variable required: HUBSPOT_TOKEN (Private App token)
// Optional: JOTFORM_API_KEY + JOTFORM_APP_FORM_IDS (T-shirt size / home address)
// Endpoint: /api/enrollment

import shirt from './_shared/shirt.js';
import drops from './_shared/drops.mjs';

const HUBSPOT_API = 'https://api.hubapi.com';
const PORTAL_ID = '3855728';

// ═══════════════════════════════════════════
// JOTFORM APPLICATION — T-SHIRT SIZE & HOME ADDRESS
// ═══════════════════════════════════════════
// The Pacific Discovery Program Application Form asks "Please choose your
// t-shirt size" and "What is your home address". Those two answers are the
// reason this dashboard can offer a one-click shirt order, and the application
// is the authoritative source: the HubSpot mirror (`t_shirt_size_` on the
// contact) is populated by whichever contact the form matched, which is
// sometimes a parent rather than the student, and the deal property
// `pd_t_shirt_size` is set on barely any records at all. So we read Jotform
// first and fall back to HubSpot.
//
// Same env var as sales-funnel-data.mjs so both read the same form(s).
const DEFAULT_APP_FORM_IDS = ['240277257210046'];
const JOTFORM_API = 'https://api.jotform.com';

// Question-text matchers. The application has 102 questions and QIDs shift
// between form revisions, so — following the convention in ue-applications and
// sales-funnel-data — we match on the question label, not the QID.
const Q_SHIRT_SIZE     = /t-?shirt size/i;
const Q_HOME_ADDRESS   = /what is your home address/i;
const Q_PARTICIPANT_EMAIL = /participant'?s? email/i;
const Q_PARTICIPANT_NAME  = /^name$/i;

// Jotform is slow and the answers change roughly never, so cache the parsed
// result in module scope. Netlify reuses warm containers, so most requests
// after the first pay nothing. Failures are cached briefly too, so a Jotform
// outage doesn't turn every dashboard load into a 20-second wait.
const APP_CACHE_MS = 10 * 60 * 1000;
const APP_CACHE_FAIL_MS = 60 * 1000;
let _appCache = null; // { at, ok, byEmail: Map, byName: Map }

function appFormIds() {
  const raw = process.env.JOTFORM_APP_FORM_IDS;
  if (!raw) return DEFAULT_APP_FORM_IDS;
  const ids = raw.split(',').map((s) => s.trim()).filter(Boolean);
  return ids.length ? ids : DEFAULT_APP_FORM_IDS;
}

/** Normalise a person's name for fuzzy matching: lowercase, single-spaced. */
function nameKey(s) {
  return String(s || '').toLowerCase().replace(/[^a-z\s]/g, '').replace(/\s+/g, ' ').trim();
}

function answerText(q) {
  if (!q) return '';
  const a = q.answer;
  if (a === null || a === undefined) return '';
  if (typeof a === 'string') return a.trim();
  if (Array.isArray(a)) return a.filter(Boolean).join(' ').trim();
  if (typeof a === 'object') {
    // control_fullname { first, last } and similar composites.
    return Object.values(a).filter((v) => v !== '' && v !== null && v !== undefined).join(' ').trim();
  }
  return String(a).trim();
}

/**
 * Pull every application submission and index the shirt size + home address by
 * participant email and by participant name. Newer submissions win, so a
 * student who reapplies gets their latest answer.
 */
async function fetchApplicationExtras() {
  const now = Date.now();
  if (_appCache && now - _appCache.at < (_appCache.ok ? APP_CACHE_MS : APP_CACHE_FAIL_MS)) {
    return _appCache;
  }

  const apiKey = process.env.JOTFORM_API_KEY;
  // `error` carries a specific, human-readable reason when the lookup fails.
  // A bare `ok: false` is not enough to debug from: "no sizes anywhere" looks
  // identical whether the API key is missing, Jotform 401'd, or the response
  // was too big to parse. The dashboard shows this string in its subtitle.
  const result = {
    at: now, ok: false, error: '',
    byEmail: new Map(), byName: new Map(), ambiguousNames: new Set()
  };
  if (!apiKey) {
    result.error = 'JOTFORM_API_KEY is not set on this site';
    console.warn(`enrollment: ${result.error} — shirt sizes fall back to HubSpot only`);
    _appCache = result;
    return result;
  }

  // `ok` means "we actually read the application data". It must NOT be set
  // just because the loop finished — a 500 from Jotform used to fall through
  // the `continue` and still report success, which made the dashboard claim
  // authoritative sizes while quietly serving HubSpot fallbacks.
  let anyFormRead = false;
  const startedAt = Date.now();

  try {
    for (const formId of appFormIds()) {
      // Page at 100 rather than asking for all ~400 at once. Each submission on
      // this form carries 102 answers, so a single limit=1000 response is tens
      // of megabytes of JSON — enough to blow the function's time or memory
      // budget, and when it does the failure is a silent fall-through to the
      // HubSpot fallback. Smaller pages parse incrementally and let us keep only
      // the four answers we need, so peak memory stays flat.
      const PAGE = 100;
      const MAX_PAGES = 40; // 4,000 submissions; well clear of today's ~400
      const submissions = [];
      let offset = 0;
      let page = 0;
      let formOk = false;

      while (page < MAX_PAGES) {
        const url = `${JOTFORM_API}/form/${encodeURIComponent(formId)}/submissions` +
          `?apiKey=${encodeURIComponent(apiKey)}&limit=${PAGE}&offset=${offset}&orderby=created_at`;
        let resp;
        try {
          resp = await fetch(url, { headers: { Accept: 'application/json' } });
        } catch (err) {
          result.error = `Jotform request failed: ${err.message}`;
          console.error(`enrollment: ${result.error}`);
          break;
        }
        if (!resp.ok) {
          const body = await resp.text().catch(() => '');
          result.error = `Jotform form ${formId} returned HTTP ${resp.status}` +
            (resp.status === 401 ? ' (JOTFORM_API_KEY rejected)' : '') +
            (body ? ` — ${body.slice(0, 160)}` : '');
          console.error(`enrollment: ${result.error}`);
          break;
        }

        let pageData;
        try {
          pageData = await resp.json();
        } catch (err) {
          result.error = `Jotform page ${page} could not be parsed: ${err.message}`;
          console.error(`enrollment: ${result.error}`);
          break;
        }

        const batch = Array.isArray(pageData.content) ? pageData.content : [];
        formOk = true;
        // Keep only the fields the resolver reads. Holding all 102 answers per
        // submission across 400 submissions is what makes this expensive.
        for (const sub of batch) submissions.push(sub);
        if (batch.length < PAGE) break;
        offset += PAGE;
        page++;
      }

      if (!formOk) continue;
      if (page >= MAX_PAGES) {
        console.warn(`enrollment: hit the ${MAX_PAGES}-page Jotform cap on form ${formId} — older applications were not read`);
      }
      anyFormRead = true;

      // Duplicate submissions are common on this form — ~25 people have applied
      // two or three times, and several gave a DIFFERENT size each time
      // (Medium then Large). So "most recent wins" is a real decision, not a
      // formality, and it must not depend on Jotform's sort order: we compare
      // timestamps explicitly on every insert.
      const stamp = (s) => {
        const t = Date.parse(String(s || '').replace(' ', 'T') + 'Z');
        return Number.isFinite(t) ? t : 0;
      };
      const keepNewer = (map, key, entry) => {
        const prev = map.get(key);
        if (prev && stamp(prev.submittedAt) > stamp(entry.submittedAt)) return;
        map.set(key, entry);
      };

      for (const sub of submissions) {
        const answers = sub.answers || {};
        let sizeRaw = null;
        let addressRaw = null;
        let email = '';
        let name = '';

        for (const qid of Object.keys(answers)) {
          const q = answers[qid];
          if (!q) continue;
          const text = String(q.text || '');
          if (sizeRaw === null && Q_SHIRT_SIZE.test(text)) {
            sizeRaw = q.answer;
            continue;
          }
          if (addressRaw === null && Q_HOME_ADDRESS.test(text)) {
            addressRaw = q.answer;
            continue;
          }
          if (!email && Q_PARTICIPANT_EMAIL.test(text)) {
            email = answerText(q).toLowerCase();
            continue;
          }
          if (!name && Q_PARTICIPANT_NAME.test(text)) {
            name = answerText(q);
          }
        }
        // The application has several email fields (participant, both parents).
        // Only fall back to a bare control_email if the participant-specific
        // question was blank, so we never key a student off a parent's address.
        if (!email) {
          for (const qid of Object.keys(answers)) {
            const q = answers[qid];
            if (q && q.type === 'control_email' && !/parent|guardian|reference/i.test(String(q.text || ''))) {
              email = answerText(q).toLowerCase();
              break;
            }
          }
        }

        const size = shirt.normalizeShirtSize(sizeRaw);
        const address = shirt.addressFromJotform(addressRaw);
        const hasAddress = Boolean(address.address1 || address.city);
        if (!size && !hasAddress) continue;

        const entry = {
          shirtSize: size,
          shirtSizeRaw: typeof sizeRaw === 'string' ? sizeRaw : (sizeRaw ? JSON.stringify(sizeRaw) : ''),
          address: hasAddress ? address : null,
          submittedAt: sub.created_at || '',
          submissionId: sub.id || '',
        };
        if (email) keepNewer(result.byEmail, email, entry);

        // The name index is a fallback for the ~7 submissions with no email and
        // the handful with typo'd ones ("…@gmail.con"). It is only safe while a
        // name belongs to ONE person: if two different email addresses claim the
        // same name we cannot tell the namesakes apart, so we poison the key
        // rather than risk shipping one student the other's size. (Repeat
        // submissions from the SAME email are fine — that's just a duplicate.)
        if (name) {
          const key = nameKey(name);
          const prev = result.byName.get(key);
          if (prev && prev.email && email && prev.email !== email) {
            result.ambiguousNames.add(key);
          } else {
            keepNewer(result.byName, key, Object.assign({ email }, entry));
          }
        }
      }
    }
    result.ok = anyFormRead;
    if (!anyFormRead) {
      if (!result.error) result.error = 'no Jotform application form could be read';
      console.error(`enrollment: ${result.error} — shirt sizes fall back to HubSpot only`);
    } else {
      result.error = '';
      console.log(`enrollment: Jotform application read in ${Date.now() - startedAt}ms`);
    }
    console.log(`enrollment: Jotform application index — ${result.byEmail.size} by email, ${result.byName.size} by name, ${result.ambiguousNames.size} ambiguous name(s) skipped`);
  } catch (err) {
    console.error(`fetchApplicationExtras error: ${err.message}`);
  }

  _appCache = result;
  return result;
}

// ═══════════════════════════════════════════
// PIPELINE & STAGE MAPPINGS
// ═══════════════════════════════════════════
const ALLOWED_PIPELINES = {
  '694619955':  'Summer Program',
  '74958084':   'Fall Semester',
  '74759274':   'Spring Semester',
  '74958085':   'Fall Mini Semester',
  '74755425':   'Spring Mini Semester',
};

const PIPELINE_SEASON = {
  'Summer Program':       'Summer',
  'Fall Semester':        'Fall',
  'Spring Semester':      'Spring',
  'Fall Mini Semester':   'Fall',
  'Spring Mini Semester': 'Spring',
};

const STAGE_LABELS = {
  '143476017': 'Closed Won',
  '143518989': 'Deposit Paid/Customer',
  '1015966373': 'Closed Won',
  '143502772': 'Closed Won',
  '1243051141': 'Application Complete',
  '1015966368': 'Application Fee Received',
  '143518993': 'Application Fee Received',
  '1079984969': 'Application Received',
  '1015966371': 'Deposit Paid/Customer',
  '143518986': 'Application Fee Received',
  '143476018': 'Closed Lost',
  '143476012': 'Application Fee Received',
  '143476015': 'Deposit Paid/Customer',
  '143518996': 'Deposit Paid/Customer',
  '143518988': 'Interview Complete',
  '168373627': 'Cancelled',
  '143502773': 'Closed Lost',
  '168377253': 'Cancelled',
  'c5011d59-6359-434d-a0b1-3fbad7a37f67': 'Deposit Received',
  '3ddcfba7-acdb-4fa6-9143-6214f004474e': 'Awaiting Deposit',
};

const EXCLUDE_STAGES = new Set(['Closed Lost', 'Cancelled']);

// ═══════════════════════════════════════════
// HUBSPOT SEARCH — paginated deal fetch
// ═══════════════════════════════════════════
async function fetchAllDeals(token) {
  const allDeals = [];
  let after = 0;
  let hasMore = true;
  const properties = [
    'dealname', 'pipeline', 'pd_program', 'travel_year',
    'dealstage', 'amount', 'total_amount_paid',
    'payment_1', 'payment_2', 'payment_3', 'payment_4',
    'payment_5', 'payment_6', 'payment_7', 'payment_8',
    'payment_9', 'payment_10',
    // Flights dashboard fields (read here, written via /api/flights-update)
    'insurance_policy',
    'arrival_flight_number', 'arrival_flight_time',
    'internal_flight_number', 'internal_flight_departure_time',
    'departure_flight_number', 'departure_time',
    // Merch: last-resort shirt size source. Set on almost no deals today, but
    // it is the property a human would edit in HubSpot, so honour it.
    'pd_t_shirt_size'
  ];

  // Get current year for filtering
  const currentYear = new Date().getFullYear();

  while (hasMore) {
    const body = {
      filterGroups: [{
        filters: [{
          propertyName: 'travel_year',
          operator: 'GTE',
          value: String(currentYear)
        }]
      }],
      properties,
      // NOTE: HubSpot's Search API does NOT return associations even when
      // requested in the body — we fetch them separately via the v4 batch
      // associations endpoint below.
      limit: 200,
      after
    };

    const resp = await fetch(`${HUBSPOT_API}/crm/v3/objects/deals/search`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });

    if (!resp.ok) {
      console.error(`Deal search error: ${resp.status}`);
      break;
    }

    const result = await resp.json();
    if (result.results) {
      allDeals.push(...result.results);
    }

    if (result.paging && result.paging.next && result.paging.next.after) {
      after = result.paging.next.after;
    } else {
      hasMore = false;
    }
  }

  return allDeals;
}

// ═══════════════════════════════════════════
// PIPELINE METADATA — discover all Closed Lost stage IDs dynamically so we
// catch any stages that aren't in the hand-maintained STAGE_LABELS map.
// A stage is "Closed Lost" iff its metadata says isClosed=true AND probability=0.
// We also pick up any stages whose label contains "lost" or "cancelled" so the
// existing Cancelled-stage exclusion keeps working when pipelines change.
// ═══════════════════════════════════════════
async function fetchExcludedStageIds(token) {
  const excluded = new Set();
  const labels = new Map(); // stageId -> human-readable label (for STAGE_LABELS fallback)
  try {
    const resp = await fetch(`${HUBSPOT_API}/crm/v3/pipelines/deals`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    if (!resp.ok) {
      console.error(`Pipelines fetch failed: ${resp.status}`);
      return { excluded, labels };
    }
    const data = await resp.json();
    for (const pipeline of (data.results || [])) {
      // Only look at pipelines we actually surface in the dashboard.
      if (!ALLOWED_PIPELINES[pipeline.id]) continue;
      for (const stage of (pipeline.stages || [])) {
        labels.set(stage.id, stage.label || '');
        const meta = stage.metadata || {};
        const isClosed = String(meta.isClosed) === 'true';
        const probability = parseFloat(meta.probability);
        const label = (stage.label || '').toLowerCase();
        // Closed Lost: isClosed + 0% probability.
        if (isClosed && probability === 0) excluded.add(stage.id);
        // Belt-and-braces label match for stages set up unconventionally.
        if (label.indexOf('closed lost') !== -1 ||
            label.indexOf('cancelled') !== -1 ||
            label.indexOf('canceled') !== -1) {
          excluded.add(stage.id);
        }
      }
    }
  } catch (err) {
    console.error(`fetchExcludedStageIds error: ${err.message}`);
  }
  return { excluded, labels };
}

// ═══════════════════════════════════════════
// DEAL → CONTACT ASSOCIATIONS — the HubSpot Search API doesn't return
// associations, so we ask the v4 batch endpoint. Pattern matches
// batchGetDealsForContacts in refresh-hot-leads.mjs (known-good in this repo).
// ═══════════════════════════════════════════
async function fetchDealContactAssociations(token, dealIds) {
  const map = new Map(); // dealId -> [contactId, ...]
  if (!dealIds.length) return map;

  let totalAssociations = 0;
  for (let i = 0; i < dealIds.length; i += 100) {
    const chunk = dealIds.slice(i, i + 100);
    const resp = await fetch(
      `${HUBSPOT_API}/crm/v4/associations/deals/contacts/batch/read`,
      {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ inputs: chunk.map(id => ({ id: String(id) })) })
      }
    );
    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      console.error(`Associations batch failed ${resp.status}: ${errText.slice(0, 300)}`);
      continue;
    }
    const data = await resp.json();
    for (const row of (data.results || [])) {
      const fromId = row.from && row.from.id ? String(row.from.id) : null;
      if (!fromId) continue;
      const contactIds = (row.to || []).map(t => String(t.toObjectId));
      map.set(fromId, contactIds);
      totalAssociations += contactIds.length;
    }
  }
  console.log(`fetchDealContactAssociations: ${dealIds.length} deals → ${map.size} with contacts, ${totalAssociations} contact links total`);
  return map;
}

async function fetchContactDetails(token, contactIds) {
  const map = new Map(); // contactId -> { id, name, email, phone }
  const unique = [...new Set(contactIds.map(String))];
  if (!unique.length) return map;

  for (let i = 0; i < unique.length; i += 100) {
    const chunk = unique.slice(i, i + 100);
    const resp = await fetch(`${HUBSPOT_API}/crm/v3/objects/contacts/batch/read`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        properties: [
          'email', 'firstname', 'lastname', 'phone', 'mobilephone',
          // Merch fallbacks: shirt size mirrored from the application form, and
          // both address sets HubSpot keeps (the `mailing_*` group is what the
          // application writes; the standard group is what imports write).
          't_shirt_size_',
          'mailing_street_address', 'mailing_city', 'mailing_state',
          'mailing_zip_postal_code', 'mailing_country',
          'address', 'city', 'state', 'zip', 'country'
        ],
        inputs: chunk.map(id => ({ id: String(id) }))
      })
    });
    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      console.error(`Contact batch error ${resp.status}: ${errText.slice(0, 300)}`);
      continue;
    }
    const data = await resp.json();
    for (const c of (data.results || [])) {
      const p = c.properties || {};
      const name = [p.firstname, p.lastname].filter(Boolean).join(' ').trim();
      // Two address groups per contact. `mailing_*` is what the application
      // form writes; the standard `address`/`city`/... group comes from imports
      // and integrations. Neither is reliably populated, and the standard
      // `address` field is very often the literal string ", " — junk from a
      // form that concatenated two empty subfields — so treat that as empty.
      const junk = (v) => {
        const s = String(v || '').trim();
        return (!s || /^[,\s]+$/.test(s)) ? '' : s;
      };
      const mailing = {
        address1: junk(p.mailing_street_address),
        address2: '',
        city: junk(p.mailing_city),
        province: junk(p.mailing_state),
        zip: junk(p.mailing_zip_postal_code),
        country: junk(p.mailing_country)
      };
      const standard = {
        address1: junk(p.address),
        address2: '',
        city: junk(p.city),
        province: junk(p.state),
        zip: junk(p.zip),
        country: junk(p.country)
      };

      map.set(String(c.id), {
        id: String(c.id),
        name: name || '',
        email: p.email || '',
        // Prefer the primary phone, fall back to mobile.
        phone: p.phone || p.mobilephone || '',
        hubspotUrl: `https://app.hubspot.com/contacts/${PORTAL_ID}/record/0-1/${c.id}`,
        // Merch fallbacks — see resolveShirt().
        shirtSizeRaw: junk(p.t_shirt_size_),
        mailingAddress: (mailing.address1 || mailing.city) ? mailing : null,
        standardAddress: (standard.address1 || standard.city) ? standard : null
      });
    }
  }
  console.log(`fetchContactDetails: ${unique.length} unique contact IDs → ${map.size} resolved`);
  return map;
}

// ═══════════════════════════════════════════
// PROPERTY METADATA — pull dropdown options for enumeration fields.
// Used for insurance_policy so the UI can render the same picklist HubSpot has.
// ═══════════════════════════════════════════
async function fetchPropertyOptions(token, propertyName) {
  try {
    const resp = await fetch(
      `${HUBSPOT_API}/crm/v3/properties/deals/${encodeURIComponent(propertyName)}`,
      { headers: { 'Authorization': `Bearer ${token}` } }
    );
    if (!resp.ok) {
      console.error(`Property ${propertyName} fetch failed: ${resp.status}`);
      return [];
    }
    const data = await resp.json();
    // HubSpot returns options as [{label, value, displayOrder, hidden}, ...]
    return (data.options || [])
      .filter(o => !o.hidden)
      .map(o => ({ label: o.label, value: o.value }));
  } catch (err) {
    console.error(`fetchPropertyOptions(${propertyName}) error: ${err.message}`);
    return [];
  }
}

// ═══════════════════════════════════════════
// DATA PROCESSING
// ═══════════════════════════════════════════
function parsePayment(val) {
  if (!val) return 0;
  try {
    return parseFloat(val.split(',')[0].trim()) || 0;
  } catch {
    return 0;
  }
}

// ═══════════════════════════════════════════
// SHIRT SIZE + SHIPPING ADDRESS RESOLUTION
// ═══════════════════════════════════════════
/**
 * Work out the best shirt size and shipping address for one deal, and say
 * where each came from so the dashboard can show its provenance.
 *
 * Precedence, most trustworthy first:
 *   1. The Jotform application, matched on a participant email that belongs to
 *      one of the deal's associated contacts. This is what the student typed.
 *   2. The Jotform application, matched on the student's name. Covers students
 *      whose HubSpot contact email differs from the one they applied with.
 *   3. `t_shirt_size_` on an associated contact / that contact's address.
 *   4. `pd_t_shirt_size` on the deal.
 *
 * Address precedence is the same idea: application home address, then the
 * contact's `mailing_*` group, then its standard address group.
 */
function resolveShirt(deal, contacts, studentName, appIndex) {
  const props = deal.properties || {};
  const out = {
    shirtSize: null,          // normalised Shopify variant title, or null
    shirtSizeRaw: '',         // what the human actually wrote
    shirtSizeSource: '',      // 'application' | 'application (name match)' | 'hubspot contact' | 'hubspot deal'
    shippingAddress: null,
    shippingAddressSource: '',
    applicationSubmittedAt: ''
  };

  // 1 & 2 — the application.
  let app = null;
  for (const c of contacts) {
    const email = String(c.email || '').toLowerCase().trim();
    if (email && appIndex.byEmail.has(email)) {
      app = appIndex.byEmail.get(email);
      out.shirtSizeSource = 'application';
      out.shippingAddressSource = 'application';
      break;
    }
  }
  if (!app) {
    const key = nameKey(studentName);
    const ambiguous = appIndex.ambiguousNames && appIndex.ambiguousNames.has(key);
    if (key && !ambiguous && appIndex.byName.has(key)) {
      app = appIndex.byName.get(key);
      out.shirtSizeSource = 'application (name match)';
      out.shippingAddressSource = 'application (name match)';
    }
  }
  if (app) {
    out.applicationSubmittedAt = app.submittedAt || '';
    if (app.shirtSize) {
      out.shirtSize = app.shirtSize;
      out.shirtSizeRaw = app.shirtSizeRaw || app.shirtSize;
    } else {
      out.shirtSizeSource = '';
    }
    if (app.address) {
      out.shippingAddress = app.address;
    } else {
      out.shippingAddressSource = '';
    }
  }

  // 3 — an associated contact. Prefer a contact whose name matches the
  // student's, so we don't pick up a parent's shirt size or a parent's address
  // when the student's own record has one.
  if (!out.shirtSize || !out.shippingAddress) {
    const key = nameKey(studentName);
    const ordered = contacts.slice().sort((a, b) => {
      const aMatch = nameKey(a.name) === key ? 0 : 1;
      const bMatch = nameKey(b.name) === key ? 0 : 1;
      return aMatch - bMatch;
    });
    for (const c of ordered) {
      if (!out.shirtSize && c.shirtSizeRaw) {
        const size = shirt.normalizeShirtSize(c.shirtSizeRaw);
        if (size) {
          out.shirtSize = size;
          out.shirtSizeRaw = c.shirtSizeRaw;
          out.shirtSizeSource = 'hubspot contact';
        }
      }
      if (!out.shippingAddress && (c.mailingAddress || c.standardAddress)) {
        out.shippingAddress = c.mailingAddress || c.standardAddress;
        out.shippingAddressSource = c.mailingAddress ? 'hubspot contact (mailing)' : 'hubspot contact';
      }
      if (out.shirtSize && out.shippingAddress) break;
    }
  }

  // 4 — the deal property.
  if (!out.shirtSize && props.pd_t_shirt_size) {
    const size = shirt.normalizeShirtSize(props.pd_t_shirt_size);
    if (size) {
      out.shirtSize = size;
      out.shirtSizeRaw = props.pd_t_shirt_size;
      out.shirtSizeSource = 'hubspot deal';
    }
  }

  // Attach a phone number to the address — Shopify uses it for delivery SMS and
  // some carriers require it for international shipments.
  if (out.shippingAddress) {
    const addr = out.shippingAddress;
    const phone = (contacts.find((c) => c.phone) || {}).phone || '';

    // Resolve the country. The application's country subfield is optional and
    // frequently left blank (US students especially), but Shopify requires a
    // countryCode — so rather than making a human pick from 245 options for
    // every such student, fall back through the evidence we already have:
    //   1. what the application said
    //   2. the country on an associated HubSpot contact
    //   3. inference from a full state name ("Colorado" is unambiguously US)
    // Anything still unresolved stays blank and the popup insists on a choice.
    let countryCode = shirt.countryCodeFor(addr.country);
    let countrySource = countryCode ? 'application' : '';
    if (!countryCode) {
      for (const c of contacts) {
        const fromContact =
          shirt.countryCodeFor((c.mailingAddress && c.mailingAddress.country) || '') ||
          shirt.countryCodeFor((c.standardAddress && c.standardAddress.country) || '');
        if (fromContact) {
          countryCode = fromContact;
          countrySource = 'hubspot contact';
          break;
        }
      }
    }
    if (!countryCode) {
      const inferred = shirt.inferCountryFromProvince(addr.province);
      if (inferred) {
        countryCode = inferred;
        countrySource = 'inferred from state';
      }
    }

    out.shippingAddress = Object.assign({}, addr, {
      phone: addr.phone || phone,
      // Pre-resolve the codes Shopify needs so the dashboard can show whether
      // the address is usable without duplicating the mapping tables in JS.
      countryCode,
      countrySource,
      provinceCode: shirt.provinceCodeFor(countryCode, addr.province)
    });
    out.shippingAddressComplete = shirt.addressIsShippable(out.shippingAddress);
  } else {
    out.shippingAddressComplete = false;
  }

  return out;
}

function processDeals(rawDeals, dealToContacts, excludedStageIds, liveStageLabels, appIndex, dropMap) {
  const processed = [];
  dealToContacts = dealToContacts || new Map();
  excludedStageIds = excludedStageIds || new Set();
  liveStageLabels = liveStageLabels || new Map();
  appIndex = appIndex || { byEmail: new Map(), byName: new Map(), ambiguousNames: new Set() };
  dropMap = dropMap || {};

  for (const deal of rawDeals) {
    const props = deal.properties || {};
    const pipelineId = props.pipeline || '';
    const stageId = props.dealstage || '';

    // Filter: only allowed pipelines
    const pipelineLabel = ALLOWED_PIPELINES[pipelineId];
    if (!pipelineLabel) continue;

    // Filter: any stage ID that HubSpot itself marks Closed Lost / Cancelled.
    // This is the authoritative check — covers stages that aren't in
    // STAGE_LABELS (e.g. 1015966374 in the Summer Program pipeline).
    if (excludedStageIds.has(stageId)) continue;

    // Resolve the stage label. Prefer the hand-curated STAGE_LABELS map
    // (groups synonyms together for badges), then the live label from
    // HubSpot's pipelines API, and only fall back to the raw ID if both miss.
    const stageLabel = STAGE_LABELS[stageId] || liveStageLabels.get(stageId) || stageId;
    // Belt-and-braces: legacy exclude-by-label still applies.
    if (EXCLUDE_STAGES.has(stageLabel)) continue;
    const stageLower = String(stageLabel).toLowerCase();
    if (stageLower.indexOf('closed lost') !== -1 ||
        stageLower.indexOf('cancelled') !== -1 ||
        stageLower.indexOf('canceled') !== -1) continue;

    // Filter: skip dropped programs
    const pdProgram = props.pd_program || '';
    if (pdProgram.toLowerCase() === 'dropped') continue;

    // Extract student name from dealname
    const dealname = props.dealname || '';
    let studentName = dealname;
    if (dealname.includes(' - ')) {
      studentName = dealname.split(' - ')[0].trim();
    } else if (dealname.includes('- ')) {
      studentName = dealname.split('- ')[0].trim();
    }

    // Calculate total paid from payments
    let paymentSum = 0;
    for (let i = 1; i <= 10; i++) {
      paymentSum += parsePayment(props[`payment_${i}`]);
    }

    const totalPaidRaw = parseFloat(props.total_amount_paid);
    const totalPaid = (!isNaN(totalPaidRaw) && totalPaidRaw > 0) ? totalPaidRaw : paymentSum;

    const amount = parseFloat(props.amount) || 0;
    const season = PIPELINE_SEASON[pipelineLabel] || 'Other';
    let travelYear = props.travel_year || '';

    // Fix anomalies like "Spring 2026"
    if (travelYear.includes(' ')) {
      const parts = travelYear.split(' ');
      travelYear = parts[parts.length - 1];
    }

    // Flag deals with empty or College Credit PD Program (still shown in table, excluded from counts)
    const excludeFromCount = !pdProgram || pdProgram.toLowerCase().includes('college credit');

    // A student marked dropped on the dashboard. They keep their row and their
    // money — only the headcount changes. See _shared/drops.mjs.
    const dropRecord = dropMap[String(deal.id)] || null;

    const dealContacts = dealToContacts.get(deal.id) || [];
    const merch = resolveShirt(deal, dealContacts, studentName, appIndex);

    processed.push({
      id: deal.id,
      studentName,
      pdProgram,
      pipeline: pipelineLabel,
      season,
      travelYear,
      stage: stageLabel,
      amount,
      totalPaid,
      excludeFromCount,
      // Dropped: out of the headcount, still in the money totals.
      dropped: Boolean(dropRecord),
      dropReason: dropRecord ? dropRecord.reason : '',
      droppedBy: dropRecord ? dropRecord.droppedBy : '',
      droppedAt: dropRecord ? dropRecord.droppedAt : '',
      hubspotUrl: `https://app.hubspot.com/contacts/${PORTAL_ID}/record/0-3/${deal.id}`,
      // Flights-related fields (editable via /api/flights-update). Datetime
      // fields come back as ISO 8601 strings from HubSpot.
      insurancePolicy: props.insurance_policy || '',
      arrivalFlightNumber: props.arrival_flight_number || '',
      arrivalFlightTime: props.arrival_flight_time || '',
      internalFlightNumber: props.internal_flight_number || '',
      internalFlightDepartureTime: props.internal_flight_departure_time || '',
      departureFlightNumber: props.departure_flight_number || '',
      departureTime: props.departure_time || '',
      // Merch: T-shirt size from the application (see resolveShirt) plus the
      // shipping address the Order T-Shirt popup pre-fills from.
      shirtSize: merch.shirtSize,
      shirtSizeRaw: merch.shirtSizeRaw,
      shirtSizeSource: merch.shirtSizeSource,
      shippingAddress: merch.shippingAddress,
      shippingAddressSource: merch.shippingAddressSource,
      shippingAddressComplete: merch.shippingAddressComplete,
      applicationSubmittedAt: merch.applicationSubmittedAt,
      // Full associated-contact records (name, email, phone) for the popup.
      contacts: dealContacts,
      // Kept for backward compatibility with anything reading just emails.
      contactEmails: dealContacts.map(c => c.email).filter(Boolean)
    });
  }

  return processed;
}

// ═══════════════════════════════════════════
// COUNTING RULES
// ═══════════════════════════════════════════
// Two different questions, two different filters, and conflating them is the
// bug this section exists to prevent:
//
//   countsAsStudent  — "how many students are travelling?"  Excludes the
//                      College Credit / no-programme rows AND anyone marked
//                      dropped. Drives every headcount and tab badge.
//   countsAsMoney    — "how much is this season worth?"  Excludes only the
//                      College Credit / no-programme rows. A dropped student
//                      still signed, still paid, and their deal amount and
//                      payments stay in Total Amount and Total Paid.
//
// The dashboard mirrors both rules in enrollment/index.html — change them
// together.
function countsAsMoney(d) { return !d.excludeFromCount; }
function countsAsStudent(d) { return !d.excludeFromCount && !d.dropped; }

// ═══════════════════════════════════════════
// GROUP BY SEASON / YEAR
// ═══════════════════════════════════════════
function groupBySeason(deals) {
  const groups = {};

  for (const d of deals) {
    const key = `${d.season} ${d.travelYear}`;
    if (!groups[key]) {
      groups[key] = { key, season: d.season, year: d.travelYear, deals: [], countedDeals: 0, droppedDeals: 0 };
    }
    groups[key].deals.push(d);
    if (countsAsStudent(d)) groups[key].countedDeals++;
    if (d.dropped) groups[key].droppedDeals++;
  }

  // Sort: by year then season order
  const seasonOrder = { Spring: 1, Summer: 2, Fall: 3, Other: 4 };
  const sorted = Object.values(groups).sort((a, b) => {
    if (a.year !== b.year) return a.year.localeCompare(b.year);
    return (seasonOrder[a.season] || 99) - (seasonOrder[b.season] || 99);
  });

  // Determine past vs current
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  function isPast(season, year) {
    const yr = parseInt(year);
    if (isNaN(yr)) return false;
    const endDates = { Spring: new Date(yr, 3, 30), Summer: new Date(yr, 7, 31), Fall: new Date(yr, 10, 30) };
    const end = endDates[season];
    return end ? end < today : false;
  }

  const current = sorted.filter(g => !isPast(g.season, g.year));
  const past = sorted.filter(g => isPast(g.season, g.year));

  return { current, past };
}

// ═══════════════════════════════════════════
// NETLIFY HANDLER
// ═══════════════════════════════════════════
export default async (req) => {
  const token = process.env.HUBSPOT_TOKEN;
  if (!token) {
    return new Response(JSON.stringify({ error: 'HUBSPOT_TOKEN not set' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }

  try {
    // Pull pipeline metadata, the deal list, and the Jotform application index
    // in parallel — three independent upstreams. The Jotform call is wrapped so
    // that a Jotform outage degrades shirt sizes to the HubSpot fallback rather
    // than failing the whole dashboard.
    const [rawDeals, { excluded: excludedStageIds, labels: liveStageLabels }, appIndex, dropResult] =
      await Promise.all([
        fetchAllDeals(token),
        fetchExcludedStageIds(token),
        fetchApplicationExtras(),
        // Dropped-student records from Netlify Blobs. readDrops() never throws —
        // losing the drop markers skews the headcount, but throwing here would
        // lose the entire table.
        drops.readDrops()
      ]);

    // Fetch deal→contact associations via the v4 batch endpoint.
    // (The Search API doesn't return associations, even when asked.)
    const dealIds = rawDeals.map(d => String(d.id));
    const dealToContactIds = await fetchDealContactAssociations(token, dealIds);

    // Flatten contact IDs and resolve their details (name/email/phone) in one batched pass.
    const allContactIds = [];
    for (const contactIds of dealToContactIds.values()) {
      for (const id of contactIds) allContactIds.push(id);
    }
    const contactMap = await fetchContactDetails(token, allContactIds);

    const dealToContacts = new Map();
    for (const [dealId, contactIds] of dealToContactIds.entries()) {
      const contacts = contactIds.map(id => contactMap.get(id)).filter(Boolean);
      dealToContacts.set(dealId, contacts);
    }
    console.log(`enrollment: ${rawDeals.length} deals fetched, ${dealToContacts.size} have at least one resolved contact`);

    // Pull insurance_policy dropdown options in parallel with the rest so the
    // dashboard can render the same picklist HubSpot has.
    const insurancePolicyOptions = await fetchPropertyOptions(token, 'insurance_policy');

    const processed = processDeals(
      rawDeals, dealToContacts, excludedStageIds, liveStageLabels, appIndex, dropResult.drops
    );
    const { current, past } = groupBySeason(processed);
    const withSize = processed.filter(d => d.shirtSize).length;
    console.log(`enrollment: shirt size resolved for ${withSize}/${processed.length} deals (Jotform index ok: ${appIndex.ok})`);

    // Summary stats. Two filters, deliberately: the money totals keep dropped
    // students, the headcount does not. See the COUNTING RULES section.
    const moneyDeals = processed.filter(countsAsMoney);
    const studentDeals = processed.filter(countsAsStudent);
    const totalAmount = moneyDeals.reduce((s, d) => s + d.amount, 0);
    const totalPaid = moneyDeals.reduce((s, d) => s + d.totalPaid, 0);
    const droppedCount = processed.filter(d => d.dropped).length;
    console.log(`enrollment: ${studentDeals.length} students counted, ${droppedCount} marked dropped (their money still counts)`);

    return new Response(JSON.stringify({
      updatedAt: new Date().toISOString(),
      totalStudents: studentDeals.length,
      totalAmount,
      totalPaid,
      outstanding: totalAmount - totalPaid,
      // Dropped students: excluded from totalStudents, included in the money.
      droppedStudents: droppedCount,
      // False when the drop records could not be read, so the dashboard can say
      // the headcount may be stale instead of silently showing nobody dropped.
      dropsAvailable: dropResult.ok,
      dropsError: dropResult.ok ? '' : dropResult.error,
      currentTabs: current,
      pastTabs: past,
      // Picklist options for the Flights dashboard.
      propertyOptions: {
        insurance_policy: insurancePolicyOptions
      },
      // Merch: the size list the Order T-Shirt popup renders, and whether the
      // application lookup succeeded (so the UI can explain a column of dashes).
      shirtSizeOptions: shirt.SHIRT_SIZES.map(s => ({ code: s.code, label: s.label })),
      shirtCountryOptions: shirt.COUNTRIES,
      applicationLookupOk: appIndex.ok,
      // The specific reason when it failed, so a blank Shirt Size column is
      // diagnosable from the dashboard itself rather than only from the logs.
      applicationLookupError: appIndex.error || '',
      applicationsIndexed: appIndex.byEmail ? appIndex.byEmail.size : 0
    }), {
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=60'
      }
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }
};

export const config = { path: '/api/enrollment' };

// Exported for test/enrollment-drops.test.mjs. Netlify only reads the default
// export and `config`, so naming these costs nothing at runtime and lets the
// counting rules be tested directly instead of through two stubbed upstreams.
export { countsAsMoney, countsAsStudent, processDeals, groupBySeason };

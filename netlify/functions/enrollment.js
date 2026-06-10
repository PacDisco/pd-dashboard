// Netlify serverless function — Student Enrollment Dashboard
// Environment variable required: HUBSPOT_TOKEN (Private App token)
// Endpoint: /api/enrollment

const HUBSPOT_API = 'https://api.hubapi.com';
const PORTAL_ID = '3855728';

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
    'departure_flight_number', 'departure_time'
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
        properties: ['email', 'firstname', 'lastname', 'phone', 'mobilephone'],
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
      map.set(String(c.id), {
        id: String(c.id),
        name: name || '',
        email: p.email || '',
        // Prefer the primary phone, fall back to mobile.
        phone: p.phone || p.mobilephone || '',
        hubspotUrl: `https://app.hubspot.com/contacts/${PORTAL_ID}/record/0-1/${c.id}`
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

function processDeals(rawDeals, dealToContacts, excludedStageIds, liveStageLabels) {
  const processed = [];
  dealToContacts = dealToContacts || new Map();
  excludedStageIds = excludedStageIds || new Set();
  liveStageLabels = liveStageLabels || new Map();

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
      // Full associated-contact records (name, email, phone) for the popup.
      contacts: dealToContacts.get(deal.id) || [],
      // Kept for backward compatibility with anything reading just emails.
      contactEmails: (dealToContacts.get(deal.id) || []).map(c => c.email).filter(Boolean)
    });
  }

  return processed;
}

// ═══════════════════════════════════════════
// GROUP BY SEASON / YEAR
// ═══════════════════════════════════════════
function groupBySeason(deals) {
  const groups = {};

  for (const d of deals) {
    const key = `${d.season} ${d.travelYear}`;
    if (!groups[key]) {
      groups[key] = { key, season: d.season, year: d.travelYear, deals: [], countedDeals: 0 };
    }
    groups[key].deals.push(d);
    if (!d.excludeFromCount) groups[key].countedDeals++;
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
    // Pull pipeline metadata and the deal list in parallel — independent calls.
    const [rawDeals, { excluded: excludedStageIds, labels: liveStageLabels }] =
      await Promise.all([
        fetchAllDeals(token),
        fetchExcludedStageIds(token)
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

    const processed = processDeals(rawDeals, dealToContacts, excludedStageIds, liveStageLabels);
    const { current, past } = groupBySeason(processed);

    // Summary stats (exclude College Credit / empty PD Program from counts)
    const counted = processed.filter(d => !d.excludeFromCount);
    const totalAmount = counted.reduce((s, d) => s + d.amount, 0);
    const totalPaid = counted.reduce((s, d) => s + d.totalPaid, 0);

    return new Response(JSON.stringify({
      updatedAt: new Date().toISOString(),
      totalStudents: counted.length,
      totalAmount,
      totalPaid,
      outstanding: totalAmount - totalPaid,
      currentTabs: current,
      pastTabs: past,
      // Picklist options for the Flights dashboard.
      propertyOptions: {
        insurance_policy: insurancePolicyOptions
      }
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

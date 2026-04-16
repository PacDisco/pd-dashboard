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
    'payment_9', 'payment_10'
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

function processDeals(rawDeals) {
  const processed = [];

  for (const deal of rawDeals) {
    const props = deal.properties || {};
    const pipelineId = props.pipeline || '';
    const stageId = props.dealstage || '';

    // Filter: only allowed pipelines
    const pipelineLabel = ALLOWED_PIPELINES[pipelineId];
    if (!pipelineLabel) continue;

    // Filter: exclude closed lost / cancelled
    const stageLabel = STAGE_LABELS[stageId] || stageId;
    if (EXCLUDE_STAGES.has(stageLabel)) continue;

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
      hubspotUrl: `https://app.hubspot.com/contacts/${PORTAL_ID}/record/0-3/${deal.id}`
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
      groups[key] = { key, season: d.season, year: d.travelYear, deals: [] };
    }
    groups[key].deals.push(d);
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
    const rawDeals = await fetchAllDeals(token);
    const processed = processDeals(rawDeals);
    const { current, past } = groupBySeason(processed);

    // Summary stats
    const totalAmount = processed.reduce((s, d) => s + d.amount, 0);
    const totalPaid = processed.reduce((s, d) => s + d.totalPaid, 0);

    return new Response(JSON.stringify({
      updatedAt: new Date().toISOString(),
      totalStudents: processed.length,
      totalAmount,
      totalPaid,
      outstanding: totalAmount - totalPaid,
      currentTabs: current,
      pastTabs: past
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

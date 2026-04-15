// Netlify serverless function — Forward Business Report
// Environment variable required: HUBSPOT_TOKEN (Private App token)
//
// Architecture:
//   Custom Program Objects (2-58411705) = source of truth for program list, names, tuition
//   Deals = only used to count actual pax (via associations to program objects)
//   Google Sheet = max pax, target pax, est future pax (editable from dashboard)

const HUBSPOT_API = 'https://api.hubapi.com';
const PROGRAM_OBJECT_TYPE = '2-58411705';

// ═══════════════════════════════════════════
// DYNAMIC YEAR CALCULATION
// ═══════════════════════════════════════════
function getSeasonYears() {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
  const baseYear = month >= 9 ? year + 1 : year;
  return { summer: baseYear, fall: baseYear, spring: baseYear + 1 };
}

// ═══════════════════════════════════════════
// SEASON DETECTION FROM PROGRAM NAME
// ═══════════════════════════════════════════
function getSeasonFromName(name) {
  const lower = name.toLowerCase();
  if (lower.includes('spring')) return 'spring';
  if (lower.includes('summer')) return 'summer';
  if (lower.includes('fall')) return 'fall';
  if (lower.includes('mini')) return 'fall';
  if (lower.includes('semester')) return 'fall';
  if (lower.includes('journey')) return 'fall';
  return null;
}

// ═══════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════

// Deal stages that count as "paid" / confirmed enrollment
const PAID_STAGES = [
  'closedwon',
  '2519302',
  '1015966373',
  '1015966374',
  '12030854',
];

// ═══════════════════════════════════════════
// STEP 1: Fetch all custom Program objects
// ═══════════════════════════════════════════
async function fetchAllPrograms(token) {
  const programs = []; // { id, name, tuition }
  const properties = ['pacific_discovery_program', 'program_tuition'];
  let after = 0;
  let hasMore = true;

  while (hasMore) {
    const params = new URLSearchParams({
      limit: '100',
      properties: properties.join(','),
    });
    if (after) params.set('after', String(after));

    const resp = await fetch(`${HUBSPOT_API}/crm/v3/objects/${PROGRAM_OBJECT_TYPE}?${params}`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });

    if (!resp.ok) {
      console.error(`Program objects fetch error: ${resp.status}`);
      break;
    }

    const result = await resp.json();
    (result.results || []).forEach(obj => {
      const props = obj.properties || {};
      const name = props.pacific_discovery_program;
      const tuition = parseFloat(props.program_tuition);
      if (name) {
        programs.push({
          id: obj.id,
          name,
          tuition: !isNaN(tuition) && tuition > 0 ? tuition : null,
        });
      }
    });

    if (result.paging && result.paging.next) {
      after = result.paging.next.after;
    } else {
      hasMore = false;
    }
  }

  return programs;
}

// ═══════════════════════════════════════════
// STEP 2: Fetch associated deals for each program object
// ═══════════════════════════════════════════
// Uses batch associations: program objects → deals
async function fetchProgramDealAssociations(token, programIds) {
  const programToDeals = {}; // programObjectId → [dealId, ...]

  for (let i = 0; i < programIds.length; i += 100) {
    const batch = programIds.slice(i, i + 100);
    const resp = await fetch(`${HUBSPOT_API}/crm/v4/associations/${PROGRAM_OBJECT_TYPE}/deals/batch/read`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ inputs: batch.map(id => ({ id: String(id) })) }),
    });

    if (!resp.ok) {
      console.error(`Associations batch error: ${resp.status}`);
      continue;
    }

    const result = await resp.json();
    (result.results || []).forEach(r => {
      const fromId = r.from && r.from.id;
      const dealIds = (r.to || []).map(t => t.toObjectId);
      if (fromId && dealIds.length > 0) {
        programToDeals[fromId] = dealIds.map(String);
      }
    });
  }

  return programToDeals;
}

// ═══════════════════════════════════════════
// STEP 3: Batch-fetch deal properties
// ═══════════════════════════════════════════
async function fetchDealsByIds(token, dealIds) {
  const dealMap = {}; // dealId → { dealstage, total_amount_paid, amount }
  const uniqueIds = [...new Set(dealIds)];

  for (let i = 0; i < uniqueIds.length; i += 100) {
    const batch = uniqueIds.slice(i, i + 100);
    const resp = await fetch(`${HUBSPOT_API}/crm/v3/objects/deals/batch/read`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        inputs: batch.map(id => ({ id: String(id) })),
        properties: ['dealstage', 'total_amount_paid', 'amount'],
      }),
    });

    if (!resp.ok) {
      console.error(`Deals batch read error: ${resp.status}`);
      continue;
    }

    const result = await resp.json();
    (result.results || []).forEach(deal => {
      dealMap[deal.id] = deal.properties || {};
    });
  }

  return dealMap;
}

// ═══════════════════════════════════════════
// STEP 4: Build the report from program objects
// ═══════════════════════════════════════════
function buildReport(programs, programToDeals, dealMap) {
  const years = getSeasonYears();
  const seasons = {
    summer: { year: years.summer, programs: [] },
    fall:   { year: years.fall, programs: [] },
    spring: { year: years.spring, programs: [] },
  };

  programs.forEach(prog => {
    const season = getSeasonFromName(prog.name);
    if (!season || !seasons[season]) return;

    // Count actual pax from associated deals
    const associatedDealIds = programToDeals[prog.id] || [];
    let actualPax = 0;
    let forecastSales = 0;

    associatedDealIds.forEach(dealId => {
      const deal = dealMap[dealId];
      if (!deal) return;

      const totalPaid = parseFloat(deal.total_amount_paid) || 0;
      const isPaidStage = PAID_STAGES.includes(deal.dealstage);
      const amount = parseFloat(deal.amount) || 0;

      if (totalPaid > 0 || isPaidStage) {
        actualPax++;
        forecastSales += prog.tuition || amount;
      }
    });

    seasons[season].programs.push({
      name: prog.name,
      hubspotName: prog.name,       // For sheet matching
      programObjectId: prog.id,
      season,
      price: prog.tuition,
      maxPax: 0,
      targetPax: 0,
      actualPax,
      totalDeals: associatedDealIds.length,
      forecastSales,
      estFuturePax: 0,
    });
  });

  // Sort: programs with actual pax first, then alphabetically
  Object.keys(seasons).forEach(s => {
    seasons[s].programs.sort((a, b) => (b.actualPax - a.actualPax) || a.name.localeCompare(b.name));
  });

  return seasons;
}

// ═══════════════════════════════════════════
// GOOGLE SHEETS FETCH (via Google Apps Script Web App)
// ═══════════════════════════════════════════
const GSHEET_API_URL = process.env.GSHEET_API_URL || 'https://script.google.com/macros/s/AKfycbznheXhdgXD1Hhjsbjzix7dHgPBcjfGycTfqX8WyhVQuSfeZFihtd7aU3TW9CE8xmMU0Q/exec';

async function fetchSheetData() {
  if (!GSHEET_API_URL) return null;
  try {
    const resp = await fetch(GSHEET_API_URL);
    if (!resp.ok) return null;
    const data = await resp.json();
    return data.status === 'ok' ? data.seasons : null;
  } catch { return null; }
}

// ═══════════════════════════════════════════
// AUTO-SYNC: Add new HubSpot programs to Google Sheet
// ═══════════════════════════════════════════
async function syncNewProgramsToSheet(hubspotSeasons, sheetSeasons) {
  if (!GSHEET_API_URL) return 0;

  // Build list of all HubSpot programs
  const hubspotPrograms = [];
  Object.entries(hubspotSeasons).forEach(([seasonKey, seasonData]) => {
    seasonData.programs.forEach(p => {
      hubspotPrograms.push({ name: p.name, season: seasonKey });
    });
  });

  // Build set of existing sheet programs
  const sheetKeys = new Set();
  if (sheetSeasons) {
    Object.entries(sheetSeasons).forEach(([seasonKey, programs]) => {
      programs.forEach(sp => {
        sheetKeys.add(`${sp.programKey}__${seasonKey}`);
      });
    });
  }

  // Find programs in HubSpot but not in the sheet
  const missing = hubspotPrograms.filter(p => !sheetKeys.has(`${p.name}__${p.season}`));
  if (missing.length === 0) return 0;

  // Call Apps Script sync endpoint to add missing rows
  try {
    const params = new URLSearchParams({
      action: 'sync',
      programs: JSON.stringify(missing),
    });
    const resp = await fetch(`${GSHEET_API_URL}?${params}`);
    if (resp.ok) {
      const result = await resp.json();
      return result.added || 0;
    }
  } catch (e) {
    console.error('Sheet sync error:', e);
  }
  return 0;
}

// ═══════════════════════════════════════════
// MERGE: HubSpot + Google Sheets
// ═══════════════════════════════════════════
function mergeData(hubspotSeasons, sheetSeasons) {
  const merged = {};

  Object.entries(hubspotSeasons).forEach(([seasonKey, seasonData]) => {
    const sheetPrograms = (sheetSeasons && sheetSeasons[seasonKey]) || [];

    merged[seasonKey] = {
      year: seasonData.year,
      programs: seasonData.programs.map(hsP => {
        // Try matching by program name (sheet programKey may use old deal names)
        const sheetRow = sheetPrograms.find(sp =>
          sp.programKey === hsP.name ||
          sp.programKey === hsP.hubspotName ||
          sp.displayName === hsP.name
        );
        return {
          ...hsP,
          maxPax: sheetRow ? sheetRow.maxPax : (hsP.maxPax || 0),
          targetPax: sheetRow ? sheetRow.targetPax : (hsP.targetPax || 0),
          estFuturePax: sheetRow ? sheetRow.estFuturePax : 0,
        };
      })
    };
  });

  return merged;
}

// ═══════════════════════════════════════════
// NETLIFY HANDLER
// ═══════════════════════════════════════════

export default async (req) => {
  const token = process.env.HUBSPOT_TOKEN;
  if (!token) {
    return new Response(JSON.stringify({ error: 'HUBSPOT_TOKEN environment variable not set' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  }

  try {
    // Step 1: Fetch program objects and sheet data in parallel
    const [programs, sheetSeasons] = await Promise.all([
      fetchAllPrograms(token),
      fetchSheetData(),
    ]);

    // Step 2: Fetch associations (program → deals)
    const programIds = programs.map(p => p.id);
    const programToDeals = await fetchProgramDealAssociations(token, programIds);

    // Step 3: Fetch deal properties for all associated deals
    const allDealIds = Object.values(programToDeals).flat();
    const dealMap = allDealIds.length > 0 ? await fetchDealsByIds(token, allDealIds) : {};

    // Step 4: Build report from program objects
    const hubspotSeasons = buildReport(programs, programToDeals, dealMap);

    // Step 5: Auto-sync — add any new HubSpot programs to the Google Sheet
    const newProgramsAdded = await syncNewProgramsToSheet(hubspotSeasons, sheetSeasons);

    // If we added new programs, re-fetch sheet data so the merge picks them up
    const finalSheetSeasons = newProgramsAdded > 0 ? await fetchSheetData() : sheetSeasons;
    const seasons = finalSheetSeasons ? mergeData(hubspotSeasons, finalSheetSeasons) : hubspotSeasons;
    const years = getSeasonYears();

    return new Response(JSON.stringify({
      updatedAt: new Date().toISOString(),
      totalPrograms: programs.length,
      totalAssociatedDeals: allDealIds.length,
      sheetConnected: !!finalSheetSeasons,
      newProgramsSynced: newProgramsAdded,
      years,
      seasons,
    }), {
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=300' },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  }
};

export const config = { path: '/api/hubspot' };

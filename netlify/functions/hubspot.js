// Netlify serverless function — fetches program data from HubSpot
// Environment variable required: HUBSPOT_TOKEN (Private App token)

const HUBSPOT_API = 'https://api.hubapi.com';

// ═══════════════════════════════════════════
// DYNAMIC YEAR CALCULATION
// ═══════════════════════════════════════════
// Academic cycle: Summer & Fall = same year, Spring = next year
// Rolls forward automatically each September
function getSeasonYears() {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
  // After August, look ahead to next year's cycle
  const baseYear = month >= 9 ? year + 1 : year;
  return {
    summer: baseYear,
    fall: baseYear,
    spring: baseYear + 1,
  };
}

// ═══════════════════════════════════════════
// NAME-BASED SEASON DETECTION
// ═══════════════════════════════════════════
// Assigns a program to a season based on keywords in the pd_program name.
// "Summer" in the name → summer
// "Mini Semester" → falls into fall (minis typically run fall)
// "Semester" (without Summer) → fall by default; pipeline override for spring
function getSeasonFromName(pdProgram) {
  const lower = pdProgram.toLowerCase();
  if (lower.includes('summer')) return 'summer';
  if (lower.includes('high school summer')) return 'summer';
  if (lower.includes('college summer')) return 'summer';
  if (lower.includes('mini semester') || lower.includes('mini')) return 'fall'; // default, pipeline can override
  if (lower.includes('semester')) return 'fall'; // default, pipeline can override
  if (lower.includes('journey')) return 'fall';
  return null; // unknown — will use pipeline fallback
}

// ═══════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════

// Pipeline-to-season overrides. Only needed when the program name
// doesn't tell us the season (e.g., semesters that run in Spring).
// Add pipeline IDs here that are specifically Spring runs.
const PIPELINE_SEASON_OVERRIDE = {
  // Spring pipelines — deals in these pipelines override the name-based season
  '74759274': 'spring',   // PD Spring Mini Semester pipeline
  // Add more spring pipeline IDs as you create them each year
};

// All pipeline IDs to fetch deals from (current year only).
// Update this list each year, or use the wildcard approach below.
const ACTIVE_PIPELINE_IDS = [
  '694619955',   // PD Summer Programs
  '742406417',   // PD Summer HS
  '74958084',    // PD Fall/Spring Gap Semester
  '74759274',    // PD Spring Mini Semester
  // Add new pipeline IDs as they're created each season
];

// Display-friendly names. If a pd_program value isn't here,
// the raw HubSpot name is cleaned up automatically.
const DISPLAY_NAMES = {
  'Bali Summer Program': 'Bali Summer',
  'Hawaii Summer Program': 'Hawaii Summer',
  'Hawaii Summer Expedition': 'Hawaii 2 Week',
  'Marine Conservation and Reef Monitoring Field Program': 'Hawaii 2 Week',
  'Thailand Summer Program': 'Thailand Summer',
  'Costa Rica Summer Program': 'Costa Rica Summer',
  'Australia Summer Program': 'Australia Summer',
  'New Zealand & Fiji Summer Program': 'NZ & Fiji Summer',
  'Thailand High School Summer': 'Thailand - High School',
  'Alaska College Summer': 'Alaska - College',
  'Peru High School Summer': 'Peru - High School',
  'Western USA College Summer': 'Western USA - College',
  'Caribbean College Summer': 'Caribbean - College',
  'Ecuador & Galapagos College Summer': 'Ecuador/Galapagos - College',
  'Vietnam & Cambodia College Summer': 'Vietnam/Cambodia - College',
  'Fiji & Vanuatu College Summer': 'Fiji/Vanuatu - College',
  'Caribbean High School Summer': 'Caribbean - High School',
  'Galapagos High School Summer': 'Galapagos - High School',
  'Nepal & India Semester': 'Nepal & India',
  'Nepal & Tibet Semester': 'Nepal & Tibet',
  'New Zealand & Australia Semester': 'New Zealand & Australia',
  'South America Semester': 'South America',
  'Southeast Asia Semester': 'Southeast Asia',
  'Australia & Bali Semester': 'Australia & Bali',
  'Polynesian Journey': 'Polynesian Journey',
  'Central America Semester': 'Central America',
  'Rewilding Residential Semester': 'Rewilding Semester',
  'Hawaii Mini Semester': 'Hawaii Mini',
  'Australia Mini Semester': 'Australia Mini',
  'Costa Rica Mini Semester': 'Costa Rica Mini',
  'Thailand Mini Semester': 'Thailand Mini',
  'Greece & Croatia Mini Semester': 'Greece & Croatia Mini',
  'Japan Mini Semester': 'Japan Mini',
};

// Auto-clean: strip " Semester", " Program", " College", " High School" suffixes
function cleanProgramName(raw) {
  if (DISPLAY_NAMES[raw]) return DISPLAY_NAMES[raw];
  return raw
    .replace(/ Semester$/i, '')
    .replace(/ Program$/i, '')
    .replace(/ College$/i, '')
    .replace(/ High School$/i, '')
    .trim();
}

// Deal stages that count as "paid" / confirmed enrollment (actual pax).
const PAID_STAGES = [
  'closedwon',
  '2519302',
  '1015966373',
  '1015966374',
  '12030854',
];

// Programs to exclude from the report
const EXCLUDED_PROGRAMS = ['Dropped', 'College Credit Program', 'Basecamp'];

// ═══════════════════════════════════════════
// HUBSPOT API HELPERS
// ═══════════════════════════════════════════

async function hubspotSearch(token, objectType, body) {
  const resp = await fetch(`${HUBSPOT_API}/crm/v3/objects/${objectType}/search`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`HubSpot API error ${resp.status}: ${err}`);
  }
  return resp.json();
}

async function fetchAllDeals(token) {
  const allDeals = [];
  const properties = ['dealname', 'pd_program', 'pd_season', 'pd_year', 'pipeline', 'amount', 'total_amount_paid', 'dealstage'];

  for (let i = 0; i < ACTIVE_PIPELINE_IDS.length; i += 3) {
    const batch = ACTIVE_PIPELINE_IDS.slice(i, i + 3);
    const filterGroups = batch.map(pid => ({
      filters: [{ propertyName: 'pipeline', operator: 'EQ', value: pid }]
    }));

    let after = 0;
    let hasMore = true;
    while (hasMore) {
      const body = { filterGroups, properties, limit: 100 };
      if (after > 0) body.after = after;
      const result = await hubspotSearch(token, 'deals', body);
      allDeals.push(...(result.results || []));
      if (result.paging && result.paging.next) {
        after = result.paging.next.after;
      } else {
        hasMore = false;
      }
    }
  }

  return allDeals;
}

// ═══════════════════════════════════════════
// AGGREGATION
// ═══════════════════════════════════════════

function aggregateDeals(deals) {
  const programs = {};
  const years = getSeasonYears();

  deals.forEach(deal => {
    const props = deal.properties || {};
    const pdProgram = props.pd_program;
    if (!pdProgram || EXCLUDED_PROGRAMS.includes(pdProgram)) return;

    const pipeline = props.pipeline;

    // Determine season: pipeline override > name-based detection
    let season = PIPELINE_SEASON_OVERRIDE[pipeline] || getSeasonFromName(pdProgram);
    if (!season) season = 'fall'; // safe default

    const key = `${pdProgram}__${season}`;

    if (!programs[key]) {
      programs[key] = {
        name: cleanProgramName(pdProgram),
        hubspotName: pdProgram,
        season,
        price: null,
        maxPax: 0,
        targetPax: 0,
        actualPax: 0,
        totalDeals: 0,
        forecastSales: 0,
        prices: [],
      };
    }

    programs[key].totalDeals++;

    const amount = parseFloat(props.amount) || 0;
    if (amount > 0) programs[key].prices.push(amount);

    const totalPaid = parseFloat(props.total_amount_paid) || 0;
    const isPaidStage = PAID_STAGES.includes(props.dealstage);

    if (totalPaid > 0 || isPaidStage) {
      programs[key].actualPax++;
      programs[key].forecastSales += amount;
    }
  });

  // Compute price from deals (use mode — most common price)
  Object.values(programs).forEach(p => {
    if (p.prices.length > 0) {
      const freq = {};
      p.prices.forEach(pr => { const r = Math.round(pr); freq[r] = (freq[r] || 0) + 1; });
      const sorted = Object.entries(freq).sort((a, b) => b[1] - a[1]);
      p.price = parseFloat(sorted[0][0]);
    }
    delete p.prices;
  });

  // Group by season
  const seasons = {
    summer: { year: years.summer, programs: [] },
    fall:   { year: years.fall, programs: [] },
    spring: { year: years.spring, programs: [] },
  };

  Object.values(programs).forEach(p => {
    if (seasons[p.season]) seasons[p.season].programs.push(p);
  });

  // Sort each season: programs with actual pax first, then alphabetically
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
// MERGE: HubSpot (prices, actual pax) + Google Sheets (max, target, est future)
// ═══════════════════════════════════════════
function mergeData(hubspotSeasons, sheetSeasons) {
  const merged = {};

  Object.entries(hubspotSeasons).forEach(([seasonKey, seasonData]) => {
    const sheetPrograms = (sheetSeasons && sheetSeasons[seasonKey]) || [];

    merged[seasonKey] = {
      year: seasonData.year,
      programs: seasonData.programs.map(hsP => {
        // Find matching sheet row by programKey (hubspotName)
        const sheetRow = sheetPrograms.find(sp => sp.programKey === hsP.hubspotName);
        return {
          ...hsP,
          maxPax: sheetRow ? sheetRow.maxPax : (hsP.maxPax || 0),
          targetPax: sheetRow ? sheetRow.targetPax : (hsP.targetPax || 0),
          estFuturePax: sheetRow ? sheetRow.estFuturePax : 0,
        };
      })
    };

    // Add sheet-only programs (in sheet but not yet in HubSpot deals)
    sheetPrograms.forEach(sp => {
      const exists = merged[seasonKey].programs.some(p => p.hubspotName === sp.programKey);
      if (!exists) {
        merged[seasonKey].programs.push({
          name: sp.displayName,
          hubspotName: sp.programKey,
          season: seasonKey,
          price: null,
          maxPax: sp.maxPax,
          targetPax: sp.targetPax,
          estFuturePax: sp.estFuturePax,
          actualPax: 0,
          totalDeals: 0,
          forecastSales: 0,
        });
      }
    });
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
    // Fetch both sources in parallel
    const [deals, sheetSeasons] = await Promise.all([
      fetchAllDeals(token),
      fetchSheetData(),
    ]);

    const hubspotSeasons = aggregateDeals(deals);
    const seasons = sheetSeasons ? mergeData(hubspotSeasons, sheetSeasons) : hubspotSeasons;
    const years = getSeasonYears();

    return new Response(JSON.stringify({
      updatedAt: new Date().toISOString(),
      totalDeals: deals.length,
      sheetConnected: !!sheetSeasons,
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

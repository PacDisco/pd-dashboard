/**
 * Flight Tickets tool — single Netlify Function with action routing.
 *
 * Upload flight ticket PDFs through the Flights dashboard. For each file,
 * Claude reads the passenger name printed on the ticket, the function
 * find-or-creates a Drive subfolder named after that student inside a shared
 * parent folder, makes that subfolder shareable (anyone-with-link can view),
 * and drops the file into it. The per-student folder link is what you hand to
 * the student / student portal.
 *
 * Design decisions (confirmed with the team):
 *   - Group by the name PRINTED ON THE TICKET (no roster / HubSpot match).
 *     We still tidy formatting (e.g. "SMITH/JOHN MR" -> "John Smith") so the
 *     same person doesn't spawn two differently-spelled folders.
 *   - Auto-file immediately (no manual review checkpoint).
 *
 * Routes (query ?action=... or JSON body { action }):
 *   - upload   POST  -> { filename, mimeType, data(base64) }
 *                       Reads passenger name(s), files the PDF into each
 *                       student's Drive subfolder. Returns the folder link(s).
 *   - list     GET   -> lists student subfolders under the parent folder,
 *                       with shareable links + file counts.
 *   - debug    GET   -> Drive / env sanity check.
 *
 * Required env vars:
 *   ANTHROPIC_API_KEY               (for reading the passenger name)
 *   GOOGLE_SERVICE_ACCOUNT_JSON     (full service-account JSON as a single string)
 *   FLIGHT_TICKETS_DRIVE_FOLDER_ID  (the shared parent folder; per-student
 *                                    subfolders are created inside it)
 *
 * Optional env vars (HubSpot write-back of the folder URL):
 *   HUBSPOT_TOKEN                   (Private App token; same one enrollment.js
 *                                    uses. If unset, the HubSpot step is skipped.)
 *   UE_PROGRAM_OBJECT_TYPE          (custom object that holds the Unearthed
 *                                    programs / dropdown source; default
 *                                    "2-58156993")
 *   UE_PROGRAM_NAME_PROP            (the property on that object holding the
 *                                    program's display name; auto-detected if
 *                                    unset)
 *   UNEARTHED_PROGRAM_MATCH         (optional substring filter on program name;
 *                                    off by default since the object is already
 *                                    Unearthed-specific)
 *
 * Verify the object wiring any time at:  /api/flight-tickets?action=program-props
 *
 * NOTE: the service account only sees Drive folders explicitly shared with it.
 * Share FLIGHT_TICKETS_DRIVE_FOLDER_ID with the service-account email (Editor)
 * before first use, exactly like the invoices folder.
 */

const { google } = require('googleapis');
const Anthropic = require('@anthropic-ai/sdk').default || require('@anthropic-ai/sdk');

// --------------------------------------------------------------------------
// Lazy-initialised clients
// --------------------------------------------------------------------------
let _drive;
async function drive() {
  if (!_drive) {
    const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
    if (!raw) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON env var is not set');

    let creds;
    try { creds = JSON.parse(raw); }
    catch (e) { throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON: ' + e.message); }

    // Common env-var gotcha: private_key sometimes arrives with literal "\n".
    if (creds.private_key && creds.private_key.includes('\\n')) {
      creds.private_key = creds.private_key.replace(/\\n/g, '\n');
    }

    const auth = new google.auth.GoogleAuth({
      credentials: creds,
      scopes: ['https://www.googleapis.com/auth/drive'],
    });
    const client = await auth.getClient();
    _drive = google.drive({ version: 'v3', auth: client });
  }
  return _drive;
}

let _anthropic;
function anthropic() {
  if (!_anthropic) _anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _anthropic;
}

// --------------------------------------------------------------------------
// HTTP helpers
// --------------------------------------------------------------------------
const JSON_HEADERS = { 'Content-Type': 'application/json' };
function ok(body)               { return { statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify(body) }; }
function bad(msg, code = 400)   { return { statusCode: code, headers: JSON_HEADERS, body: JSON.stringify({ error: msg }) }; }

function parentFolderId() {
  const id = process.env.FLIGHT_TICKETS_DRIVE_FOLDER_ID;
  if (!id) throw new Error('FLIGHT_TICKETS_DRIVE_FOLDER_ID env var is not set');
  return id;
}

// --------------------------------------------------------------------------
// Name normalisation
// --------------------------------------------------------------------------
const HONORIFICS = new Set(['mr', 'mrs', 'ms', 'miss', 'mstr', 'master', 'dr', 'prof', 'sir', 'madam', 'mx']);

// Tidy the printed passenger name into a consistent "First Last" form so the
// same student doesn't get two folders. This is formatting only — NOT a lookup
// against any roster.
function normalizeName(raw) {
  if (!raw) return null;
  let s = String(raw).trim();
  if (!s) return null;

  // Airline format "LAST/FIRST MIDDLE" -> "FIRST MIDDLE LAST"
  if (s.includes('/')) {
    const [last, rest] = s.split('/');
    s = `${(rest || '').trim()} ${(last || '').trim()}`.trim();
  } else if ((s.match(/,/g) || []).length === 1) {
    // "Last, First Middle" -> "First Middle Last"
    const [last, rest] = s.split(',');
    s = `${(rest || '').trim()} ${(last || '').trim()}`.trim();
  }

  // Split, drop honorifics, title-case each token.
  const tokens = s
    .replace(/[,]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .filter(t => !HONORIFICS.has(t.replace(/\./g, '').toLowerCase()));

  if (!tokens.length) return null;

  const titled = tokens.map(t => {
    // Preserve hyphenated names (Anne-Marie) and apostrophes (O'Brien).
    return t.toLowerCase().replace(/(^|[-'’])([a-z])/g, (_, sep, ch) => sep + ch.toUpperCase());
  });

  return titled.join(' ');
}

// Drive-safe folder name (no chars that break the search query / display).
function safeFolderName(name) {
  return name.replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
}

// --------------------------------------------------------------------------
// Claude — read passenger name(s) off the ticket
// --------------------------------------------------------------------------
function extractJSON(text) {
  if (!text) return null;
  const tries = [
    text.trim(),
    text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim(),
  ];
  const fb = text.indexOf('['), lb = text.lastIndexOf(']');
  if (fb !== -1 && lb > fb) tries.push(text.slice(fb, lb + 1));
  const fc = text.indexOf('{'), lc = text.lastIndexOf('}');
  if (fc !== -1 && lc > fc) tries.push(text.slice(fc, lc + 1));
  for (const c of tries) { try { return JSON.parse(c); } catch (_) {} }
  return null;
}

async function readPassengerNames(buffer, mimeType) {
  const prompt = `You are reading a flight ticket / e-ticket / boarding pass / travel itinerary.

Return ONLY a JSON array of the PASSENGER name(s) on this document — no markdown fences, no commentary.

[
  { "name": "First Last" }
]

This document may be a GROUP booking listing several passengers. Read the
ENTIRE document — including passenger tables/manifests, multiple pages, and
names that repeat across flight segments — and return EVERY distinct traveller.

Rules:
  - Return the TRAVELLER / passenger name(s). Ignore travel-agent names, airline staff, emergency contacts, and the name of whoever booked it if they are not travelling.
  - GROUP / FAMILY bookings: one element per passenger. A passenger list, a table of names, or "Passenger 1 / Passenger 2…" all mean multiple travellers — return each one. Do NOT merge two people into one entry, and do NOT collapse a family onto a single name.
  - The SAME passenger often appears multiple times (once per flight leg). List each distinct person only ONCE.
  - Do NOT split a single person's first/middle names into separate entries.
  - If the name is printed in airline "LAST/FIRST" order (e.g. "SMITH/JOHN MR"), reorder it to natural "First Last" and drop the honorific -> "John Smith".
  - Title-case the name (not ALL CAPS).
  - If you genuinely cannot find any passenger name, return [].`;

  const content = mimeType === 'application/pdf'
    ? [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: buffer.toString('base64') } }]
    : [{ type: 'image', source: { type: 'base64', media_type: mimeType, data: buffer.toString('base64') } }];

  const msg = await anthropic().messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1500,
    messages: [{ role: 'user', content: [...content, { type: 'text', text: prompt }] }],
  });

  const text = msg.content.find(c => c.type === 'text')?.text || '';
  const parsed = extractJSON(text);
  const arr = Array.isArray(parsed) ? parsed : (parsed && typeof parsed === 'object' ? [parsed] : []);

  // Normalise + de-dupe.
  const seen = new Set();
  const names = [];
  for (const el of arr) {
    const n = normalizeName(el && (el.name || el.passenger || el.full_name));
    if (n && !seen.has(n.toLowerCase())) { seen.add(n.toLowerCase()); names.push(n); }
  }
  return names;
}

// --------------------------------------------------------------------------
// Drive helpers
// --------------------------------------------------------------------------
const FOLDER_MIME = 'application/vnd.google-apps.folder';

function driveEsc(s) { return String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'"); }

// Find a child folder by name under `parentId`; create it if missing.
// `shareable` makes it anyone-with-link readable (used for student folders —
// that link is what gets written to the deal / shared with the student).
async function findOrCreateFolder(name, parentId, { shareable = false } = {}) {
  const d = await drive();
  const safe = safeFolderName(name);

  const q = `'${driveEsc(parentId)}' in parents and name = '${driveEsc(safe)}' ` +
            `and mimeType = '${FOLDER_MIME}' and trashed = false`;
  const found = await d.files.list({
    q,
    fields: 'files(id, name, webViewLink)',
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
    pageSize: 1,
  });

  if (found.data.files && found.data.files.length) {
    const f = found.data.files[0];
    return { id: f.id, name: f.name, url: f.webViewLink, created: false };
  }

  const created = await d.files.create({
    requestBody: { name: safe, mimeType: FOLDER_MIME, parents: [parentId] },
    fields: 'id, name, webViewLink',
    supportsAllDrives: true,
  });

  if (shareable) {
    try {
      await d.permissions.create({
        fileId: created.data.id,
        requestBody: { role: 'reader', type: 'anyone' },
        supportsAllDrives: true,
      });
    } catch (e) {
      // Non-fatal: folder exists, just not link-shared (e.g. domain policy
      // blocks anyone-links).
      console.warn(`Could not set anyone-link on folder ${created.data.id}: ${e.message}`);
    }
  }

  return { id: created.data.id, name: created.data.name, url: created.data.webViewLink, created: true };
}

// Program container folder (under the root parent) — not link-shared.
function ensureProgramFolder(programName) {
  return findOrCreateFolder(programName, parentFolderId(), { shareable: false });
}

// Student folder, nested under a program folder — link-shared.
function ensureStudentFolder(studentName, programFolderId) {
  return findOrCreateFolder(studentName, programFolderId || parentFolderId(), { shareable: true });
}

// Find a folder by name under a parent without creating it. Returns null if absent.
async function findFolderByName(name, parentId) {
  const d = await drive();
  const safe = safeFolderName(name);
  const res = await d.files.list({
    q: `'${driveEsc(parentId)}' in parents and name = '${driveEsc(safe)}' and mimeType = '${FOLDER_MIME}' and trashed = false`,
    fields: 'files(id, name, webViewLink)', pageSize: 1,
    supportsAllDrives: true, includeItemsFromAllDrives: true,
  });
  const f = res.data.files && res.data.files[0];
  return f ? { id: f.id, name: f.name, url: f.webViewLink } : null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function uploadIntoFolder({ folderId, filename, mimeType, buffer }) {
  const d = await drive();
  // Shared Drives are eventually consistent: a folder we just created can
  // briefly 404 ("File not found") on the immediately-following write. Retry
  // a few times with backoff before giving up.
  const MAX_TRIES = 4;
  let lastErr;
  for (let attempt = 1; attempt <= MAX_TRIES; attempt++) {
    try {
      const res = await d.files.create({
        requestBody: { name: filename, parents: [folderId] },
        media: { mimeType, body: require('stream').Readable.from(buffer) },
        fields: 'id, name, webViewLink',
        supportsAllDrives: true,
      });
      return { id: res.data.id, name: res.data.name, url: res.data.webViewLink };
    } catch (e) {
      lastErr = e;
      const status = e && (e.code || e.status || (e.response && e.response.status));
      const isNotFound = status === 404 || /not found/i.test(e.message || '');
      if (isNotFound && attempt < MAX_TRIES) {
        await sleep(400 * attempt); // 400, 800, 1200ms
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

// --------------------------------------------------------------------------
// HubSpot — match a student to their Unearthed deal and write the folder URL
// into the `ue_airline_tickets` deal property.
//
// "Unearthed programs" = records in the custom Program object
// (UE_PROGRAM_OBJECT_TYPE, default 2-58156993). Association chain is:
//   program -> CONTACTS -> deals
// i.e. we pull the contacts associated to the selected program, then the deals
// associated to each of those contacts, and build a name -> deal index. A deal
// is only written when the student name resolves to exactly one contact whose
// contact is on exactly one deal; otherwise we skip and report.
// --------------------------------------------------------------------------
const HUBSPOT_API = 'https://api.hubapi.com';
const HUBSPOT_PORTAL_ID = '3855728';
// The custom object that holds the Unearthed programs (the dropdown source).
const PROGRAM_OBJECT_TYPE = process.env.UE_PROGRAM_OBJECT_TYPE || '2-58156993';
const UE_TICKETS_PROPERTY = 'ue_airline_tickets';

function hubspotToken() { return process.env.HUBSPOT_TOKEN || null; }

function unearthedMatcher() {
  const needle = (process.env.UNEARTHED_PROGRAM_MATCH || 'unearthed').toLowerCase();
  return (name) => String(name || '').toLowerCase().includes(needle);
}

// Comparable key for matching a ticket/folder name to a HubSpot contact name.
function nameKey(name) {
  const n = normalizeName(name);
  return n ? n.toLowerCase() : '';
}

async function hsFetch(path, opts = {}) {
  const token = hubspotToken();
  const resp = await fetch(`${HUBSPOT_API}${path}`, {
    ...opts,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  return resp;
}

// Cache TTLs (warm-Lambda memory).
const CACHE_TTL_MS = 60 * 1000;

// Discover which property on the program object holds its display name.
// Override with UE_PROGRAM_NAME_PROP; otherwise auto-detect from metadata.
let _nameProp = null;
async function getProgramNameProp() {
  if (_nameProp) return _nameProp;
  if (process.env.UE_PROGRAM_NAME_PROP) { _nameProp = process.env.UE_PROGRAM_NAME_PROP; return _nameProp; }

  // 1. Authoritative: the object schema's primary display property.
  try {
    const sresp = await hsFetch(`/crm/v3/schemas/${PROGRAM_OBJECT_TYPE}`);
    if (sresp.ok) {
      const schema = await sresp_json(sresp);
      const primary = schema && schema.primaryDisplayProperty;
      if (primary) { _nameProp = primary; return _nameProp; }
    }
  } catch (_) {}

  // 2. Fallback: heuristic over property metadata.
  try {
    const resp = await hsFetch(`/crm/v3/properties/${PROGRAM_OBJECT_TYPE}`);
    if (resp.ok) {
      const data = await resp.json();
      const props = (data.results || []).filter(p => !String(p.name).startsWith('hs_'));
      const strings = props.filter(p => p.type === 'string' || p.fieldType === 'text');
      const pick = strings.find(p => /program|name|title/i.test(p.name)) || strings[0] || props[0];
      if (pick) { _nameProp = pick.name; return _nameProp; }
    }
  } catch (_) {}
  _nameProp = 'name';
  return _nameProp;
}
async function sresp_json(r) { try { return await r.json(); } catch { return null; } }

// ---- Unearthed programs list (for the uploader's dropdown) ----------------
let _programs = { at: 0, data: null };
async function getProgramsList() {
  if (_programs.data && Date.now() - _programs.at < CACHE_TTL_MS) return _programs.data;
  if (!hubspotToken()) throw new Error('HUBSPOT_TOKEN not set');

  const nameProp = await getProgramNameProp();
  // Optional name filter — off by default, since this object is already the
  // Unearthed-programs object. Set UNEARTHED_PROGRAM_MATCH to filter.
  const filterStr = (process.env.UNEARTHED_PROGRAM_MATCH || '').toLowerCase();
  const programs = [];
  let after = 0, more = true;
  while (more) {
    const params = new URLSearchParams({ limit: '100', properties: nameProp });
    if (after) params.set('after', String(after));
    const resp = await hsFetch(`/crm/v3/objects/${PROGRAM_OBJECT_TYPE}?${params}`);
    if (!resp.ok) throw new Error(`Program objects fetch failed: ${resp.status}`);
    const data = await resp.json();
    for (const obj of (data.results || [])) {
      const name = obj.properties && obj.properties[nameProp];
      if (!name) continue;
      if (filterStr && !String(name).toLowerCase().includes(filterStr)) continue;
      programs.push({ id: String(obj.id), name });
    }
    if (data.paging && data.paging.next) after = data.paging.next.after; else more = false;
  }
  programs.sort((a, b) => a.name.localeCompare(b.name));
  _programs = { at: Date.now(), data: programs };
  return programs;
}

async function programNameById(programId) {
  const list = await getProgramsList();
  const p = list.find(x => x.id === String(programId));
  return p ? p.name : null;
}

// ---- Per-program contact roster (the names we match a ticket against) ------
// Keyed by programId so switching programs doesn't reuse the wrong roster.
const _progIndex = new Map(); // programId -> { at, data:{contacts, dealCount} }

async function getProgramIndex(programId) {
  const cached = _progIndex.get(String(programId));
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.data;

  // 1. CONTACTS associated to THIS program.
  const contactIdSet = new Set();
  const resp = await hsFetch(`/crm/v4/associations/${PROGRAM_OBJECT_TYPE}/contacts/batch/read`, {
    method: 'POST', body: JSON.stringify({ inputs: [{ id: String(programId) }] }),
  });
  if (resp.ok) {
    const data = await resp.json();
    for (const r of (data.results || [])) for (const t of (r.to || [])) contactIdSet.add(String(t.toObjectId));
  }

  // 2. Deals associated to each of those contacts.
  const contactToDeals = new Map(); // contactId -> Set(dealId)
  const dealIdSet = new Set();
  const cIds0 = [...contactIdSet];
  for (let i = 0; i < cIds0.length; i += 100) {
    const batch = cIds0.slice(i, i + 100);
    const r2 = await hsFetch(`/crm/v4/associations/contacts/deals/batch/read`, {
      method: 'POST', body: JSON.stringify({ inputs: batch.map(id => ({ id })) }),
    });
    if (!r2.ok) continue;
    const d2 = await r2.json();
    for (const r of (d2.results || [])) {
      const cId = r.from && String(r.from.id);
      const dIds = (r.to || []).map(t => String(t.toObjectId));
      if (cId) contactToDeals.set(cId, new Set(dIds));
      dIds.forEach(id => dealIdSet.add(id));
    }
  }
  const dealIds = [...dealIdSet];

  // 3. Contact names.
  const contactName = new Map();
  const cIds = [...contactIdSet];
  for (let i = 0; i < cIds.length; i += 100) {
    const batch = cIds.slice(i, i + 100);
    const r3 = await hsFetch(`/crm/v3/objects/contacts/batch/read`, {
      method: 'POST',
      body: JSON.stringify({ properties: ['firstname', 'lastname'], inputs: batch.map(id => ({ id })) }),
    });
    if (!r3.ok) continue;
    const d3 = await r3.json();
    for (const c of (d3.results || [])) {
      const p = c.properties || {};
      contactName.set(String(c.id), [p.firstname, p.lastname].filter(Boolean).join(' ').trim());
    }
  }

  // 4. One record per contact (deals come from the contact's associations).
  const contacts = [];
  for (const cId of contactIdSet) {
    const deals = contactToDeals.get(cId) || new Set();
    const canonicalName = normalizeName(contactName.get(cId));
    if (!canonicalName) continue;
    const tokens = canonicalName.toLowerCase().split(/\s+/).filter(Boolean);
    contacts.push({
      contactId: cId, canonicalName,
      fullKey: tokens.join(' '), lastKey: tokens[tokens.length - 1], firstToken: tokens[0],
      dealIds: [...deals],
    });
  }

  const out = { contacts, dealCount: dealIds.length };
  _progIndex.set(String(programId), { at: Date.now(), data: out });
  return out;
}

function dealUrl(dealId) {
  return `https://app.hubspot.com/contacts/${HUBSPOT_PORTAL_ID}/record/0-3/${dealId}`;
}

// Are two first-name tokens compatible? Equal, or one is a prefix of the other
// (handles "Alana" vs "Alanajoyce" where the airline ran first+middle together).
function firstNameCompatible(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length <= b.length ? b : a;
  return shorter.length >= 2 && longer.startsWith(shorter);
}

// Resolve a ticket name against the SELECTED program's contact roster.
// Returns: { roster, person, canonicalName, dealIds }
//   roster:  true if the roster was available to match against
//   person:  'matched' | 'none' | 'ambiguous'
async function resolveStudent(ticketName, programId) {
  if (!hubspotToken() || !programId) return { roster: false };
  let data;
  try { data = await getProgramIndex(programId); }
  catch (e) { return { roster: false, error: e.message }; }

  const contacts = data.contacts || [];
  const norm = normalizeName(ticketName);
  if (!norm) return { roster: true, person: 'none' };
  const tokens = norm.toLowerCase().split(/\s+/).filter(Boolean);
  const full = tokens.join(' ');
  const last = tokens[tokens.length - 1];
  const first = tokens[0];

  // Strongest signal: exact full-name key. Otherwise last name + compatible first.
  let cands = contacts.filter(c => c.fullKey === full);
  if (!cands.length) {
    cands = contacts.filter(c => c.lastKey === last && firstNameCompatible(c.firstToken, first));
  }
  // Collapse candidates that are the same person (same canonical name).
  const distinct = [...new Map(cands.map(c => [c.canonicalName.toLowerCase(), c])).values()];

  if (distinct.length === 0) return { roster: true, person: 'none' };
  if (distinct.length > 1) {
    return { roster: true, person: 'ambiguous', candidates: distinct.map(c => c.canonicalName) };
  }
  const c = distinct[0];
  return { roster: true, person: 'matched', canonicalName: c.canonicalName, dealIds: c.dealIds };
}

// Write the folder URL to the deal's ue_airline_tickets property.
// Never throws — returns a status object.
async function writeDealUrl(dealIds, folderUrl) {
  if (!dealIds || !dealIds.length) return { status: 'no_match' };
  if (dealIds.length > 1) return { status: 'ambiguous', reason: 'contact is on multiple Unearthed deals', deal_ids: dealIds };
  const dealId = dealIds[0];
  try {
    const resp = await hsFetch(`/crm/v3/objects/deals/${encodeURIComponent(dealId)}`, {
      method: 'PATCH',
      body: JSON.stringify({ properties: { [UE_TICKETS_PROPERTY]: folderUrl } }),
    });
    if (!resp.ok) {
      const detail = await resp.text().catch(() => '');
      return { status: 'error', reason: `HubSpot PATCH ${resp.status}`, detail: detail.slice(0, 200) };
    }
    return { status: 'written', deal_id: dealId, deal_url: dealUrl(dealId) };
  } catch (e) {
    return { status: 'error', reason: e.message };
  }
}

// --------------------------------------------------------------------------
// Action: upload
// --------------------------------------------------------------------------
async function handleUpload(body) {
  if (!body.data || !body.filename) return bad('filename and base64 data required');
  const buffer = Buffer.from(body.data, 'base64');
  const mimeType = body.mimeType || 'application/pdf';

  // 0. Program is required — it scopes matching and nests the Drive folders.
  const programId = body.program_id;
  if (!programId) return bad('program_id required — pick an Unearthed program before uploading.', 400);
  let programName;
  try {
    programName = await programNameById(programId);
  } catch (e) {
    return bad(`Couldn't load programs: ${e.message}`, 502);
  }
  if (!programName) return bad(`Unknown program_id "${programId}".`, 400);

  // Program container folder (under the root parent).
  let programFolder;
  try {
    programFolder = await ensureProgramFolder(programName);
  } catch (e) {
    return bad(`Couldn't create the program folder "${programName}": ${e.message}. Check the service account is a Content Manager member of the Shared Drive.`, 502);
  }

  // 1. Read the passenger name(s) off the ticket.
  let names;
  try {
    names = await readPassengerNames(buffer, mimeType);
  } catch (e) {
    return bad(`Could not read ticket: ${e.message}`, 502);
  }
  if (!names.length) {
    return bad('No passenger name could be read from this file — please file it manually.', 422);
  }

  // 2. For each passenger: resolve against THIS program's roster, then file
  //    into a student folder NESTED under the program folder.
  //    - Matched  → folder named by the canonical HubSpot contact name; URL
  //                 written to that student's deal.
  //    - No / ambiguous match → BACKUP: own folder from the ticket name,
  //                 flagged for review.
  //    (Group bookings on one PDF land in every passenger's folder.)
  const filed = [];
  for (const student of names) {
    const resolved = await resolveStudent(student, programId);

    let folderName, hubspot;
    if (resolved.person === 'matched') {
      folderName = resolved.canonicalName;
    } else {
      folderName = student; // backup: own folder from the ticket name
      if (!resolved.roster) {
        hubspot = { status: 'skipped', reason: resolved.error ? `roster error: ${resolved.error}` : 'HUBSPOT_TOKEN not set' };
      } else if (resolved.person === 'ambiguous') {
        hubspot = { status: 'ambiguous', reason: 'name matched more than one contact in this program', candidates: resolved.candidates };
      } else {
        hubspot = { status: 'no_match' };
      }
    }

    let folder, file;
    try {
      folder = await ensureStudentFolder(folderName, programFolder.id);
    } catch (e) {
      return bad(`Couldn't create the Drive folder "${folderName}": ${e.message}. Check that the service account is a Content Manager member of the Shared Drive.`, 502);
    }
    try {
      file = await uploadIntoFolder({ folderId: folder.id, filename: body.filename, mimeType, buffer });
    } catch (e) {
      return bad(`Created the folder "${folderName}" but couldn't upload the ticket into it: ${e.message}. This usually means the service account lacks write access to the Shared Drive, or the configured folder isn't actually inside a Shared Drive (service accounts have no personal storage quota). Run ?action=debug to confirm.`, 502);
    }

    // Write the student folder URL to their matched deal.
    if (resolved.roster && resolved.person === 'matched') {
      hubspot = await writeDealUrl(resolved.dealIds, folder.url);
    }

    filed.push({
      student,
      matched_name: resolved.person === 'matched' ? resolved.canonicalName : null,
      needs_review: !!(resolved.roster && resolved.person !== 'matched'),
      folder, file, hubspot,
    });
  }

  return ok({
    ok: true,
    filename: body.filename,
    program: { id: String(programId), name: programName, url: programFolder.url },
    students: names,
    multi_passenger: names.length > 1,
    filed,
  });
}

// Resolve the program folder (no create) for a given program_id. Returns
// { program:{id,name}, folder:{id,url}|null } or throws on bad id.
async function resolveProgramFolder(programId) {
  if (!programId) { const e = new Error('program_id required'); e.code = 400; throw e; }
  const name = await programNameById(programId);
  if (!name) { const e = new Error(`Unknown program_id "${programId}"`); e.code = 400; throw e; }
  const folder = await findFolderByName(name, parentFolderId());
  return { program: { id: String(programId), name }, folder };
}

// --------------------------------------------------------------------------
// Action: list (student folders + links) — scoped to one program
// --------------------------------------------------------------------------
async function handleList(qs) {
  let pf;
  try { pf = await resolveProgramFolder(qs.program_id); }
  catch (e) { return bad(e.message, e.code || 500); }
  if (!pf.folder) return ok({ program: pf.program, students: [] });

  const d = await drive();
  const folders = [];
  let pageToken;
  do {
    const res = await d.files.list({
      q: `'${driveEsc(pf.folder.id)}' in parents and mimeType = '${FOLDER_MIME}' and trashed = false`,
      fields: 'nextPageToken, files(id, name, webViewLink)',
      orderBy: 'name', pageSize: 200, pageToken,
      supportsAllDrives: true, includeItemsFromAllDrives: true,
    });
    for (const f of (res.data.files || [])) {
      let files = [];
      try {
        const inner = await d.files.list({
          q: `'${driveEsc(f.id)}' in parents and trashed = false`,
          fields: 'files(id, name, webViewLink)', orderBy: 'name', pageSize: 1000,
          supportsAllDrives: true, includeItemsFromAllDrives: true,
        });
        files = (inner.data.files || []).map(x => ({ name: x.name, url: x.webViewLink }));
      } catch (_) {}
      folders.push({ student: f.name, folder_id: f.id, url: f.webViewLink, file_count: files.length, files });
    }
    pageToken = res.data.nextPageToken;
  } while (pageToken);

  return ok({ program: pf.program, students: folders });
}

// --------------------------------------------------------------------------
// Action: dedupe-scan — find duplicate student folders (same person, different
// spelling) within ONE program by resolving each folder name to that program's
// roster. Folders resolving to the same canonical contact are a merge group.
// --------------------------------------------------------------------------
async function listStudentFolders(programFolderId) {
  const d = await drive();
  const out = [];
  let pageToken;
  do {
    const res = await d.files.list({
      q: `'${driveEsc(programFolderId)}' in parents and mimeType = '${FOLDER_MIME}' and trashed = false`,
      fields: 'nextPageToken, files(id, name, webViewLink)',
      orderBy: 'name', pageSize: 200, pageToken,
      supportsAllDrives: true, includeItemsFromAllDrives: true,
    });
    for (const f of (res.data.files || [])) {
      let count = 0;
      try {
        const inner = await d.files.list({
          q: `'${driveEsc(f.id)}' in parents and trashed = false`,
          fields: 'files(id)', pageSize: 1000,
          supportsAllDrives: true, includeItemsFromAllDrives: true,
        });
        count = (inner.data.files || []).length;
      } catch (_) {}
      out.push({ id: f.id, name: f.name, url: f.webViewLink, file_count: count });
    }
    pageToken = res.data.nextPageToken;
  } while (pageToken);
  return out;
}

async function handleDedupeScan(qs) {
  if (!hubspotToken()) return bad('Dedupe needs HUBSPOT_TOKEN (it matches folders to the program roster).', 400);
  let pf;
  try { pf = await resolveProgramFolder(qs.program_id); }
  catch (e) { return bad(e.message, e.code || 500); }
  if (!pf.folder) return ok({ program: pf.program, groups: [] });

  const folders = await listStudentFolders(pf.folder.id);

  // Group folders by the canonical contact their name resolves to (within program).
  const groups = new Map(); // canonicalName -> [folder, ...]
  for (const f of folders) {
    const r = await resolveStudent(f.name, pf.program.id);
    if (r.roster && r.person === 'matched') {
      const key = r.canonicalName;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(f);
    }
  }

  // Keep groups with a real duplicate (2+ folders) or a single mis-named folder.
  const result = [];
  for (const [canonical, fols] of groups.entries()) {
    const needsRename = fols.length === 1 && fols[0].name !== canonical;
    if (fols.length < 2 && !needsRename) continue;
    const exact = fols.find(f => f.name === canonical);
    const keep = exact || fols.slice().sort((a, b) => b.file_count - a.file_count || a.name.length - b.name.length)[0];
    const merge = fols.filter(f => f.id !== keep.id);
    result.push({
      canonical_name: canonical,
      program_folder_id: pf.folder.id,
      keep: { id: keep.id, name: keep.name, url: keep.url, file_count: keep.file_count },
      candidates: fols.map(f => ({ id: f.id, name: f.name, file_count: f.file_count })),
      merge: merge.map(f => ({ id: f.id, name: f.name, file_count: f.file_count })),
      needs_rename: needsRename,
    });
  }
  return ok({ program: pf.program, groups: result });
}

// --------------------------------------------------------------------------
// Action: merge — move all files from merge_folder_ids into keep_folder_id,
// trash the emptied folders, rename keep to the canonical name, then re-write
// the (now canonical) folder URL to the matched Unearthed deal.
// --------------------------------------------------------------------------
async function handleMerge(body) {
  const keepId = body.keep_folder_id;
  const mergeIds = Array.isArray(body.merge_folder_ids) ? body.merge_folder_ids : [];
  if (!keepId) return bad('keep_folder_id required');
  if (!mergeIds.length) return bad('merge_folder_ids (non-empty array) required');
  if (!body.program_id) return bad('program_id required');

  const d = await drive();

  // Determine the program folder the targets must live inside.
  let programFolderId = body.program_folder_id;
  if (!programFolderId) {
    let pf;
    try { pf = await resolveProgramFolder(body.program_id); }
    catch (e) { return bad(e.message, e.code || 500); }
    if (!pf.folder) return bad('Program folder not found.', 400);
    programFolderId = pf.folder.id;
  }

  // Safety: confirm every folder is a direct child of THIS program folder.
  async function assertChild(id) {
    const meta = await d.files.get({ fileId: id, fields: 'id, name, parents', supportsAllDrives: true });
    if (!(meta.data.parents || []).includes(programFolderId)) {
      throw new Error(`Folder ${id} is not inside the selected program folder — refusing to touch it.`);
    }
    return meta.data;
  }
  try { await assertChild(keepId); } catch (e) { return bad(e.message, 400); }

  let movedFiles = 0;
  const trashed = [];
  for (const mId of mergeIds) {
    let meta;
    try { meta = await assertChild(mId); } catch (e) { return bad(e.message, 400); }

    // Move every file out of the merge folder into keep.
    let pageToken;
    do {
      const res = await d.files.list({
        q: `'${driveEsc(mId)}' in parents and trashed = false`,
        fields: 'nextPageToken, files(id, parents)', pageSize: 200, pageToken,
        supportsAllDrives: true, includeItemsFromAllDrives: true,
      });
      for (const f of (res.data.files || [])) {
        await d.files.update({
          fileId: f.id,
          addParents: keepId,
          removeParents: (f.parents || [mId]).join(','),
          fields: 'id',
          supportsAllDrives: true,
        });
        movedFiles++;
      }
      pageToken = res.data.nextPageToken;
    } while (pageToken);

    // Trash the now-empty merge folder (reversible, unlike delete).
    try {
      await d.files.update({ fileId: mId, requestBody: { trashed: true }, supportsAllDrives: true });
      trashed.push({ id: mId, name: meta.name });
    } catch (e) {
      console.warn(`Could not trash merged folder ${mId}: ${e.message}`);
    }
  }

  // Rename keep to canonical if requested, and re-resolve for the HubSpot write.
  const keepMeta = await d.files.get({ fileId: keepId, fields: 'id, name, webViewLink', supportsAllDrives: true });
  let keepName = keepMeta.data.name;
  if (body.canonical_name && safeFolderName(body.canonical_name) !== keepName) {
    try {
      const renamed = await d.files.update({
        fileId: keepId,
        requestBody: { name: safeFolderName(body.canonical_name) },
        fields: 'id, name, webViewLink',
        supportsAllDrives: true,
      });
      keepName = renamed.data.name;
    } catch (e) {
      console.warn(`Could not rename keep folder ${keepId}: ${e.message}`);
    }
  }

  // The merged-away folder URLs are now dead — push the surviving folder's URL
  // to the matched deal so HubSpot points at the right place.
  let hubspot = { status: 'skipped' };
  const resolved = await resolveStudent(keepName, body.program_id);
  if (resolved.roster && resolved.person === 'matched') {
    hubspot = await writeDealUrl(resolved.dealIds, keepMeta.data.webViewLink);
  } else if (resolved.roster) {
    hubspot = { status: resolved.person === 'ambiguous' ? 'ambiguous' : 'no_match' };
  }

  return ok({
    ok: true,
    keep: { id: keepId, name: keepName, url: keepMeta.data.webViewLink },
    moved_files: movedFiles,
    trashed_folders: trashed,
    hubspot,
  });
}

// --------------------------------------------------------------------------
// Action: programs — Unearthed programs for the uploader's dropdown
// --------------------------------------------------------------------------
async function handlePrograms() {
  if (!hubspotToken()) return bad('HUBSPOT_TOKEN not set — cannot load programs.', 400);
  try {
    const programs = await getProgramsList();
    return ok({ programs });
  } catch (e) {
    return bad(`Couldn't load programs: ${e.message}`, 502);
  }
}

// Introspection: confirm the object id, detected name property, a few sample
// program names, and whether the first program actually associates to deals.
async function handleProgramProps() {
  if (!hubspotToken()) return bad('HUBSPOT_TOKEN not set.', 400);
  const report = { object_type: PROGRAM_OBJECT_TYPE };

  // Schema primary display property.
  try {
    const sresp = await hsFetch(`/crm/v3/schemas/${PROGRAM_OBJECT_TYPE}`);
    if (sresp.ok) {
      const schema = await sresp.json();
      report.schema_primary_display_property = schema.primaryDisplayProperty || null;
      report.object_labels = schema.labels || null;
    } else {
      report.schema_status = sresp.status;
    }
  } catch (e) { report.schema_error = e.message; }

  // String properties available on the object.
  try {
    const presp = await hsFetch(`/crm/v3/properties/${PROGRAM_OBJECT_TYPE}`);
    if (presp.ok) {
      const pdata = await presp.json();
      report.string_properties = (pdata.results || [])
        .filter(p => (p.type === 'string' || p.fieldType === 'text') && !String(p.name).startsWith('hs_'))
        .map(p => ({ name: p.name, label: p.label }));
    }
  } catch (e) { report.properties_error = e.message; }

  try { report.detected_name_property = await getProgramNameProp(); }
  catch (e) { report.name_property_error = e.message; }

  // A raw sample record with ALL its property values, so you can spot the right field.
  try {
    const r = await hsFetch(`/crm/v3/objects/${PROGRAM_OBJECT_TYPE}?limit=3&properties=${encodeURIComponent((report.string_properties || []).map(p => p.name).join(','))}`);
    if (r.ok) {
      const d = await r.json();
      report.sample_records = (d.results || []).map(o => ({ id: o.id, properties: o.properties }));
    }
  } catch (e) { report.sample_records_error = e.message; }

  // What the dropdown currently produces + first program's contact/deal resolution.
  try {
    const programs = await getProgramsList();
    report.dropdown_count = programs.length;
    report.dropdown_sample = programs.slice(0, 10);
    if (programs.length) {
      const idx = await getProgramIndex(programs[0].id);
      report.first_program = {
        name: programs[0].name,
        contact_count: idx.contacts.length,
        deal_count: idx.dealCount,
        sample_contacts: idx.contacts.slice(0, 5).map(c => c.canonicalName),
      };
    }
  } catch (e) { report.dropdown_error = e.message; }

  return ok(report);
}

// --------------------------------------------------------------------------
// Action: debug
// --------------------------------------------------------------------------
async function handleDebug() {
  const report = { env: {} };
  report.env.ANTHROPIC_API_KEY = !!process.env.ANTHROPIC_API_KEY;
  report.env.GOOGLE_SERVICE_ACCOUNT_JSON = !!process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  report.env.FLIGHT_TICKETS_DRIVE_FOLDER_ID = !!process.env.FLIGHT_TICKETS_DRIVE_FOLDER_ID;

  let d;
  try {
    d = await drive();
    const meta = await d.files.get({
      fileId: parentFolderId(),
      // driveId tells us if it lives in a Shared Drive; capabilities tells us
      // whether the service account may actually create children here.
      fields: 'id, name, mimeType, driveId, capabilities(canAddChildren)',
      supportsAllDrives: true,
    });
    report.parent_folder = {
      ok: true,
      id: meta.data.id,
      name: meta.data.name,
      in_shared_drive: !!meta.data.driveId,
      drive_id: meta.data.driveId || null,
      can_add_children: meta.data.capabilities ? meta.data.capabilities.canAddChildren : null,
    };
  } catch (e) {
    report.parent_folder = { ok: false, error: e.message };
    return ok(report);
  }

  // Real write test: create a tiny file in the parent, then delete it. This
  // reproduces exactly what an upload does and surfaces the true error
  // (quota / permission / shared-drive) instead of a vague 404 later.
  try {
    const created = await d.files.create({
      requestBody: { name: `__write-test-${Date.now()}.txt`, parents: [parentFolderId()] },
      media: { mimeType: 'text/plain', body: require('stream').Readable.from(Buffer.from('ping')) },
      fields: 'id',
      supportsAllDrives: true,
    });
    report.write_test = { ok: true, created_id: created.data.id };
    try {
      await d.files.delete({ fileId: created.data.id, supportsAllDrives: true });
      report.write_test.cleaned_up = true;
    } catch (e) {
      report.write_test.cleaned_up = false;
      report.write_test.cleanup_error = e.message;
    }
  } catch (e) {
    report.write_test = { ok: false, error: e.message };
  }

  return ok(report);
}

// --------------------------------------------------------------------------
// Entry point
// --------------------------------------------------------------------------
exports.handler = async (event) => {
  try {
    const method = event.httpMethod;
    const qs = event.queryStringParameters || {};
    const body = event.body
      ? (event.isBase64Encoded ? JSON.parse(Buffer.from(event.body, 'base64').toString('utf8')) : JSON.parse(event.body))
      : {};
    const action = qs.action || body.action;

    if (method === 'GET'  && action === 'debug')        return await handleDebug();
    if (method === 'GET'  && action === 'programs')     return await handlePrograms();
    if (method === 'GET'  && action === 'program-props') return await handleProgramProps();
    if (method === 'GET'  && action === 'list')         return await handleList(qs);
    if (method === 'GET'  && action === 'dedupe-scan')  return await handleDedupeScan(qs);
    if (method === 'POST' && action === 'upload')       return await handleUpload(body);
    if (method === 'POST' && action === 'merge')        return await handleMerge(body);

    return bad(`unknown action '${action}' for method ${method}`);
  } catch (err) {
    console.error('flight-tickets error:', err);
    return bad(err.message || 'server error', 500);
  }
};

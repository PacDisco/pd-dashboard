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
 *   UNEARTHED_PROGRAM_MATCH         (substring that identifies Unearthed program
 *                                    objects by name; default "unearthed")
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

// Find a child subfolder by name; create it (shareable) if missing.
async function ensureStudentFolder(studentName) {
  const d = await drive();
  const parent = parentFolderId();
  const safe = safeFolderName(studentName);

  const q = `'${driveEsc(parent)}' in parents and name = '${driveEsc(safe)}' ` +
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
    requestBody: { name: safe, mimeType: FOLDER_MIME, parents: [parent] },
    fields: 'id, name, webViewLink',
    supportsAllDrives: true,
  });

  // Make the folder shareable: anyone with the link can VIEW. This is the
  // link you hand to the student. Remove this block if you'd rather keep
  // folders private and share explicitly.
  try {
    await d.permissions.create({
      fileId: created.data.id,
      requestBody: { role: 'reader', type: 'anyone' },
      supportsAllDrives: true,
    });
  } catch (e) {
    // Non-fatal: folder still exists, just not link-shared (e.g. domain policy
    // blocks anyone-links). Surface it but don't fail the upload.
    console.warn(`Could not set anyone-link on folder ${created.data.id}: ${e.message}`);
  }

  return { id: created.data.id, name: created.data.name, url: created.data.webViewLink, created: true };
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
// "Unearthed programs" = entries in the custom Program object (2-58411705)
// whose name matches UNEARTHED_PROGRAM_MATCH (default "unearthed"). We pull the
// deals associated to those programs, then the contacts on those deals, and
// build a name -> deal index. A folder is only written when its student name
// resolves to EXACTLY ONE Unearthed deal; otherwise we skip and report.
// --------------------------------------------------------------------------
const HUBSPOT_API = 'https://api.hubapi.com';
const HUBSPOT_PORTAL_ID = '3855728';
const PROGRAM_OBJECT_TYPE = '2-58411705';
const UE_TICKETS_PROPERTY = 'ue_airline_tickets';
const UNMATCHED_FOLDER_NAME = 'Unmatched — Needs Review';

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

// Cache the Unearthed name->deals index briefly so a batch of uploads doesn't
// rebuild it for every file. (Warm-Lambda memory; TTL keeps it fresh-ish.)
let _ueIndex = { at: 0, data: null };
const UE_INDEX_TTL_MS = 60 * 1000;

async function getUnearthedIndex() {
  if (_ueIndex.data && Date.now() - _ueIndex.at < UE_INDEX_TTL_MS) return _ueIndex.data;

  // 1. Unearthed program objects.
  const isUnearthed = unearthedMatcher();
  const programIds = [];
  let after = 0, more = true;
  while (more) {
    const params = new URLSearchParams({ limit: '100', properties: 'pacific_discovery_program' });
    if (after) params.set('after', String(after));
    const resp = await hsFetch(`/crm/v3/objects/${PROGRAM_OBJECT_TYPE}?${params}`);
    if (!resp.ok) throw new Error(`Program objects fetch failed: ${resp.status}`);
    const data = await resp.json();
    for (const obj of (data.results || [])) {
      if (isUnearthed(obj.properties && obj.properties.pacific_discovery_program)) programIds.push(String(obj.id));
    }
    if (data.paging && data.paging.next) after = data.paging.next.after; else more = false;
  }

  // 2. Deals associated to those programs.
  const dealIdSet = new Set();
  for (let i = 0; i < programIds.length; i += 100) {
    const batch = programIds.slice(i, i + 100);
    const resp = await hsFetch(`/crm/v4/associations/${PROGRAM_OBJECT_TYPE}/deals/batch/read`, {
      method: 'POST', body: JSON.stringify({ inputs: batch.map(id => ({ id })) }),
    });
    if (!resp.ok) continue;
    const data = await resp.json();
    for (const r of (data.results || [])) for (const t of (r.to || [])) dealIdSet.add(String(t.toObjectId));
  }
  const dealIds = [...dealIdSet];

  // 3. Deal -> contacts associations.
  const dealToContacts = new Map();
  const contactIdSet = new Set();
  for (let i = 0; i < dealIds.length; i += 100) {
    const batch = dealIds.slice(i, i + 100);
    const resp = await hsFetch(`/crm/v4/associations/deals/contacts/batch/read`, {
      method: 'POST', body: JSON.stringify({ inputs: batch.map(id => ({ id })) }),
    });
    if (!resp.ok) continue;
    const data = await resp.json();
    for (const r of (data.results || [])) {
      const dealId = r.from && String(r.from.id);
      const cIds = (r.to || []).map(t => String(t.toObjectId));
      if (dealId) dealToContacts.set(dealId, cIds);
      cIds.forEach(c => contactIdSet.add(c));
    }
  }

  // 4. Contact names.
  const contactName = new Map();
  const cIds = [...contactIdSet];
  for (let i = 0; i < cIds.length; i += 100) {
    const batch = cIds.slice(i, i + 100);
    const resp = await hsFetch(`/crm/v3/objects/contacts/batch/read`, {
      method: 'POST',
      body: JSON.stringify({ properties: ['firstname', 'lastname'], inputs: batch.map(id => ({ id })) }),
    });
    if (!resp.ok) continue;
    const data = await resp.json();
    for (const c of (data.results || [])) {
      const p = c.properties || {};
      contactName.set(String(c.id), [p.firstname, p.lastname].filter(Boolean).join(' ').trim());
    }
  }

  // 5. Build one record per Unearthed CONTACT (the roster we match against).
  //    contactId -> { canonicalName, fullKey, lastKey, firstToken, dealIds:Set }
  const contactToDeals = new Map();
  for (const [dealId, cList] of dealToContacts.entries()) {
    for (const cId of cList) {
      if (!contactToDeals.has(cId)) contactToDeals.set(cId, new Set());
      contactToDeals.get(cId).add(dealId);
    }
  }
  const contacts = [];
  for (const [cId, deals] of contactToDeals.entries()) {
    const raw = contactName.get(cId);
    const canonicalName = normalizeName(raw);
    if (!canonicalName) continue;
    const tokens = canonicalName.toLowerCase().split(/\s+/).filter(Boolean);
    contacts.push({
      contactId: cId,
      canonicalName,
      fullKey: tokens.join(' '),
      lastKey: tokens[tokens.length - 1],
      firstToken: tokens[0],
      dealIds: [...deals],
    });
  }

  _ueIndex = { at: Date.now(), data: { contacts, programCount: programIds.length, dealCount: dealIds.length } };
  return _ueIndex.data;
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

// Resolve a ticket name against the Unearthed roster.
// Returns: { roster, person, canonicalName, dealIds }
//   roster:  true if the roster was available to match against
//   person:  'matched' | 'none' | 'ambiguous'
async function resolveStudent(ticketName) {
  if (!hubspotToken()) return { roster: false };
  let data;
  try { data = await getUnearthedIndex(); }
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

  // 2. For each passenger: resolve to the Unearthed roster, then file.
  //    - Matched  → folder named by the canonical HubSpot contact name (so
  //                 ticket spelling variants land in ONE folder), URL written
  //                 to the deal.
  //    - No / ambiguous match → BACKUP: the student gets their OWN folder named
  //                 from the ticket, flagged for review (not a shared bucket).
  //    - Roster unavailable (no HUBSPOT_TOKEN) → fall back to the ticket name.
  //    (Group bookings on one PDF land in every passenger's folder.)
  const filed = [];
  for (const student of names) {
    const resolved = await resolveStudent(student);

    let folderName, hubspot;
    if (resolved.person === 'matched') {
      folderName = resolved.canonicalName;        // canonical name unifies variants
    } else {
      // Backup: each unmatched student gets their own folder from the ticket name.
      folderName = student;
      if (!resolved.roster) {
        hubspot = { status: 'skipped', reason: resolved.error ? `roster error: ${resolved.error}` : 'HUBSPOT_TOKEN not set' };
      } else if (resolved.person === 'ambiguous') {
        hubspot = { status: 'ambiguous', reason: 'name matched more than one Unearthed contact', candidates: resolved.candidates };
      } else {
        hubspot = { status: 'no_match' };
      }
    }

    let folder, file;
    try {
      folder = await ensureStudentFolder(folderName);
    } catch (e) {
      return bad(`Couldn't create the Drive folder "${folderName}": ${e.message}. Check that the service account is a Content Manager member of the Shared Drive.`, 502);
    }
    try {
      file = await uploadIntoFolder({ folderId: folder.id, filename: body.filename, mimeType, buffer });
    } catch (e) {
      return bad(`Created the folder "${folderName}" but couldn't upload the ticket into it: ${e.message}. This usually means the service account lacks write access to the Shared Drive, or the configured folder isn't actually inside a Shared Drive (service accounts have no personal storage quota). Run ?action=debug to confirm.`, 502);
    }

    // Write the folder URL to the matched deal (only when we have a clean match).
    if (resolved.roster && resolved.person === 'matched') {
      hubspot = await writeDealUrl(resolved.dealIds, folder.url);
    }

    filed.push({
      student,                                   // name as read off the ticket
      matched_name: resolved.person === 'matched' ? resolved.canonicalName : null,
      needs_review: !!(resolved.roster && resolved.person !== 'matched'),
      folder, file, hubspot,
    });
  }

  return ok({
    ok: true,
    filename: body.filename,
    students: names,
    multi_passenger: names.length > 1,
    filed,
  });
}

// --------------------------------------------------------------------------
// Action: list (student folders + links)
// --------------------------------------------------------------------------
async function handleList() {
  const d = await drive();
  const parent = parentFolderId();
  const folders = [];
  let pageToken;
  do {
    const res = await d.files.list({
      q: `'${driveEsc(parent)}' in parents and mimeType = '${FOLDER_MIME}' and trashed = false`,
      fields: 'nextPageToken, files(id, name, webViewLink)',
      orderBy: 'name',
      pageSize: 200,
      pageToken,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });
    for (const f of (res.data.files || [])) {
      // List the files uploaded inside each student folder.
      let files = [];
      try {
        const inner = await d.files.list({
          q: `'${driveEsc(f.id)}' in parents and trashed = false`,
          fields: 'files(id, name, webViewLink)',
          orderBy: 'name',
          pageSize: 1000,
          supportsAllDrives: true,
          includeItemsFromAllDrives: true,
        });
        files = (inner.data.files || []).map(x => ({ name: x.name, url: x.webViewLink }));
      } catch (_) {}
      folders.push({ student: f.name, folder_id: f.id, url: f.webViewLink, file_count: files.length, files });
    }
    pageToken = res.data.nextPageToken;
  } while (pageToken);

  return ok({ students: folders });
}

// --------------------------------------------------------------------------
// Action: dedupe-scan — find duplicate student folders (same person, different
// spelling) by resolving each folder name to the Unearthed roster. Folders that
// resolve to the same canonical contact are a merge group.
// --------------------------------------------------------------------------
async function listStudentFolders() {
  const d = await drive();
  const parent = parentFolderId();
  const out = [];
  let pageToken;
  do {
    const res = await d.files.list({
      q: `'${driveEsc(parent)}' in parents and mimeType = '${FOLDER_MIME}' and trashed = false`,
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

async function handleDedupeScan() {
  if (!hubspotToken()) return bad('Dedupe needs HUBSPOT_TOKEN (it matches folders to the Unearthed roster).', 400);
  const folders = await listStudentFolders();

  // Group folders by the canonical contact their name resolves to.
  const groups = new Map(); // canonicalName -> [folder, ...]
  for (const f of folders) {
    if (f.name === UNMATCHED_FOLDER_NAME) continue;
    const r = await resolveStudent(f.name);
    if (r.roster && r.person === 'matched') {
      const key = r.canonicalName;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(f);
    }
  }

  // Keep only groups with a real duplicate (2+ folders) or a single mis-named
  // folder that should be renamed to canonical.
  const result = [];
  for (const [canonical, fols] of groups.entries()) {
    const needsRename = fols.length === 1 && fols[0].name !== canonical;
    if (fols.length < 2 && !needsRename) continue;
    // Keep target: prefer the folder already named canonically, else most files.
    const exact = fols.find(f => f.name === canonical);
    const keep = exact || fols.slice().sort((a, b) => b.file_count - a.file_count || a.name.length - b.name.length)[0];
    const merge = fols.filter(f => f.id !== keep.id);
    result.push({
      canonical_name: canonical,
      keep: { id: keep.id, name: keep.name, url: keep.url, file_count: keep.file_count },
      merge: merge.map(f => ({ id: f.id, name: f.name, file_count: f.file_count })),
      needs_rename: needsRename,
    });
  }
  return ok({ groups: result });
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

  const d = await drive();
  const parent = parentFolderId();

  // Safety: confirm every folder is a direct child of our parent folder.
  async function assertChild(id) {
    const meta = await d.files.get({ fileId: id, fields: 'id, name, parents', supportsAllDrives: true });
    if (!(meta.data.parents || []).includes(parent)) {
      throw new Error(`Folder ${id} is not inside the configured flights folder — refusing to touch it.`);
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
  // to the matched Unearthed deal so HubSpot points at the right place.
  let hubspot = { status: 'skipped' };
  const resolved = await resolveStudent(keepName);
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
    if (method === 'GET'  && action === 'list')         return await handleList();
    if (method === 'GET'  && action === 'dedupe-scan')  return await handleDedupeScan();
    if (method === 'POST' && action === 'upload')       return await handleUpload(body);
    if (method === 'POST' && action === 'merge')        return await handleMerge(body);

    return bad(`unknown action '${action}' for method ${method}`);
  } catch (err) {
    console.error('flight-tickets error:', err);
    return bad(err.message || 'server error', 500);
  }
};

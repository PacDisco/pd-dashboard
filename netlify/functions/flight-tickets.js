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

  // 5. Build nameKey -> Set(dealId).
  const index = new Map();
  for (const [dealId, cList] of dealToContacts.entries()) {
    for (const cId of cList) {
      const key = nameKey(contactName.get(cId));
      if (!key) continue;
      if (!index.has(key)) index.set(key, new Set());
      index.get(key).add(dealId);
    }
  }

  _ueIndex = { at: Date.now(), data: { index, programCount: programIds.length, dealCount: dealIds.length } };
  return _ueIndex.data;
}

function dealUrl(dealId) {
  return `https://app.hubspot.com/contacts/${HUBSPOT_PORTAL_ID}/record/0-3/${dealId}`;
}

// Match a student to a single Unearthed deal and write the folder URL.
// Returns a status object (never throws — HubSpot issues must not fail the upload).
async function writeFolderToHubspot(student, folderUrl) {
  if (!hubspotToken()) return { status: 'skipped', reason: 'HUBSPOT_TOKEN not set' };
  try {
    const { index } = await getUnearthedIndex();
    const key = nameKey(student);
    const deals = index.get(key);
    if (!deals || deals.size === 0) return { status: 'no_match' };
    if (deals.size > 1) return { status: 'ambiguous', deal_ids: [...deals] };

    const dealId = [...deals][0];
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

  // 2. For each passenger: ensure their folder, drop the file in.
  //    (Group bookings on one PDF land in every passenger's folder.)
  const filed = [];
  for (const student of names) {
    let folder, file;
    try {
      folder = await ensureStudentFolder(student);
    } catch (e) {
      return bad(`Couldn't create the Drive folder for "${student}": ${e.message}. Check that the service account is a Content Manager member of the Shared Drive.`, 502);
    }
    try {
      file = await uploadIntoFolder({ folderId: folder.id, filename: body.filename, mimeType, buffer });
    } catch (e) {
      return bad(`Created the folder for "${student}" but couldn't upload the ticket into it: ${e.message}. This usually means the service account lacks write access to the Shared Drive, or the configured folder isn't actually inside a Shared Drive (service accounts have no personal storage quota). Run ?action=debug to confirm.`, 502);
    }

    // Push the folder URL into the matching Unearthed deal's ue_airline_tickets.
    // Never fails the upload — HubSpot result is reported per student.
    const hubspot = await writeFolderToHubspot(student, folder.url);

    filed.push({ student, folder, file, hubspot });
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

    if (method === 'GET'  && action === 'debug')  return await handleDebug();
    if (method === 'GET'  && action === 'list')   return await handleList();
    if (method === 'POST' && action === 'upload') return await handleUpload(body);

    return bad(`unknown action '${action}' for method ${method}`);
  } catch (err) {
    console.error('flight-tickets error:', err);
    return bad(err.message || 'server error', 500);
  }
};

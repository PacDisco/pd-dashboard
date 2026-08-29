/**
 * Program Schedule — single Netlify Function with action routing.
 * Backs the "EDA Group Programs Calendar" tracker: a simple, at-a-glance list of programs
 * across all brands (program name, brand, location, start/end dates, headcount,
 * notes). Separate from flight-programs (which drives the student flight portal).
 *
 * Routes (query ?action=... or JSON body { action }):
 *   - list    GET   -> programs, always ordered by date (add ?include_inactive=1 for the archive view)
 *   - create  POST  -> { name, brand, location?, start_date, end_date?, participants?, notes? }
 *   - update  POST  -> { id, patch: { ...any of the above + is_active } }
 *   - delete  POST  -> { id }
 *
 * Required env var:
 *   NETLIFY_DATABASE_URL   (auto-injected when Netlify DB / Neon is provisioned)
 *
 * Dates are plain calendar dates (YYYY-MM-DD) — no timezone handling, so what
 * you type is exactly what is stored and shown.
 */

const { neon } = require('@neondatabase/serverless');

let _sql;
function sql() {
  if (!_sql) _sql = neon(process.env.NETLIFY_DATABASE_URL);
  return _sql;
}

// Brands offered in the UI. Kept permissive server-side: unknown brands are
// still accepted (trimmed) so the list can grow without a code change, but the
// value must be non-empty.
// 'Leave' is last on purpose: the first five are business units, and Leave is a
// category for time nobody is running a program. Keeping it at the end of the
// list keeps the brands reading as brands.
const BRANDS = ['EDA Group', 'Unearthed Education', 'Pacific Discovery', 'Pure Exploration', 'Conference', 'Leave'];

const JSON_HEADERS = { 'Content-Type': 'application/json' };
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function ok(body)             { return { statusCode: 200, headers: { ...JSON_HEADERS, ...CORS_HEADERS }, body: JSON.stringify(body) }; }
function bad(msg, code = 400) { return { statusCode: code, headers: { ...JSON_HEADERS, ...CORS_HEADERS }, body: JSON.stringify({ error: msg }) }; }

// A calendar date "YYYY-MM-DD". Accepts a full ISO/datetime and keeps only the
// date part, so it round-trips cleanly regardless of what the client sends.
function coerceDate(label, raw) {
  if (raw === null || raw === undefined || String(raw).trim() === '') {
    throw new Error(`${label} is required`);
  }
  const s = String(raw).trim();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) throw new Error(`Invalid date for ${label}: ${raw}`);
  const [ , y, mo, d ] = m;
  // Validate it's a real calendar date (e.g. rejects 2026-02-31).
  const dt = new Date(`${y}-${mo}-${d}T00:00:00Z`);
  if (isNaN(dt.getTime()) || dt.getUTCMonth() + 1 !== Number(mo) || dt.getUTCDate() !== Number(d)) {
    throw new Error(`Invalid date for ${label}: ${raw}`);
  }
  return `${y}-${mo}-${d}`;
}
function optDate(label, raw) {
  if (raw === null || raw === undefined || String(raw).trim() === '') return null;
  return coerceDate(label, raw);
}
function brand(raw) {
  const b = String(raw || '').trim();
  if (!b) throw new Error('brand is required');
  return b;
}
function optText(raw) {
  if (raw === null || raw === undefined || String(raw).trim() === '') return null;
  return String(raw).trim();
}
function optInt(label, raw) {
  if (raw === null || raw === undefined || String(raw).trim() === '') return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${label} must be a whole number of 0 or more`);
  return n;
}

// --------------------------------------------------------------------------
async function handleList(qs) {
  const includeInactive = qs.include_inactive === '1' || qs.include_inactive === 'true';
  const rows = includeInactive
    ? await sql()`
        SELECT id, name, brand, location, start_date, end_date,
               participants, notes, is_active, updated_at
        FROM program_schedule
        ORDER BY start_date, name
      `
    : await sql()`
        SELECT id, name, brand, location, start_date, end_date,
               participants, notes, is_active, updated_at
        FROM program_schedule
        WHERE is_active = TRUE
        ORDER BY start_date, name
      `;
  return ok({ programs: rows, brands: BRANDS });
}

async function handleCreate(body) {
  let name, br, startDate, endDate, loc, ppl;
  try {
    name      = String(body.name || '').trim();
    if (!name) throw new Error('name required');
    br        = brand(body.brand);
    startDate = coerceDate('start_date', body.start_date);
    endDate   = optDate('end_date', body.end_date);
    loc       = optText(body.location);
    ppl       = optInt('participants', body.participants);
  } catch (e) { return bad(e.message); }
  if (endDate && endDate < startDate) return bad('end date cannot be before start date');

  const notes = optText(body.notes);

  const rows = await sql()`
    INSERT INTO program_schedule
      (name, brand, location, start_date, end_date, participants, notes)
    VALUES
      (${name}, ${br}, ${loc}, ${startDate}, ${endDate}, ${ppl}, ${notes})
    RETURNING *
  `;
  return ok({ program: rows[0] });
}

async function handleUpdate(body) {
  const { id, patch } = body;
  if (!id || !patch) return bad('id and patch required');

  const sets = [];
  const args = [];
  const allow = ['name', 'brand', 'location', 'start_date', 'end_date',
    'participants', 'notes', 'is_active'];
  let nextStart, nextEnd;
  try {
    for (const k of Object.keys(patch)) {
      if (!allow.includes(k)) continue;
      let v = patch[k];
      if (k === 'name')            { v = String(v).trim(); if (!v) throw new Error('name cannot be empty'); }
      else if (k === 'brand')        v = brand(v);
      else if (k === 'location')     v = optText(v);
      else if (k === 'start_date')   { v = coerceDate('start_date', v); nextStart = v; }
      else if (k === 'end_date')     { v = optDate('end_date', v);      nextEnd = v; }
      else if (k === 'participants') v = optInt('participants', v);
      else if (k === 'notes')        v = optText(v);
      else if (k === 'is_active')    v = !!v;
      args.push(v);
      sets.push(`${k} = $${args.length}`);
    }
  } catch (e) { return bad(e.message); }
  if (!sets.length) return bad('no updatable fields in patch');

  // If both endpoints are being changed together, sanity-check the range early
  // for a friendly message (the DB constraint is the ultimate backstop).
  if (nextStart !== undefined && nextEnd) {
    if (nextEnd < nextStart) return bad('end date cannot be before start date');
  }

  args.push(Number(id));
  try {
    const rows = await sql().query(
      `UPDATE program_schedule SET ${sets.join(', ')} WHERE id = $${args.length} RETURNING *`,
      args
    );
    if (!rows.length) return bad('not found', 404);
    return ok({ program: rows[0] });
  } catch (e) {
    if (/date_range_check/i.test(e.message)) return bad('end date cannot be before start date');
    throw e;
  }
}

async function handleDelete(body) {
  const id = Number(body.id);
  if (!id) return bad('id required');
  const rows = await sql()`DELETE FROM program_schedule WHERE id = ${id} RETURNING id`;
  if (!rows.length) return bad('not found', 404);
  return ok({ deleted: id });
}

// --------------------------------------------------------------------------
exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  }
  try {
    const method = event.httpMethod;
    const qs = event.queryStringParameters || {};
    const body = event.body
      ? (event.isBase64Encoded ? JSON.parse(Buffer.from(event.body, 'base64').toString('utf8')) : JSON.parse(event.body))
      : {};
    const action = qs.action || body.action || (method === 'GET' ? 'list' : null);

    if (method === 'GET'  && action === 'list')   return await handleList(qs);
    if (method === 'POST' && action === 'create') return await handleCreate(body);
    if (method === 'POST' && action === 'update') return await handleUpdate(body);
    if (method === 'POST' && action === 'delete') return await handleDelete(body);

    return bad(`unknown action '${action}' for method ${method}`);
  } catch (err) {
    console.error('program-schedule error:', err);
    return bad(err.message || 'server error', 500);
  }
};

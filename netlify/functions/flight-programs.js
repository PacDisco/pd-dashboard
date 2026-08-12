/**
 * Flight Programs — single Netlify Function with action routing.
 * Backs the "Flight Programs" admin dashboard and the public student flight portal.
 *
 * Routes (query ?action=... or JSON body { action }):
 *   - list            GET   -> programs (add ?include_inactive=1 for the admin view)
 *   - create          POST  -> { name, airport_code, arrival_at, ends_at, sort_order?, notes? }
 *   - update          POST  -> { id, patch: { name, airport_code, arrival_at, ends_at, is_active, sort_order, notes } }
 *   - delete          POST  -> { id }
 *
 * Required env var:
 *   NETLIFY_DATABASE_URL   (auto-injected when Netlify DB / Neon is provisioned)
 *
 * The GET `list` response sends permissive CORS headers so the public student
 * portal (hosted elsewhere) can read the active programs. Writes are still
 * protected by the site's Netlify Identity auth-gate on the /flight-programs page.
 */

const { neon } = require('@neondatabase/serverless');

let _sql;
function sql() {
  if (!_sql) _sql = neon(process.env.NETLIFY_DATABASE_URL);
  return _sql;
}

const JSON_HEADERS = { 'Content-Type': 'application/json' };
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function ok(body)               { return { statusCode: 200, headers: { ...JSON_HEADERS, ...CORS_HEADERS }, body: JSON.stringify(body) }; }
function bad(msg, code = 400)   { return { statusCode: code, headers: { ...JSON_HEADERS, ...CORS_HEADERS }, body: JSON.stringify({ error: msg }) }; }

// Coerce a datetime-local / ISO string to an ISO timestamp Postgres accepts.
function coerceDatetime(label, raw) {
  if (raw === null || raw === undefined || raw === '') {
    throw new Error(`${label} is required`);
  }
  const s = String(raw);
  let d;
  if (typeof raw === 'number' || /^\d+$/.test(s)) {
    d = new Date(Number(raw)); // epoch millis
  } else if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(s)) {
    // Naive datetime-local value ("2026-05-15T12:00") with no timezone.
    // Treat it as a FLOATING wall-clock and pin it to UTC, so the stored time
    // does not depend on the server's timezone (Lambda TZ) and round-trips
    // back to the admin form unchanged. The client reads UTC components too.
    d = new Date(s + 'Z');
  } else {
    d = new Date(s); // full ISO with Z or ±offset — respect it as an instant
  }
  if (isNaN(d.getTime())) throw new Error(`Invalid datetime for ${label}: ${raw}`);
  return d.toISOString();
}

function normalizeAirport(raw) {
  const code = String(raw || '').trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) throw new Error(`airport_code must be a 3-letter IATA code (got "${raw}")`);
  return code;
}

// Optional variants for nullable fields (return airport, budget).
function optAirport(label, raw) {
  if (raw === null || raw === undefined || String(raw).trim() === '') return null;
  const code = String(raw).trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) throw new Error(`${label} must be a 3-letter IATA code (got "${raw}")`);
  return code;
}
function optDatetime(label, raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  return coerceDatetime(label, raw);
}
function optText(raw) {
  if (raw === null || raw === undefined || String(raw).trim() === '') return null;
  return String(raw).trim();
}
function optNumber(label, raw) {
  if (raw === null || raw === undefined || String(raw).trim() === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${label} must be a non-negative number`);
  return n;
}
function currency(raw) {
  const c = String(raw || 'USD').trim().toUpperCase().slice(0, 3);
  return /^[A-Z]{3}$/.test(c) ? c : 'USD';
}

// --------------------------------------------------------------------------
async function handleList(qs) {
  const includeInactive = qs.include_inactive === '1' || qs.include_inactive === 'true';
  const rows = includeInactive
    ? await sql()`
        SELECT id, name, airport_code, return_airport, arrival_at, ends_at,
               budget, budget_currency, is_active, sort_order, notes, updated_at
        FROM flight_programs
        ORDER BY sort_order, name
      `
    : await sql()`
        SELECT id, name, airport_code, return_airport, arrival_at, ends_at,
               budget, budget_currency, sort_order
        FROM flight_programs
        WHERE is_active = TRUE
        ORDER BY sort_order, name
      `;
  return ok({ programs: rows });
}

async function handleCreate(body) {
  const name = (body.name || '').trim();
  if (!name) return bad('name required');
  let airport, arrivalAt, endsAt;
  try {
    airport   = normalizeAirport(body.airport_code);
    arrivalAt = coerceDatetime('arrival_at', body.arrival_at);
    endsAt    = coerceDatetime('ends_at', body.ends_at);
  } catch (e) { return bad(e.message); }
  if (new Date(endsAt) < new Date(arrivalAt)) return bad('ends_at cannot be before arrival_at');

  const sortOrder = Number.isFinite(Number(body.sort_order)) ? Number(body.sort_order) : 100;
  const notes = body.notes ? String(body.notes) : null;

  let retAir, budget, cur;
  try {
    retAir = optAirport('return_airport', body.return_airport);
    budget = optNumber('budget', body.budget);
    cur    = currency(body.budget_currency);
  } catch (e) { return bad(e.message); }

  try {
    const rows = await sql()`
      INSERT INTO flight_programs
        (name, airport_code, return_airport, arrival_at, ends_at, sort_order, notes, budget, budget_currency)
      VALUES
        (${name}, ${airport}, ${retAir}, ${arrivalAt}, ${endsAt}, ${sortOrder}, ${notes}, ${budget}, ${cur})
      RETURNING *
    `;
    return ok({ program: rows[0] });
  } catch (e) {
    if (/duplicate key/i.test(e.message)) return bad(`Program "${name}" already exists`, 409);
    throw e;
  }
}

async function handleUpdate(body) {
  const { id, patch } = body;
  if (!id || !patch) return bad('id and patch required');

  const sets = [];
  const args = [];
  const allow = ['name', 'airport_code', 'return_airport', 'arrival_at', 'ends_at',
    'is_active', 'sort_order', 'notes', 'budget', 'budget_currency'];
  try {
    for (const k of Object.keys(patch)) {
      if (!allow.includes(k)) continue;
      let v = patch[k];
      if (k === 'name')                    v = String(v).trim();
      else if (k === 'airport_code')       v = normalizeAirport(v);
      else if (k === 'return_airport')     v = optAirport('return_airport', v);
      else if (k === 'arrival_at')         v = coerceDatetime('arrival_at', v);
      else if (k === 'ends_at')            v = coerceDatetime('ends_at', v);
      else if (k === 'is_active')          v = !!v;
      else if (k === 'sort_order')         v = Number(v) || 0;
      else if (k === 'budget')             v = optNumber('budget', v);
      else if (k === 'budget_currency')    v = currency(v);
      args.push(v);
      sets.push(`${k} = $${args.length}`);
    }
  } catch (e) { return bad(e.message); }
  if (!sets.length) return bad('no updatable fields in patch');

  args.push(Number(id));
  try {
    const rows = await sql().query(
      `UPDATE flight_programs SET ${sets.join(', ')} WHERE id = $${args.length} RETURNING *`,
      args
    );
    if (!rows.length) return bad('not found', 404);
    return ok({ program: rows[0] });
  } catch (e) {
    if (/duplicate key/i.test(e.message)) return bad('That program name already exists', 409);
    throw e;
  }
}

async function handleDelete(body) {
  const id = Number(body.id);
  if (!id) return bad('id required');
  const rows = await sql()`DELETE FROM flight_programs WHERE id = ${id} RETURNING id`;
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
    console.error('flight-programs error:', err);
    return bad(err.message || 'server error', 500);
  }
};

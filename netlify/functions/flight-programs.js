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
  const d = (typeof raw === 'number' || /^\d+$/.test(String(raw)))
    ? new Date(Number(raw))
    : new Date(String(raw)); // "2026-05-15T12:00" or full ISO
  if (isNaN(d.getTime())) throw new Error(`Invalid datetime for ${label}: ${raw}`);
  return d.toISOString();
}

function normalizeAirport(raw) {
  const code = String(raw || '').trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) throw new Error(`airport_code must be a 3-letter IATA code (got "${raw}")`);
  return code;
}

// Optional variants for the (nullable) group-gateway fields.
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

// --------------------------------------------------------------------------
async function handleList(qs) {
  const includeInactive = qs.include_inactive === '1' || qs.include_inactive === 'true';
  const rows = includeInactive
    ? await sql()`
        SELECT id, name, airport_code, arrival_at, ends_at, is_active, sort_order, notes, updated_at,
               gateway_airport, group_out_depart_at, group_out_airline, group_out_flight_no,
               group_back_depart_at, group_back_airline, group_back_flight_no
        FROM flight_programs
        ORDER BY sort_order, name
      `
    : await sql()`
        SELECT id, name, airport_code, arrival_at, ends_at, sort_order,
               gateway_airport, group_out_depart_at, group_out_airline, group_out_flight_no,
               group_back_depart_at, group_back_airline, group_back_flight_no
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

  let gw, gOutAt, gOutAir, gOutNo, gBackAt, gBackAir, gBackNo;
  try {
    gw      = optAirport('gateway_airport', body.gateway_airport);
    gOutAt  = optDatetime('group_out_depart_at', body.group_out_depart_at);
    gOutAir = optText(body.group_out_airline);
    gOutNo  = optText(body.group_out_flight_no);
    gBackAt = optDatetime('group_back_depart_at', body.group_back_depart_at);
    gBackAir= optText(body.group_back_airline);
    gBackNo = optText(body.group_back_flight_no);
  } catch (e) { return bad(e.message); }

  try {
    const rows = await sql()`
      INSERT INTO flight_programs
        (name, airport_code, arrival_at, ends_at, sort_order, notes,
         gateway_airport, group_out_depart_at, group_out_airline, group_out_flight_no,
         group_back_depart_at, group_back_airline, group_back_flight_no)
      VALUES
        (${name}, ${airport}, ${arrivalAt}, ${endsAt}, ${sortOrder}, ${notes},
         ${gw}, ${gOutAt}, ${gOutAir}, ${gOutNo},
         ${gBackAt}, ${gBackAir}, ${gBackNo})
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
  const allow = ['name', 'airport_code', 'arrival_at', 'ends_at', 'is_active', 'sort_order', 'notes',
    'gateway_airport', 'group_out_depart_at', 'group_out_airline', 'group_out_flight_no',
    'group_back_depart_at', 'group_back_airline', 'group_back_flight_no'];
  try {
    for (const k of Object.keys(patch)) {
      if (!allow.includes(k)) continue;
      let v = patch[k];
      if (k === 'name')                       v = String(v).trim();
      else if (k === 'airport_code')          v = normalizeAirport(v);
      else if (k === 'arrival_at')            v = coerceDatetime('arrival_at', v);
      else if (k === 'ends_at')               v = coerceDatetime('ends_at', v);
      else if (k === 'is_active')             v = !!v;
      else if (k === 'sort_order')            v = Number(v) || 0;
      else if (k === 'gateway_airport')       v = optAirport('gateway_airport', v);
      else if (k === 'group_out_depart_at')   v = optDatetime('group_out_depart_at', v);
      else if (k === 'group_back_depart_at')  v = optDatetime('group_back_depart_at', v);
      else if (k === 'group_out_airline' || k === 'group_out_flight_no'
            || k === 'group_back_airline' || k === 'group_back_flight_no') v = optText(v);
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

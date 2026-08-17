/**
 * Time Tracking — contractor tick timer.
 *
 * One Netlify Function with action routing (same shape as program-schedule.js).
 * Every request is authenticated with the caller's Netlify Identity JWT, so a
 * contractor can only ever see and edit their OWN entries; admin / operations
 * get the manager view across everyone.
 *
 * The frontend must send `Authorization: Bearer <identity jwt>` — Netlify then
 * populates context.clientContext.user. No header ⇒ 401.
 *
 * Routes (query ?action=… or JSON body { action }):
 *
 *   Everyone (self-service)
 *     me            GET   -> { contractor, isManager, projects, running }
 *     entries       GET   -> ?from=YYYY-MM-DD&to=YYYY-MM-DD[&contractor_id=] (manager only for others)
 *     start         POST  -> { project_id?, description?, work_date }
 *     stop          POST  -> { id? }                        (defaults to own running timer)
 *     discard       POST  -> { id? }                        (throw away a running timer)
 *     create-entry  POST  -> { work_date, started_at, ended_at, project_id?, description? }
 *     update-entry  POST  -> { id, patch: {…} }
 *     delete-entry  POST  -> { id }
 *
 *   Manager only (admin | operations)
 *     contractors      GET   -> roster with period totals
 *     save-contractor  POST  -> { id | email, patch: { hourly_rate, currency, vendor_name, is_active, full_name, notes } }
 *     save-project     POST  -> { id?, name, code?, brand?, sort_order?, is_active?, notes? }
 *     delete-project   POST  -> { id }        (deactivates if entries reference it)
 *     approvals        GET   -> ?contractor_id=&limit=
 *     approve          POST  -> { contractor_id, period_start, period_end, notes? }
 *     unapprove        POST  -> { id }        (only while not yet pushed to payments)
 *     push-payment     POST  -> { id, due_date?, invoice_number? } -> writes a `payments` row
 *
 * Required env var:
 *   NETLIFY_DATABASE_URL   (auto-injected when Netlify DB / Neon is provisioned)
 *
 * Timezone contract: the CLIENT owns timezones. It sends `work_date` (the local
 * calendar day the work belongs to) plus full ISO instants for started_at /
 * ended_at. The server stores those verbatim and derives `minutes` itself, so
 * durations can never be spoofed from the browser.
 */

const { neon } = require('@neondatabase/serverless');

let _sql;
function sql() {
  if (!_sql) _sql = neon(process.env.NETLIFY_DATABASE_URL);
  return _sql;
}

const MANAGER_ROLES = ['admin', 'operations'];
const MAX_MINUTES = 1440;          // matches the DB constraint (24h)
// NZD first: it's the default across the rest of the payments pipeline.
const CURRENCIES = ['NZD', 'USD', 'AUD', 'EUR', 'GBP', 'CAD'];

const JSON_HEADERS = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };

function ok(body)             { return { statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify(body) }; }
function bad(msg, code = 400) { return { statusCode: code, headers: JSON_HEADERS, body: JSON.stringify({ error: msg }) }; }

// ---------------------------------------------------------------- validators
function coerceDate(label, raw) {
  if (raw === null || raw === undefined || String(raw).trim() === '') throw new Error(`${label} is required`);
  const m = String(raw).trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) throw new Error(`Invalid date for ${label}: ${raw}`);
  const [, y, mo, d] = m;
  const dt = new Date(`${y}-${mo}-${d}T00:00:00Z`);
  if (isNaN(dt.getTime()) || dt.getUTCMonth() + 1 !== Number(mo) || dt.getUTCDate() !== Number(d)) {
    throw new Error(`Invalid date for ${label}: ${raw}`);
  }
  return `${y}-${mo}-${d}`;
}
function coerceInstant(label, raw) {
  if (raw === null || raw === undefined || String(raw).trim() === '') throw new Error(`${label} is required`);
  const dt = new Date(String(raw));
  if (isNaN(dt.getTime())) throw new Error(`Invalid timestamp for ${label}: ${raw}`);
  return dt;
}
function optText(raw, max = 2000) {
  if (raw === null || raw === undefined || String(raw).trim() === '') return null;
  return String(raw).trim().slice(0, max);
}
function optMoney(label, raw) {
  if (raw === null || raw === undefined || String(raw).trim() === '') return null;
  const n = Number(raw);
  if (!isFinite(n) || n < 0 || n > 100000) throw new Error(`${label} must be between 0 and 100000`);
  return Math.round(n * 100) / 100;
}
function currency(raw) {
  const c = String(raw || CURRENCIES[0]).trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(c)) throw new Error('currency must be a 3-letter code');
  return c;
}
function optId(label, raw) {
  if (raw === null || raw === undefined || String(raw).trim() === '') return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${label} must be a positive id`);
  return n;
}
function reqId(label, raw) {
  const n = optId(label, raw);
  if (n === null) throw new Error(`${label} is required`);
  return n;
}
// Postgres DATE columns can come back as a JS Date or an ISO string depending
// on the driver's type parsing. Everything server-side compares plain
// 'YYYY-MM-DD' strings, so normalise once here.
function dstr(raw) {
  if (raw === null || raw === undefined) return null;
  if (raw instanceof Date) {
    // A DATE arrives as midnight — but which midnight depends on the driver:
    // pg/neon's type parser gives LOCAL midnight, others give UTC midnight.
    // Exactly-00:00:00Z means it's the UTC flavour; anything else is local.
    // Reading it back with the matching getters is correct under either, in any
    // timezone (plain toISOString() silently shifts the day west of UTC).
    const isUtcMidnight = raw.getUTCHours() === 0 && raw.getUTCMinutes() === 0
      && raw.getUTCSeconds() === 0 && raw.getUTCMilliseconds() === 0;
    const y  = isUtcMidnight ? raw.getUTCFullYear() : raw.getFullYear();
    const mo = (isUtcMidnight ? raw.getUTCMonth() : raw.getMonth()) + 1;
    const d  = isUtcMidnight ? raw.getUTCDate() : raw.getDate();
    return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }
  return String(raw).slice(0, 10);
}
// A date range, defaulting to the current ISO week if the client sends nothing.
function range(qs) {
  const to   = qs.to   ? coerceDate('to', qs.to)     : new Date().toISOString().slice(0, 10);
  const from = qs.from ? coerceDate('from', qs.from) : to;
  if (from > to) throw new Error('`from` cannot be after `to`');
  return { from, to };
}

// --------------------------------------------------------------------- auth
function readCaller(context) {
  const user = (context && context.clientContext && context.clientContext.user) || null;
  if (!user) return null;
  const email = String(user.email || '').trim().toLowerCase();
  if (!email) return null;
  const roles = (user.app_metadata && user.app_metadata.roles) || [];
  return {
    email,
    name: (user.user_metadata && user.user_metadata.full_name) || null,
    roles,
    isManager: roles.some((r) => MANAGER_ROLES.includes(r)),
  };
}

/**
 * Find-or-create the caller's contractor row. Every dashboard login that opens
 * the timer gets a row on first visit — nothing to pre-provision.
 */
async function ensureContractor(caller) {
  const rows = await sql()`
    INSERT INTO time_contractors (email, full_name)
    VALUES (${caller.email}, ${caller.name})
    ON CONFLICT (email) DO UPDATE
      SET full_name = COALESCE(time_contractors.full_name, EXCLUDED.full_name)
    RETURNING *
  `;
  return rows[0];
}

/**
 * Resolve which contractor a request is acting on.
 * Contractors are pinned to themselves; managers may pass ?contractor_id=.
 */
function assertActive(self) {
  if (self.is_active === false) {
    throw Object.assign(new Error('Your time tracking has been deactivated — talk to operations.'), { status: 403 });
  }
}

/**
 * Guard for touching an entry that an approval already covers. Once a timesheet
 * has been pushed to Invoices & Payments, editing the hours behind it would make
 * the payout wrong with no record, so that has to be unwound deliberately.
 */
async function assertApprovalEditable(entry) {
  if (!entry.approval_id) return null;
  const rows = await sql()`SELECT id, payment_id FROM time_approvals WHERE id = ${entry.approval_id}`;
  const appr = rows[0];
  if (!appr) return null;
  if (appr.payment_id) {
    throw Object.assign(
      new Error('that entry is on a timesheet already pushed to Invoices & Payments — delete payment #'
        + appr.payment_id + ' first, then undo the approval'),
      { status: 409 }
    );
  }
  return appr.id;
}

/** Re-total an approval after one of its entries was edited or removed. */
async function recomputeApproval(approvalId) {
  if (!approvalId) return;
  await sql()`
    UPDATE time_approvals a
    SET total_minutes = t.m,
        amount = CASE WHEN a.hourly_rate IS NULL THEN NULL
                      ELSE ROUND((t.m / 60.0) * a.hourly_rate, 2) END
    FROM (
      SELECT COALESCE(SUM(minutes), 0)::int AS m
      FROM time_entries WHERE approval_id = ${approvalId}
    ) t
    WHERE a.id = ${approvalId}
  `;
}

async function targetContractorId(caller, self, requested) {
  const id = optId('contractor_id', requested);
  if (id === null || id === self.id) return self.id;
  if (!caller.isManager) throw new Error('You can only access your own time entries');
  const rows = await sql()`SELECT id FROM time_contractors WHERE id = ${id}`;
  if (!rows.length) throw new Error('contractor not found');
  return rows[0].id;
}

// ------------------------------------------------------------------ queries
const ENTRY_SELECT = `
  SELECT e.id, e.contractor_id, e.project_id, e.work_date, e.started_at, e.ended_at,
         e.minutes, e.description, e.source, e.locked, e.approval_id,
         p.name AS project_name, p.code AS project_code,
         c.email AS contractor_email, c.full_name AS contractor_name
  FROM time_entries e
  LEFT JOIN time_projects p    ON p.id = e.project_id
  JOIN time_contractors c      ON c.id = e.contractor_id
`;

async function listProjects(includeInactive) {
  return includeInactive
    ? await sql()`SELECT * FROM time_projects ORDER BY is_active DESC, sort_order, name`
    : await sql()`SELECT * FROM time_projects WHERE is_active = TRUE ORDER BY sort_order, name`;
}

async function runningFor(contractorId) {
  const rows = await sql().query(
    `${ENTRY_SELECT} WHERE e.contractor_id = $1 AND e.ended_at IS NULL LIMIT 1`,
    [contractorId]
  );
  return rows[0] || null;
}

// -------------------------------------------------------------------- me
async function handleMe(caller) {
  const self = await ensureContractor(caller);
  const [projects, running] = await Promise.all([
    listProjects(caller.isManager),
    runningFor(self.id),
  ]);
  return ok({
    contractor: self,
    isManager: caller.isManager,
    roles: caller.roles,
    projects,
    running,
    currencies: CURRENCIES,
    serverNow: new Date().toISOString(),
  });
}

// --------------------------------------------------------------- entries
async function handleEntries(caller, qs) {
  const self = await ensureContractor(caller);
  const { from, to } = range(qs);

  // Managers can ask for everyone at once with ?contractor_id=all
  if (String(qs.contractor_id || '') === 'all') {
    if (!caller.isManager) return bad('You can only access your own time entries', 403);
    const rows = await sql().query(
      `${ENTRY_SELECT} WHERE e.work_date BETWEEN $1 AND $2
       ORDER BY e.work_date DESC, e.started_at DESC`,
      [from, to]
    );
    return ok({ entries: rows, from, to, contractor_id: 'all' });
  }

  let cid;
  try { cid = await targetContractorId(caller, self, qs.contractor_id); }
  catch (e) { return bad(e.message, /own time entries/.test(e.message) ? 403 : 400); }

  const rows = await sql().query(
    `${ENTRY_SELECT} WHERE e.contractor_id = $1 AND e.work_date BETWEEN $2 AND $3
     ORDER BY e.work_date DESC, e.started_at DESC`,
    [cid, from, to]
  );
  return ok({ entries: rows, from, to, contractor_id: cid });
}

// ----------------------------------------------------------------- timer
async function handleStart(caller, body) {
  const self = await ensureContractor(caller);
  try { assertActive(self); } catch (e) { return bad(e.message, e.status); }

  let workDate, projectId, description;
  try {
    workDate    = coerceDate('work_date', body.work_date);
    projectId   = optId('project_id', body.project_id);
    description = optText(body.description);
  } catch (e) { return bad(e.message); }

  if (projectId !== null) {
    const p = await sql()`SELECT id, is_active FROM time_projects WHERE id = ${projectId}`;
    if (!p.length) return bad('project not found');
    if (!p[0].is_active) return bad('that project is no longer active');
  }

  // The partial unique index makes this safe against double-clicks and a second
  // open tab: the insert loses, and we hand back the timer that's already live.
  try {
    const rows = await sql()`
      INSERT INTO time_entries (contractor_id, project_id, work_date, started_at, description, source)
      VALUES (${self.id}, ${projectId}, ${workDate}, NOW(), ${description}, 'timer')
      RETURNING id
    `;
    const entry = await sql().query(`${ENTRY_SELECT} WHERE e.id = $1`, [rows[0].id]);
    return ok({ running: entry[0], started: true });
  } catch (e) {
    if (/one_running_per_contractor/i.test(e.message)) {
      const existing = await runningFor(self.id);
      return ok({ running: existing, started: false, note: 'A timer was already running — returning that one.' });
    }
    throw e;
  }
}

async function handleStop(caller, body) {
  const self = await ensureContractor(caller);
  let id;
  try { id = optId('id', body.id); } catch (e) { return bad(e.message); }

  // minutes is derived from the DB clock, never from the client. At least 1
  // minute for any deliberate start/stop; capped at 24h so a timer forgotten
  // over a weekend can still be closed out (and then edited).
  const rows = id
    ? await sql()`
        UPDATE time_entries SET ended_at = NOW(),
          minutes = LEAST(${MAX_MINUTES}, GREATEST(1, ROUND(EXTRACT(EPOCH FROM (NOW() - started_at)) / 60)))::int
        WHERE id = ${id} AND contractor_id = ${self.id} AND ended_at IS NULL
        RETURNING id, minutes`
    : await sql()`
        UPDATE time_entries SET ended_at = NOW(),
          minutes = LEAST(${MAX_MINUTES}, GREATEST(1, ROUND(EXTRACT(EPOCH FROM (NOW() - started_at)) / 60)))::int
        WHERE contractor_id = ${self.id} AND ended_at IS NULL
        RETURNING id, minutes`;

  if (!rows.length) return bad('no running timer to stop', 404);
  const entry = await sql().query(`${ENTRY_SELECT} WHERE e.id = $1`, [rows[0].id]);
  const capped = rows[0].minutes >= MAX_MINUTES;
  return ok({ entry: entry[0], capped, running: null });
}

async function handleDiscard(caller, body) {
  const self = await ensureContractor(caller);
  let id;
  try { id = optId('id', body.id); } catch (e) { return bad(e.message); }
  const rows = id
    ? await sql()`DELETE FROM time_entries WHERE id = ${id} AND contractor_id = ${self.id} AND ended_at IS NULL RETURNING id`
    : await sql()`DELETE FROM time_entries WHERE contractor_id = ${self.id} AND ended_at IS NULL RETURNING id`;
  if (!rows.length) return bad('no running timer to discard', 404);
  return ok({ discarded: rows[0].id, running: null });
}

// ---------------------------------------------------- manual entry + edits
async function handleCreateEntry(caller, body) {
  const self = await ensureContractor(caller);
  // A deactivated contractor can't log time by hand either — not just via the timer.
  if (!caller.isManager) { try { assertActive(self); } catch (e) { return bad(e.message, e.status); } }
  let cid, workDate, startedAt, endedAt, projectId, description;
  try {
    cid         = await targetContractorId(caller, self, body.contractor_id);
    workDate    = coerceDate('work_date', body.work_date);
    startedAt   = coerceInstant('started_at', body.started_at);
    endedAt     = coerceInstant('ended_at', body.ended_at);
    projectId   = optId('project_id', body.project_id);
    description = optText(body.description);
  } catch (e) { return bad(e.message, /own time entries/.test(e.message) ? 403 : 400); }

  const minutes = Math.round((endedAt.getTime() - startedAt.getTime()) / 60000);
  if (minutes <= 0) return bad('the finish time must be after the start time');
  if (minutes > MAX_MINUTES) return bad('a single entry cannot be longer than 24 hours — split it across days');

  const rows = await sql()`
    INSERT INTO time_entries
      (contractor_id, project_id, work_date, started_at, ended_at, minutes, description, source)
    VALUES
      (${cid}, ${projectId}, ${workDate}, ${startedAt.toISOString()}, ${endedAt.toISOString()},
       ${minutes}, ${description}, 'manual')
    RETURNING id
  `;
  const entry = await sql().query(`${ENTRY_SELECT} WHERE e.id = $1`, [rows[0].id]);
  return ok({ entry: entry[0] });
}

async function handleUpdateEntry(caller, body) {
  const self = await ensureContractor(caller);
  let id;
  try { id = optId('id', body.id); } catch (e) { return bad(e.message); }
  const patch = body.patch;
  if (!id || !patch || typeof patch !== 'object') return bad('id and patch required');

  const existing = await sql()`SELECT * FROM time_entries WHERE id = ${id}`;
  if (!existing.length) return bad('not found', 404);
  const row = existing[0];

  if (row.contractor_id !== self.id && !caller.isManager) return bad('You can only edit your own time entries', 403);
  if (row.locked && !caller.isManager) return bad('that entry is part of an approved timesheet and is locked', 409);
  if (row.ended_at === null) return bad('stop the running timer before editing it');
  if (!caller.isManager) { try { assertActive(self); } catch (e) { return bad(e.message, e.status); } }

  // A manager may correct an approved entry, but only while the timesheet hasn't
  // been paid out — otherwise the payment and the hours behind it would disagree.
  let approvalId;
  try { approvalId = await assertApprovalEditable(row); }
  catch (e) { return bad(e.message, e.status || 400); }

  const sets = [];
  const args = [];
  let startedAt = new Date(row.started_at);
  let endedAt   = new Date(row.ended_at);
  let touchedTimes = false;

  try {
    for (const key of Object.keys(patch)) {
      const v = patch[key];
      if (key === 'work_date')        { args.push(coerceDate('work_date', v)); sets.push(`work_date = $${args.length}`); }
      else if (key === 'project_id')  { args.push(optId('project_id', v));     sets.push(`project_id = $${args.length}`); }
      else if (key === 'description') { args.push(optText(v));                 sets.push(`description = $${args.length}`); }
      else if (key === 'started_at')  { startedAt = coerceInstant('started_at', v); touchedTimes = true; }
      else if (key === 'ended_at')    { endedAt   = coerceInstant('ended_at', v);   touchedTimes = true; }
      // `locked` is deliberately NOT patchable: unlocking here would leave
      // approval_id set, and the same hours could then be swept into a second
      // approval and paid twice. Use the `unapprove` action instead.
    }
  } catch (e) { return bad(e.message); }

  if (touchedTimes) {
    const minutes = Math.round((endedAt.getTime() - startedAt.getTime()) / 60000);
    if (minutes <= 0) return bad('the finish time must be after the start time');
    if (minutes > MAX_MINUTES) return bad('a single entry cannot be longer than 24 hours');
    args.push(startedAt.toISOString()); sets.push(`started_at = $${args.length}`);
    args.push(endedAt.toISOString());   sets.push(`ended_at = $${args.length}`);
    args.push(minutes);                 sets.push(`minutes = $${args.length}`);
  }

  if (!sets.length) return bad('no updatable fields in patch');

  if (patch.project_id !== undefined && patch.project_id) {
    const p = await sql()`SELECT id FROM time_projects WHERE id = ${Number(patch.project_id)}`;
    if (!p.length) return bad('project not found');
  }

  args.push(id);
  await sql().query(`UPDATE time_entries SET ${sets.join(', ')} WHERE id = $${args.length}`, args);
  // Keep the approval's total (and payout amount) in step with the corrected hours.
  await recomputeApproval(approvalId);
  const entry = await sql().query(`${ENTRY_SELECT} WHERE e.id = $1`, [id]);
  return ok({ entry: entry[0], approvalRetotalled: approvalId || undefined });
}

async function handleDeleteEntry(caller, body) {
  const self = await ensureContractor(caller);
  let id;
  try { id = optId('id', body.id); } catch (e) { return bad(e.message); }
  if (!id) return bad('id required');

  const existing = await sql()`SELECT id, contractor_id, locked, approval_id FROM time_entries WHERE id = ${id}`;
  if (!existing.length) return bad('not found', 404);
  const row = existing[0];
  if (row.contractor_id !== self.id && !caller.isManager) {
    return bad('You can only delete your own time entries', 403);
  }
  if (row.locked && !caller.isManager) {
    return bad('that entry is part of an approved timesheet and is locked', 409);
  }
  let approvalId;
  try { approvalId = await assertApprovalEditable(row); }
  catch (e) { return bad(e.message, e.status || 400); }

  await sql()`DELETE FROM time_entries WHERE id = ${id}`;
  await recomputeApproval(approvalId);
  return ok({ deleted: id, approvalRetotalled: approvalId || undefined });
}

// ------------------------------------------------------- manager: roster
async function handleContractors(caller, qs) {
  if (!caller.isManager) return bad('admin or operations role required', 403);
  let from, to;
  try { ({ from, to } = range({ from: qs.from, to: qs.to })); } catch (e) { return bad(e.message); }
  const rows = await sql().query(
    `SELECT c.*,
            COALESCE(SUM(e.minutes) FILTER (WHERE e.work_date BETWEEN $1 AND $2 AND e.ended_at IS NOT NULL), 0)::int AS period_minutes,
            COALESCE(SUM(e.minutes) FILTER (WHERE e.work_date BETWEEN $1 AND $2 AND e.ended_at IS NOT NULL AND e.locked = FALSE), 0)::int AS unapproved_minutes,
            MAX(e.work_date) AS last_logged,
            BOOL_OR(e.ended_at IS NULL) AS timer_running
     FROM time_contractors c
     LEFT JOIN time_entries e ON e.contractor_id = c.id
     GROUP BY c.id
     ORDER BY c.is_active DESC, LOWER(COALESCE(c.full_name, c.email))`,
    [from, to]
  );
  return ok({ contractors: rows, from, to });
}

async function handleSaveContractor(caller, body) {
  if (!caller.isManager) return bad('admin or operations role required', 403);
  const patch = body.patch || {};
  let id;
  try { id = optId('id', body.id); } catch (e) { return bad(e.message); }
  if (!id) {
    const email = String(body.email || '').trim().toLowerCase();
    if (!email) return bad('id or email required');
    const rows = await sql()`SELECT id FROM time_contractors WHERE email = ${email}`;
    if (!rows.length) return bad('contractor not found — they get a row the first time they open the timer', 404);
    id = rows[0].id;
  }

  const sets = [];
  const args = [];
  try {
    for (const key of Object.keys(patch)) {
      const v = patch[key];
      if (key === 'hourly_rate')      { args.push(optMoney('hourly_rate', v)); sets.push(`hourly_rate = $${args.length}`); }
      else if (key === 'currency')    { args.push(currency(v));                sets.push(`currency = $${args.length}`); }
      else if (key === 'vendor_name') { args.push(optText(v, 200));            sets.push(`vendor_name = $${args.length}`); }
      else if (key === 'full_name')   { args.push(optText(v, 200));            sets.push(`full_name = $${args.length}`); }
      else if (key === 'notes')       { args.push(optText(v));                 sets.push(`notes = $${args.length}`); }
      else if (key === 'is_active')   { args.push(!!v);                        sets.push(`is_active = $${args.length}`); }
    }
  } catch (e) { return bad(e.message); }
  if (!sets.length) return bad('no updatable fields in patch');

  args.push(id);
  const rows = await sql().query(
    `UPDATE time_contractors SET ${sets.join(', ')} WHERE id = $${args.length} RETURNING *`, args
  );
  return ok({ contractor: rows[0] });
}

// ------------------------------------------------------ manager: projects
async function handleSaveProject(caller, body) {
  if (!caller.isManager) return bad('admin or operations role required', 403);
  let id, name, code, brand, order, notes;
  try {
    id    = optId('id', body.id);
    name  = optText(body.name, 200);
    code  = optText(body.code, 32);
    brand = optText(body.brand, 100);
    notes = optText(body.notes);
    order = body.sort_order === undefined || body.sort_order === null || body.sort_order === ''
      ? null : Number(body.sort_order);
    if (order !== null && !Number.isFinite(order)) throw new Error('sort_order must be a number');
  } catch (e) { return bad(e.message); }

  try {
    if (id) {
      const sets = [];
      const args = [];
      if (body.name !== undefined) {
        if (!name) return bad('name cannot be empty');
        args.push(name); sets.push(`name = $${args.length}`);
      }
      if (body.code       !== undefined) { args.push(code);  sets.push(`code = $${args.length}`); }
      if (body.brand      !== undefined) { args.push(brand); sets.push(`brand = $${args.length}`); }
      if (body.notes      !== undefined) { args.push(notes); sets.push(`notes = $${args.length}`); }
      if (body.sort_order !== undefined && order !== null) { args.push(Math.round(order)); sets.push(`sort_order = $${args.length}`); }
      if (body.is_active  !== undefined) { args.push(!!body.is_active); sets.push(`is_active = $${args.length}`); }
      if (!sets.length) return bad('nothing to update');
      args.push(id);
      const rows = await sql().query(
        `UPDATE time_projects SET ${sets.join(', ')} WHERE id = $${args.length} RETURNING *`, args
      );
      if (!rows.length) return bad('not found', 404);
      return ok({ project: rows[0] });
    }

    if (!name) return bad('name is required');
    const rows = await sql()`
      INSERT INTO time_projects (name, code, brand, sort_order, notes)
      VALUES (${name}, ${code}, ${brand}, ${order === null ? 100 : Math.round(order)}, ${notes})
      RETURNING *
    `;
    return ok({ project: rows[0] });
  } catch (e) {
    if (/time_projects_name_uniq/i.test(e.message)) return bad('a project with that name already exists');
    throw e;
  }
}

async function handleDeleteProject(caller, body) {
  if (!caller.isManager) return bad('admin or operations role required', 403);
  let id;
  try { id = optId('id', body.id); } catch (e) { return bad(e.message); }
  if (!id) return bad('id required');

  const used = await sql()`SELECT COUNT(*)::int AS n FROM time_entries WHERE project_id = ${id}`;
  if (used[0].n > 0) {
    // Keep the history readable — deactivate instead of orphaning entries.
    const rows = await sql()`UPDATE time_projects SET is_active = FALSE WHERE id = ${id} RETURNING *`;
    if (!rows.length) return bad('not found', 404);
    return ok({ project: rows[0], deactivated: true, entries: used[0].n });
  }
  const rows = await sql()`DELETE FROM time_projects WHERE id = ${id} RETURNING id`;
  if (!rows.length) return bad('not found', 404);
  return ok({ deleted: rows[0].id });
}

// ----------------------------------------------------- manager: approvals
async function handleApprovals(caller, qs) {
  if (!caller.isManager) return bad('admin or operations role required', 403);
  let cid;
  try { cid = optId('contractor_id', qs.contractor_id); } catch (e) { return bad(e.message); }
  const limit = Math.min(Number(qs.limit) || 50, 200);
  const rows = cid
    ? await sql()`
        SELECT a.*, c.email AS contractor_email, c.full_name AS contractor_name,
               p.paid, p.due_date AS payment_due_date, p.invoice_file_url
        FROM time_approvals a
        JOIN time_contractors c ON c.id = a.contractor_id
        LEFT JOIN payments p    ON p.id = a.payment_id
        WHERE a.contractor_id = ${cid}
        ORDER BY a.period_start DESC LIMIT ${limit}`
    : await sql()`
        SELECT a.*, c.email AS contractor_email, c.full_name AS contractor_name,
               p.paid, p.due_date AS payment_due_date, p.invoice_file_url
        FROM time_approvals a
        JOIN time_contractors c ON c.id = a.contractor_id
        LEFT JOIN payments p    ON p.id = a.payment_id
        ORDER BY a.period_start DESC LIMIT ${limit}`;
  return ok({ approvals: rows });
}

/**
 * Approve every finished, not-yet-approved entry in a period.
 *
 * The whole thing is ONE statement on purpose. `pend` pins the exact entry ids in
 * a single snapshot; the total, the approval row and the entry locks are all
 * derived from that same set. Doing the SUM in a separate round-trip (as an
 * earlier version did) let a timer stopped in the gap get locked into the
 * timesheet without being counted — hours that were then unpayable forever.
 */
async function handleApprove(caller, body) {
  if (!caller.isManager) return bad('admin or operations role required', 403);
  let cid, start, end, notes;
  try {
    cid   = reqId('contractor_id', body.contractor_id);
    start = coerceDate('period_start', body.period_start);
    end   = coerceDate('period_end', body.period_end);
    notes = optText(body.notes);
  } catch (e) { return bad(e.message); }
  if (end < start) return bad('period_end cannot be before period_start');

  const c = await sql()`SELECT * FROM time_contractors WHERE id = ${cid}`;
  if (!c.length) return bad('contractor not found', 404);
  const contractor = c[0];
  const rate = contractor.hourly_rate === null ? null : Number(contractor.hourly_rate);

  const stillRunning = await runningFor(cid);
  if (stillRunning) {
    const wd = dstr(stillRunning.work_date);
    if (wd >= start && wd <= end) {
      return bad('that contractor has a timer still running inside this period — stop it first');
    }
  }

  const rows = await sql()`
    WITH pend AS (
      SELECT id, minutes FROM time_entries
      WHERE contractor_id = ${cid} AND work_date BETWEEN ${start} AND ${end}
        AND ended_at IS NOT NULL AND locked = FALSE
      -- FOR UPDATE serialises two managers clicking approve at the same moment:
      -- the second waits, re-checks locked = FALSE against the now-committed
      -- rows, finds nothing pending, and inserts no approval. Without it, both
      -- could write a full-value timesheet for the same hours.
      FOR UPDATE
    ), tot AS (
      SELECT COALESCE(SUM(minutes), 0)::int AS m, COUNT(*)::int AS n FROM pend
    ), ins AS (
      INSERT INTO time_approvals
        (contractor_id, period_start, period_end, total_minutes, hourly_rate, currency, amount, approved_by, notes)
      SELECT ${cid}, ${start}, ${end}, tot.m, ${rate}, ${contractor.currency},
             CASE WHEN ${rate}::numeric IS NULL THEN NULL
                  ELSE ROUND((tot.m / 60.0) * ${rate}::numeric, 2) END,
             ${caller.email}, ${notes}
      FROM tot WHERE tot.n > 0
      RETURNING *
    ), upd AS (
      UPDATE time_entries SET approval_id = (SELECT id FROM ins), locked = TRUE
      WHERE id IN (SELECT id FROM pend) AND locked = FALSE AND EXISTS (SELECT 1 FROM ins)
      RETURNING id
    )
    SELECT (SELECT row_to_json(ins) FROM ins) AS approval,
           (SELECT COUNT(*)::int FROM upd)    AS locked_count,
           (SELECT n FROM tot)                AS pending_count
  `;

  if (!rows[0].approval) {
    return bad('nothing to approve in that period — the entries are already approved or there are none');
  }
  return ok({
    approval: rows[0].approval,
    lockedEntries: rows[0].locked_count,
    needsRate: rate === null,
  });
}

async function handleUnapprove(caller, body) {
  if (!caller.isManager) return bad('admin or operations role required', 403);
  let id;
  try { id = optId('id', body.id); } catch (e) { return bad(e.message); }
  if (!id) return bad('id required');

  const rows = await sql()`SELECT * FROM time_approvals WHERE id = ${id}`;
  if (!rows.length) return bad('not found', 404);
  if (rows[0].payment_id) {
    return bad('this timesheet has already been pushed to Invoices & Payments — delete that payment row first', 409);
  }
  // Unlocking the entries and dropping the approval together.
  const out = await sql()`
    WITH upd AS (
      UPDATE time_entries SET locked = FALSE, approval_id = NULL
      WHERE approval_id = ${id} RETURNING id
    ), del AS (
      DELETE FROM time_approvals WHERE id = ${id} RETURNING id
    )
    SELECT (SELECT COUNT(*)::int FROM upd) AS unlocked, (SELECT id FROM del) AS deleted
  `;
  return ok({ deleted: out[0].deleted, unlockedEntries: out[0].unlocked });
}

/**
 * Push an approved timesheet into the existing Invoices & Payments table as a
 * manually-scheduled payment, so contractor payouts ride the same weekly pay
 * schedule, approve/paid checkboxes and reporting as every other invoice.
 */
async function handlePushPayment(caller, body) {
  if (!caller.isManager) return bad('admin or operations role required', 403);
  let id;
  try { id = optId('id', body.id); } catch (e) { return bad(e.message); }
  if (!id) return bad('id required');

  const rows = await sql()`
    SELECT a.*, c.email, c.full_name, c.vendor_name
    FROM time_approvals a JOIN time_contractors c ON c.id = a.contractor_id
    WHERE a.id = ${id}
  `;
  if (!rows.length) return bad('not found', 404);
  const a = rows[0];
  if (a.payment_id) return bad('already pushed to Invoices & Payments', 409);
  if (a.amount === null || Number(a.amount) <= 0) {
    return bad('set an hourly rate for this contractor first, then re-approve the period so the amount can be calculated');
  }

  let dueDate, invoiceNumber;
  try {
    // Default: due at the end of the week following the period.
    dueDate = body.due_date ? coerceDate('due_date', body.due_date) : defaultDueDate(a.period_end);
    invoiceNumber = optText(body.invoice_number, 64) || `TIME-${a.id}`;
  } catch (e) { return bad(e.message); }

  const vendor = a.vendor_name || a.full_name || a.email;
  const hours = (a.total_minutes / 60).toFixed(2);
  const note = `Contractor time ${dstr(a.period_start)} → ${dstr(a.period_end)}`
    + ` · ${hours}h @ ${a.hourly_rate}/h ${a.currency} · approved by ${a.approved_by || caller.email}`
    + ` · timesheet #${a.id}`;

  // Insert the payment and claim it in one statement. The UPDATE's
  // `payment_id IS NULL` is re-checked after it takes the row lock, so of two
  // simultaneous pushes only one can link — the loser is detected below and its
  // payment row removed, so a double-click can never produce a double payout.
  const out = await sql()`
    WITH ins AS (
      INSERT INTO payments (vendor, amount, currency, invoice_number, due_date, source, notes)
      SELECT ${vendor}, ${a.amount}, ${a.currency}, ${invoiceNumber}, ${dueDate}, 'manual', ${note}
      FROM time_approvals WHERE id = ${id} AND payment_id IS NULL
      RETURNING *
    ), upd AS (
      UPDATE time_approvals SET payment_id = (SELECT id FROM ins), pushed_at = NOW()
      WHERE id = ${id} AND payment_id IS NULL AND EXISTS (SELECT 1 FROM ins)
      RETURNING id
    )
    SELECT (SELECT row_to_json(ins) FROM ins) AS payment,
           (SELECT COUNT(*)::int FROM upd)    AS linked
  `;

  const payment = out[0].payment;
  if (!payment) return bad('already pushed to Invoices & Payments', 409);
  if (!out[0].linked) {
    // Another push won the race between our INSERT and our UPDATE. Undo ours.
    await sql()`DELETE FROM payments WHERE id = ${payment.id}`;
    return bad('already pushed to Invoices & Payments', 409);
  }
  return ok({ payment, approvalId: id });
}

// Friday of the week after the period ends — matches how the invoices board
// buckets payments into weekly runs.
function defaultDueDate(periodEnd) {
  const base = new Date(`${dstr(periodEnd)}T00:00:00Z`);
  const day = base.getUTCDay();                 // 0 Sun … 6 Sat
  const daysToFriday = ((5 - day) + 7) % 7;     // next Friday (today if already Fri)
  base.setUTCDate(base.getUTCDate() + daysToFriday + 7);
  return base.toISOString().slice(0, 10);
}

// -------------------------------------------------------------------------
exports.handler = async (event, context) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: JSON_HEADERS, body: '' };

  const caller = readCaller(context);
  if (!caller) {
    return bad('Not authenticated — sign in to the dashboard and reload this page.', 401);
  }

  try {
    const method = event.httpMethod;
    const qs = event.queryStringParameters || {};
    const body = event.body
      ? (event.isBase64Encoded ? JSON.parse(Buffer.from(event.body, 'base64').toString('utf8')) : JSON.parse(event.body))
      : {};
    const action = qs.action || body.action || (method === 'GET' ? 'me' : null);

    if (method === 'GET') {
      if (action === 'me')          return await handleMe(caller);
      if (action === 'entries')     return await handleEntries(caller, qs);
      if (action === 'contractors') return await handleContractors(caller, qs);
      if (action === 'projects')    return ok({ projects: await listProjects(caller.isManager) });
      if (action === 'approvals')   return await handleApprovals(caller, qs);
    }
    if (method === 'POST') {
      if (action === 'start')            return await handleStart(caller, body);
      if (action === 'stop')             return await handleStop(caller, body);
      if (action === 'discard')          return await handleDiscard(caller, body);
      if (action === 'create-entry')     return await handleCreateEntry(caller, body);
      if (action === 'update-entry')     return await handleUpdateEntry(caller, body);
      if (action === 'delete-entry')     return await handleDeleteEntry(caller, body);
      if (action === 'save-contractor')  return await handleSaveContractor(caller, body);
      if (action === 'save-project')     return await handleSaveProject(caller, body);
      if (action === 'delete-project')   return await handleDeleteProject(caller, body);
      if (action === 'approve')          return await handleApprove(caller, body);
      if (action === 'unapprove')        return await handleUnapprove(caller, body);
      if (action === 'push-payment')     return await handlePushPayment(caller, body);
    }

    return bad(`unknown action '${action}' for method ${method}`);
  } catch (err) {
    console.error('time-tracking error:', err);
    if (/relation "time_/i.test(err.message || '')) {
      return bad('Time tracking tables are missing — run MIGRATION-time-tracking.sql against the database.', 500);
    }
    // Anything unexpected: the details go to the function log, not to the browser
    // (raw Postgres errors leak table, column and constraint names).
    if (err && err.status) return bad(err.message, err.status);
    return bad('Something went wrong saving that — the details are in the function logs.', 500);
  }
};

// Exported for unit tests (test/time-tracking.test.mjs).
exports._internals = { defaultDueDate, coerceDate, coerceInstant, optMoney, currency, dstr, MAX_MINUTES };

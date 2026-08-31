/**
 * Time Tracking — contractor tick timer.
 *
 * One Netlify Function with action routing (same shape as program-schedule.js).
 * Every request is authenticated with the caller's Netlify Identity JWT, so a
 * contractor can only ever see and edit their OWN entries; ADMIN gets the manager
 * view across everyone. See MANAGER_ROLES below — that one list is the whole
 * boundary.
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
 *     import-entries POST -> { rows: [...], dry_run } — bulk paste; dry_run
 *                            (the default) validates and returns a per-row
 *                            report, dry_run:false commits the batch
 *     undo-import   POST  -> { batch_id }  (removes a whole import)
 *
 *   Manager only (admin)
 *     contractors      GET   -> roster with period totals
 *     save-contractor  POST  -> { id | email, patch: { hourly_rate, currency, vendor_name, is_active, full_name, notes } }
 *     save-project     POST  -> { id?, name, code?, brand?, sort_order?, is_active?, notes? }
 *     delete-project   POST  -> { id }        (deactivates if entries reference it)
 *     approvals        GET   -> ?contractor_id=&limit=
 *     approve          POST  -> { contractor_id, period_start, period_end, notes? }
 *     unapprove        POST  -> { id }        (only while not yet pushed to payments)
 *     push-payment     POST  -> { id, due_date?, invoice_number? } -> writes a `payments` row
 *     restore-exact    POST  -> { from?, to?, dry_run } — recompute UNAPPROVED
 *                              entries' minutes from their recorded start/finish
 *                              times, undoing the old per-entry rounding; dry_run
 *                              (the default) reports the effect per contractor
 *
 * Required env var:
 *   NETLIFY_DATABASE_URL   (auto-injected when Netlify DB / Neon is provisioned)
 *
 * Timezone contract: the CLIENT owns timezones. It sends `work_date` (the local
 * calendar day the work belongs to) plus full ISO instants for started_at /
 * ended_at. The server stores those verbatim and derives `minutes` itself, so
 * durations can never be spoofed from the browser.
 *
 * Rounding: entries store EXACT minutes. Billing is in quarter hours, and that
 * rounding is applied to TOTALS — the week total, a roster period, an approved
 * timesheet — never to individual entries. Rounding each entry and then summing
 * accumulates the errors instead of cancelling them; see ROUND_TO_MINUTES below
 * for the worked example. Every total a person is shown or paid goes through
 * roundBillableMinutes(); raw sums are for arithmetic, not for display.
 */

const { neon } = require('@neondatabase/serverless');
const { randomUUID } = require('node:crypto');

let _sql;
function sql() {
  if (!_sql) _sql = neon(process.env.NETLIFY_DATABASE_URL);
  return _sql;
}

// Who can see and act on OTHER people's time. Everyone else — including
// operations — only ever sees their own entries. Rates and payout totals live
// behind this too, so widening it exposes what every contractor is paid.
const MANAGER_ROLES = ['admin'];
const MAX_MINUTES = 1440;          // matches the DB constraint (24h)

// Billing granularity. Time is billed in quarter hours.
//
// The rounding happens on the TOTAL, not on each entry, and that distinction is
// the whole design. Rounding every entry and then adding them up accumulates the
// per-entry errors instead of cancelling them: 14 real entries summing to 938
// minutes (15.63 h) round individually to 915 (15.25 h) — 23 minutes of worked
// time gone, with the loss growing as the entry count does. Rounding the sum
// gives 945 (15.75 h), which is what 938 minutes actually rounds to.
//
// So entries keep their exact minutes and every total a person is shown or paid
// is rounded at the point it is totalled. One rounding step, no accumulation.
const ROUND_TO_MINUTES = 15;
const MIN_BILLABLE_MINUTES = 15;

/**
 * Round a TOTAL to the billing granularity.
 *
 * Nearest, not up or down. Zero stays zero — an empty week is not a quarter of
 * an hour — but any real total is worth at least one quarter, so a period with
 * three minutes in it bills as 0:15 rather than rounding away to nothing.
 *
 * There is deliberately no 24h cap here: MAX_MINUTES bounds a single ENTRY, and
 * a week's total is expected to exceed it.
 */
function roundBillableMinutes(raw) {
  const n = Number(raw) || 0;
  if (n <= 0) return 0;
  return Math.max(MIN_BILLABLE_MINUTES, Math.round(n / ROUND_TO_MINUTES) * ROUND_TO_MINUTES);
}

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
    throw Object.assign(new Error('Your time tracking has been deactivated — talk to an admin.'), { status: 403 });
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

// Round a summed minutes expression, in SQL. Mirrors roundBillableMinutes():
// nearest quarter, zero stays zero, anything else is worth at least one quarter.
// A timesheet total is what gets paid, so this is the number that has to be
// right — and it is computed from the EXACT entry minutes, once, at the end.
const ROUND_TOTAL_SQL = (expr) =>
  `(CASE WHEN (${expr}) <= 0 THEN 0
         ELSE GREATEST(${MIN_BILLABLE_MINUTES},
              ROUND((${expr}) / ${ROUND_TO_MINUTES}.0) * ${ROUND_TO_MINUTES}) END)::int`;

/** Re-total an approval after one of its entries was edited or removed. */
async function recomputeApproval(approvalId) {
  if (!approvalId) return;
  await sql().query(
    `UPDATE time_approvals a
     SET total_minutes = t.m,
         amount = CASE WHEN a.hourly_rate IS NULL THEN NULL
                       ELSE ROUND((t.m / 60.0) * a.hourly_rate, 2) END
     FROM (
       SELECT ${ROUND_TOTAL_SQL('COALESCE(SUM(minutes), 0)')} AS m
       FROM time_entries WHERE approval_id = $1
     ) t
     WHERE a.id = $1`,
    [approvalId]
  );
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

  // minutes is derived from the DB clock, never from the client, and stored
  // EXACT — the quarter-hour rounding happens when hours are totalled, not here.
  // At least 1 minute for any deliberate start/stop; capped at 24h so a timer
  // forgotten over a weekend can still be closed out (and then edited).
  const EXACT = `LEAST(${MAX_MINUTES}, GREATEST(1,
      ROUND(EXTRACT(EPOCH FROM (NOW() - started_at)) / 60)))::int`;
  const rows = id
    ? await sql().query(
        `UPDATE time_entries SET ended_at = NOW(), minutes = ${EXACT}
         WHERE id = $1 AND contractor_id = $2 AND ended_at IS NULL
         RETURNING id, minutes`, [id, self.id])
    : await sql().query(
        `UPDATE time_entries SET ended_at = NOW(), minutes = ${EXACT}
         WHERE contractor_id = $1 AND ended_at IS NULL
         RETURNING id, minutes`, [self.id]);

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

  // Stored exact. Rounding happens when hours are totalled, not per entry.
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

// ------------------------------------------------------------ bulk import
/**
 * Bulk import — paste a spreadsheet of hours instead of typing entries one by
 * one. Same trust model as everything else here: a contractor can only ever
 * import onto themselves, a manager may name someone else per row.
 *
 * The CLIENT parses the CSV/TSV and converts each row's local date + clock time
 * into ISO instants, exactly as the by-hand modal already does — that keeps the
 * timezone contract at the top of this file intact, with the browser owning
 * timezones and the server owning durations.
 *
 * Two phases over one handler:
 *   dry_run: true   validate everything, write nothing, return a per-row report
 *   dry_run: false  re-validate from scratch, then insert as a single statement
 *
 * The commit deliberately re-runs the whole validation rather than trusting the
 * preview it just sent back: between the two calls a period can be approved or a
 * project deactivated, and a preview token would only paper over that.
 *
 * All-or-nothing. One multi-row INSERT is atomic in Postgres, so a batch either
 * lands whole or not at all — a half-imported timesheet is the failure mode that
 * makes people stop trusting the feature.
 */
const MAX_IMPORT_ROWS = 500;

/** Build the lookup tables an import needs, in two queries rather than 2N. */
async function importLookups(caller) {
  const projects = await sql()`SELECT id, name, code, is_active FROM time_projects`;
  const byKey = new Map();
  for (const p of projects) {
    // Code first: it's the shorter, more deliberate identifier, so if a code and
    // some other project's name collide the code is what the typist meant.
    if (p.code) byKey.set(`c:${String(p.code).trim().toLowerCase()}`, p);
    byKey.set(`n:${String(p.name).trim().toLowerCase()}`, p);
  }
  const contractors = caller.isManager
    ? await sql()`SELECT id, email, full_name, is_active FROM time_contractors`
    : [];
  const byEmail = new Map();
  for (const c of contractors) byEmail.set(String(c.email).trim().toLowerCase(), c);
  return { byKey, byEmail };
}

function resolveProject(byKey, raw) {
  if (raw === null || raw === undefined || String(raw).trim() === '') return { id: null, name: null };
  const key = String(raw).trim().toLowerCase();
  const hit = byKey.get(`c:${key}`) || byKey.get(`n:${key}`);
  if (!hit) throw new Error(`no project called "${String(raw).trim()}" — check the spelling or add it under Projects first`);
  if (hit.is_active === false) throw new Error(`project "${hit.name}" is archived — reactivate it under Projects first`);
  return { id: hit.id, name: hit.name };
}

/**
 * Validate one candidate row into the shape the INSERT wants. Throws with a
 * message written for whoever is staring at row 37 of their paste.
 */
function validateImportRow(raw, ctx) {
  const workDate  = coerceDate('date', raw.work_date);
  const startedAt = coerceInstant('start time', raw.started_at);
  const endedAt   = coerceInstant('finish time', raw.ended_at);

  const minutes = Math.round((endedAt.getTime() - startedAt.getTime()) / 60000);
  if (minutes <= 0)          throw new Error('the finish time is not after the start time');
  if (minutes > MAX_MINUTES) throw new Error('longer than 24 hours — split it across days');

  const project = resolveProject(ctx.byKey, raw.project);

  // Who the row is for. A contractor's rows are pinned to them whatever the
  // sheet says; only a manager's email column is honoured.
  let contractor = ctx.self;
  const email = optText(raw.contractor_email, 320);
  if (email && namesSomeoneElse(email, ctx)) {
    if (!ctx.isManager) throw new Error('you can only import your own time — remove the email column');
    const hit = ctx.byEmail.get(email.trim().toLowerCase());
    if (!hit) throw new Error(`no contractor with the email ${email.trim()} — they need to open the Time Tracker once first`);
    contractor = hit;
  }
  if (contractor.is_active === false) {
    throw new Error(`${contractor.full_name || contractor.email} is deactivated — reactivate them before importing their time`);
  }

  return {
    contractor_id: contractor.id,
    contractor_name: contractor.full_name || contractor.email,
    project_id: project.id,
    project_name: project.name,
    work_date: workDate,
    started_at: startedAt.toISOString(),
    ended_at: endedAt.toISOString(),
    minutes,
    description: optText(raw.description),
  };
}

/** True when the row's email column points at anyone other than the caller. */
function namesSomeoneElse(email, ctx) {
  return String(email).trim().toLowerCase() !== String(ctx.self.email).trim().toLowerCase();
}

/** Dates already covered by an approval, for the contractors in this batch. */
async function approvedDateGuard(candidates) {
  const ids = [...new Set(candidates.map((c) => c.contractor_id))];
  if (!ids.length) return () => false;
  const dates = candidates.map((c) => c.work_date).sort();
  const rows = await sql().query(
    `SELECT contractor_id, period_start, period_end
       FROM time_approvals
      WHERE contractor_id = ANY($1::int[])
        AND period_end >= $2 AND period_start <= $3`,
    [ids, dates[0], dates[dates.length - 1]]
  );
  const spans = rows.map((r) => ({ cid: r.contractor_id, from: dstr(r.period_start), to: dstr(r.period_end) }));
  return (row) => spans.some((s) => s.cid === row.contractor_id && row.work_date >= s.from && row.work_date <= s.to);
}

/**
 * Rows that look like something already logged. A warning, never a hard error:
 * two identical half-hour blocks on the same day are perfectly legitimate, and
 * refusing them would make the honest case impossible. The client defaults to
 * leaving them out; the person can put them back.
 */
async function duplicateProbe(candidates) {
  if (!candidates.length) return () => false;
  const ids = [...new Set(candidates.map((c) => c.contractor_id))];
  const dates = [...new Set(candidates.map((c) => c.work_date))];
  const rows = await sql().query(
    `SELECT contractor_id, work_date, started_at, minutes
       FROM time_entries
      WHERE contractor_id = ANY($1::int[]) AND work_date = ANY($2::date[]) AND ended_at IS NOT NULL`,
    [ids, dates]
  );
  const seen = new Set(rows.map((r) =>
    `${r.contractor_id}|${dstr(r.work_date)}|${new Date(r.started_at).toISOString()}|${r.minutes}`));
  return (row) => seen.has(`${row.contractor_id}|${row.work_date}|${row.started_at}|${row.minutes}`);
}

async function handleImportEntries(caller, body) {
  const self = await ensureContractor(caller);
  if (!caller.isManager) { try { assertActive(self); } catch (e) { return bad(e.message, e.status); } }

  const rows = body.rows;
  if (!Array.isArray(rows) || !rows.length) return bad('nothing to import — paste some rows first');
  if (rows.length > MAX_IMPORT_ROWS) {
    return bad(`that's ${rows.length} rows — import at most ${MAX_IMPORT_ROWS} at a time`);
  }

  const { byKey, byEmail } = await importLookups(caller);
  const ctx = { self, byKey, byEmail, isManager: caller.isManager };

  // Pass 1 — shape and identity, row by row.
  const report = [];
  const candidates = [];
  rows.forEach((raw, i) => {
    const line = Number(raw && raw.line) || i + 1;
    try {
      const c = validateImportRow(raw || {}, ctx);
      c.line = line;
      candidates.push(c);
      report.push({ line, status: 'ok', ...c });
    } catch (e) {
      report.push({ line, status: 'error', message: e.message });
    }
  });

  // Pass 2 — the two checks that need the whole batch in hand, so they cost one
  // query each instead of one per row.
  if (candidates.length) {
    const isApproved = await approvedDateGuard(candidates);
    const isDupe = await duplicateProbe(candidates);
    // Repeats *within the paste itself* count too — a sheet with the same block
    // pasted twice is the commonest way a batch goes in doubled, and nothing in
    // the database can catch it because neither copy is there yet.
    const withinBatch = new Set();
    for (const entry of report) {
      if (entry.status !== 'ok') continue;
      const key = `${entry.contractor_id}|${entry.work_date}|${entry.started_at}|${entry.minutes}`;
      if (isApproved(entry)) {
        entry.status = 'error';
        entry.message = 'that day is inside an approved timesheet — undo the approval first';
      } else if (isDupe(entry)) {
        entry.status = 'duplicate';
        entry.message = 'looks like this is already logged';
      } else if (withinBatch.has(key)) {
        entry.status = 'duplicate';
        entry.message = 'the same row appears earlier in this paste';
      }
      withinBatch.add(key);
    }
  }

  const summary = {
    total: report.length,
    ok: report.filter((r) => r.status === 'ok').length,
    duplicates: report.filter((r) => r.status === 'duplicate').length,
    errors: report.filter((r) => r.status === 'error').length,
  };

  if (body.dry_run !== false) return ok({ dryRun: true, summary, rows: report });

  // ---- commit
  if (summary.errors) {
    return bad(`${summary.errors} of ${summary.total} rows can't be imported — fix or remove them and try again`, 422);
  }
  const importable = report.filter((r) => r.status === 'ok' || r.status === 'duplicate');
  if (!importable.length) return bad('nothing left to import');

  const batchId = randomUUID();
  const cols = 10;
  const values = [];
  const args = [];
  importable.forEach((r, i) => {
    const b = i * cols;
    values.push(`($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6}, $${b + 7}, $${b + 8}, $${b + 9}, $${b + 10})`);
    args.push(r.contractor_id, r.project_id, r.work_date, r.started_at, r.ended_at,
      r.minutes, r.description, 'import', false, batchId);
  });
  const inserted = await sql().query(
    `INSERT INTO time_entries
       (contractor_id, project_id, work_date, started_at, ended_at, minutes, description, source, locked, import_batch_id)
     VALUES ${values.join(', ')}
     RETURNING id`,
    args
  );

  return ok({
    imported: inserted.length,
    batchId,
    summary,
    // What actually went in, so the client can say "42 rows, 2 of them possible
    // repeats" rather than a bare count.
    duplicatesIncluded: importable.filter((r) => r.status === 'duplicate').length,
  });
}

/**
 * Take a whole import back out. Keyed on the batch id, which only imported rows
 * carry, so this can never reach a timer tick or a hand-typed entry.
 *
 * Refuses a batch with any locked row rather than deleting around it: a partly
 * withdrawn import leaves hours no one can account for, which is worse than
 * making someone undo the approval first.
 */
async function handleUndoImport(caller, body) {
  const self = await ensureContractor(caller);
  const batchId = String((body && body.batch_id) || '').trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(batchId)) {
    return bad('batch_id required');
  }

  const rows = await sql()`
    SELECT id, contractor_id, locked FROM time_entries WHERE import_batch_id = ${batchId}
  `;
  if (!rows.length) return bad('that import has already been undone, or never existed', 404);

  if (!caller.isManager && rows.some((r) => r.contractor_id !== self.id)) {
    return bad('that import includes other people\'s time — an admin has to undo it', 403);
  }
  if (rows.some((r) => r.locked)) {
    return bad('part of that import is on an approved timesheet — undo the approval first, then remove the import', 409);
  }

  const gone = await sql()`DELETE FROM time_entries WHERE import_batch_id = ${batchId} RETURNING id`;
  return ok({ undone: gone.length, batchId });
}

// ------------------------------------- manager: restore exact entry minutes
/**
 * Put back the exact minutes on entries that were rounded individually.
 *
 * An earlier version of this tracker snapped every entry to a quarter hour as it
 * was saved. That was wrong: rounding each entry and then adding them up
 * accumulates the errors rather than cancelling them, so a week of fourteen
 * entries could lose twenty-odd minutes of real work. Billing now rounds the
 * TOTAL instead, which needs the entries underneath it to be exact.
 *
 * Nothing was lost by that rounding: `minutes` has always been derived from
 * started_at / ended_at, and those instants were never rounded, so the true
 * duration of every affected entry is recoverable from the row itself. This
 * recomputes it.
 *
 * Deliberately narrow, same as before: entries on an approved timesheet are left
 * exactly as approved. A running timer has no ended_at and is skipped.
 *
 * Two phases:
 *   dry_run: true   report what would change, per contractor, and write nothing
 *   dry_run: false  apply it in one statement, returning every prior value
 */
const EXACT_MINUTES_SQL = `LEAST(${MAX_MINUTES}, GREATEST(1,
  ROUND(EXTRACT(EPOCH FROM (e.ended_at - e.started_at)) / 60)))::int`;

// Which entries this tool may look at at all.
const RESTORE_SCOPE = `
  e.locked = FALSE
  AND e.approval_id IS NULL
  AND e.ended_at IS NOT NULL
  AND e.started_at IS NOT NULL
`;
// …and which of those actually disagree with their recorded times.
const DIFFERS = `e.minutes IS DISTINCT FROM ${EXACT_MINUTES_SQL}`;
const RESTORE_WHERE = `${RESTORE_SCOPE} AND ${DIFFERS}`;

async function handleRestoreExact(caller, body) {
  if (!caller.isManager) return bad('admin role required', 403);

  let from = null, to = null;
  try {
    if (body.from) from = coerceDate('from', body.from);
    if (body.to)   to   = coerceDate('to', body.to);
  } catch (e) { return bad(e.message); }
  if (from && to && from > to) return bad('`from` cannot be after `to`');

  const args = [];
  let window = '';
  if (from) { args.push(from); window += ` AND e.work_date >= $${args.length}`; }
  if (to)   { args.push(to);   window += ` AND e.work_date <= $${args.length}`; }

  // Per contractor: what's stored now, what the clock actually says, and — since
  // billing rounds the total — what each of those totals bills as. The billed
  // column is the one that matters; the rest is showing the working.
  // The totals span EVERY unapproved entry the person has in the window, not
  // just the ones that change — "billed 3.25 h → 3.58 h" across four corrected
  // rows tells an admin nothing about the invoice. `entries` counts only what
  // actually moves, and the HAVING drops anyone with nothing to correct.
  const perPerson = await sql().query(
    `SELECT c.id, c.email, c.full_name, c.hourly_rate, c.currency,
            COUNT(*) FILTER (WHERE ${DIFFERS})::int         AS entries,
            COALESCE(SUM(e.minutes), 0)::int                AS stored_minutes,
            COALESCE(SUM(${EXACT_MINUTES_SQL}), 0)::int     AS exact_minutes,
            MIN(e.work_date) FILTER (WHERE ${DIFFERS})      AS first_entry,
            MAX(e.work_date) FILTER (WHERE ${DIFFERS})      AS last_entry
       FROM time_entries e
       JOIN time_contractors c ON c.id = e.contractor_id
      WHERE ${RESTORE_SCOPE}${window}
      GROUP BY c.id
     HAVING COUNT(*) FILTER (WHERE ${DIFFERS}) > 0
      ORDER BY LOWER(COALESCE(c.full_name, c.email))`,
    args
  );

  const people = perPerson.map((r) => {
    const billedBefore = roundBillableMinutes(r.stored_minutes);
    const billedAfter  = roundBillableMinutes(r.exact_minutes);
    const delta = billedAfter - billedBefore;
    const rate = r.hourly_rate === null ? null : Number(r.hourly_rate);
    return {
      contractor_id: r.id,
      name: r.full_name || r.email,
      email: r.email,
      entries: r.entries,
      stored_minutes: r.stored_minutes,
      exact_minutes: r.exact_minutes,
      billed_before: billedBefore,
      billed_after: billedAfter,
      delta_minutes: delta,
      currency: r.currency,
      // Null rather than 0 when no rate is set — "no rate on file" and "costs
      // nothing" are different things and shouldn't look the same in the UI.
      delta_amount: rate === null ? null : Math.round((delta / 60) * rate * 100) / 100,
      first_entry: dstr(r.first_entry),
      last_entry: dstr(r.last_entry),
    };
  });

  const summary = {
    entries: people.reduce((s, p) => s + p.entries, 0),
    contractors: people.length,
    stored_minutes: people.reduce((s, p) => s + p.stored_minutes, 0),
    exact_minutes: people.reduce((s, p) => s + p.exact_minutes, 0),
    billed_before: people.reduce((s, p) => s + p.billed_before, 0),
    billed_after: people.reduce((s, p) => s + p.billed_after, 0),
  };
  summary.delta_minutes = summary.billed_after - summary.billed_before;

  // What's being left alone, and why — otherwise the counts beg the question.
  const skipped = await sql().query(
    `SELECT COUNT(*) FILTER (WHERE a.payment_id IS NOT NULL)::int AS paid,
            COUNT(*) FILTER (WHERE a.payment_id IS NULL)::int     AS approved_unpaid
       FROM time_entries e
       LEFT JOIN time_approvals a ON a.id = e.approval_id
      WHERE e.approval_id IS NOT NULL
        AND e.ended_at IS NOT NULL AND e.started_at IS NOT NULL
        AND e.minutes IS DISTINCT FROM ${EXACT_MINUTES_SQL}${window}`,
    args
  );

  const out = {
    dryRun: body.dry_run !== false,
    from, to,
    summary,
    people,
    skipped: { approvedUnpaid: skipped[0].approved_unpaid, paid: skipped[0].paid },
  };
  if (out.dryRun) return ok(out);

  if (!summary.entries) return bad('nothing to restore — every unapproved entry already matches its recorded times');

  // Return the old value alongside the new one so the client can save a CSV of
  // the before-state. The self-join reads the pre-update snapshot.
  const done = await sql().query(
    `UPDATE time_entries AS e
        SET minutes = ${EXACT_MINUTES_SQL}
       FROM (SELECT id, minutes AS was FROM time_entries) o
      WHERE o.id = e.id AND ${RESTORE_WHERE}${window}
      RETURNING e.id, o.was, e.minutes AS now`,
    args
  );
  console.log(`time-tracking: ${caller.email} restored exact minutes on ${done.length} entries`
    + ` (billed ${summary.delta_minutes >= 0 ? '+' : ''}${summary.delta_minutes} min)`);
  return ok({
    ...out,
    dryRun: false,
    restored: done.length,
    changes: done.map((r) => ({ id: r.id, was: r.was, now: r.now })),
  });
}

// ------------------------------------------------------- manager: roster
async function handleContractors(caller, qs) {
  if (!caller.isManager) return bad('admin role required', 403);
  let from, to;
  try { ({ from, to } = range({ from: qs.from, to: qs.to })); } catch (e) { return bad(e.message); }
  const rows = await sql().query(
    `SELECT c.*,
            ${ROUND_TOTAL_SQL(`COALESCE(SUM(e.minutes) FILTER (WHERE e.work_date BETWEEN $1 AND $2 AND e.ended_at IS NOT NULL), 0)`)} AS period_minutes,
            COALESCE(SUM(e.minutes) FILTER (WHERE e.work_date BETWEEN $1 AND $2 AND e.ended_at IS NOT NULL), 0)::int AS period_minutes_exact,
            ${ROUND_TOTAL_SQL(`COALESCE(SUM(e.minutes) FILTER (WHERE e.work_date BETWEEN $1 AND $2 AND e.ended_at IS NOT NULL AND e.locked = FALSE), 0)`)} AS unapproved_minutes,
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
  if (!caller.isManager) return bad('admin role required', 403);
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
  if (!caller.isManager) return bad('admin role required', 403);
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
  if (!caller.isManager) return bad('admin role required', 403);
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
  if (!caller.isManager) return bad('admin role required', 403);
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
  if (!caller.isManager) return bad('admin role required', 403);
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

  // Written with .query() rather than the tagged-template form because the
  // rounding expression has to reach Postgres as SQL. In a tagged template every
  // ${…} becomes a bind parameter, so interpolating ROUND_TOTAL_SQL there sends
  // the expression as a text value and the statement fails at run time.
  const rows = await sql().query(
    `WITH pend AS (
      SELECT id, minutes FROM time_entries
      WHERE contractor_id = $1 AND work_date BETWEEN $2 AND $3
        AND ended_at IS NOT NULL AND locked = FALSE
      -- FOR UPDATE serialises two managers clicking approve at the same moment:
      -- the second waits, re-checks locked = FALSE against the now-committed
      -- rows, finds nothing pending, and inserts no approval. Without it, both
      -- could write a full-value timesheet for the same hours.
      FOR UPDATE
    ), tot AS (
      -- The timesheet total is rounded here, ONCE, from the exact entry minutes.
      -- Rounding the entries first and summing those would lose time; see
      -- ROUND_TO_MINUTES at the top of this file.
      SELECT ${ROUND_TOTAL_SQL('COALESCE(SUM(minutes), 0)')} AS m,
             COUNT(*)::int AS n,
             COALESCE(SUM(minutes), 0)::int AS raw_m
        FROM pend
    ), ins AS (
      INSERT INTO time_approvals
        (contractor_id, period_start, period_end, total_minutes, hourly_rate, currency, amount, approved_by, notes)
      SELECT $1, $2, $3, tot.m, $4::numeric, $5,
             CASE WHEN $4::numeric IS NULL THEN NULL
                  ELSE ROUND((tot.m / 60.0) * $4::numeric, 2) END,
             $6, $7
      FROM tot WHERE tot.n > 0
      RETURNING *
    ), upd AS (
      UPDATE time_entries SET approval_id = (SELECT id FROM ins), locked = TRUE
      WHERE id IN (SELECT id FROM pend) AND locked = FALSE AND EXISTS (SELECT 1 FROM ins)
      RETURNING id
    )
    SELECT (SELECT row_to_json(ins) FROM ins) AS approval,
           (SELECT COUNT(*)::int FROM upd)    AS locked_count,
           (SELECT n FROM tot)                AS pending_count,
           (SELECT raw_m FROM tot)            AS raw_minutes`,
    [cid, start, end, rate, contractor.currency, caller.email, notes]
  );

  if (!rows[0].approval) {
    return bad('nothing to approve in that period — the entries are already approved or there are none');
  }
  return ok({
    approval: rows[0].approval,
    lockedEntries: rows[0].locked_count,
    needsRate: rate === null,
    // The exact sum behind the rounded timesheet, so the UI can show both.
    rawMinutes: rows[0].raw_minutes,
  });
}

async function handleUnapprove(caller, body) {
  if (!caller.isManager) return bad('admin role required', 403);
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
  if (!caller.isManager) return bad('admin role required', 403);
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

// Pure, DB-free pieces of the import path, exposed for test/time-import.test.mjs.
// Netlify only ever looks at `handler`, so this is inert in production.
exports.__test = {
  validateImportRow, resolveProject, namesSomeoneElse, MAX_IMPORT_ROWS,
  roundBillableMinutes, ROUND_TOTAL_SQL, EXACT_MINUTES_SQL,
  ROUND_TO_MINUTES, MIN_BILLABLE_MINUTES, MAX_MINUTES,
};

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
      if (action === 'import-entries')   return await handleImportEntries(caller, body);
      if (action === 'undo-import')      return await handleUndoImport(caller, body);
      if (action === 'save-contractor')  return await handleSaveContractor(caller, body);
      if (action === 'save-project')     return await handleSaveProject(caller, body);
      if (action === 'delete-project')   return await handleDeleteProject(caller, body);
      if (action === 'approve')          return await handleApprove(caller, body);
      if (action === 'unapprove')        return await handleUnapprove(caller, body);
      if (action === 'push-payment')     return await handlePushPayment(caller, body);
      if (action === 'restore-exact')    return await handleRestoreExact(caller, body);
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

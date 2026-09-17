/**
 * Database-backed tests for the per-brand split on approved timesheets.
 *
 * The split payroll reads is not stored on the approval — it is rebuilt from the
 * entries locked to it, by a SQL aggregate (APPROVAL_BRANDS_SQL) that no amount
 * of unit testing reaches. So this runs the real `approvals` handler against a
 * real PostgreSQL, through the real `approve` handler, and checks the two agree.
 *
 * What it pins down:
 *
 *   - every locked minute lands in exactly one brand bucket, including the time
 *     logged against no project at all;
 *   - the split follows the entries, so an edit that retotals a timesheet moves
 *     the split with it rather than leaving payroll a stale breakdown;
 *   - undoing an approval takes its split with it.
 *
 * NOT part of `npm test` — it needs a database. Run it against a scratch one:
 *
 *   initdb -D /tmp/pgd -U postgres --auth=trust
 *   pg_ctl -D /tmp/pgd -o "-k /tmp/pgrun -p 5433" start
 *   DATABASE_URL="postgres://postgres@localhost:5433/postgres?host=/tmp/pgrun" \
 *     node test/time-brand-approvals.db.test.mjs
 *
 * Everything happens inside a throwaway schema, which is dropped on the way out.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

const URL_ = process.env.DATABASE_URL || process.env.NETLIFY_DATABASE_URL;
if (!URL_) {
  console.log('SKIP time-brand-approvals.db — set DATABASE_URL to a scratch PostgreSQL to run these.');
  process.exit(0);
}

let pg;
try { pg = require('pg'); }
catch { console.log('SKIP time-brand-approvals.db — `npm i pg` first (dev-only dependency).'); process.exit(0); }

const SCHEMA = 'time_brand_test_' + Date.now();
const pool = new pg.Pool({ connectionString: URL_ });

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ok   ${name}`); passed++; }
  catch (err) { console.error(`  FAIL ${name}\n       ${err.message}`); failed++; }
}

// ── Wire the function's neon() driver to this pool, inside our own schema ────
const q = (text, args) => pool.query(text, args).then((r) => r.rows);
const tagged = (strings, ...vals) => {
  if (!Array.isArray(strings)) return null;
  return q(strings.reduce((a, s, i) => a + s + (i < vals.length ? '$' + (i + 1) : ''), ''), vals);
};
tagged.query = q;
require.cache[require.resolve('@neondatabase/serverless')] = { exports: { neon: () => tagged } };
process.env.NETLIFY_DATABASE_URL = URL_;

const fn = require(path.join(root, 'netlify/functions/time-tracking.js'));

const asAdmin = { clientContext: { user: { email: 'boss@test', app_metadata: { roles: ['admin'] } } } };
const asUser  = { clientContext: { user: { email: 'sam@test',  app_metadata: { roles: [] } } } };
const call = async (method, ctx, payload) => {
  const r = await fn.handler(method === 'GET'
    ? { httpMethod: 'GET', queryStringParameters: payload, body: null }
    : { httpMethod: 'POST', queryStringParameters: {}, body: JSON.stringify(payload) }, ctx);
  return { status: r.statusCode, body: JSON.parse(r.body) };
};

/** The brand split the handler reports, as a plain { brand: minutes } map. */
const splitOf = (approval) => Object.fromEntries(
  (approval.brand_minutes || []).map((b) => [b.brand === '' ? '(none)' : b.brand, b.minutes]));

async function setup() {
  await q(`CREATE SCHEMA ${SCHEMA}`);
  await pool.query(`SET search_path TO ${SCHEMA}`);
  pool.on('connect', (c) => c.query(`SET search_path TO ${SCHEMA}`));
  await q(`
    CREATE TABLE time_contractors (
      id serial PRIMARY KEY, email text UNIQUE NOT NULL, full_name text,
      hourly_rate numeric, currency text DEFAULT 'NZD', vendor_name text,
      notes text, is_active boolean NOT NULL DEFAULT true);
    CREATE TABLE time_projects (
      id serial PRIMARY KEY, name text NOT NULL, code text, brand text,
      sort_order int DEFAULT 100, is_active boolean NOT NULL DEFAULT true, notes text);
    CREATE TABLE time_approvals (
      id serial PRIMARY KEY, contractor_id int, period_start date, period_end date,
      total_minutes int, hourly_rate numeric, currency text, amount numeric,
      approved_by text, notes text, payment_id int);
    CREATE TABLE time_entries (
      id serial PRIMARY KEY, contractor_id int NOT NULL, project_id int,
      work_date date NOT NULL, started_at timestamptz, ended_at timestamptz,
      minutes int, description text, source text,
      locked boolean NOT NULL DEFAULT false, approval_id int, import_batch_id uuid,
      brand text);
    CREATE TABLE payments (id serial PRIMARY KEY, paid boolean, due_date date, invoice_file_url text);
  `);
  await q(`INSERT INTO time_contractors (email, full_name, hourly_rate) VALUES ('sam@test','Sam',60)`);
  await q(`INSERT INTO time_projects (id, name, code, brand) VALUES
    (1,'Website rebuild','WEB','Pacific Discovery'),
    (2,'Leader portal','LEAD','Unearthed Education'),
    (3,'Housekeeping','ADMIN',NULL),
    (4,'Blank brand','BLANK','   ')`);
  await q(`SELECT setval('time_projects_id_seq', 4)`);
}

const addEntry = (projectId, mins, d = '2026-08-20') => q(
  `INSERT INTO time_entries (contractor_id, project_id, work_date, started_at, ended_at, minutes, source)
   VALUES (1, $1, $2, TIMESTAMPTZ '${d} 09:00+12',
           TIMESTAMPTZ '${d} 09:00+12' + make_interval(mins => $3), $3, 'manual') RETURNING id`,
  [projectId, d, mins]);

const approveWeek = () => call('POST', asAdmin,
  { action: 'approve', contractor_id: 1, period_start: '2026-08-17', period_end: '2026-08-23' });
const latest = async () => (await call('GET', asAdmin, { action: 'approvals', limit: '10' })).body.approvals[0];

// ════════════════════════════════════════════════════
try {
  await setup();

  console.log('\nthe split payroll reads is rebuilt from the locked entries');

  await test('every brand on the timesheet comes back with its exact minutes', async () => {
    await addEntry(1, 195);
    await addEntry(1, 142);
    await addEntry(2, 128);
    const r = await approveWeek();
    assert.equal(r.status, 200);
    assert.deepEqual(splitOf(await latest()),
      { 'Pacific Discovery': 337, 'Unearthed Education': 128 });
  });

  await test('the subtotals account for every locked minute', async () => {
    const a = await latest();
    const summed = (a.brand_minutes || []).reduce((s, b) => s + b.minutes, 0);
    const [{ exact }] = await q(
      `SELECT COALESCE(SUM(minutes),0)::int AS exact FROM time_entries WHERE approval_id = $1`, [a.id]);
    assert.equal(summed, exact, 'the split must not lose or invent time');
  });

  await test('subtotals are exact, so they need not equal the rounded total_minutes', async () => {
    const a = await latest();
    const summed = (a.brand_minutes || []).reduce((s, b) => s + b.minutes, 0);
    assert.equal(summed, 465, '337 + 128');
    assert.equal(a.total_minutes, 465, 'this one happens to be a whole quarter hour');
    // The rounding lives on the total; the split is deliberately not re-rounded.
    assert.ok(Math.abs(summed - a.total_minutes) < 15, 'never more than a quarter hour apart');
  });

  await test('a project with no brand, and one with a blank brand, share one bucket', async () => {
    await q(`UPDATE time_entries SET locked = false, approval_id = NULL`);
    await q(`DELETE FROM time_approvals`);
    await addEntry(3, 40);   // brand IS NULL
    await addEntry(4, 20);   // brand is whitespace
    await approveWeek();
    const split = splitOf(await latest());
    assert.equal(split['(none)'], 60, 'both land in the empty-brand bucket the UI labels "Unassigned"');
  });

  await test('time logged against no project at all lands there too', async () => {
    await q(`UPDATE time_entries SET locked = false, approval_id = NULL`);
    await q(`DELETE FROM time_approvals`);
    await q(`INSERT INTO time_entries (contractor_id, project_id, work_date, started_at, ended_at, minutes, source)
             VALUES (1, NULL, '2026-08-20', TIMESTAMPTZ '2026-08-20 09:00+12',
                     TIMESTAMPTZ '2026-08-20 09:33+12', 33, 'timer')`);
    await approveWeek();
    assert.ok(splitOf(await latest())['(none)'] >= 33, 'a NULL project_id is not dropped by the join');
  });

  await test('an unapproved entry in the same week is not in the split', async () => {
    const before = splitOf(await latest());
    await addEntry(1, 77);                      // logged after the approval, still open
    assert.deepEqual(splitOf(await latest()), before, 'only locked entries count');
  });

  console.log('\nthe split follows the timesheet');

  await test('editing an entry moves the split with the retotalled timesheet', async () => {
    await q(`UPDATE time_entries SET locked = false, approval_id = NULL`);
    await q(`DELETE FROM time_approvals`);
    await q(`DELETE FROM time_entries`);
    const [{ id }] = await addEntry(1, 120);
    await addEntry(2, 60);
    await approveWeek();
    assert.deepEqual(splitOf(await latest()), { 'Pacific Discovery': 120, 'Unearthed Education': 60 });

    const r = await call('POST', asAdmin, { action: 'update-entry', id, patch: { project_id: 2 } });
    assert.equal(r.status, 200, r.body.error);
    assert.deepEqual(splitOf(await latest()), { 'Unearthed Education': 180 },
      'the entry moved brand, so the timesheet payroll reads moved with it');
  });

  await test('undoing the approval takes its split away', async () => {
    const a = await latest();
    const r = await call('POST', asAdmin, { action: 'unapprove', id: a.id });
    assert.equal(r.status, 200, r.body.error);
    const list = (await call('GET', asAdmin, { action: 'approvals', limit: '10' })).body.approvals;
    assert.equal(list.length, 0, 'no approval, nothing for payroll to read');
  });

  await test('a timesheet with no entries left reports an empty split, not null', async () => {
    await q(`INSERT INTO time_approvals (contractor_id, period_start, period_end, total_minutes, currency)
             VALUES (1, '2026-07-01', '2026-07-07', 0, 'NZD')`);
    const a = await latest();
    assert.ok(Array.isArray(a.brand_minutes), 'always an array — the client maps over it unguarded');
    assert.equal(a.brand_minutes.length, 0);
  });

  console.log('\nan entry can be booked against a brand other than its project\'s');

  const reset = async () => {
    await q(`UPDATE time_entries SET locked = false, approval_id = NULL`);
    await q(`DELETE FROM time_approvals`);
    await q(`DELETE FROM time_entries`);
  };
  const tick = (payload) => call('POST', asUser,
    { action: 'create-entry', work_date: '2026-08-20',
      started_at: '2026-08-20T21:00:00Z', ended_at: '2026-08-20T23:00:00Z', ...payload });

  await test('picking nothing inherits the project — and stores no override', async () => {
    await reset();
    const r = await tick({ project_id: 1 });
    assert.equal(r.status, 200, r.body.error);
    assert.equal(r.body.entry.brand, 'Pacific Discovery', 'resolved brand follows the project');
    assert.equal(r.body.entry.entry_brand, null, 'nothing pinned to the row');
  });

  await test('picking the project\'s own brand still stores no override', async () => {
    await reset();
    const r = await tick({ project_id: 1, brand: 'Pacific Discovery' });
    assert.equal(r.body.entry.entry_brand, null,
      'a copy of the project brand would quietly cut the entry loose from it');
    assert.equal(r.body.entry.brand, 'Pacific Discovery');
  });

  await test('picking a different brand is recorded on the entry', async () => {
    await reset();
    const r = await tick({ project_id: 1, brand: 'Unearthed Education' });
    assert.equal(r.body.entry.entry_brand, 'Unearthed Education');
    assert.equal(r.body.entry.brand, 'Unearthed Education', 'the override wins over the project');
    assert.equal(r.body.entry.project_brand, 'Pacific Discovery', 'the project is unchanged');
  });

  await test('one shared project splits across brands on the timesheet', async () => {
    await reset();
    await tick({ project_id: 1 });                                  // 120 min, inherits PD
    await tick({ project_id: 1, brand: 'Unearthed Education' });    // 120 min, override
    await tick({ project_id: 1, brand: 'Pure Exploration' });       // 120 min, override
    await approveWeek();
    assert.deepEqual(splitOf(await latest()), {
      'Pacific Discovery': 120, 'Unearthed Education': 120, 'Pure Exploration': 120,
    }, 'the whole point: three brands out of one project');
  });

  await test('re-branding the project moves the entries that never overrode it', async () => {
    await reset();
    await tick({ project_id: 1 });                                  // inherits
    await tick({ project_id: 1, brand: 'Unearthed Education' });    // pinned
    await approveWeek();
    await q(`UPDATE time_projects SET brand = 'Pure Exploration' WHERE id = 1`);
    assert.deepEqual(splitOf(await latest()), {
      'Pure Exploration': 120, 'Unearthed Education': 120,
    }, 'the inheriting entry follows the fix; the deliberate one holds');
    await q(`UPDATE time_projects SET brand = 'Pacific Discovery' WHERE id = 1`);
  });

  await test('moving an entry onto a project that already has that brand drops the override', async () => {
    await reset();
    const r = await tick({ project_id: 1, brand: 'Unearthed Education' });
    const moved = await call('POST', asUser,
      { action: 'update-entry', id: r.body.entry.id, patch: { project_id: 2 } });
    assert.equal(moved.status, 200, moved.body.error);
    assert.equal(moved.body.entry.entry_brand, null,
      'project 2 IS Unearthed — keeping a copy would stop it following that project');
    assert.equal(moved.body.entry.brand, 'Unearthed Education', 'and the answer is unchanged');
  });

  await test('an override survives a move to a project with a different brand', async () => {
    await reset();
    const r = await tick({ project_id: 2, brand: 'Pacific Discovery' });
    const moved = await call('POST', asUser,
      { action: 'update-entry', id: r.body.entry.id, patch: { description: 'typo fix' } });
    assert.equal(moved.body.entry.entry_brand, 'Pacific Discovery', 'an unrelated edit must not clear it');
  });

  await test('clearing the brand hands the entry back to its project', async () => {
    await reset();
    const r = await tick({ project_id: 1, brand: 'Unearthed Education' });
    const cleared = await call('POST', asUser,
      { action: 'update-entry', id: r.body.entry.id, patch: { brand: '' } });
    assert.equal(cleared.body.entry.entry_brand, null);
    assert.equal(cleared.body.entry.brand, 'Pacific Discovery');
  });

  await test('a blank or whitespace brand is never a brand of its own', async () => {
    await reset();
    const r = await tick({ project_id: 4, brand: '   ' });   // project 4's brand is whitespace
    assert.equal(r.body.entry.entry_brand, null);
    assert.equal(r.body.entry.brand, '', 'falls into the Unassigned bucket, not a phantom brand');
  });

  await test('an imported row carries a Brand column the same way', async () => {
    await reset();
    const r = await call('POST', asUser, { action: 'import-entries', dry_run: false, rows: [
      { line: 1, work_date: '2026-08-20', started_at: '2026-08-20T21:00:00Z',
        ended_at: '2026-08-20T22:00:00Z', project: 'WEB', brand: 'Unearthed Education' },
      { line: 2, work_date: '2026-08-20', started_at: '2026-08-20T22:00:00Z',
        ended_at: '2026-08-20T23:00:00Z', project: 'WEB', brand: 'Pacific Discovery' },
      { line: 3, work_date: '2026-08-20', started_at: '2026-08-20T23:00:00Z',
        ended_at: '2026-08-21T00:00:00Z', project: 'WEB' },
    ] });
    assert.equal(r.status, 200, r.body.error);
    const got = await q(`SELECT brand FROM time_entries ORDER BY started_at`);
    assert.deepEqual(got.map((x) => x.brand), ['Unearthed Education', null, null],
      'only the divergent row is pinned; the one repeating the project brand is not');
  });

  console.log('\nand it stays behind the admin boundary');

  await test('a contractor cannot read approvals, split or otherwise', async () => {
    const r = await call('GET', asUser, { action: 'approvals' });
    assert.equal(r.status, 403);
  });

  await test('filtering by contractor still returns the split', async () => {
    const r = await call('GET', asAdmin, { action: 'approvals', contractor_id: '1', limit: '10' });
    assert.equal(r.status, 200, r.body.error);
    assert.ok(r.body.approvals.every((a) => Array.isArray(a.brand_minutes)),
      'the filtered branch must carry the aggregate too — it is a separate query');
  });
} finally {
  await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => {});
  await pool.end();
}

console.log(`\n${passed}/${passed + failed} passed`);
if (failed) process.exit(1);

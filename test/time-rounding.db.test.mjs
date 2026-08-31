/**
 * Database-backed tests for quarter-hour rounding.
 *
 * These exist because the rounding rule is written twice — once as
 * `roundBillableMinutes()` in JavaScript, and once as `ROUND_TOTAL_SQL` for the
 * totals computed in the database. Two dialects of one rule is exactly the
 * arrangement that drifts, and no amount of unit testing the JS half will catch
 * it. So this runs the real handler against a real PostgreSQL and compares them.
 *
 * The rule under test, which is the whole point of the design:
 *
 *     entries store EXACT minutes; the TOTAL is what gets rounded.
 *
 * Rounding each entry and then summing accumulates the error instead of
 * cancelling it — 14 entries totalling 938 minutes billed as 915 rather than
 * 945, losing 23 minutes of real work. There is a test below that fails if that
 * behaviour ever comes back.
 *
 * It also pins the restore tool's blast radius: an approved, paid, or running
 * entry must come out the far side untouched, and the before-values it hands
 * back must be good enough to restore from.
 *
 * NOT part of `npm test` — it needs a database. Run it against a scratch one:
 *
 *   initdb -D /tmp/pgd -U postgres --auth=trust
 *   pg_ctl -D /tmp/pgd -o "-k /tmp/pgrun -p 5433" start
 *   DATABASE_URL="postgres://postgres@localhost:5433/postgres?host=/tmp/pgrun" \
 *     node test/time-rounding.db.test.mjs
 *
 * Everything happens inside a throwaway schema, which is dropped on the way out.
 * It will not touch tables in the default search path — but point it at a
 * scratch database anyway.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

const URL_ = process.env.DATABASE_URL || process.env.NETLIFY_DATABASE_URL;
if (!URL_) {
  console.log('SKIP time-rounding.db — set DATABASE_URL to a scratch PostgreSQL to run these.');
  process.exit(0);
}

let pg;
try { pg = require('pg'); }
catch { console.log('SKIP time-rounding.db — `npm i pg` first (dev-only dependency).'); process.exit(0); }

const SCHEMA = 'time_rounding_test_' + Date.now();
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
const { roundBillableMinutes, ROUND_TOTAL_SQL, MAX_MINUTES } = fn.__test;

const asAdmin = { clientContext: { user: { email: 'boss@test', app_metadata: { roles: ['admin'] } } } };
const asUser  = { clientContext: { user: { email: 'sam@test',  app_metadata: { roles: [] } } } };
const post = async (ctx, body) => {
  const r = await fn.handler(
    { httpMethod: 'POST', queryStringParameters: {}, body: JSON.stringify(body) }, ctx);
  return { status: r.statusCode, body: JSON.parse(r.body) };
};

async function setup() {
  await q(`CREATE SCHEMA ${SCHEMA}`);
  // Every later statement — including the function's — resolves here.
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
      locked boolean NOT NULL DEFAULT false, approval_id int, import_batch_id uuid);
  `);
  await q(`INSERT INTO time_contractors (email, full_name, hourly_rate) VALUES
    ('jake@test','Jake',80), ('sam@test','Sam',60), ('norate@test','No Rate',NULL)`);
  await q(`INSERT INTO time_approvals (id, contractor_id, payment_id) VALUES (1,1,99),(2,1,NULL)`);
  await q(`SELECT setval('time_approvals_id_seq', 2)`);

  // Sam: the reported case. 14 entries whose true durations total 938 minutes
  // (15.63 h). started_at/ended_at carry the real length; `minutes` here is what
  // the old per-entry rounding left behind, summing to 915 (15.25 h).
  await q(`INSERT INTO time_entries (contractor_id, work_date, started_at, ended_at, minutes, source)
           SELECT 2, DATE '2026-08-20',
                  TIMESTAMPTZ '2026-08-20 09:00+12',
                  TIMESTAMPTZ '2026-08-20 09:00+12' + make_interval(mins => m),
                  GREATEST(15, ROUND(m / 15.0) * 15)::int, 'manual'
             FROM unnest(ARRAY[52,52,52,62,75,75,75,75,75,75,75,75,60,60]) m`);
  // Jake: a running timer, an approved+paid entry and an approved+unpaid entry,
  // all of which the restore tool must leave exactly as they are.
  await q(`INSERT INTO time_entries (contractor_id, work_date, started_at, minutes, source)
           VALUES (1,'2026-08-06',NOW(),NULL,'timer')`);
  await q(`INSERT INTO time_entries (contractor_id, work_date, started_at, ended_at, minutes, source, locked, approval_id)
           VALUES (1,'2026-06-01', TIMESTAMPTZ '2026-06-01 09:00+12', TIMESTAMPTZ '2026-06-01 09:37+12', 45,'timer',true,1),
                  (1,'2026-06-02', TIMESTAMPTZ '2026-06-02 09:00+12', TIMESTAMPTZ '2026-06-02 09:22+12', 15,'timer',true,2)`);
}

const snapshot = () => q(
  `SELECT id, minutes, locked, approval_id, ended_at IS NULL AS running FROM time_entries ORDER BY id`);

// ════════════════════════════════════════════════════
try {
  await setup();

  console.log('\nthe SQL total-rounding matches the JavaScript rule');

  // These use the exact expression the function ships, not a copy of it — a copy
  // would agree with itself forever while the real one drifted.
  const sqlRound = (expr) => ROUND_TOTAL_SQL(expr);

  await test('they agree on every total from 0 to 24h', async () => {
    const rows = await q(`SELECT g AS raw, ${sqlRound('g')} AS m FROM generate_series(0, ${MAX_MINUTES}) g`);
    const bad = rows.filter((r) => r.m !== roundBillableMinutes(r.raw));
    assert.equal(bad.length, 0, bad.length
      ? `first disagreement: raw=${bad[0].raw} sql=${bad[0].m} js=${roundBillableMinutes(bad[0].raw)}` : '');
  });

  await test('and beyond 24h — a period total is not capped the way an entry is', async () => {
    const rows = await q(
      `SELECT g AS raw, ${sqlRound('g')} AS m
         FROM generate_series(${MAX_MINUTES}, ${MAX_MINUTES * 5}, 7) g`);
    rows.forEach((r) => assert.equal(r.m, roundBillableMinutes(r.raw), `at ${r.raw}`));
  });

  await test('zero stays zero on both sides', async () => {
    const rows = await q(`SELECT ${sqlRound('0')} AS m`);
    assert.equal(rows[0].m, 0);
    assert.equal(roundBillableMinutes(0), 0);
  });

  console.log('\nentries stay exact; the total is what rounds');

  await test('a stopped timer stores its exact minutes, not a quarter', async () => {
    await q(`INSERT INTO time_entries (contractor_id, work_date, started_at, minutes, source)
             VALUES (3, CURRENT_DATE, NOW() - interval '7 minutes', NULL, 'timer')`);
    const r = await post(
      { clientContext: { user: { email: 'norate@test', app_metadata: { roles: [] } } } }, { action: 'stop' });
    assert.equal(r.status, 200);
    assert.equal(r.body.entry.minutes, 7, 'a 7-minute timer must log 7 minutes, not 15');
    await q(`DELETE FROM time_entries WHERE contractor_id = 3`);
  });

  await test('a by-hand entry stores its exact minutes', async () => {
    const r = await post(asUser, {
      action: 'create-entry', work_date: '2026-09-01',
      started_at: '2026-09-01T09:00:00Z', ended_at: '2026-09-01T09:07:00Z' });
    assert.equal(r.status, 200);
    assert.equal(r.body.entry.minutes, 7);
    await q(`DELETE FROM time_entries WHERE id = $1`, [r.body.entry.id]);
  });

  console.log('\nthe reported regression: 938 minutes must bill as 15.75 h, not 15.25 h');

  await test('restoring exact minutes reports the right before and after', async () => {
    const r = await post(asAdmin, { action: 'restore-exact', dry_run: true });
    const sam = r.body.people.find((p) => p.email === 'sam@test');
    assert.equal(sam.entries, 4, 'only the rows whose stored value disagrees with the clock');
    assert.equal(sam.stored_minutes, 915, 'but the totals span ALL her unapproved entries');
    assert.equal(sam.exact_minutes, 938, 'what the recorded times actually say');
    assert.equal(sam.billed_before, 915, '915 is already a multiple of 15, so it bills as itself');
    assert.equal(sam.billed_after, 945, '938 minutes rounds to 945 — 15.75 h');
    assert.equal(sam.delta_minutes, 30);
    assert.equal(sam.delta_amount, 30, '30 minutes at $60/h');
  });

  let before, committed;
  await test('the dry run writes nothing', async () => {
    before = await snapshot();
    await post(asAdmin, { action: 'restore-exact', dry_run: true });
    assert.deepEqual(await snapshot(), before, 'a dry run must not touch a single row');
  });

  await test('a non-admin cannot run it', async () => {
    assert.equal((await post(asUser, { action: 'restore-exact', dry_run: true })).status, 403);
  });

  await test('the commit puts the exact minutes back', async () => {
    before = await snapshot();
    committed = (await post(asAdmin, { action: 'restore-exact', dry_run: false })).body;
    assert.equal(committed.restored, 4);
    const sum = await q(`SELECT COALESCE(SUM(minutes),0)::int AS m FROM time_entries WHERE contractor_id = 2`);
    assert.equal(sum[0].m, 938);
  });

  await test('every restored entry now matches its own start and finish times', async () => {
    const off = await q(
      `SELECT count(*)::int AS n FROM time_entries e
        WHERE e.contractor_id = 2
          AND e.minutes <> ROUND(EXTRACT(EPOCH FROM (e.ended_at - e.started_at)) / 60)::int`);
    assert.equal(off[0].n, 0);
  });

  await test('approving the period bills 945, not 915 — the whole point', async () => {
    const r = await post(asAdmin, {
      action: 'approve', contractor_id: 2, period_start: '2026-08-01', period_end: '2026-08-31' });
    assert.equal(r.status, 200);
    assert.equal(r.body.rawMinutes, 938, 'the exact sum behind the timesheet');
    assert.equal(r.body.approval.total_minutes, 945,
      'rounding each entry first would have given 915 and quietly lost 23 minutes');
    assert.equal(Number(r.body.approval.amount), 945);   // 15.75 h at $60
  });

  await test('the roster shows the same rounded total, and the exact one beside it', async () => {
    const g = await fn.handler({ httpMethod: 'GET',
      queryStringParameters: { action: 'contractors', from: '2026-08-01', to: '2026-08-31' } }, asAdmin);
    const sam = JSON.parse(g.body).contractors.find((c) => c.email === 'sam@test');
    assert.equal(sam.period_minutes, 945, 'the billable figure');
    assert.equal(sam.period_minutes_exact, 938, 'the exact sum, for showing the working');
  });

  console.log('\nblast radius');

  await test('approved, paid and running entries came through untouched', async () => {
    // Pinned to the rows that were protected when the restore ran, by id. A
    // whole-table diff would be meaningless here: the approve test above has
    // since locked Sam's entries, which is a legitimate change and not this
    // tool's doing.
    const approved = await q(
      `SELECT id, minutes FROM time_entries WHERE approval_id IN (1,2) ORDER BY id`);
    assert.deepEqual(approved.map((r) => r.minutes), [45, 15],
      'the approved entries still hold the minutes they were approved with, '
      + 'even though both disagree with their recorded times');
    const running = await q(`SELECT minutes FROM time_entries WHERE ended_at IS NULL`);
    assert.deepEqual(running.map((r) => r.minutes), [null], 'a running timer has no duration yet');
    // And none of them appeared in the change set.
    const touched = new Set(committed.changes.map((c) => c.id));
    approved.forEach((r) => assert.ok(!touched.has(r.id), `entry ${r.id} was approved and must not move`));
  });

  await test('it says what it is leaving alone', async () => {
    const r = (await post(asAdmin, { action: 'restore-exact', dry_run: true })).body;
    assert.equal(r.skipped.paid, 1);
    assert.equal(r.skipped.approvedUnpaid, 1);
  });

  await test('the before-values it returned are true, and restore exactly', async () => {
    const wasById = Object.fromEntries(before.map((r) => [r.id, r.minutes]));
    committed.changes.forEach((c) =>
      assert.equal(c.was, wasById[c.id], `entry ${c.id} reported the wrong prior value`));
    for (const c of committed.changes) {
      await q('UPDATE time_entries SET minutes = $1 WHERE id = $2', [c.was, c.id]);
    }
    const after = await snapshot();
    // approval_id/locked moved when the period was approved, so compare minutes.
    assert.deepEqual(after.map((r) => [r.id, r.minutes]), before.map((r) => [r.id, r.minutes]));
    for (const c of committed.changes) {
      await q('UPDATE time_entries SET minutes = $1 WHERE id = $2', [c.now, c.id]);
    }
  });

  await test('a date window narrows the set', async () => {
    await q(`UPDATE time_entries SET minutes = 99, locked = FALSE, approval_id = NULL
              WHERE contractor_id = 2 AND id = (SELECT MIN(id) FROM time_entries WHERE contractor_id = 2)`);
    const all = (await post(asAdmin, { action: 'restore-exact', dry_run: true })).body;
    const none = (await post(asAdmin, { action: 'restore-exact', dry_run: true,
      from: '2020-01-01', to: '2020-12-31' })).body;
    assert.equal(all.summary.entries, 1);
    assert.equal(none.summary.entries, 0);
  });

  await test('`from` after `to` is refused', async () => {
    const r = await post(asAdmin, { action: 'restore-exact', dry_run: true, from: '2026-09-01', to: '2026-08-01' });
    assert.equal(r.status, 400);
  });

  await test('running it twice over is refused rather than being a silent no-op', async () => {
    await post(asAdmin, { action: 'restore-exact', dry_run: false });
    const again = await post(asAdmin, { action: 'restore-exact', dry_run: false });
    assert.equal(again.status, 400);
    assert.match(again.body.error, /already matches its recorded times/);
  });
} finally {
  await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => {});
  await pool.end();
}

console.log(`\n${passed}/${passed + failed} passed`);
if (failed) process.exit(1);

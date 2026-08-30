/**
 * Database-backed tests for quarter-hour rounding.
 *
 * These exist because the rounding rule is written twice — once as
 * `roundMinutes()` in JavaScript, and once as SQL in `handleStop` and the
 * retroactive back-fill. Two dialects of one rule is exactly the arrangement
 * that drifts, and no amount of unit testing the JS half will catch it. So this
 * runs the real handler against a real PostgreSQL and compares them.
 *
 * It also pins the back-fill's blast radius: an approved, paid, or running
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
const { roundMinutes, MAX_MINUTES, ROUND_TO_MINUTES } = fn.__test;

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

  // Unapproved, off-quarter — the rows that should move.
  await q(`INSERT INTO time_entries (contractor_id, work_date, started_at, ended_at, minutes, source)
           SELECT 1, DATE '2026-08-01', NOW() - interval '2 hours', NOW(), m, 'timer'
             FROM unnest(ARRAY[7,8,22,23,37,38,52,53,3,1,1439]) m`);
  // Already on a quarter — must not be reported as changing.
  await q(`INSERT INTO time_entries (contractor_id, work_date, started_at, ended_at, minutes, source)
           VALUES (2,'2026-08-03',NOW(),NOW(),30,'timer'), (2,'2026-08-04',NOW(),NOW(),45,'timer')`);
  // A running timer, an approved+paid entry, an approved+unpaid entry.
  await q(`INSERT INTO time_entries (contractor_id, work_date, started_at, minutes, source)
           VALUES (1,'2026-08-06',NOW(),NULL,'timer')`);
  await q(`INSERT INTO time_entries (contractor_id, work_date, started_at, ended_at, minutes, source, locked, approval_id)
           VALUES (1,'2026-06-01',NOW(),NOW(),37,'timer',true,1),
                  (1,'2026-06-02',NOW(),NOW(),22,'timer',true,2)`);
}

const snapshot = () => q(
  `SELECT id, minutes, locked, approval_id, ended_at IS NULL AS running FROM time_entries ORDER BY id`);

// ════════════════════════════════════════════════════
try {
  await setup();

  console.log('\nSQL rounding matches the JavaScript rule');

  await test('handleStop\'s expression agrees with roundMinutes() for every duration to 24h', async () => {
    // Same expression as handleStop, fed a started_at N minutes in the past.
    const rows = await q(
      `SELECT g AS raw,
              LEAST(${MAX_MINUTES}, GREATEST(15,
                ROUND(EXTRACT(EPOCH FROM (NOW() - (NOW() - make_interval(secs => g*60))))
                      / 60.0 / ${ROUND_TO_MINUTES}) * ${ROUND_TO_MINUTES}))::int AS m
         FROM generate_series(1, ${MAX_MINUTES}) g`);
    const bad = rows.filter((r) => r.m !== roundMinutes(r.raw));
    assert.equal(bad.length, 0,
      bad.length ? `first disagreement: raw=${bad[0].raw} sql=${bad[0].m} js=${roundMinutes(bad[0].raw)}` : '');
  });

  await test('they agree on exact half-quarter midpoints too', async () => {
    // 7.5, 22.5, 37.5 … minutes — where a rounding-mode difference would show.
    const secs = [450, 1350, 2250, 3150, 4050];
    const rows = await q(
      `SELECT s, LEAST(${MAX_MINUTES}, GREATEST(15,
          ROUND(EXTRACT(EPOCH FROM make_interval(secs => s)) / 60.0 / ${ROUND_TO_MINUTES})
          * ${ROUND_TO_MINUTES}))::int AS m
         FROM unnest($1::int[]) s`, [secs]);
    rows.forEach((r) => assert.equal(r.m, roundMinutes(r.s / 60), `at ${r.s}s`));
  });

  console.log('\nretroactive back-fill');

  await test('a non-admin cannot run it', async () => {
    const r = await post(asUser, { action: 'round-history', dry_run: true });
    assert.equal(r.status, 403);
  });

  let dry, before;
  await test('the dry run reports the effect and writes nothing', async () => {
    before = await snapshot();
    dry = (await post(asAdmin, { action: 'round-history', dry_run: true })).body;
    assert.equal(dry.dryRun, true);
    assert.equal(dry.summary.entries, 11, 'only the off-quarter unapproved rows');
    assert.equal(dry.summary.contractors, 1);
    assert.deepEqual(await snapshot(), before, 'a dry run must not touch a single row');
  });

  await test('it costs out the change per person, and says so in money', async () => {
    const jake = dry.people.find((p) => p.email === 'jake@test');
    assert.equal(jake.delta_minutes, jake.after_minutes - jake.before_minutes);
    // 80/h, so the delta in money must follow the delta in minutes.
    assert.equal(jake.delta_amount, Math.round((jake.delta_minutes / 60) * 80 * 100) / 100);
  });

  await test('someone with no rate reports null, not zero', async () => {
    await q(`INSERT INTO time_entries (contractor_id, work_date, started_at, ended_at, minutes, source)
             VALUES (3,'2026-08-05',NOW(),NOW(),50,'manual')`);
    const r = (await post(asAdmin, { action: 'round-history', dry_run: true })).body;
    const nr = r.people.find((p) => p.email === 'norate@test');
    assert.equal(nr.delta_amount, null, '"no rate on file" must not look like "costs nothing"');
    assert.equal(nr.delta_minutes, -5, '50 min rounds down to 45');
  });

  await test('it reports what it is leaving alone', async () => {
    const r = (await post(asAdmin, { action: 'round-history', dry_run: true })).body;
    assert.equal(r.skipped.paid, 1);
    assert.equal(r.skipped.approvedUnpaid, 1);
  });

  await test('a date window narrows the set', async () => {
    const r = (await post(asAdmin, { action: 'round-history', dry_run: true, from: '2026-08-05', to: '2026-08-05' })).body;
    assert.equal(r.summary.entries, 1, 'only the 5 August entry');
  });

  await test('`from` after `to` is refused', async () => {
    const r = await post(asAdmin, { action: 'round-history', dry_run: true, from: '2026-09-01', to: '2026-08-01' });
    assert.equal(r.status, 400);
  });

  let committed;
  await test('the commit rounds every unapproved entry', async () => {
    before = await snapshot();
    committed = (await post(asAdmin, { action: 'round-history', dry_run: false })).body;
    assert.equal(committed.rounded, 12);
    const left = await q(
      `SELECT count(*)::int AS n FROM time_entries
        WHERE locked = FALSE AND approval_id IS NULL AND ended_at IS NOT NULL
          AND minutes % ${ROUND_TO_MINUTES} <> 0`);
    assert.equal(left[0].n, 0);
  });

  await test('it rounds to the same values roundMinutes() would', async () => {
    committed.changes.forEach((c) => assert.equal(c.now, roundMinutes(c.was), `entry ${c.id}`));
  });

  await test('approved, paid and running entries came through untouched', async () => {
    const after = await snapshot();
    const wasById = Object.fromEntries(before.map((r) => [r.id, r.minutes]));
    const violations = after.filter((r) =>
      r.minutes !== wasById[r.id] && (r.locked || r.approval_id !== null || r.running));
    assert.deepEqual(violations, [], 'the back-fill reached a protected row');
    // And specifically: the two approved entries still hold their exact minutes.
    const approved = after.filter((r) => r.approval_id !== null).map((r) => r.minutes).sort();
    assert.deepEqual(approved, [22, 37]);
  });

  await test('the before-values it returns are true, and restore exactly', async () => {
    const wasById = Object.fromEntries(before.map((r) => [r.id, r.minutes]));
    committed.changes.forEach((c) =>
      assert.equal(c.was, wasById[c.id], `entry ${c.id} reported the wrong prior value`));
    for (const c of committed.changes) {
      await q('UPDATE time_entries SET minutes = $1 WHERE id = $2', [c.was, c.id]);
    }
    assert.deepEqual(await snapshot(), before, 'restoring from the audit trail must be exact');
  });

  await test('running it twice over is refused rather than being a silent no-op', async () => {
    await post(asAdmin, { action: 'round-history', dry_run: false });
    const again = await post(asAdmin, { action: 'round-history', dry_run: false });
    assert.equal(again.status, 400);
    assert.match(again.body.error, /already on a quarter hour/);
  });
} finally {
  await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => {});
  await pool.end();
}

console.log(`\n${passed}/${passed + failed} passed`);
if (failed) process.exit(1);

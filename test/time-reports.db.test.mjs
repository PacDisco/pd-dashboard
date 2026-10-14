/**
 * Database-backed tests for Time Tracker reports and scheduled report emails.
 *
 * Runs the real handler (and the real scheduled sender) against a real
 * PostgreSQL, with a fake inbox in place of Gmail. Same harness as
 * time-rounding.db.test.mjs — NOT part of `npm test`, it needs a database:
 *
 *   DATABASE_URL="postgres://postgres@localhost:5433/postgres?host=/tmp/pgrun" \
 *     node test/time-reports.db.test.mjs
 *
 * Everything happens in a throwaway schema, dropped on the way out.
 *
 * What it pins, roughly in order of how bad a regression would be:
 *   - a personal report can only ever contain the caller's own time
 *   - a team report needs review; a personal schedule only mails its owner
 *   - a due schedule sends exactly once, covers the right Mon–Sun period, and a
 *     failure puts it back to retry rather than silently skipping a week
 *   - a team schedule stops when its owner loses the reviewer role
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

const URL_ = process.env.DATABASE_URL || process.env.NETLIFY_DATABASE_URL;
if (!URL_) { console.log('SKIP time-reports.db — set DATABASE_URL to a scratch PostgreSQL to run these.'); process.exit(0); }
let pg;
try { pg = require('pg'); } catch { console.log('SKIP time-reports.db — `npm i pg` first (dev-only dependency).'); process.exit(0); }

const SCHEMA = 'time_reports_test_' + Date.now();
const pool = new pg.Pool({ connectionString: URL_ });

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ok   ${name}`); passed++; }
  catch (err) { console.error(`  FAIL ${name}\n       ${err.stack.split('\n').slice(0, 8).join('\n       ')}`); failed++; }
}

const q = (text, args) => pool.query(text, args).then((r) => r.rows);
const tagged = (strings, ...vals) => q(strings.reduce((a, s, i) => a + s + (i < vals.length ? '$' + (i + 1) : ''), ''), vals);
tagged.query = q;
require.cache[require.resolve('@neondatabase/serverless')] = { exports: { neon: () => tagged } };
process.env.NETLIFY_DATABASE_URL = URL_;

const fn = require(path.join(root, 'netlify/functions/time-tracking.js'));
const sender = require(path.join(root, 'netlify/functions/time-report-emails.js'));
const R = require(path.join(root, 'netlify/functions/_shared/time-report.js'));

const as = (email, roles = []) => ({ clientContext: { user: { email, app_metadata: { roles } } } });
const ADMIN = as('boss@pd.test', ['admin']);
const REVIEWER = as('rev@pd.test', ['timesheet-reviewer']);
const SAM = as('sam@pd.test');
const JAKE = as('jake@pd.test');

async function call(ctx, method, action, body, qs = {}) {
  const r = await fn.handler({
    httpMethod: method, queryStringParameters: { action, ...qs },
    body: body === undefined ? null : JSON.stringify(body),
  }, ctx);
  const isFile = r.isBase64Encoded;
  return {
    status: r.statusCode,
    headers: r.headers,
    body: isFile ? Buffer.from(r.body, 'base64') : JSON.parse(r.body),
    text: isFile ? Buffer.from(r.body, 'base64').toString('utf8') : r.body,
  };
}

const OPTS = { from: '2026-10-05', to: '2026-10-11' };

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
      locked boolean NOT NULL DEFAULT false, approval_id int, import_batch_id uuid, brand text);
  `);
  // The real migration, not a copy of it.
  const { readFileSync } = await import('node:fs');
  await q(readFileSync(path.join(root, 'MIGRATION-time-report-schedules.sql'), 'utf8'));

  await q(`INSERT INTO time_contractors (email, full_name, hourly_rate) VALUES
    ('jake@pd.test','Jake',80), ('sam@pd.test','Sam',60), ('rev@pd.test','Rita Reviewer',NULL), ('boss@pd.test','Boss',NULL)`);
  await q(`INSERT INTO time_projects (name, code, brand) VALUES
    ('Website','WEB','Pacific Discovery'), ('STEM page','STEM','Unearthed Education'), ('Admin',NULL,NULL)`);
  // Week of Mon 5 Oct 2026. Jake: 3 entries (one locked). Sam: 2. Plus one of
  // Sam's the week before, one running timer, and a formula-looking description.
  await q(`INSERT INTO time_entries (contractor_id, project_id, work_date, started_at, ended_at, minutes, description, source, locked, brand) VALUES
    (1, 1, '2026-10-05', '2026-10-04T20:00Z', '2026-10-04T21:07Z', 67, 'Homepage hero', 'timer', true, NULL),
    (1, 2, '2026-10-06', '2026-10-05T20:00Z', '2026-10-05T20:52Z', 52, '=HYPERLINK("http://x")', 'manual', false, NULL),
    (1, 1, '2026-10-07', '2026-10-06T20:00Z', '2026-10-06T20:38Z', 38, 'Split to UE', 'timer', false, 'Unearthed Education'),
    (2, 3, '2026-10-06', '2026-10-05T22:00Z', '2026-10-06T00:00Z', 120, 'Sam admin', 'timer', false, NULL),
    (2, 1, '2026-10-09', '2026-10-08T22:00Z', '2026-10-08T22:22Z', 22, 'Sam web', 'timer', false, NULL),
    (2, 1, '2026-09-30', '2026-09-29T22:00Z', '2026-09-29T23:00Z', 60, 'Sam last week', 'timer', false, NULL)`);
  await q(`INSERT INTO time_entries (contractor_id, project_id, work_date, started_at, source) VALUES (2, 1, '2026-10-08', NOW(), 'timer')`);
}

try {
  await setup();

  console.log('\nthe brand rule is the tracker\'s, not a lookalike');
  await test('REPORT_BRAND_SQL is the same expression as ENTRY_BRAND_SQL', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(path.join(root, 'netlify/functions/time-tracking.js'), 'utf8');
    const m = src.match(/const ENTRY_BRAND_SQL =\s*`([^`]+)`/);
    assert.ok(m, 'ENTRY_BRAND_SQL not found');
    assert.equal(R.REPORT_BRAND_SQL, m[1]);
  });

  console.log('\na personal report is the caller\'s and nobody else\'s');

  await test('Sam\'s report holds only Sam\'s time, even when she names Jake', async () => {
    const r = await call(SAM, 'POST', 'report', { format: 'csv', options: { ...OPTS, contractor_ids: [1], columns: ['date', 'contractor', 'description', 'hours'] } });
    assert.equal(r.status, 200);
    assert.match(r.headers['Content-Type'], /text\/csv/);
    assert.match(r.text, /Sam admin/);
    assert.match(r.text, /Sam web/);
    assert.doesNotMatch(r.text, /Homepage hero|Split to UE/, 'Jake\'s entries leaked into Sam\'s report');
    assert.doesNotMatch(r.text, /Sam last week/, 'outside the period');
    assert.doesNotMatch(r.text, /,Contractor,/, 'a personal report has no contractor column');
  });

  await test('the running timer is not in a report', async () => {
    const r = await call(SAM, 'POST', 'report', { format: 'csv', options: OPTS });
    assert.match(r.text, /^Total,2,2\.37/m, '120 + 22 minutes, two finished entries');
  });

  await test('billable rounds the period total once', async () => {
    const r = await call(SAM, 'POST', 'report', { format: 'csv', options: OPTS });
    // 142 exact minutes → 135 (nearest quarter) = 2.25 h.
    assert.match(r.text, /Billable hours \(rounded to the nearest quarter hour\),2\.25/);
  });

  await test('a description that looks like a formula is defused', async () => {
    const r = await call(JAKE, 'POST', 'report', { format: 'csv', options: OPTS });
    assert.match(r.text, /"'=HYPERLINK\(""http:\/\/x""\)"/);
  });

  await test('a PDF comes back as a PDF', async () => {
    const r = await call(JAKE, 'POST', 'report', { format: 'pdf', options: { ...OPTS, group_by: 'day', include_money: true } });
    assert.equal(r.status, 200);
    assert.equal(r.headers['Content-Type'], 'application/pdf');
    assert.equal(r.body.subarray(0, 5).toString(), '%PDF-');
    assert.match(r.headers['Content-Disposition'], /time-report-jake-2026-10-05_to_2026-10-11\.pdf/);
  });

  await test('bad dates are refused with a readable message', async () => {
    const r = await call(SAM, 'POST', 'report', { format: 'csv', options: { from: '2026-10-11', to: '2026-10-05' } });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /start date is after/);
  });

  console.log('\nteam reports');

  await test('a contractor can\'t run one', async () => {
    const r = await call(SAM, 'POST', 'team-report', { format: 'csv', options: OPTS });
    assert.equal(r.status, 403);
  });

  await test('a reviewer can, and billable is per person then summed', async () => {
    const r = await call(REVIEWER, 'POST', 'team-report', { format: 'csv', options: { ...OPTS, include_money: true } });
    assert.equal(r.status, 200);
    // Jake 157 → 150, Sam 142 → 135; team 285 = 4.75 h (rounding 299 raw would give 300).
    assert.match(r.text, /^Jake,3,2\.62,2\.50,80\.00,NZD,200\.00/m);
    assert.match(r.text, /^Sam,2,2\.37,2\.25,60\.00,NZD,135\.00/m);
    assert.match(r.text, /^Total,5,4\.98,4\.75,,,335\.00 NZD/m);
  });

  await test('filters: people, brand and status narrow it', async () => {
    const one = await call(REVIEWER, 'POST', 'team-report', { format: 'csv', options: { ...OPTS, contractor_ids: [2] } });
    assert.doesNotMatch(one.text, /Homepage hero/);
    const ue = await call(REVIEWER, 'POST', 'team-report', { format: 'csv', options: { ...OPTS, brands: ['Unearthed Education'], columns: ['description', 'brand'] } });
    assert.match(ue.text, /Split to UE/, 'an entry-level brand override counts');
    assert.match(ue.text, /HYPERLINK/, 'the STEM project\'s own brand counts');
    assert.doesNotMatch(ue.text, /Homepage hero|Sam admin/);
    const none = await call(REVIEWER, 'POST', 'team-report', { format: 'csv', options: { ...OPTS, brands: [''], columns: ['description'] } });
    assert.match(none.text, /Sam admin/, 'the Unassigned bucket is selectable');
    const appr = await call(REVIEWER, 'POST', 'team-report', { format: 'csv', options: { ...OPTS, status: 'approved', columns: ['description'] } });
    assert.match(appr.text, /Homepage hero/);
    assert.match(appr.text, /^Total,1,/m);
  });

  await test('grouping by contractor writes the group into its own column only when needed', async () => {
    const r = await call(REVIEWER, 'POST', 'team-report', { format: 'csv', options: { ...OPTS, group_by: 'week', columns: ['date', 'hours'] } });
    assert.match(r.text, /^Week,Date,Hours/m);
    assert.match(r.text, /^Week of 5 Oct 2026,2026-10-05,1\.12/m);
  });

  console.log('\nscheduled reports — saving');

  let samSched, teamSched;
  await test('a personal schedule only ever mails its owner', async () => {
    const r = await call(SAM, 'POST', 'save-report-schedule', {
      scope: 'self', frequency: 'weekly', formats: ['csv', 'pdf'], recipients: ['evil@elsewhere.com'],
      options: { group_by: 'day' }, tz: 'Pacific/Auckland' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    samSched = r.body.schedule;
    assert.deepEqual(samSched.recipients, ['sam@pd.test']);
    assert.equal(new Date(`${samSched.next_send_on}T00:00:00Z`).getUTCDay(), 1, 'always a Monday');
    assert.equal(samSched.options.from, undefined, 'the period is not frozen into the schedule');
  });

  await test('a contractor can\'t schedule a team report', async () => {
    const r = await call(SAM, 'POST', 'save-report-schedule', { scope: 'team', frequency: 'weekly', formats: ['csv'], recipients: ['a@b.co'] });
    assert.equal(r.status, 403);
  });

  await test('a reviewer can, and the addresses are checked', async () => {
    const badList = await call(REVIEWER, 'POST', 'save-report-schedule', { scope: 'team', frequency: 'fortnightly', formats: ['pdf'], recipients: 'rev@pd.test, not-an-email' });
    assert.equal(badList.status, 400);
    const r = await call(REVIEWER, 'POST', 'save-report-schedule', {
      scope: 'team', frequency: 'fortnightly', formats: ['pdf', 'csv'], recipients: 'rev@pd.test, Accounts@Example.com',
      options: { include_money: true, group_by: 'contractor' }, name: 'Payroll fortnight' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    teamSched = r.body.schedule;
    assert.deepEqual(teamSched.recipients, ['rev@pd.test', 'accounts@example.com']);
    assert.equal(teamSched.owner_can_review, true);
  });

  await test('people see their own schedules; an admin sees everyone\'s', async () => {
    const sam = await call(SAM, 'GET', 'report-schedules');
    assert.deepEqual(sam.body.schedules.map((s) => s.id), [samSched.id]);
    const boss = await call(ADMIN, 'GET', 'report-schedules');
    assert.equal(boss.body.schedules.length, 2);
  });

  await test('someone else\'s schedule can\'t be deleted or sent', async () => {
    assert.equal((await call(JAKE, 'POST', 'delete-report-schedule', { id: samSched.id })).status, 403);
    assert.equal((await call(JAKE, 'POST', 'send-report-schedule', { id: samSched.id })).status, 403);
  });

  await test('an admin editing a personal schedule can\'t redirect it', async () => {
    const r = await call(ADMIN, 'POST', 'save-report-schedule', {
      id: samSched.id, scope: 'self', frequency: 'weekly', formats: ['csv', 'pdf'], recipients: ['boss@pd.test'], options: { group_by: 'day' } });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.schedule.recipients, ['sam@pd.test']);
    assert.equal(r.body.schedule.owner_email, 'sam@pd.test');
  });

  console.log('\nscheduled reports — sending');

  const inbox = [];
  const fakeMailer = { send: async (m) => { inbox.push(m); return { from: 'bot@pd.test' }; } };
  const MONDAY_19 = '2026-10-19';
  // 8am NZ on Monday 19 Oct is 19:00 UTC on the 18th — when the cron actually fires.
  const cronTime = new Date('2026-10-18T19:00:00Z');

  await test('a due weekly schedule sends last Mon–Sun, once', async () => {
    await q(`UPDATE time_report_schedules SET next_send_on = $2 WHERE id = $1`, [samSched.id, '2026-10-12']);
    await q(`UPDATE time_report_schedules SET is_active = FALSE WHERE id = $1`, [teamSched.id]);
    const res = await sender.runDue(tagged, { mailer: fakeMailer, now: new Date('2026-10-11T19:00:00Z'), log: { log() {}, warn() {}, error() {} } });
    assert.equal(res.length, 1);
    assert.equal(inbox.length, 1);
    const m = inbox[0];
    assert.deepEqual(m.to, ['sam@pd.test']);
    assert.match(m.subject, /5 Oct 2026 – 11 Oct 2026/);
    assert.deepEqual(m.attachments.map((a) => a.filename), [
      'time-report-sam-2026-10-05_to_2026-10-11.csv', 'time-report-sam-2026-10-05_to_2026-10-11.pdf']);
    assert.match(m.attachments[0].content.toString(), /Sam admin/);
    assert.doesNotMatch(m.attachments[0].content.toString(), /Homepage hero/);
    assert.match(m.html, /2\.37/);
    const row = (await q(`SELECT *, next_send_on::text AS d FROM time_report_schedules WHERE id = $1`, [samSched.id]))[0];
    assert.equal(row.d, MONDAY_19);
    assert.ok(row.last_sent_at);
    assert.equal(row.last_error, null);

    const again = await sender.runDue(tagged, { mailer: fakeMailer, now: new Date('2026-10-11T23:00:00Z'), log: { log() {}, warn() {}, error() {} } });
    assert.equal(again.length, 0, 'not twice the same Monday');
    assert.equal(inbox.length, 1);
  });

  await test('it doesn\'t send before its Monday has started in its own timezone', async () => {
    // 18:00 UTC Sunday is 7am Monday in NZ — but 18:00 UTC is still Sunday in London.
    await q(`UPDATE time_report_schedules SET timezone = 'Europe/London' WHERE id = $1`, [samSched.id]);
    const res = await sender.runDue(tagged, { mailer: fakeMailer, now: new Date('2026-10-18T18:00:00Z'), log: { log() {}, warn() {}, error() {} } });
    assert.equal(res.length, 0);
    await q(`UPDATE time_report_schedules SET timezone = 'Pacific/Auckland' WHERE id = $1`, [samSched.id]);
  });

  await test('a failed send is put back and the reason recorded', async () => {
    const before = inbox.length;
    const broken = { send: async () => { throw new Error('Gmail 401: token revoked'); } };
    const res = await sender.runDue(tagged, { mailer: broken, now: cronTime, log: { log() {}, warn() {}, error() {} } });
    assert.equal(res[0].ok, false);
    const row = (await q(`SELECT next_send_on::text AS d, last_error, is_active FROM time_report_schedules WHERE id = $1`, [samSched.id]))[0];
    assert.equal(row.d, MONDAY_19, 'still due — tomorrow\'s run retries it');
    assert.match(row.last_error, /token revoked/);
    assert.equal(row.is_active, true);
    assert.equal(inbox.length, before);

    const retry = await sender.runDue(tagged, { mailer: fakeMailer, now: new Date('2026-10-19T19:00:00Z'), log: { log() {}, warn() {}, error() {} } });
    assert.equal(retry[0].ok, true);
    assert.match(inbox.at(-1).subject, /12 Oct 2026 – 18 Oct 2026/, 'the retry still covers the week it was for');
    const after = (await q(`SELECT next_send_on::text AS d, last_error FROM time_report_schedules WHERE id = $1`, [samSched.id]))[0];
    assert.equal(after.d, '2026-10-26');
    assert.equal(after.last_error, null);
  });

  await test('fortnightly covers two weeks and steps by two', async () => {
    await q(`UPDATE time_report_schedules SET is_active = TRUE, next_send_on = $2 WHERE id = $1`, [teamSched.id, '2026-10-12']);
    await q(`UPDATE time_report_schedules SET is_active = FALSE WHERE id = $1`, [samSched.id]);
    const n = inbox.length;
    const res = await sender.runDue(tagged, { mailer: fakeMailer, now: new Date('2026-10-11T19:00:00Z'), log: { log() {}, warn() {}, error() {} } });
    assert.equal(res[0].ok, true, res[0].error);
    const m = inbox[n];
    assert.deepEqual(m.to, ['rev@pd.test', 'accounts@example.com']);
    assert.match(m.subject, /^Payroll fortnight · 28 Sep 2026 – 11 Oct 2026/);
    const csv = m.attachments.find((a) => a.filename.endsWith('.csv')).content.toString();
    assert.match(csv, /Sam last week/, 'the first of the two weeks is in it');
    assert.match(csv, /Homepage hero/, 'and so is everyone else, on a team report');
    const row = (await q(`SELECT next_send_on::text AS d FROM time_report_schedules WHERE id = $1`, [teamSched.id]))[0];
    assert.equal(row.d, '2026-10-26');
  });

  await test('a team schedule stops when its owner loses the reviewer role', async () => {
    // Rita opens the tracker without the role any more → the snapshot updates.
    const me = await call(as('rev@pd.test', []), 'GET', 'me');
    assert.equal(me.status, 200);
    const flag = (await q(`SELECT owner_can_review FROM time_report_schedules WHERE id = $1`, [teamSched.id]))[0];
    assert.equal(flag.owner_can_review, false);
    const n = inbox.length;
    const res = await sender.runDue(tagged, { mailer: fakeMailer, now: new Date('2026-10-25T19:00:00Z'), log: { log() {}, warn() {}, error() {} } });
    assert.equal(res[0].ok, false);
    assert.match(res[0].error, /no longer has the admin or timesheet-reviewer role/);
    assert.equal(inbox.length, n, 'nothing sent');
  });

  await test('two weeks of failures pauses it instead of retrying forever', async () => {
    const res = await sender.runDue(tagged, { mailer: fakeMailer, now: new Date('2026-11-08T19:00:00Z'), log: { log() {}, warn() {}, error() {} } });
    assert.equal(res[0].ok, false);
    const row = (await q(`SELECT is_active, last_error FROM time_report_schedules WHERE id = $1`, [teamSched.id]))[0];
    assert.equal(row.is_active, false);
    assert.match(row.last_error, /paused after two weeks/);
  });

  await test('deleting a schedule removes it', async () => {
    const r = await call(SAM, 'POST', 'delete-report-schedule', { id: samSched.id });
    assert.equal(r.status, 200);
    assert.equal((await q(`SELECT 1 FROM time_report_schedules WHERE id = $1`, [samSched.id])).length, 0);
  });
} finally {
  await q(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => {});
  await pool.end();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

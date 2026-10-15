/**
 * End-to-end: the real Time Tracker page in Chromium, talking to the REAL
 * time-tracking handler, backed by a real PostgreSQL. Nothing about reports is
 * stubbed except Netlify Identity (offline) and the Gmail mailbox.
 *
 *   DATABASE_URL="postgres://postgres@localhost:5433/postgres?host=/tmp/pgrun" \
 *     PW_CHROMIUM=/path/to/chromium node test/time-reports.smoke.mjs [shot-dir]
 *
 * Signs in as a contractor, downloads their own CSV and PDF; then as an admin,
 * builds a filtered team report, and saves, edits, pauses and deletes a
 * fortnightly email schedule from the dialog.
 */
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const PAGE = new URL('../time-tracking/index.html', import.meta.url).href;
const SHOT = process.argv[2];

const URL_ = process.env.DATABASE_URL;
if (!URL_) { console.log('SKIP time-reports.smoke — set DATABASE_URL'); process.exit(0); }
const pg = require('pg');
const SCHEMA = 'time_reports_smoke_' + Date.now();
const pool = new pg.Pool({ connectionString: URL_ });
const q = (text, args) => pool.query(text, args).then((r) => r.rows);
const tagged = (strings, ...vals) => q(strings.reduce((a, s, i) => a + s + (i < vals.length ? '$' + (i + 1) : ''), ''), vals);
tagged.query = q;
require.cache[require.resolve('@neondatabase/serverless')] = { exports: { neon: () => tagged } };
process.env.NETLIFY_DATABASE_URL = URL_;
const fn = require(path.join(root, 'netlify/functions/time-tracking.js'));

await q(`CREATE SCHEMA ${SCHEMA}`);
await pool.query(`SET search_path TO ${SCHEMA}`);
pool.on('connect', (c) => c.query(`SET search_path TO ${SCHEMA}`));
await q(`
  CREATE TABLE time_contractors (id serial PRIMARY KEY, email text UNIQUE NOT NULL, full_name text,
    hourly_rate numeric, currency text DEFAULT 'NZD', vendor_name text, notes text, is_active boolean NOT NULL DEFAULT true);
  CREATE TABLE time_projects (id serial PRIMARY KEY, name text NOT NULL, code text, brand text,
    sort_order int DEFAULT 100, is_active boolean NOT NULL DEFAULT true, notes text);
  CREATE TABLE time_approvals (id serial PRIMARY KEY, contractor_id int, period_start date, period_end date,
    total_minutes int, hourly_rate numeric, currency text, amount numeric, approved_by text, notes text,
    payment_id int, pushed_at timestamptz);
  CREATE TABLE payments (id serial PRIMARY KEY, paid boolean, due_date date, invoice_file_url text);
  CREATE TABLE time_entries (id serial PRIMARY KEY, contractor_id int NOT NULL, project_id int,
    work_date date NOT NULL, started_at timestamptz, ended_at timestamptz, minutes int, description text,
    source text, locked boolean NOT NULL DEFAULT false, approval_id int, import_batch_id uuid, brand text);
`);
await q(readFileSync(path.join(root, 'MIGRATION-time-report-schedules.sql'), 'utf8'));
await q(readFileSync(path.join(root, 'MIGRATION-time-projects-owner.sql'), 'utf8'));
await q(`INSERT INTO time_contractors (email, full_name, hourly_rate) VALUES
  ('jake@pd.test','Jake',80), ('sam@pd.test','Sam Rivers',60), ('ana@pd.test','Ana Mercer',55)`);
await q(`INSERT INTO time_projects (name, code, brand) VALUES
  ('Website rebuild','WEB','Pacific Discovery'), ('STEM page','STEM','Unearthed Education'), ('Housekeeping','ADMIN',NULL)`);

// This week and last week, relative to today, so "Week on screen" has data.
const mon = (() => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return d; })();
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const day = (n) => { const d = new Date(mon); d.setDate(d.getDate() + n); return ymd(d); };
const rows = [
  [2, 1, 0, 95, 'Sam: homepage hero'], [2, 3, 1, 40, 'Sam: inbox'], [2, 2, 2, 130, 'Sam: STEM copy'],
  [1, 1, 0, 60, 'Jake: deploy'], [1, 2, 3, 75, 'Jake: STEM build'],
  [3, 3, 1, 50, 'Ana: admin'], [2, 1, -5, 45, 'Sam: last week'],
];
for (const [c, p, d, m, desc] of rows) {
  await q(`INSERT INTO time_entries (contractor_id, project_id, work_date, started_at, ended_at, minutes, description, source)
           VALUES ($1, $2, $3, $4::timestamptz, $4::timestamptz + make_interval(mins => $5), $5, $6, 'timer')`,
    [c, p, day(d), `${day(d)}T09:00:00+13:00`, m, desc]);
}

let WHO = { email: 'sam@pd.test', app_metadata: { roles: ['contractor'] } };

const browser = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
const failures = [];
async function session(label, fnBody) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 1000 }, acceptDownloads: true });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => failures.push(`${label}: PAGE ERROR ${e.message}`));
  page.on('dialog', (d) => d.accept());
  await page.addInitScript(() => {
    const h = {};
    window.netlifyIdentity = { on: (ev, f) => { h[ev] = f; }, init: () => setTimeout(() => h.init && h.init({ jwt: async () => 'stub' }), 0), open() {}, close() {}, logout() {} };
  });
  await page.route('**/netlify-identity-widget.js', (r) => r.fulfill({ status: 200, contentType: 'application/javascript', body: '' }));
  await page.route('**/api/time-tracking*', async (route) => {
    const req = route.request();
    const u = new URL(req.url());
    const res = await fn.handler({
      httpMethod: req.method(), queryStringParameters: Object.fromEntries(u.searchParams),
      body: req.postData() || null, isBase64Encoded: false,
    }, { clientContext: { user: WHO } });
    route.fulfill({
      status: res.statusCode, headers: res.headers,
      body: res.isBase64Encoded ? Buffer.from(res.body, 'base64') : res.body,
    });
  });
  try { await fnBody(page); }
  catch (e) { failures.push(`${label}: ${e.message}`); if (SHOT) await page.screenshot({ path: `${SHOT}/fail-${label}.png` }); }
  await ctx.close();
}

const readDownload = async (dl) => readFileSync(await dl.path());

// ── a contractor exports their own time ─────────────────────────────────────
await session('contractor', async (page) => {
  await page.goto(PAGE);
  await page.waitForSelector('#btn-report');
  await page.waitForSelector('#sched-self h2');
  assert.equal(await page.isVisible('#tab-team'), false, 'contractor has no Team tab');

  await page.click('#btn-report');
  await page.waitForSelector('#r-download');
  assert.equal(await page.locator('input[name="r-person"]').count(), 0, 'no people picker on a personal report');
  assert.equal(await page.locator('input[name="r-col"][value="contractor"]').count(), 0);
  if (SHOT) await page.screenshot({ path: `${SHOT}/1-self-dialog.png` });

  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#r-download')]);
  const csv = (await readDownload(dl)).toString();
  assert.match(dl.suggestedFilename(), /^time-report-sam-rivers-.*\.csv$/);
  assert.match(csv, /Sam: homepage hero/);
  assert.doesNotMatch(csv, /Jake:|Ana:/, 'only my own time');
  assert.doesNotMatch(csv, /Sam: last week/, 'only the week on screen');

  // PDF of last week.
  await page.click('#r-fmt-pdf');
  await page.selectOption('#r-preset', 'last-week');
  const [pdf] = await Promise.all([page.waitForEvent('download'), page.click('#r-download')]);
  const buf = await readDownload(pdf);
  assert.equal(buf.subarray(0, 5).toString(), '%PDF-');

  // The PDF/CSV both lead with time per project.
  await page.click('#r-fmt-csv');
  const [dl2] = await Promise.all([page.waitForEvent('download'), page.click('#r-download')]);
  assert.match((await readDownload(dl2)).toString(), /^Time by project,Code,Brand,Entries,Hours,% of total/m);

  // Schedule it weekly — recipients aren't editable, it's me.
  await page.selectOption('#r-freq', 'weekly');
  assert.equal(await page.locator('#r-to-emails').count(), 0, 'a personal report always goes to its owner');
  await page.click('#r-save-sched');
  await page.waitForSelector('#sched-self tbody tr');
  const rowText = await page.textContent('#sched-self tbody tr');
  assert.match(rowText, /sam@pd\.test/);
  assert.match(rowText, /Week/);
  if (SHOT) await page.screenshot({ path: `${SHOT}/2-self-scheduled.png`, fullPage: true });

  // ── personal projects ──
  assert.equal(await page.isVisible('#tab-admin'), true, 'everyone gets the Projects tab now');
  await page.click('#tab-admin');
  await page.waitForSelector('#proj-rows tr');
  assert.equal(await page.isVisible('#rh-section'), false, 'admin migration tool stays hidden');
  assert.equal(await page.isVisible('#p-team'), false, 'no team-project option for a contractor');
  assert.equal(await page.locator('#proj-rows tr', { hasText: 'Website rebuild' }).locator('input').count(), 0,
    'team projects are read-only to a contractor');
  await page.fill('#p-name', 'Client research');
  await page.fill('#p-code', 'RES');
  await page.selectOption('#p-brand', 'Pacific Discovery');
  await page.click('#p-add');
  await page.waitForSelector('#proj-rows tr:has-text("You")');
  const mineRow = page.locator('#proj-rows tr', { has: page.locator('.pill-own') });
  assert.equal(await mineRow.locator('input.fld').first().inputValue(), 'Client research');
  // It's in the timer picker, under My projects.
  const groups = await page.$$eval('#t-project optgroup', (gs) => gs.map((g) => g.label + ':' + [...g.children].map((o) => o.textContent).join('|')));
  assert.ok(groups.some((g) => /^My projects:Client research \(RES\)$/.test(g)), groups.join(' / '));
  if (SHOT) await page.screenshot({ path: `${SHOT}/5-my-projects.png`, fullPage: true });

  // Log 30 min to it by hand and see it in the report's project table.
  await page.click('#tab-week');
  await page.click('#btn-manual');
  await page.selectOption('#m-project', { label: 'Client research (RES)' });
  await page.fill('#m-start', '10:00');
  await page.fill('#m-end', '10:30');
  await page.click('#m-save');
  await page.waitForSelector('#modal-root:empty', { state: 'attached' });
  await page.click('#btn-report');
  await page.waitForSelector('#r-download');
  await page.click('#r-fmt-csv');
  const [dl3] = await Promise.all([page.waitForEvent('download'), page.click('#r-download')]);
  assert.match((await readDownload(dl3)).toString(), /^Client research,RES,Pacific Discovery,1,0\.50,/m);
});

// ── an admin builds a team report and a fortnightly email ───────────────────
WHO = { email: 'jake@pd.test', app_metadata: { roles: ['admin'] } };
await session('admin', async (page) => {
  await page.goto(PAGE);
  await page.waitForSelector('#tab-team:not(.hidden)');
  await page.click('#tab-team');
  await page.waitForSelector('#team-rows tr');
  await page.click('#btn-report');
  await page.waitForSelector('input[name="r-person"]');
  assert.equal(await page.locator('input[name="r-person"]').count(), 3);

  // Just Sam and Ana, Unearthed + Unassigned brands, grouped by person, with money.
  await page.uncheck('input[name="r-person"][value="1"]');
  await page.click('summary:has-text("Brands")');
  await page.uncheck('input[name="r-brand"][value="Pacific Discovery"]');
  for (const b of ['EDA Group', 'Pure Exploration', 'Conference']) {
    const box = page.locator(`input[name="r-brand"][value="${b}"]`);
    if (await box.count()) await box.uncheck();
  }
  await page.selectOption('#r-group', 'contractor');
  await page.check('#r-money');
  assert.match(await page.textContent('#r-person-n'), /2 of 3/);
  if (SHOT) await page.screenshot({ path: `${SHOT}/3-team-dialog.png` });

  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#r-download')]);
  const csv = (await readDownload(dl)).toString();
  assert.match(dl.suggestedFilename(), /^time-report-team-/);
  assert.match(csv, /Sam: STEM copy/);
  assert.match(csv, /Sam: inbox/, 'Unassigned bucket kept');
  assert.match(csv, /Ana: admin/);
  assert.doesNotMatch(csv, /Jake:/, 'unticked person left out');
  assert.doesNotMatch(csv, /homepage hero/, 'Pacific Discovery unticked');
  assert.match(csv, /^Sam Rivers,2,2\.83,2\.75,60\.00,NZD,165\.00/m, '170 exact min → 165 billable → $165');

  // PDF of the same, then schedule it fortnightly to two people.
  await page.click('#r-fmt-pdf');
  const [pdf] = await Promise.all([page.waitForEvent('download'), page.click('#r-download')]);
  assert.equal((await readDownload(pdf)).subarray(0, 5).toString(), '%PDF-');

  await page.selectOption('#r-freq', 'fortnightly');
  await page.fill('#r-to-emails', 'jake@pd.test, not an email');
  await page.click('#r-save-sched');
  await page.waitForFunction(() => /isn't an email address/.test(document.getElementById('r-err').textContent));
  await page.fill('#r-to-emails', 'jake@pd.test, accounts@example.com');
  await page.fill('#r-title', 'Payroll fortnight');
  await page.click('#r-save-sched');
  await page.waitForSelector('#sched-team tbody tr');
  const row = page.locator('#sched-team tbody tr', { hasText: 'Payroll fortnight' });
  assert.match(await row.textContent(), /Other week/);
  assert.match(await row.textContent(), /accounts@example\.com/);
  assert.match(await row.textContent(), /by person · with amounts · PDF \+ CSV|by person · with amounts · CSV \+ PDF/);

  // The team report's project table names the owner of a personal project, and
  // splits each project by person.
  await page.click('#btn-report');
  await page.waitForSelector('#r-download');
  await page.click('#r-fmt-csv');
  await page.check('input[name="r-person"][value="1"]');
  await page.$$eval('input[name="r-brand"]', (els) => els.forEach((e) => { e.checked = true; }));
  const [dl4] = await Promise.all([page.waitForEvent('download'), page.click('#r-download')]);
  const tcsv = (await readDownload(dl4)).toString();
  assert.match(tcsv, /^Client research,RES,Pacific Discovery,Sam Rivers,1,1,0\.50,/m);
  assert.match(tcsv, /^Project,Person,Entries,Hours/m);
  if (SHOT) {
    await page.click('#r-fmt-pdf');
    const [p4] = await Promise.all([page.waitForEvent('download'), page.click('#r-download')]);
    const { writeFileSync } = await import('node:fs');
    writeFileSync(`${SHOT}/team.pdf`, await readDownload(p4));
  }
  await page.keyboard.press('Escape');

  // An admin also sees Sam's personal schedule under My week, flagged as hers.
  await page.click('#tab-week');
  assert.match(await page.textContent('#sched-self'), /set up by Sam Rivers/);
  await page.click('#tab-team');

  // Edit: the saved filters come back into the dialog.
  await row.locator('button', { hasText: 'Edit' }).click();
  await page.waitForSelector('#r-save-sched');
  assert.equal(await page.isChecked('input[name="r-person"][value="1"]'), false, 'Jake stays unticked');
  assert.equal(await page.isChecked('#r-money'), true);
  assert.equal(await page.inputValue('#r-freq'), 'fortnightly');
  await page.selectOption('#r-freq', 'weekly');
  await page.click('#r-save-sched');
  await page.waitForFunction(() => /Week/.test(document.querySelector('#sched-team tbody tr td:nth-child(2)').textContent)
    && !/Other/.test(document.querySelector('#sched-team tbody tr td:nth-child(2)').textContent));

  // Send now: no mailbox in this test, so it must fail loudly, not pretend.
  await row.locator('button', { hasText: 'Send now' }).click();
  await page.waitForFunction(() => document.getElementById('toast').className.includes('error'));

  // Pause, then delete.
  await row.locator('button', { hasText: 'Pause' }).click();
  await page.waitForSelector('#sched-team .pill-lock');
  if (SHOT) await page.screenshot({ path: `${SHOT}/4-team-schedules.png`, fullPage: true });
  await row.locator('button', { hasText: 'delete' }).click();
  await page.waitForFunction(() => !/Payroll fortnight/.test(document.getElementById('sched-team').textContent));

  // Projects tab: Sam's personal project shows with her name and can be opened up.
  await page.click('#tab-admin');
  await page.waitForSelector('#proj-rows tr:has-text("Sam Rivers")');
  assert.equal(await page.isVisible('#rh-section'), true);
  if (SHOT) await page.screenshot({ path: `${SHOT}/6-admin-projects.png`, fullPage: true });
  await page.locator('#proj-rows tr', { hasText: 'Sam Rivers' }).locator('button', { hasText: 'Make team project' }).click();
  await page.waitForFunction(() => !/Sam Rivers/.test(document.getElementById('proj-rows').textContent));
  const shared = await q(`SELECT owner_email FROM time_projects WHERE name = 'Client research'`);
  assert.equal(shared[0].owner_email, null);

  const left = await q(`SELECT scope, owner_email FROM time_report_schedules ORDER BY id`);
  assert.deepEqual(left, [{ scope: 'self', owner_email: 'sam@pd.test' }]);
});

await browser.close();
await q(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => {});
await pool.end();
if (failures.length) { console.error(failures.join('\n')); process.exit(1); }
console.log('time-reports smoke: all checks passed');

// node test/apply-form.smoke.mjs — the Apply Form editor in a real browser
// (needs TEST_PG_URL; SHOTS=dir for screenshots; PW_CHROMIUM optional path).
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import pg from 'pg';
import { chromium } from 'playwright';
import handler, { __setSql } from '../netlify/functions/apply-forms.mjs';

const pool = new pg.Pool({ connectionString: process.env.TEST_PG_URL || 'postgres://postgres@127.0.0.1:55432/apply' });
const toText = (s, v) => s.reduce((a, x, i) => a + x + (i < v.length ? `$${i + 1}` : ''), '');
const sql = async (s, ...v) => (await pool.query(toText(s, v), v)).rows;
sql.query = async (t, p = []) => (await pool.query(t, p)).rows;
__setSql(sql);
await pool.query('TRUNCATE apply_files, applications, apply_form_versions, apply_forms CASCADE');
await pool.query(`INSERT INTO applications (token_hash, email, first_name, last_name, program, term, status, answers, step1_at, step2_at, interview_at, interview, sync)
  VALUES ('h2','sam@x.org','Sam','Rivera','Hawaii Summer Program','Summer 2027','interview',
  '{"name":{"first":"Sam","last":"Rivera"},"email":"sam@x.org","program":"Hawaii Summer Program","term":"Summer 2027","shirtSize":"Medium","respiratory":"Yes","respiratoryDetails":"Mild asthma"}',
  now(), now(), now(), '{"label":"Tue 13 Oct, 9:00 AM"}', '{"jf1":{"ok":true},"hsDeal":{"ok":true}}')`);

const deps = { verifiedUser: async () => ({ email: 'jake@x.org', name: 'Jake', roles: ['admin'] }), accessInputs: async () => ({ grants: null, dashboard: { slug: 'apply-form', allowedRoles: ['admin'] } }) };
const root = new URL('..', import.meta.url).pathname;
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json' };
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost:8898');
  if (url.pathname === '/api/apply-forms') {
    const chunks = []; for await (const c of req) chunks.push(c);
    const out = await handler(new Request(url, { method: req.method, headers: req.headers, body: req.method === 'POST' ? Buffer.concat(chunks) : undefined }), {}, deps);
    res.writeHead(out.status, Object.fromEntries(out.headers)); res.end(Buffer.from(await out.arrayBuffer())); return;
  }
  const p = join(root, url.pathname.endsWith('/') ? `${url.pathname}index.html` : url.pathname);
  if (!existsSync(p)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': types[extname(p)] || 'application/octet-stream' }); res.end(readFileSync(p));
});
await new Promise((r) => server.listen(8898, r));
const browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM || undefined });
const SHOTS = process.env.SHOTS;
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('https://fonts.googleapis.com/**', (r) => r.fulfill({ body: '', contentType: 'text/css' }));
  await page.goto('http://localhost:8898/apply-form/');
  await page.waitForSelector('#pv .fk-field');
  assert.match(await page.locator('#notices').textContent(), /set up from your current Jotform/);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/editor-1-fields.png` });

  // edit a label via the preview → inspector
  await page.click('#pv [data-key=preferredName]');
  await page.fill('#fe-label', 'Preferred first name');
  await page.waitForTimeout(400);
  assert.equal(await page.locator('#pv [data-key=preferredName] .fk-label').first().textContent(), 'Preferred first name*');
  await page.click('#back');

  // add a field with a condition to step 2
  await page.click('.seg [data-step=step2]');
  await page.click('.sec[data-sec="0"] [data-add]');
  await page.fill('#nf-label', 'Will you need a visa?');
  await page.selectOption('#nf-type', 'radio');
  await page.check('#nf-req');
  await page.click('#nf-ok');
  await page.waitForSelector('#fe-label');
  await page.click('#add-rule');
  await page.selectOption('[data-rule="0"] [data-r=field]', 'hasPassport');
  await page.selectOption('[data-rule="0"] [data-r=value]', 'No');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/editor-2-newfield.png` });
  await page.waitForFunction(() => document.querySelector('#save-state').textContent === 'Saved', null, { timeout: 5000 });
  const [row] = (await pool.query('SELECT draft FROM apply_forms')).rows;
  const nf = row.draft.steps[1].sections[0].fields.find((f) => f.label === 'Will you need a visa?');
  assert.ok(nf, 'new field saved');
  assert.equal(nf.type, 'radio'); assert.equal(nf.required, true); assert.equal(Number(nf.qid) >= 1000, true);
  assert.deepEqual(nf.showIf.rules[0], { field: 'hasPassport', op: 'equals', value: 'No' });
  assert.equal(row.draft.steps[0].sections[0].fields.find((f) => f.key === 'preferredName').label, 'Preferred first name');

  // programs tab: set Japan Summer price
  await page.click('[data-tab=programs]');
  const i = row.draft.programs.findIndex((p) => p.name === 'Japan Summer Program');
  await page.fill(`[data-p="${i}"][data-k=price]`, '9950');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/editor-3-programs.png`, fullPage: true });
  await page.waitForFunction(() => document.querySelector('#save-state').textContent === 'Saved', null, { timeout: 5000 });

  // settings
  await page.click('[data-tab=settings]');
  assert.equal(await page.locator('#s-total').textContent(), '$258.75');
  await page.fill('#s-fee', '300');
  assert.equal(await page.locator('#s-total').textContent(), '$310.50');
  await page.fill('#s-fee', '250');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/editor-4-settings.png`, fullPage: true });

  // publish
  await page.waitForFunction(() => document.querySelector('#save-state').textContent === 'Saved', null, { timeout: 5000 });
  await page.click('#btn-publish');
  await page.fill('#pd-in', 'Japan summer price, visa question');
  await page.click('[data-ok]');
  await page.waitForSelector('.chip--live');
  const [pub] = (await pool.query('SELECT published FROM apply_forms')).rows;
  assert.equal(pub.published.programs[i].price, 9950);

  // applications
  await page.click('[data-tab=apps]');
  await page.waitForSelector('.apps tr[data-id]');
  await page.click('.apps tr[data-id]');
  await page.waitForSelector('dl.ans');
  assert.match(await page.locator('dl.ans').textContent(), /Mild asthma/);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/editor-5-application.png` });
  assert.deepEqual(errors, []);
  console.log('  ✓ editor: edit, add conditional field, programs, settings, publish, applications');
} finally {
  await browser.close(); server.close(); await pool.end();
}

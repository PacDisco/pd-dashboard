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

await pool.query(`INSERT INTO applications (token_hash, email, first_name, last_name, program, term, status, answers, step1_at, step2_at, created_at, reminders)
  VALUES ('h3','ana@x.org','Ana','Lopez','Hawaii Summer Program','Summer 2027','step2','{}', now() - interval '5 days', now() - interval '5 days', now() - interval '5 days',
  '{"sent":{"1":{"at":"2026-10-22T09:00:00Z","to":["ana@x.org","mom@x.org"]},"2":{"at":"2026-10-25T09:00:00Z","to":["ana@x.org","mom@x.org"]}}}')`);
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
  await page.fill('#s-ach', '0.8');
  await page.fill('#em-fc-subject', 'Application received — {program}');
  await page.click('#em-fc-default');
  assert.match(await page.locator('#em-fc-body').inputValue(), /What happens next/);
  await page.check('#rm-on');
  await page.click('[data-email=feeReminder3] summary');
  await page.click('[data-email=feeReminder3] [data-em-default]');
  assert.match(await page.locator('[data-email=feeReminder3] [data-em=body]').inputValue(), /check in personally/);
  await page.click('[data-email=feeReminder2] summary');
  await page.uncheck('[data-email=feeReminder2] [data-em=enabled]');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/editor-4-settings.png`, fullPage: true });

  // publish
  await page.waitForFunction(() => document.querySelector('#save-state').textContent === 'Saved', null, { timeout: 5000 });
  await page.click('#btn-publish');
  await page.fill('#pd-in', 'Japan summer price, visa question');
  await page.click('[data-ok]');
  await page.waitForSelector('.chip--live');
  const [pub] = (await pool.query('SELECT published FROM apply_forms')).rows;
  assert.equal(pub.published.programs[i].price, 9950);
  assert.equal(pub.published.settings.achFeeRate, 0.008);
  assert.match(pub.published.settings.emails.feeConfirmation.body, /What happens next/);
  assert.equal(pub.published.settings.feeReminders.enabled, true);
  assert.ok(Date.now() - new Date(pub.published.settings.feeReminders.since) < 120000, 'switch-on time recorded');
  assert.equal(pub.published.settings.emails.feeReminder2.enabled, false);
  assert.match(pub.published.settings.emails.feeReminder3.body, /check in personally/);

  // terms
  await pool.query('DELETE FROM apply_terms_versions; DELETE FROM apply_terms');
  await page.click('[data-tab=terms]');
  await page.waitForSelector('#t-body');
  assert.ok(await page.locator('#t-publish').isDisabled(), 'nothing to publish yet');
  await page.fill('#t-body', `# Program Terms & Conditions\n\n## 1. Application Process\n\nA **$250 application fee** is refunded in full if you are not accepted. ${'Lorem ipsum dolor sit amet. '.repeat(8)}\n\n1. Deposit\n2. Balance`);
  await page.waitForFunction(() => /Application Process/.test(document.querySelector('#t-preview').innerHTML));
  assert.equal(await page.locator('#t-preview ol li').count(), 2);
  await page.waitForFunction(() => /Draft saved/.test(document.querySelector('#t-state').textContent), null, { timeout: 5000 });
  await page.click('#t-publish');
  await page.fill('#pd-in', 'Initial version');
  await page.click('[data-ok]');
  await page.waitForFunction(() => /Live: version 1/.test(document.querySelector('#t-diff').textContent), null, { timeout: 5000 });
  const [tv] = (await pool.query('SELECT version, note FROM apply_terms_versions')).rows;
  assert.equal(tv.version, 1); assert.equal(tv.note, 'Initial version');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/editor-6-terms.png`, fullPage: true });

  // applications
  await page.click('[data-tab=apps]');
  await page.waitForSelector('.apps tr[data-id]');
  await page.click('.apps tr[data-id]');
  await page.waitForSelector('dl.ans');
  assert.match(await page.locator('dl.ans').textContent(), /Mild asthma/);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/editor-5-application.png` });
  await page.click('[data-x]');

  // fee reminders on an unpaid application
  await page.waitForSelector('text=Reminder 2/4 sent');
  await page.click('.apps tr[data-id]:has-text("Ana Lopez")');
  await page.waitForSelector('#rem-toggle');
  assert.match(await page.locator('.dlg-body').textContent(), /Reminder 2 sent .* to ana@x\.org, mom@x\.org/);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/editor-7-reminders.png` });
  assert.ok(await page.locator('#dec-accept').isDisabled(), 'cannot accept before the fee is paid');
  await page.click('#dec-decline');
  await page.waitForSelector('#dd-msg');
  assert.match(await page.locator('.dlg-body').textContent(), /Decline Ana Lopez\?/);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/editor-8-decline.png` });
  await page.click('[data-x]');
  await page.waitForSelector('#rem-toggle');
  await page.click('#rem-toggle');
  await page.waitForSelector('#rem-toggle[data-stop="0"]');
  const [ana] = (await pool.query(`SELECT reminders FROM applications WHERE email = 'ana@x.org'`)).rows;
  assert.ok(ana.reminders.stopped);
  await page.click('.dlg-head [data-x]').catch(() => {});

  // an accepted applicant who paid the deposit on a monthly plan
  await pool.query(`INSERT INTO applications (token_hash, email, first_name, last_name, program, term, status, step1_at, step2_at, interview_at, paid_at, payment, decision, enrolment)
    VALUES ('dep-ui','dep@x.org','Sam','Lee','South America Gap Semester','Fall 2027','paid', now(), now(), now(), now(), '{"total":258.75}', $1, $2)`,
    [JSON.stringify({ outcome: 'accepted', at: new Date().toISOString(), by: 'Megan', holdUntil: new Date(Date.now() + 5 * 864e5).toISOString(), email: { to: ['dep@x.org', 'mum@x.org'] } }),
      JSON.stringify({ offer: { tuition: 15500, start: '2027-09-09' }, choice: { plan: 'monthly', method: 'card', termsVersion: 1 },
        deposit: { total: 2328.75, status: 'paid', method: 'card', reference: 'pi_dep', paidAt: new Date().toISOString() },
        schedule: [{ due: '2026-10-27', amount: 2250, kind: 'deposit', status: 'paid' }, { due: '2026-11-27', amount: 1625, kind: 'instalment', status: 'scheduled' }, { due: '2026-12-27', amount: 1625, kind: 'instalment', status: 'needs_admissions', attempts: 3, lastError: { reason: 'insufficient_funds' } }],
        emails: { enrolled: { to: ['dep@x.org', 'mum@x.org'] } } })]);
  await page.click('[data-tab=settings]');
  await page.waitForSelector('#ac-hold');
  assert.equal(await page.locator('[data-email=accepted]').count(), 1);
  assert.equal(await page.locator('[data-email=enrolled]').count(), 1);
  assert.ok(await page.isChecked('#pay-auto'));
  assert.equal(await page.locator('[data-email=paymentFailed]').count(), 1);
  await page.click('[data-tab=apps]');
  await page.waitForSelector('text=Payment failed — contact family');
  await page.click('.apps tr[data-id]:has-text("Sam Lee")');
  await page.waitForSelector('dl.ans');
  const dtext = await page.locator('.dlg-body').textContent();
  assert.match(dtext, /Deposit paid — \$2,328\.75 by card/);
  assert.match(dtext, /2026-11-27\s*\$1,625\s*automatic/);
  assert.match(dtext, /failed ×3 — contact the family/);
  assert.equal(await page.locator('[data-retry="2"]').count(), 1);
  assert.equal(await page.locator('#pay-pause').count(), 1);
  assert.equal(await page.locator('#dec-extend').count(), 0, 'no hold to extend once paid');
  assert.equal(await page.locator('#dec-decline').count(), 0, 'no decline once the deposit is in');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/editor-9-deposit.png` });
  assert.deepEqual(errors, []);
  console.log('  ✓ editor: edit, add conditional field, programs, settings, publish, terms, applications');
} finally {
  await browser.close(); server.close(); await pool.end();
}

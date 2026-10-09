// node test/quiz-editor.smoke.mjs — the Quiz editor and Lead Sources pages in a
// real browser (needs TEST_PG_URL; SHOTS=dir for screenshots; PW_CHROMIUM optional).
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import pg from 'pg';
import { chromium } from 'playwright';
import handler, { __setSql } from '../netlify/functions/apply-forms.mjs';
import leads, { __setSql as setLeadSql, __setFetch } from '../netlify/functions/lead-sources.mjs';

const pool = new pg.Pool({ connectionString: process.env.TEST_PG_URL || 'postgres://postgres@127.0.0.1:55432/apply' });
const toText = (s, v) => s.reduce((a, x, i) => a + x + (i < v.length ? `$${i + 1}` : ''), '');
const sql = async (s, ...v) => (await pool.query(toText(s, v), v)).rows;
sql.query = async (t, p = []) => (await pool.query(t, p)).rows;
__setSql(sql); setLeadSql(sql);
await pool.query('TRUNCATE apply_files, applications, apply_form_versions, apply_forms, quiz_responses CASCADE');
await pool.query(`INSERT INTO quiz_responses (email, first_name, last_name, archetype, scores, answers, attribution, sync, hubspot_contact_id, created_at) VALUES
  ('maya@x.org','Maya','Ortiz','connector','{"connector":6,"adventurer":2}','{"motivation":"Cultural immersion — I want to live and learn alongside locals."}','{"first":{"utm_source":"facebook","utm_medium":"paid_social","utm_campaign":"fall-quiz","landing":"https://www.pacificdiscovery.org/gap-year/"},"hutk":"abc"}','{"hubspot":{"ok":true},"form":{"ok":true}}','101', now()),
  ('leo@x.org','Leo','Ng','seeker','{"seeker":5}','{}','{"first":{"referrer":"https://www.google.com/"}}','{"hubspot":{"ok":false,"error":"boom"}}',null, now())`);
process.env.HUBSPOT_TOKEN = 'x';
__setFetch(async (url) => {
  const u = new URL(url);
  const now = new Date().toISOString();
  if (u.pathname === '/crm/v3/objects/contacts/search') return new Response(JSON.stringify({ results: [
    { id: '101', properties: { email: 'maya@x.org', firstname: 'Maya', lastname: 'Ortiz', createdate: now, hs_analytics_source: 'OFFLINE', company_tag: 'Pacific Discovery' } },
    { id: '102', properties: { email: 'ana@x.org', firstname: 'Ana', createdate: now, hs_analytics_source: 'OFFLINE', original_source_drill_down_3: 'adwords', company_tag: 'Pacific Discovery' } },
    { id: '103', properties: { email: 'kai@x.org', firstname: 'Kai', createdate: now, hs_analytics_source: 'ORGANIC_SEARCH', hs_analytics_source_data_1: 'google', company_tag: 'Pacific Discovery', how_did_you_find_us_: 'Google' } },
  ] }), { status: 200 });
  if (u.pathname === '/crm/v3/objects/contacts/batch/read') return new Response(JSON.stringify({ results: [{ id: '104', properties: { email: 'leo@x.org', firstname: 'Leo', createdate: '2025-01-01T00:00:00Z', hs_analytics_source: 'OFFLINE' } }] }), { status: 200 });
  return new Response('{}', { status: 404 });
});

const deps = { verifiedUser: async () => ({ email: 'jake@x.org', name: 'Jake', roles: ['admin'] }), accessInputs: async () => ({ grants: null, dashboard: { slug: 'x', allowedRoles: ['admin'] } }) };
const root = new URL('..', import.meta.url).pathname;
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json' };
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost:8897');
  const fn = url.pathname === '/api/apply-forms' ? handler : url.pathname === '/api/lead-sources' ? leads : null;
  if (fn) {
    const chunks = []; for await (const c of req) chunks.push(c);
    const out = await fn(new Request(url, { method: req.method, headers: req.headers, body: req.method === 'POST' ? Buffer.concat(chunks) : undefined }), {}, deps);
    res.writeHead(out.status, Object.fromEntries(out.headers)); res.end(Buffer.from(await out.arrayBuffer())); return;
  }
  const p = join(root, url.pathname.endsWith('/') ? `${url.pathname}index.html` : url.pathname);
  if (!existsSync(p)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': types[extname(p)] || 'application/octet-stream' }); res.end(readFileSync(p));
});
await new Promise((r) => server.listen(8897, r));
const browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM || undefined });
const SHOTS = process.env.SHOTS;
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('https://fonts.googleapis.com/**', (r) => r.fulfill({ body: '', contentType: 'text/css' }));
  await page.goto('http://localhost:8897/apply-form/quiz.html');
  await page.click('#init');
  await page.waitForSelector('.qcard');
  assert.equal(await page.locator('.qcard').count(), 15);
  await page.click('.qcard[data-sec="0"] [data-toggle]');
  // un-score "Adventure and fun" for Adventurer, then re-score
  const btn = page.locator('.qcard[data-sec="0"] .optrow[data-opt="0"] [data-a=adventurer]');
  assert.equal(await btn.getAttribute('aria-pressed'), 'true');
  await btn.click();
  assert.equal(await btn.getAttribute('aria-pressed'), 'false');
  await btn.click();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/quiz-editor-1-questions.png`, fullPage: false });
  await page.click('[data-tab=results]');
  await page.fill('.qcard[data-ai="0"] [data-k=html]', 'First paragraph pasted.\n\nSecond paragraph.');
  await page.locator('.qcard[data-ai="0"] [data-k=name]').click();
  assert.equal(await page.inputValue('.qcard[data-ai="0"] [data-k=html]'), '<p>First paragraph pasted.</p><p>Second paragraph.</p>');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/quiz-editor-2-results.png` });
  await page.waitForFunction(() => document.querySelector('#save-state').textContent === 'Saved', null, { timeout: 8000 });
  await page.click('[data-tab=settings]');
  await page.waitForSelector('#st-hubspotFormGuid');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/quiz-editor-3-settings.png` });
  await page.click('[data-tab=responses]');
  await page.waitForSelector('tr[data-id]');
  assert.equal(await page.locator('tr[data-id]').count(), 2);
  assert.match(await page.locator('tr[data-id]').first().textContent(), /Paid Social|Organic Search/);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/quiz-editor-4-responses.png` });
  await page.click('#btn-publish');
  await page.click('[data-ok]');
  await page.waitForFunction(() => /Live/.test(document.querySelector('#status-chip').textContent));
  const [row] = (await pool.query(`SELECT published FROM apply_forms WHERE id = 'pd-quiz'`)).rows;
  assert.equal(row.published.archetypes[0].html, '<p>First paragraph pasted.</p><p>Second paragraph.</p>');
  console.log('  ✓ quiz editor: set up, scoring chips, paste results, responses, publish');

  await page.route('https://cdn.jsdelivr.net/**', (r) => r.continue());
  await page.goto('http://localhost:8897/lead-sources/');
  await page.waitForSelector('#funnel table');
  const kpis = await page.textContent('#kpis');
  assert.match(kpis, /“Offline” in HubSpot\s*3/);
  const funnel = await page.textContent('#funnel');
  assert.match(funnel, /Paid Social/); assert.match(funnel, /Paid Search/); assert.match(funnel, /Organic Search/);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/lead-sources.png`, fullPage: true });
  await page.click('[data-ch="Paid Social"]');
  assert.match(await page.textContent('#leads'), /maya@x.org/);
  assert.doesNotMatch(await page.textContent('#leads'), /kai@x.org/);
  console.log('  ✓ lead sources: real vs HubSpot, funnel, channel filter');
  assert.deepEqual(errors.filter((e) => !/Chart is not defined/.test(e)), []);
} finally {
  await browser.close(); server.close(); await pool.end();
}

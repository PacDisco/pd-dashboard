// Quiz editing through /api/apply-forms (?form=quiz) and the Lead Sources merge.
// Needs TEST_PG_URL (MIGRATION-apply.sql + MIGRATION-quiz.sql applied).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import handler, { __setSql, checkQuiz, hubspotFormPayload } from '../netlify/functions/apply-forms.mjs';
import leads, { buildLeads, __setSql as setLeadSql, __setFetch } from '../netlify/functions/lead-sources.mjs';

const pool = new pg.Pool({ connectionString: process.env.TEST_PG_URL || 'postgres://postgres@127.0.0.1:55432/apply' });
const toText = (s, v) => s.reduce((a, x, i) => a + x + (i < v.length ? `$${i + 1}` : ''), '');
const sql = async (s, ...v) => (await pool.query(toText(s, v), v)).rows;
sql.query = async (t, p = []) => (await pool.query(t, p)).rows;
__setSql(sql); setLeadSql(sql);
await pool.query('TRUNCATE apply_files, applications, apply_form_versions, apply_forms, quiz_responses CASCADE');
const seed = JSON.parse(readFileSync(new URL('../apply-form/quiz-seed.json', import.meta.url)));
const deps = { verifiedUser: async () => ({ email: 'jake@x.org', name: 'Jake', roles: ['admin'] }), accessInputs: async () => ({ grants: null, dashboard: { slug: 'x', allowedRoles: ['admin'] } }) };
const call = async (method, params, body) => {
  const url = `https://d.example.org/api/apply-forms?${new URLSearchParams(params)}`;
  const res = await handler(new Request(url, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined }), {}, deps);
  return { status: res.status, body: await res.json() };
};
let n = 0; const t = async (name, fn) => { await fn(); n++; console.log('  ✓', name); };

await t('checkQuiz', () => {
  assert.equal(checkQuiz(seed), null);
  assert.match(checkQuiz({ ...seed, kind: 'x' }), /kind/);
  assert.match(checkQuiz({ ...seed, settings: { hubspotFormGuid: 'nope' } }), /HubSpot form ID/);
  const bad = JSON.parse(JSON.stringify(seed)); bad.archetypes[0].html = '<script>x</script>';
  assert.match(checkQuiz(bad), /script/);
});

await t('quiz: init, save, publish — separate from the application form', async () => {
  let r = await call('GET', { action: 'get', form: 'quiz' });
  assert.equal(r.body.form, null);
  r = await call('POST', {}, { form: 'quiz', action: 'init', schema: seed });
  assert.equal(r.status, 200);
  const d = JSON.parse(JSON.stringify(seed)); d.archetypes[0].html = '<p>Pasted text</p>';
  r = await call('POST', {}, { form: 'quiz', action: 'save', rev: 1, draft: d });
  assert.equal(r.body.rev, 2);
  r = await call('POST', {}, { form: 'quiz', action: 'publish', rev: 2, note: 'texts' });
  assert.equal(r.status, 200);
  const [row] = (await pool.query(`SELECT id, published FROM apply_forms WHERE id = 'pd-quiz'`)).rows;
  assert.equal(row.published.archetypes[0].html, '<p>Pasted text</p>');
  assert.equal((await pool.query(`SELECT count(*)::int n FROM apply_forms WHERE id = 'pd-application'`)).rows[0].n, 0);
  r = await call('GET', { action: 'versions', form: 'quiz' });
  assert.equal(r.body.versions.length, 1);
});

await t('quiz: publish refused when a result is unreachable by lint error', async () => {
  const d = JSON.parse(JSON.stringify(seed)); d.steps[0].sections[0].fields[0].scores['Adventure and fun — I want to see and do new things!'] = ['ghost'];
  let r = await call('POST', {}, { form: 'quiz', action: 'save', rev: 2, draft: d });
  assert.equal(r.status, 200);
  r = await call('POST', {}, { form: 'quiz', action: 'publish', rev: 3 });
  assert.equal(r.status, 422);
});

await t('quiz responses list', async () => {
  await pool.query(`INSERT INTO quiz_responses (email, first_name, archetype, scores, answers, attribution, sync) VALUES ('a@x.org','A','seeker','{"seeker":4}','{}','{"first":{"gclid":"1"}}','{"hubspot":{"ok":true}}')`);
  const r = await call('GET', { action: 'quiz-responses', form: 'quiz' });
  assert.equal(r.body.responses.length, 1);
  assert.equal(r.body.counts.seeker, 1);
});

await t('HubSpot form payload has the email field', () => {
  const p = hubspotFormPayload('Quiz');
  assert.equal(p.fieldGroups[0].fields[0].name, 'email');
  assert.equal(p.configuration.createNewContactForNewEmail, false);
});

await t('buildLeads: Offline fixed by site cookie, recovered by drill-down, parents flagged', () => {
  const contacts = [
    { id: '1', properties: { email: 'quiz@x.org', createdate: '2026-09-10T00:00:00Z', hs_analytics_source: 'OFFLINE' } },
    { id: '2', properties: { email: 'old@x.org', createdate: '2026-09-11T00:00:00Z', hs_analytics_source: 'OFFLINE', original_source_drill_down_3: 'adwords' } },
    { id: '3', properties: { email: 'web@x.org', createdate: '2026-09-12T00:00:00Z', hs_analytics_source: 'ORGANIC_SEARCH', hs_analytics_source_data_1: 'google' } },
    { id: '4', properties: { email: 'mum@x.org', createdate: '2026-09-12T00:00:00Z', hs_analytics_source: 'OFFLINE' } },
  ];
  const out = buildLeads(contacts, {
    quizzes: [{ email: 'quiz@x.org', created_at: '2026-09-10T00:00:00Z', archetype: 'seeker', attribution: { first: { utm_source: 'facebook', utm_medium: 'paid_social', utm_campaign: 'fall' } } }],
    apps: [{ email: 'quiz@x.org', created_at: '2026-09-12T00:00:00Z', status: 'step2', step2_at: '2026-09-13', paid_at: null, program: 'Bali Summer Program', attribution: {} }],
    parents: new Set(['mum@x.org']),
  });
  const by = Object.fromEntries(out.map((l) => [l.email, l]));
  assert.deepEqual([by['quiz@x.org'].real.channel, by['quiz@x.org'].real.basis], ['Paid Social', 'site']);
  assert.equal(by['quiz@x.org'].app, 'complete');
  assert.equal(by['quiz@x.org'].quiz, 'seeker');
  assert.deepEqual([by['old@x.org'].real.channel, by['old@x.org'].real.basis], ['Paid Search', 'recovered']);
  assert.equal(by['web@x.org'].real.basis, 'hubspot');
  assert.equal(by['mum@x.org'].parent, true);
});

await t('lead-sources endpoint: HubSpot search + Neon join', async () => {
  __setFetch(async (url, init) => {
    const u = new URL(url);
    if (u.pathname === '/crm/v3/objects/contacts/search') return new Response(JSON.stringify({ results: [{ id: '9', properties: { email: 'a@x.org', createdate: new Date().toISOString(), hs_analytics_source: 'OFFLINE' } }] }), { status: 200 });
    return new Response(JSON.stringify({ results: [] }), { status: 200 });
  });
  process.env.HUBSPOT_TOKEN = 'x';
  const res = await leads(new Request('https://d.example.org/api/lead-sources'), {}, deps);
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  const a = body.leads.find((l) => l.email === 'a@x.org');
  assert.equal(a.real.channel, 'Paid Search');
  assert.equal(a.quiz, 'seeker');
});

console.log(`\n${n} passed`);
await pool.end();

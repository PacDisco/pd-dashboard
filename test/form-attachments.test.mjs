// test/form-attachments.test.mjs — PDFs of quizzes, referrals, step-1
// applications, Meta lead forms and popups on HubSpot contacts.
//
//   npm run test:form-attachments
//
// The DB half runs against a scratch PostgreSQL when one is reachable
// (TEST_PG_URL, default postgres://postgres@127.0.0.1:55432/apply) and `pg`
// is installed (npm i --no-save pg); otherwise it's skipped.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { quizPdf, referralPdf, step1Pdf, metaLeadPdf, popupPdf, metaLeadRows, metaLeadName, sourceLine, noteHtml } from '../netlify/functions/_shared/submission-pdf.mjs';
import { applicationRows } from '../netlify/functions/_shared/application-pdf.mjs';
import { toLead, listMetaLeads, __setFetch as setMetaFetch } from '../netlify/functions/_shared/meta-leads.mjs';

let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log(`  ✓ ${name}`); };
const json = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8'));
const quizSeed = json('../apply-form/quiz-seed.json');
const refSeed = json('../apply-form/referral-seed.json');
const appSeed = json('../apply-form/seed-schema.json');
const isPdf = (b) => b instanceof Uint8Array && b.length > 500 && String.fromCharCode(...b.slice(0, 4)) === '%PDF';

console.log('PDF builders');
const quizResp = {
  id: 'q-1', email: 'maya@x.org', first_name: 'Maya', last_name: 'Ortiz', phone: '+1 555 0100', archetype: 'connector',
  scores: { connector: 6, adventurer: 2 }, created_at: '2026-10-20T01:00:00Z',
  answers: { motivation: quizSeed.steps[0].sections[0].fields[0].options?.[0] || 'x', name: { first: 'Maya', last: 'Ortiz' }, email: 'maya@x.org' },
  attribution: { first: { utm_source: 'facebook', utm_medium: 'paid_social', utm_campaign: 'fall-quiz' } },
};
await t('quiz PDF: result, scores, source and answers', async () => {
  const p = quizPdf({ resp: quizResp, schema: quizSeed });
  assert.ok(isPdf(p.bytes));
  assert.equal(p.fileName, 'Quiz-Maya-Ortiz-2026-10-20.pdf');
  assert.match(p.noteTitle, /quiz — Maya Ortiz/);
  assert.match(p.noteLines[0], /^Result: /);
  assert.equal(sourceLine(quizResp.attribution), 'Came from: facebook / paid_social / fall-quiz');
});
await t('referral PDF names both people', async () => {
  const p = referralPdf({ ref: { id: 'r-1', referrer_email: 'a@x.org', referrer_first_name: 'Ann', referrer_last_name: 'Bee', referrer_type: 'Parent',
    referred_email: 'c@x.org', referred_first_name: 'Cal', referred_last_name: 'Dee', answers: { referrerType: 'Parent' }, created_at: '2026-10-21T00:00:00Z' }, schema: refSeed });
  assert.ok(isPdf(p.bytes));
  assert.equal(p.noteTitle, 'Referral — Cal Dee, referred by Ann Bee');
  assert.match(p.fileName, /^Referral-Cal-Dee-by-Ann-Bee-2026-10-21\.pdf$/);
});
await t('step-1 PDF only prints step-1 questions', async () => {
  const rows = applicationRows(appSeed, { email: 'z@x.com' }, { steps: ['step1'] });
  const all = applicationRows(appSeed, { email: 'z@x.com' });
  assert.ok(rows.sections.length > 0 && rows.sections.length < all.sections.length);
  assert.ok(rows.sections.every((s) => s.step === (appSeed.steps[0].title || 'step1')));
  const p = step1Pdf({ app: { id: 'a-1', email: 'z@x.com', first_name: 'Zoë', last_name: 'Ng', program: 'Japan', step1_at: '2026-10-22T00:00:00Z', answers: {} }, schema: appSeed });
  assert.ok(isPdf(p.bytes));
  assert.equal(p.fileName, 'Application-Started-Zo-Ng-2026-10-22.pdf');
});
const graphLead = {
  id: '9001', created_time: '2026-10-25T03:04:05+0000', ad_name: 'Quiz ad 1', adset_name: 'Tier 1', campaign_name: 'Spring Leads', form_id: 'f1', platform: 'ig', is_organic: false,
  field_data: [
    { name: 'email', values: ['Kim@Example.com'] }, { name: 'full_name', values: ['Kim Lo'] },
    { name: 'phone_number', values: ['+15550100'] }, { name: 'when_do_you_want_to_travel?', values: ['spring_2027'] },
  ],
};
const graphForm = { id: 'f1', name: 'Spring instant form', questions: [{ key: 'when_do_you_want_to_travel?', label: 'When do you want to travel?' }] };
await t('Meta lead: row, labels, name, PDF', async () => {
  const l = toLead(graphLead, graphForm, 'p1');
  assert.equal(l.email, 'kim@example.com');
  assert.equal(l.created_time, '2026-10-25T03:04:05.000Z');
  assert.deepEqual(metaLeadRows(l.field_data, l.questions).map((r) => r.label), ['Email', 'Full name', 'Phone number', 'When do you want to travel?']);
  assert.equal(metaLeadRows(l.field_data, l.questions)[3].value, 'spring 2027');
  assert.equal(metaLeadName(l), 'Kim Lo');
  const p = metaLeadPdf({ lead: l });
  assert.ok(isPdf(p.bytes));
  assert.match(p.noteLines.join(' '), /Instagram/);
});
await t('Meta Graph: page token, forms, leads filtered by time, paging', async () => {
  const urls = [];
  setMetaFetch(async (u) => {
    urls.push(u);
    const url = new URL(u);
    const ok = (j) => new Response(JSON.stringify(j), { status: 200 });
    if (url.pathname === '/v21.0/p1') return ok({ access_token: 'PAGE' });
    if (url.pathname === '/v21.0/p1/leadgen_forms') return ok({ data: [graphForm] });
    if (url.pathname === '/v21.0/f1/leads' && !url.searchParams.get('after')) return ok({ data: [graphLead], paging: { next: `${u}&after=x` } });
    if (url.pathname === '/v21.0/f1/leads') return ok({ data: [{ ...graphLead, id: '9002' }] });
    return new Response('{"error":{"message":"nope"}}', { status: 400 });
  });
  const r = await listMetaLeads({ sinceMs: Date.parse('2026-10-01T00:00:00Z'), cfg: { token: 'SYS', pages: ['p1'], version: 'v21.0', enabled: true } });
  assert.deepEqual(r.leads.map((l) => l.id), ['9001', '9002']);
  assert.equal(r.forms, 1); assert.deepEqual(r.errors, []);
  const leadsUrl = new URL(urls.find((u) => u.includes('/f1/leads')));
  assert.equal(leadsUrl.searchParams.get('access_token'), 'PAGE');
  assert.deepEqual(JSON.parse(leadsUrl.searchParams.get('filtering')), [{ field: 'time_created', operator: 'GREATER_THAN', value: Date.parse('2026-10-01T00:00:00Z') / 1000 }]);
  setMetaFetch(fetch);
});
await t('popup PDF + note HTML is escaped', async () => {
  const popup = { id: 'p', name: 'Booklet', fields: [{ key: 'email', label: 'Email', on: true }, { key: 'program', label: 'Program', on: true, options: [{ value: 'SAS', label: 'South America' }] }, { key: 'x', label: 'Off', on: false }] };
  const p = popupPdf({ popup, values: { email: 'a@b.co', program: 'SAS', x: 'hidden' }, page: { uri: 'https://www.pacificdiscovery.org/x', title: 'X' } });
  assert.ok(isPdf(p.bytes));
  assert.equal(noteHtml('A <b>', ['1 & 2']), '<p><strong>A &lt;b&gt;</strong><br>1 &amp; 2</p>');
});

await t('popup submit attaches the PDF to the timeline note', async () => {
  process.env.HUBSPOT_TOKEN = 'test-token';
  const { upsertContact } = await import('../netlify/functions/_shared/popups-hubspot.mjs');
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const path = url.replace('https://api.hubapi.com', '');
    const body = init.body instanceof FormData ? init.body : init.body ? JSON.parse(init.body) : null;
    calls.push({ path, body });
    const ok = (j) => new Response(JSON.stringify(j), { status: 200 });
    if (path.startsWith('/crm/v3/properties/contacts')) return ok({ results: [] });
    if (path === '/crm/v3/objects/contacts/search') return ok({ results: [] });
    if (path.startsWith('/crm/v3/objects/contacts')) return ok({ id: '901' });
    if (path === '/files/v3/files') return ok({ id: 'file-77' });
    if (path === '/crm/v3/objects/notes') return ok({ id: 'n1' });
    return new Response('nf', { status: 404 });
  };
  const popup = { id: 'p', name: 'Booklet', fields: [{ key: 'email', label: 'Email', on: true, property: 'email' }] };
  await upsertContact(popup, { email: 'a@b.co' }, { uri: '/x' }, { fetchImpl, log: { warn() {} } });
  const up = calls.find((c) => c.path === '/files/v3/files');
  assert.ok(up && up.body.get('fileName').startsWith('Popup-'));
  assert.equal(up.body.get('folderPath'), '/Lead Forms/Website Popups');
  assert.equal(calls.find((c) => c.path === '/crm/v3/objects/notes').body.properties.hs_attachment_ids, 'file-77');

  // Upload refused (no `files` scope) → the note still goes on, without it.
  const noFiles = async (u, i) => (u.endsWith('/files/v3/files') ? new Response('{"message":"scope"}', { status: 403 }) : fetchImpl(u, i));
  calls.length = 0;
  await upsertContact(popup, { email: 'a@b.co' }, {}, { fetchImpl: noFiles, log: { warn() {} } });
  const note = calls.find((c) => c.path === '/crm/v3/objects/notes');
  assert.ok(note && !('hs_attachment_ids' in note.body.properties));
});

// ── DB: one pass end to end ─────────────────────────────────────────────────
let pg; try { pg = (await import('pg')).default; } catch { pg = null; }
const pool = pg && new pg.Pool({ connectionString: process.env.TEST_PG_URL || 'postgres://postgres@127.0.0.1:55432/apply' });
let dbOk = false;
if (pool) { try { await pool.query('select 1'); dbOk = true; } catch { /* skip */ } }
if (!dbOk) {
  console.log(`  – DB tests skipped (no Postgres)\n${n} passed`);
  process.exit(0);
}
console.log('sync pass (Postgres)');
for (const f of ['MIGRATION-apply.sql', 'MIGRATION-quiz.sql', 'MIGRATION-referral.sql', 'MIGRATION-student-payments.sql']) {
  await pool.query(readFileSync(new URL(`../${f}`, import.meta.url), 'utf8'));
}
await pool.query('DROP TABLE IF EXISTS meta_leads, form_attachment_state');
await pool.query('TRUNCATE quiz_responses, referrals, apply_files, applications, apply_form_versions, apply_forms CASCADE');
await pool.query(`INSERT INTO apply_forms (id, draft, published) VALUES ('pd-application', $1, $1), ('pd-quiz', $2, $2), ('pd-referral', $3, $3)`,
  [JSON.stringify(appSeed), JSON.stringify(quizSeed), JSON.stringify(refSeed)]);
const sql = { query: async (text, p = []) => (await pool.query(text, p)).rows };

const run = await import('../netlify/functions/_shared/form-attachments-run.mjs');
run.__setSql(sql);
const contacts = new Map([['maya@x.org', '201'], ['c@x.org', '301'], ['a@x.org', '302'], ['z@x.com', '401']]);
const notes = []; const uploads = [];
let metaLeads = [];
run.__setDeps({
  hub: {
    contactIdForEmail: async (e) => contacts.get(String(e).toLowerCase()) || null,
    uploadFile: async (bytes, name, folder) => { uploads.push({ name, folder }); return `file-${uploads.length}`; },
    createNote: async (note) => { notes.push(note); return `note-${notes.length}`; },
  },
  metaConfig: () => ({ enabled: true, token: 'x', pages: ['p1'], version: 'v21.0' }),
  listMetaLeads: async () => ({ leads: metaLeads, forms: 1, errors: [] }),
});

await t('first pass creates its tables and attaches quiz, referral, step-1', async () => {
  await pool.query(`INSERT INTO quiz_responses (email, first_name, last_name, archetype, answers, created_at) VALUES
    ('maya@x.org', 'Maya', 'Ortiz', 'connector', '{}', now() - interval '1 day'),
    ('nobody@x.org', 'No', 'Body', 'seeker', '{}', now())`);
  await pool.query(`INSERT INTO referrals (referrer_email, referrer_first_name, referred_email, referred_first_name, referrer_contact_id, answers)
    VALUES ('a@x.org', 'Ann', 'c@x.org', 'Cal', '302', '{}')`);
  await pool.query(`INSERT INTO applications (token_hash, email, first_name, status, step1_at, step2_at, hubspot_deal_id) VALUES
    ('s1', 'z@x.com', 'Zoe', 'step1', now() - interval '2 hours', NULL, NULL),
    ('s2', 'z@x.com', 'Zoe', 'step1', now() - interval '5 minutes', NULL, NULL),
    ('s3', 'z@x.com', 'Zoe', 'step2', now() - interval '3 hours', now() - interval '2 hours', NULL)`);
  const r = await run.runFormAttachments({ budgetMs: 10_000 });
  assert.equal(r.schemaSkipped, undefined);
  assert.deepEqual([r.quiz.attached, r.quiz.waiting], [1, 1]);
  assert.equal(r.referral.attached, 1);
  assert.equal(r.step1.attached, 1, 'only the step-1 app older than the delay, never one that went on to step 2');
  const ref = notes.find((x) => /Referral/.test(x.body));
  assert.deepEqual(ref.contactIds.sort(), ['301', '302'], 'one note on referred + referrer');
  assert.equal(notes.find((x) => /quiz/.test(x.body)).contactIds[0], '201');
  assert.ok(uploads.some((u) => u.folder === '/Lead Forms/Quiz'));
  const [w] = await sql.query(`SELECT pdf_error, pdf_attempts FROM quiz_responses WHERE email = 'nobody@x.org'`);
  assert.match(w.pdf_error, /No HubSpot contact/); assert.equal(w.pdf_attempts, 1);
});
await t('second pass: nothing re-attached; a waiting quiz backs off', async () => {
  const before = notes.length;
  const r = await run.runFormAttachments({ budgetMs: 10_000 });
  assert.equal(notes.length, before);
  assert.equal(r.quiz.waiting, 0, 'inside its backoff window, so not even tried');
  assert.equal(r.quiz.remaining, 1);
});
await t('Meta: ingested once, waits for HubSpot’s Lead Ads contact, then attaches', async () => {
  metaLeads = [toLead(graphLead, graphForm, 'p1')];
  let r = await run.runFormAttachments({ budgetMs: 10_000 });
  assert.equal(r.metaIngest.added, 1); assert.equal(r.meta.waiting, 1);
  r = await run.runFormAttachments({ budgetMs: 10_000 });
  assert.equal(r.metaIngest.added, 0, 'same lead read again is not a new row');
  contacts.set('kim@example.com', '501');
  await pool.query(`UPDATE meta_leads SET pdf_error_at = NULL`);
  r = await run.runFormAttachments({ budgetMs: 10_000 });
  assert.equal(r.meta.attached, 1);
  const [row] = await sql.query(`SELECT hubspot_contact_id, pdf_note_id FROM meta_leads`);
  assert.equal(row.hubspot_contact_id, '501'); assert.ok(row.pdf_note_id);
  assert.ok(uploads.some((u) => u.folder === '/Lead Forms/Meta Lead Forms'));
});
await t('Meta not configured → skipped, everything else still runs', async () => {
  run.__setDeps({ hub: { contactIdForEmail: async () => null, uploadFile: async () => 'f', createNote: async () => 'n' }, metaConfig: () => ({ enabled: false }), listMetaLeads: async () => { throw new Error('should not be called'); } });
  const r = await run.runFormAttachments({ budgetMs: 10_000 });
  assert.match(r.metaIngest.skipped, /META_LEADS_TOKEN/);
  assert.ok(r.quiz && !r.quiz.error);
});
await t('lock stops overlapping passes', async () => {
  await pool.query(`UPDATE form_attachment_state SET lock_until = now() + interval '1 minute'`);
  assert.deepEqual(await run.runFormAttachments({}), { skipped: 'locked' });
  await pool.query(`UPDATE form_attachment_state SET lock_until = NULL`);
});

await t('full application with no contact id on it is matched by email', async () => {
  const sp = await import('../netlify/functions/_shared/student-payments-run.mjs');
  sp.__setSql(sql);
  const spNotes = [];
  sp.__setDeps({ hub: { contactIdForEmail: async (e) => (e === 'full@x.com' ? '601' : null), uploadFile: async () => 'f', createNote: async (x) => { spNotes.push(x); return 'n'; }, linkNoteToDeal: async () => ({}) }, buildPdf: () => new Uint8Array([1]) });
  await pool.query(`INSERT INTO applications (token_hash, email, first_name, status, step1_at, step2_at) VALUES
    ('f1', 'full@x.com', 'Fu', 'step2', now(), now()), ('f2', 'ghost@x.com', 'Gh', 'step2', now(), now())`);
  const r = await sp.attachApplicationPdfs({ deadline: Date.now() + 5000, limit: 10 });
  assert.ok(spNotes.some((x) => x.contactId === '601'));
  const [g] = await sql.query(`SELECT pdf_error FROM applications WHERE token_hash = 'f2'`);
  assert.match(g.pdf_error, /No HubSpot contact for ghost@x.com/);
  assert.ok(r.errors >= 1);
});

await pool.end();
console.log(`${n} passed`);

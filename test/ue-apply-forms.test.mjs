// node test/ue-apply-forms.test.mjs — the Unearthed Application Form dashboard:
// Jotform import (pure) always; the API too when a local Postgres is reachable
// (TEST_PG_URL, default postgres://postgres@127.0.0.1:55432/apply).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { jotformToSchema } from '../ue-apply-form/jotform-import.mjs';
import { lintSchema, fieldByKey } from '../ue-apply-form/form-kit.mjs';
import { QUESTIONS, PROPERTIES } from './fixtures/ue-jotform.mjs';

let n = 0; const t = async (name, fn) => { await fn(); n++; console.log('  ✓', name); };

console.log('Jotform import');
await t('every question kept with its Jotform field ID; core keys recognised', () => {
  const { schema, report } = jotformToSchema(QUESTIONS, PROPERTIES, '251396787451873');
  assert.deepEqual(lintSchema(schema), []);
  assert.equal(fieldByKey(schema, 'name').qid, '3'); assert.equal(fieldByKey(schema, 'email').qid, '4'); assert.equal(fieldByKey(schema, 'dob').qid, '76');
  assert.equal(fieldByKey(schema, 'parent1Email').qid, '50'); assert.equal(fieldByKey(schema, 'parent2Name').qid, '55');
  assert.equal(fieldByKey(schema, 'program').source, 'trip:name'); assert.equal(fieldByKey(schema, 'school').prefill, 'trip:school');
  assert.equal(fieldByKey(schema, 'waiverSigned').source, 'waiver:signed');
  assert.equal(schema.settings.jotform.formId, '251396787451873');
  assert.ok(report.some((r) => /Left out "Program Deposit"/.test(r)));
});
await t('passport widget saves into the classic upload field the portals read', () => {
  const { schema } = jotformToSchema(QUESTIONS, PROPERTIES, '1');
  const p = fieldByKey(schema, 'passportPhoto');
  assert.equal(p.type, 'file'); assert.equal(p.qid, '89'); assert.equal(p.jf.type, 'control_fileupload'); assert.ok(p.sensitive);
  assert.equal(fieldByKey(schema, 'passportCover'), null, 'merged, not duplicated');
});
await t('"show when" rules copied, including multi-field actions', () => {
  const { schema } = jotformToSchema(QUESTIONS, PROPERTIES, '1');
  assert.deepEqual(fieldByKey(schema, 'medicalMore').showIf, { match: 'any', rules: [{ field: 'asthma', op: 'equals', value: 'Yes' }] });
  assert.equal(fieldByKey(schema, 'parent2Email').showIf.rules[0].field, 'secondary');
  assert.equal(fieldByKey(schema, 'passportPhoto').showIf.rules[0].field, 'holdPassport');
  assert.equal(fieldByKey(schema, 'name').middle, true, "the student's name asks for middle names");
});

let pg; try { pg = (await import('pg')).default; } catch { pg = null; }
const pool = pg && new pg.Pool({ connectionString: process.env.TEST_PG_URL || 'postgres://postgres@127.0.0.1:55432/apply' });
let ok = false; if (pool) { try { await pool.query('select 1'); ok = true; } catch { /* skip */ } }
if (!ok) { console.log(`  – API tests skipped (no Postgres)\n${n} passed`); process.exit(0); }

console.log('API (Postgres)');
await pool.query(readFileSync(new URL('../MIGRATION-ue-apply.sql', import.meta.url), 'utf8'));
await pool.query(readFileSync(new URL('../MIGRATION-ue-apply-submission-ids.sql', import.meta.url), 'utf8'));
await pool.query(readFileSync(new URL('../MIGRATION-ue-apply-teachers.sql', import.meta.url), 'utf8'));
await pool.query('TRUNCATE ue_apply_files, ue_applications, ue_apply_trips, ue_apply_form_versions, ue_apply_forms CASCADE');
const api = await import('../netlify/functions/ue-apply-forms.mjs');
api.__setSql({ query: async (text, p = []) => (await pool.query(text, p)).rows });
process.env.JOTFORM_API_KEY = 'jf'; process.env.HUBSPOT_TOKEN = 'hs'; process.env.UE_APPLY_SITE_URL = 'https://apply.test'; process.env.UE_APPLY_SERVICE_KEY = 'svc';
const proxied = [];
api.__setFetch(async (url, opts = {}) => {
  const u = new URL(url);
  const r = (b, s = 200, type = 'application/json') => ({ ok: s < 300, status: s, json: async () => b, arrayBuffer: async () => new TextEncoder().encode('%PDF-x').buffer, headers: new Map([['content-type', type]]) });
  if (u.pathname.endsWith('/questions')) return r({ responseCode: 200, content: QUESTIONS });
  if (u.pathname.endsWith('/properties')) return r({ responseCode: 200, content: PROPERTIES });
  if (u.hostname === 'api.hubapi.com' && u.pathname.startsWith('/crm/v3/objects/2-58156993')) return r({ results: [
    { id: '57951798456', properties: { unearthed_program: 'Otago Boys High School - Borneo 2027', program_currency: 'NZD' } },
    { id: '50506535214', properties: { unearthed_program: 'Global Portal Information' } }] });
  if (u.hostname === 'apply.test') { proxied.push({ path: u.pathname, key: opts.headers?.['x-apply-key'], body: opts.body ? JSON.parse(opts.body) : null }); return u.pathname === '/api/service' && JSON.parse(opts.body).action === 'waiver-pdf' ? r(null, 200, 'application/pdf') : r({ ok: true }); }
  throw new Error(`unexpected ${url}`);
});
const ue = { email: 'u@ue.org', name: 'UE Ops', roles: ['unearthed'] };
const deps = (user) => ({ verifiedUser: async () => user, accessInputs: async () => ({ grants: null, dashboard: { slug: 'ue-apply-form', allowedRoles: ['admin', 'operations', 'unearthed'] } }) });
const call = async (user, body, qs = '') => {
  const res = await api.default(new Request(`https://d/api/ue-apply-forms${qs}`, body ? { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } } : {}), {}, deps(user));
  return { status: res.status, body: res.headers.get('content-type')?.includes('json') ? await res.json() : await res.arrayBuffer(), type: res.headers.get('content-type') };
};

await t('access: unearthed / operations / admin only', async () => {
  assert.equal((await call(null, null, '?action=get')).status, 401);
  assert.equal((await call({ ...ue, roles: ['admissions'] }, null, '?action=get')).status, 403);
  const r = await call(ue, null, '?action=get');
  assert.equal(r.status, 200); assert.equal(r.body.form, null);
});
let rev;
await t('import from Jotform → draft; save with stale rev refused; publish blocked by lint errors', async () => {
  const r = await call(ue, { action: 'import-jotform', formId: '251396787451873' });
  assert.equal(r.status, 200, JSON.stringify(r.body)); rev = r.body.form.draftRev; assert.ok(r.body.report.length);
  const d = r.body.form.draft; d.steps[0].sections[0].fields = d.steps[0].sections[0].fields.filter((f) => f.key !== 'dob');
  const s = await call(ue, { action: 'save', draft: d, rev });
  assert.equal(s.status, 200); rev = s.body.form.draftRev;
  assert.equal((await call(ue, { action: 'save', draft: d, rev: rev - 1 })).status, 409);
  const p = await call(ue, { action: 'publish', rev });
  assert.equal(p.status, 422); assert.match(p.body.error, /"dob"/);
});
await t('publish → versions; discard and restore', async () => {
  const r = await call(ue, { action: 'import-jotform', formId: '251396787451873' }); rev = r.body.form.draftRev;
  const p = await call(ue, { action: 'publish', rev, note: 'first' });
  assert.equal(p.status, 200);
  const g = await call(ue, null, '?action=get'); assert.equal(g.body.form.published, true); assert.equal(g.body.form.changed, false);
  const v = await call(ue, null, '?action=versions'); assert.ok(v.body.versions.some((x) => x.kind === 'publish' && x.note === 'first'));
  const [{ published }] = (await pool.query(`SELECT published FROM ue_apply_forms`)).rows; assert.equal(published.steps[0].key, 'step1');
});
await t('trips: validated, slug locked once used, programs list skips the defaults records', async () => {
  const progs = await call(ue, null, '?action=programs');
  assert.deepEqual(progs.body.programs.map((p) => p.id), ['57951798456']);
  assert.equal((await call(ue, { action: 'trip-save', trip: { slug: 'Bad Slug!', program_id: '1' } })).status, 400);
  assert.equal((await call(ue, { action: 'trip-save', trip: { slug: 'otago-borneo', program_id: '57951798456', deposit: '-5' } })).status, 400);
  const s = await call(ue, { action: 'trip-save', trip: { slug: 'otago-borneo', program_id: '57951798456', program_name: 'Otago Boys High School - Borneo 2027', school: 'Otago Boys', deposit: '', currency: 'nzd', open: true } });
  assert.equal(s.status, 200, JSON.stringify(s.body)); assert.equal(s.body.trip.currency, 'NZD'); assert.equal(s.body.trip.deposit, null);
  await pool.query(`INSERT INTO ue_applications (email, trip_slug, status, first_name) VALUES ('a@b.nz', 'otago-borneo', 'applied', 'Ana')`);
  assert.equal((await call(ue, { action: 'trip-save', trip: { originalSlug: 'otago-borneo', slug: 'renamed', program_id: '57951798456' } })).status, 409);
  assert.equal((await call(ue, { action: 'trip-delete', slug: 'otago-borneo' })).status, 409);
  const list = await call(ue, null, '?action=trips'); assert.equal(list.body.trips[0].applications, 1);
});
await t('applications list + detail; service calls proxied with the key', async () => {
  const l = await call(ue, null, '?action=applications&trip=otago-borneo');
  assert.equal(l.body.applications.length, 1); assert.equal(l.body.counts.applied, 1);
  const att = await call(ue, null, '?action=applications&status=attention'); assert.equal(att.body.applications.length, 1, 'applied but unsigned needs attention');
  const d = await call(ue, null, `?action=application&id=${l.body.applications[0].id}`); assert.equal(d.body.app.first_name, 'Ana');
  await call(ue, { action: 'resync', id: 'x', only: ['jotform'] });
  await call(ue, { action: 'import', email: 'r@o.nz', slug: 'otago-borneo' });
  const pdf = await call(ue, null, `?action=waiver-pdf&id=${l.body.applications[0].id}`);
  assert.equal(pdf.type, 'application/pdf');
  assert.ok(proxied.every((p) => p.key === 'svc'));
  assert.deepEqual(proxied.map((p) => p.body?.action), ['resync', 'import', 'waiver-pdf']);
  assert.equal(proxied[1].body.actor, 'UE Ops');
});
await t('teacher & trip leader form: its own draft from the student form; approval proxied; lists split by kind', async () => {
  assert.equal((await call(ue, null, '?action=get&form=teacher')).body.form, null);
  const c = await call(ue, { action: 'create-teacher-form' });
  assert.equal(c.status, 200, JSON.stringify(c.body)); assert.ok(c.body.removed.length);
  const td = c.body.form.draft;
  assert.equal(td.settings.kind, 'teacher');
  assert.ok(!JSON.stringify(td).includes('"parent1Email"'));
  assert.equal((await call(ue, { action: 'create-teacher-form' })).status, 409, 'no accidental overwrite');
  // The student form is untouched; a student draft can't be saved over the teacher form.
  const sg = await call(ue, null, '?action=get'); assert.ok(JSON.stringify(sg.body.form.draft).includes('"parent1Email"'));
  assert.equal((await call(ue, { action: 'save', form: 'teacher', draft: sg.body.form.draft, rev: c.body.form.draftRev })).status, 409);
  const pub = await call(ue, { action: 'publish', form: 'teacher', rev: c.body.form.draftRev, note: 'teachers' });
  assert.equal(pub.status, 200, JSON.stringify(pub.body));
  assert.ok((await call(ue, null, '?action=versions&form=teacher')).body.versions.some((v) => v.note === 'teachers'));
  assert.ok(!(await call(ue, null, '?action=versions')).body.versions.some((v) => v.note === 'teachers'));
  await pool.query(`INSERT INTO ue_applications (email, trip_slug, status, first_name, kind, role, step2_at) VALUES ('t@school.nz', 'otago-borneo', 'signed', 'Tina', 'teacher', 'Trip Leader', now())`);
  const tl = await call(ue, null, '?action=applications&kind=teacher');
  assert.equal(tl.body.applications.length, 1); assert.equal(tl.body.applications[0].role, 'Trip Leader'); assert.equal(tl.body.applications[0].approved, false);
  assert.equal((await call(ue, null, '?action=applications&kind=student')).body.applications.length, 1);
  assert.ok((await call(ue, null, '?action=applications&status=attention')).body.applications.some((a) => a.kind === 'teacher'), 'unapproved teacher needs attention');
  const trips = await call(ue, null, '?action=trips'); assert.equal(trips.body.trips[0].applications, 1); assert.equal(trips.body.trips[0].staff, 1);
  await call(ue, { action: 'approve-teacher', id: tl.body.applications[0].id, role: 'Teacher' });
  assert.deepEqual(proxied.at(-1).body, { action: 'approve-teacher', id: tl.body.applications[0].id, actor: 'UE Ops', role: 'Teacher' });
});
await pool.end();
console.log(`${n} passed`);

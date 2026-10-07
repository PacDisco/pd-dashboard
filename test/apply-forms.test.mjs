// node test/apply-forms.test.mjs   (needs a local Postgres with MIGRATION-apply.sql: TEST_PG_URL)
// API behind /apply-form/: access, seed, autosave conflicts, lint-gated publish,
// versions/restore, applications list.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import handler, { __setSql, checkSchema, syncHealth } from '../netlify/functions/apply-forms.mjs';

const pool = new pg.Pool({ connectionString: process.env.TEST_PG_URL || 'postgres://postgres@127.0.0.1:55432/apply' });
const toText = (s, v) => s.reduce((a, x, i) => a + x + (i < v.length ? `$${i + 1}` : ''), '');
const sql = async (s, ...v) => (await pool.query(toText(s, v), v)).rows;
sql.query = async (t, p = []) => (await pool.query(t, p)).rows;
__setSql(sql);
await pool.query('TRUNCATE apply_files, applications, apply_form_versions, apply_forms CASCADE');

const seed = JSON.parse(readFileSync(new URL('../apply-form/seed-schema.json', import.meta.url)));
const editor = { email: 'ed@pd.org', name: 'Ed', roles: ['outreach'] };
const viewer = { email: 'v@pd.org', name: 'V', roles: ['operations'] };
const deps = (user) => ({ verifiedUser: async () => user, accessInputs: async () => ({ grants: null, dashboard: { slug: 'apply-form', allowedRoles: ['admin', 'admissions', 'outreach'] } }) });
const call = async (user, body, qs = '') => {
  const res = await handler(new Request(`https://d/api/apply-forms${qs}`, body ? { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } } : {}), {}, deps(user));
  return { status: res.status, body: await res.json() };
};
let n = 0; const t = async (name, fn) => { await fn(); n++; console.log('  ✓', name); };

await t('no session → 401; wrong role → 403', async () => {
  assert.equal((await call(null, null, '?action=get')).status, 401);
  assert.equal((await call(viewer, null, '?action=get')).status, 403);
});
await t('first load: no form, then init from seed', async () => {
  const g = await call(editor, null, '?action=get');
  assert.equal(g.body.form, null);
  const i = await call(editor, { action: 'init', schema: seed });
  assert.equal(i.status, 200); assert.equal(i.body.form.draftRev, 1);
  assert.equal((await call(editor, { action: 'init', schema: seed })).status, 409);
});
await t('schema checks', async () => {
  assert.equal(checkSchema(seed), null);
  const bad = structuredClone(seed); bad.settings.meetingUrl = 'https://evil.example/x';
  assert.match(checkSchema(bad), /HubSpot meetings/);
  const s2 = structuredClone(seed); s2.steps[0].sections[0].fields[0].html = '<script>x</script>';
  assert.match(checkSchema(s2), /script/);
});
let rev = 1;
await t('save bumps rev; stale rev → 409', async () => {
  const d = structuredClone(seed); d.programs.find((p) => p.name === 'Japan Summer Program').price = 9950;
  const s = await call(editor, { action: 'save', rev, draft: d });
  assert.equal(s.status, 200); rev = s.body.rev; assert.equal(rev, 2);
  const stale = await call(editor, { action: 'save', rev: 1, draft: d });
  assert.equal(stale.status, 409);
});
await t('publish blocked by lint errors, then succeeds; versions + restore', async () => {
  const d = structuredClone(seed);
  d.steps[0].sections[0].fields = d.steps[0].sections[0].fields.filter((f) => f.key !== 'email');
  rev = (await call(editor, { action: 'save', rev, draft: d })).body.rev;
  const p = await call(editor, { action: 'publish', rev });
  assert.equal(p.status, 422);
  rev = (await call(editor, { action: 'save', rev, draft: seed })).body.rev;
  const ok = await call(editor, { action: 'publish', rev, note: 'first' });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const [row] = (await pool.query('SELECT published_rev, published FROM apply_forms')).rows;
  assert.equal(row.published_rev, rev);
  const v = await call(editor, null, '?action=versions');
  assert.equal(v.body.versions[0].note, 'first');
  const r = await call(editor, { action: 'restore', versionId: v.body.versions[0].id });
  assert.equal(r.status, 200); assert.ok(r.body.form.draftRev > rev);
});
await t('applications list + detail + withdraw', async () => {
  await pool.query(`INSERT INTO applications (token_hash, email, first_name, last_name, program, term, status, answers, step1_at, step2_at, sync)
    VALUES ('h1','a@x.org','Ann','Bee','Bali Summer Program','Summer 2027','step2','{"email":"a@x.org"}', now(), now(), '{"jf2":{"ok":false,"error":"boom"}}')`);
  const l = await call(editor, null, '?action=applications&q=ann');
  assert.equal(l.body.applications.length, 1);
  assert.equal(l.body.applications[0].sync.ok, false);
  assert.equal(l.body.counts.step2, 1);
  const id = l.body.applications[0].id;
  const g = await call(editor, null, `?action=application&id=${id}`);
  assert.equal(g.body.application.answers.email, 'a@x.org');
  const w = await call(editor, { action: 'withdraw', id, withdrawn: true });
  assert.equal(w.body.application.status, 'withdrawn');
  const u = await call(editor, { action: 'withdraw', id, withdrawn: false });
  assert.equal(u.body.application.status, 'step2');
});
await t('syncHealth', async () => {
  assert.deepEqual(syncHealth({ a: { ok: true }, b: { ok: false, error: 'x' } }), { ok: false, problems: ['b: x'] });
});
await pool.end();
console.log(`\n${n} passed`);

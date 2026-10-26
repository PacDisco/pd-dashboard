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
await t('settings: card / ACH fees, refund wording and fee email pass the schema checks', async () => {
  const d = structuredClone(seed);
  d.settings.achFeeRate = 0.008; d.settings.texts = { ...(d.settings.texts || {}), feePolicy: 'Fee {fee} refundable only if declined.' };
  d.settings.emails = { feeConfirmation: { enabled: true, subject: 'Got it — {program}', body: 'Hi {firstName}\n\n- one' } };
  assert.equal(checkSchema(d), null);
});

await t('terms: draft save, publish creates versions, nothing-changed and short drafts refused', async () => {
  await pool.query('DELETE FROM apply_terms_versions; DELETE FROM apply_terms');
  const g0 = await call(editor, null, '?action=terms');
  assert.equal(g0.status, 200); assert.equal(g0.body.live, null); assert.equal(g0.body.draft, '');
  assert.equal((await call(editor, { action: 'terms-save', body: '# T\n\nshort' })).status, 200);
  assert.equal((await call(editor, { action: 'terms-publish' })).status, 400, 'too short to publish');
  const body1 = `# Program Terms & Conditions\n\n${'A $250 application fee is refunded in full if you are not accepted. '.repeat(5)}`;
  await call(editor, { action: 'terms-save', title: 'Program Terms & Conditions', body: body1 });
  const p1 = await call(editor, { action: 'terms-publish', note: 'first' });
  assert.equal(p1.status, 200); assert.equal(p1.body.version, 1);
  assert.equal((await call(editor, { action: 'terms-publish' })).status, 409, 'unchanged');
  await call(editor, { action: 'terms-save', title: 'Program Terms & Conditions', body: `${body1}\n\n## Payment plans\n\nMonthly until 60 days before departure.` });
  const p2 = await call(editor, { action: 'terms-publish', note: 'plans' });
  assert.equal(p2.body.version, 2);
  const g = await call(editor, null, '?action=terms');
  assert.equal(g.body.live.version, 2); assert.match(g.body.live.body, /Payment plans/);
  assert.deepEqual(g.body.versions.map((v) => v.version), [2, 1]);
  const v1 = await call(editor, null, '?action=terms-version&v=1');
  assert.equal(v1.body.note, 'first'); assert.ok(!/Payment plans/.test(v1.body.body));
  assert.equal((await call(editor, null, '?action=terms-version&v=7')).status, 404);
  assert.equal((await call(viewer, null, '?action=terms')).status, 403);
});

await t('terms: publishing needs a publish role', async () => {
  const prev = process.env.APPLY_FORM_PUBLISH_ROLES;
  process.env.APPLY_FORM_PUBLISH_ROLES = 'admin';
  try {
    await call(editor, { action: 'terms-save', body: `# X\n\n${'changed text '.repeat(30)}` });
    assert.equal((await call(editor, { action: 'terms-publish' })).status, 403);
  } finally { if (prev === undefined) delete process.env.APPLY_FORM_PUBLISH_ROLES; else process.env.APPLY_FORM_PUBLISH_ROLES = prev; }
});

await t('terms: import from the website (pacificdiscovery.org only)', async () => {
  const real = globalThis.fetch;
  globalThis.fetch = async () => new Response('<html><body><nav>Menu</nav><main><h1>Program Terms</h1><h2>1. Application Process</h2><p>A <strong>$250</strong> fee.</p><ul><li>One</li><li>Two</li></ul></main></body></html>', { status: 200 });
  try {
    const r = await call(editor, { action: 'terms-import' });
    assert.equal(r.status, 200);
    assert.equal(r.body.body, '# Program Terms\n\n## 1. Application Process\n\nA **$250** fee.\n\n- One\n- Two');
    assert.equal((await call(editor, { action: 'terms-import', url: 'https://evil.example/terms' })).status, 400);
  } finally { globalThis.fetch = real; }
});

await pool.end();
console.log(`\n${n} passed`);

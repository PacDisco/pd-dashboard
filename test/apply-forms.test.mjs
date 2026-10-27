// node test/apply-forms.test.mjs   (needs a local Postgres with MIGRATION-apply.sql: TEST_PG_URL)
// API behind /apply-form/: access, seed, autosave conflicts, lint-gated publish,
// versions/restore, applications list.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import handler, { __setSql, checkSchema, syncHealth, reminderSummary, canDecide, enrolmentSummary } from '../netlify/functions/apply-forms.mjs';

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

await t('fee reminders: status in the list, closed filter, stop and resume', async () => {
  const [r] = (await pool.query(`INSERT INTO applications (token_hash, email, first_name, last_name, program, term, status, step1_at, step2_at, reminders)
    VALUES ('rem1','rem@x.org','Rem','One','Hawaii Summer Program','Summer 2027','step2', now(), now() - interval '30 days',
    '{"sent":{"1":{"at":"2026-10-01T00:00:00Z","to":["rem@x.org"]},"4":{"at":"2026-10-20T00:00:00Z","pending":true}},"skipped":[2,3],"closedAt":"2026-10-25T00:00:00Z"}') RETURNING id`)).rows;
  const l = await call(editor, null, '?action=applications');
  const row = l.body.applications.find((a) => a.id === r.id);
  assert.equal(row.reminders.count, 1, 'a pending (claimed, unsent) reminder is not counted');
  assert.equal(row.reminders.closedAt, '2026-10-25T00:00:00Z');
  assert.equal(l.body.counts.closed, 1);
  const c = await call(editor, null, '?action=applications&status=closed');
  assert.deepEqual(c.body.applications.map((a) => a.id), [r.id]);
  const stop = await call(editor, { action: 'reminders', id: r.id, stop: true });
  assert.equal(stop.status, 200); assert.equal(stop.body.application.reminders.stopped.by, 'Ed');
  const resume = await call(editor, { action: 'reminders', id: r.id, stop: false });
  assert.equal(resume.body.application.reminders.stopped, null);
  assert.equal(resume.body.application.reminders.closedAt, null, 'resume re-opens a closed application');
  assert.equal((await call(editor, { action: 'reminders', id: '00000000-0000-0000-0000-000000000000', stop: true })).status, 404);
  assert.deepEqual(reminderSummary(null), { sent: [], count: 0 });
});

await t('accept / decline: role check, passed to pd-apply with who decided, shown in the list', async () => {
  assert.equal(canDecide({ roles: ['outreach'] }), false);
  assert.equal(canDecide({ roles: ['admissions'] }), true);
  assert.equal(canDecide({ roles: ['admin'] }), true);
  const [r] = (await pool.query(`INSERT INTO applications (token_hash, email, first_name, last_name, program, term, status, step1_at, step2_at, paid_at)
    VALUES ('dec1','dec@x.org','Dee','Cee','Hawaii Summer Program','Summer 2027','paid', now(), now(), now()) RETURNING id`)).rows;
  assert.equal((await call(editor, { action: 'decide', id: r.id, outcome: 'declined' })).status, 403, 'outreach editor cannot decide');
  const admissions = { email: 'meg@pd.org', name: 'Megan', roles: ['admissions'] };
  process.env.APPLY_SITE_URL = 'https://apply.test'; process.env.APPLY_SERVICE_KEY = 'svc';
  const real = globalThis.fetch; let sent;
  globalThis.fetch = async (u, init) => {
    sent = { url: String(u), key: init.headers['x-apply-key'], body: JSON.parse(init.body) };
    await pool.query(`UPDATE applications SET decision = $2 WHERE id = $1`, [r.id, JSON.stringify({ outcome: 'declined', at: new Date().toISOString(), by: 'Megan', refund: { id: 're_1', amount: 25875 } })]);
    return new Response(JSON.stringify({ ok: true, decision: { outcome: 'declined' } }), { status: 200 });
  };
  try {
    const out = await call(admissions, { action: 'decide', id: r.id, outcome: 'declined', message: 'Try Fall', refund: true });
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.equal(sent.url, 'https://apply.test/api/service/decision'); assert.equal(sent.key, 'svc');
    assert.deepEqual({ ...sent.body, id: undefined }, { id: undefined, outcome: 'declined', message: 'Try Fall', refund: true, by: 'Megan' });
    const l = await call(admissions, null, '?action=applications&status=declined');
    assert.deepEqual(l.body.applications.map((a) => a.id), [r.id]);
    assert.equal(l.body.applications[0].decision.refund.amount, 25875);
    assert.equal(l.body.counts.declined, 1);
    globalThis.fetch = async () => new Response(JSON.stringify({ error: 'Already declined.' }), { status: 409 });
    const dup = await call(admissions, { action: 'decide', id: r.id, outcome: 'declined' });
    assert.equal(dup.status, 409); assert.equal(dup.body.error, 'Already declined.');
  } finally { globalThis.fetch = real; delete process.env.APPLY_SITE_URL; delete process.env.APPLY_SERVICE_KEY; }
});

await t('deposit paid: listed under Deposit paid with plan + schedule; extend hold is proxied with who did it', async () => {
  const enrolment = {
    offer: { tuition: 15500, paid: 250, deposit: 2250, start: '2027-09-09' },
    choice: { plan: 'monthly', method: 'card', termsVersion: 3 },
    deposit: { amount: 2250, fee: 78.75, total: 2328.75, status: 'paid', method: 'card', reference: 'pi_1', paidAt: new Date().toISOString() },
    schedule: [{ due: '2026-11-01', amount: 2250, kind: 'deposit', status: 'paid' }, { due: '2026-12-01', amount: 1625, kind: 'instalment', status: 'scheduled' }],
    lastPending: { secret: 'not shown' },
  };
  const [r] = (await pool.query(`INSERT INTO applications (token_hash, email, first_name, last_name, program, term, status, step1_at, step2_at, paid_at, decision, enrolment)
    VALUES ('dep1','dep@x.org','Dee','Pee','South America Gap Semester','Fall 2027','paid', now(), now(), now(), $1, $2) RETURNING id`,
    [JSON.stringify({ outcome: 'accepted', at: new Date().toISOString(), by: 'Megan', holdUntil: new Date().toISOString() }), JSON.stringify(enrolment)])).rows;
  const admissions = { email: 'meg@pd.org', name: 'Megan', roles: ['admissions'] };
  const l = await call(admissions, null, '?action=applications&status=deposit_paid');
  assert.deepEqual(l.body.applications.map((a) => a.id), [r.id]);
  assert.equal(l.body.counts.deposit_paid, 1);
  const e = l.body.applications[0].enrolment;
  assert.equal(e.plan, 'monthly'); assert.equal(e.deposit.total, 2328.75); assert.equal(e.schedule.length, 2);
  assert.equal(e.lastPending, undefined, 'internal checkout details not sent to the browser');
  assert.equal(enrolmentSummary({}), null); assert.equal(enrolmentSummary(null), null);

  assert.equal((await call(editor, { action: 'extend-hold', id: r.id, days: 5 })).status, 403);
  process.env.APPLY_SITE_URL = 'https://apply.test'; process.env.APPLY_SERVICE_KEY = 'svc';
  const real = globalThis.fetch; let sent;
  globalThis.fetch = async (u, init) => { sent = { url: String(u), body: JSON.parse(init.body) }; return new Response(JSON.stringify({ ok: true, decision: {} }), { status: 200 }); };
  try {
    assert.equal((await call(admissions, { action: 'extend-hold', id: r.id, days: 5 })).status, 200);
    assert.equal(sent.url, 'https://apply.test/api/service/extend-hold');
    assert.deepEqual(sent.body, { id: r.id, days: 5, by: 'Megan' });
  } finally { globalThis.fetch = real; delete process.env.APPLY_SITE_URL; delete process.env.APPLY_SERVICE_KEY; }
});

await t('after the deposit: withdraw / retry / pause go to pd-apply (admissions only); a plain withdraw stays local', async () => {
  const [r] = (await pool.query(`INSERT INTO applications (token_hash, email, first_name, last_name, program, term, status, step1_at, step2_at, paid_at, decision, enrolment)
    VALUES ('wd1','wd@x.org','Wen','Dee','South America Gap Semester','Fall 2027','paid', now(), now(), now(), '{"outcome":"accepted"}', '{"deposit":{"status":"paid"},"schedule":[]}') RETURNING id`)).rows;
  const admissions = { email: 'meg@pd.org', name: 'Megan', roles: ['admissions'] };
  assert.equal((await call(editor, { action: 'withdraw', id: r.id, withdrawn: true })).status, 403, 'needs admissions once a deposit is paid');
  assert.equal((await call(editor, { action: 'payment-retry', id: r.id, item: 1 })).status, 403);
  process.env.APPLY_SITE_URL = 'https://apply.test'; process.env.APPLY_SERVICE_KEY = 'svc';
  const real = globalThis.fetch; const sent = [];
  globalThis.fetch = async (u, init) => {
    const body = JSON.parse(init.body); sent.push({ url: String(u), body });
    if (String(u).endsWith('/withdraw')) await pool.query(`UPDATE applications SET status = 'withdrawn' WHERE id = $1`, [r.id]);
    return new Response(JSON.stringify({ ok: true, kept: 2500, cancelled: 3 }), { status: 200 });
  };
  try {
    const w = await call(admissions, { action: 'withdraw', id: r.id, withdrawn: true, reason: 'Gap year job' });
    assert.equal(w.status, 200, JSON.stringify(w.body));
    assert.deepEqual(sent[0], { url: 'https://apply.test/api/service/withdraw', body: { id: r.id, reason: 'Gap year job', by: 'Megan' } });
    assert.equal(w.body.application.status, 'withdrawn'); assert.equal(w.body.withdraw.kept, 2500);
    await call(admissions, { action: 'payment-retry', id: r.id, item: 2 });
    assert.deepEqual(sent[1], { url: 'https://apply.test/api/service/payment-retry', body: { id: r.id, item: 2, by: 'Megan' } });
    await call(admissions, { action: 'payments-pause', id: r.id, paused: true });
    assert.deepEqual(sent[2].body, { id: r.id, paused: true, by: 'Megan' });
    await call(admissions, { action: 'resend-acceptance', id: r.id });
    assert.deepEqual(sent.at(-1), { url: 'https://apply.test/api/service/resend-acceptance', body: { id: r.id, by: 'Megan' } });
    sent.pop();
    await call(admissions, { action: 'payment-mark-paid', id: r.id, item: 3, reference: 'Wise 9' });
    assert.deepEqual(sent[3], { url: 'https://apply.test/api/service/payment-mark-paid', body: { id: r.id, item: 3, reference: 'Wise 9', by: 'Megan' } });
  } finally { globalThis.fetch = real; delete process.env.APPLY_SITE_URL; delete process.env.APPLY_SERVICE_KEY; }
});

await pool.end();
console.log(`\n${n} passed`);

// node test/student-payments.test.mjs
//   Pure rules always run. The sync pass + API run too when a local Postgres
//   is reachable (TEST_PG_URL, default postgres://postgres@127.0.0.1:55432/apply)
//   — the migrations are applied to it first. HubSpot, Stripe, Wise and FX are fakes.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  parseLooseDate, parseSlot, planWrite, removeSurcharge, fromStripeCharge, fromWiseTransaction,
  studentNameOf, dealIdsIn, dealsNamedIn, matchPayment, formatAmount, nameVariants, contactFits,
} from '../netlify/functions/_shared/deal-payments.mjs';
import * as hubStudent from '../netlify/functions/_shared/hubspot-student.mjs';
import { applicationRows, buildApplicationPdf, pdfText } from '../netlify/functions/_shared/application-pdf.mjs';
import { stripeAccounts } from '../netlify/functions/_shared/payment-sources.mjs';

let n = 0; const t = async (name, fn) => { await fn(); n++; console.log('  ✓', name); };

console.log('rules');
await t('dates people type into slots', () => {
  assert.equal(parseLooseDate('2026-10-17'), '2026-10-17');
  assert.equal(parseLooseDate('13 Oct 2026'), '2026-10-13');
  assert.equal(parseLooseDate('4 Sept 2026'), '2026-09-04');
  assert.equal(parseLooseDate('19-10-2026'), '2026-10-19');
  assert.equal(parseLooseDate('pi_3ULbJdAY32Ud1Dlw3z9ByIDS'), null);
});
await t('slot parsing matches the existing shapes', () => {
  assert.deepEqual(parseSlot(1, '250, pi_3ULbJdAY, 2026-10-01'), { n: 1, raw: '250, pi_3ULbJdAY, 2026-10-01', amount: 250, ref: 'pi_3ULbJdAY', date: '2026-10-01' });
  assert.equal(parseSlot(2, '1802.50, 4 Sept 2026').date, '2026-09-04');
  assert.equal(parseSlot(3, '2000, pi_3SeEPH,\n').amount, 2000);
  assert.equal(parseSlot(4, '').amount, null);
});
await t('planWrite: next free slot, running total, original currency appended', () => {
  const props = { payment_1: '250, pi_A1234567, 2026-10-01', payment_2: '2250, 20261016GMQFMP01015544, 2026-10-17', total_amount_paid: '' };
  const w = planWrite(props, { source: 'wise', ref: 'TRANSFER-99887766', amountUsd: 2283.75, amount: 4000, currency: 'NZD', fxRate: 0.5709375, date: '2026-10-20' });
  assert.equal(w.action, 'write'); assert.equal(w.prop, 'payment_3');
  assert.equal(w.line, '2283.75, TRANSFER-99887766, 2026-10-20, NZD 4000.00 @ 0.5709');
  assert.equal(w.total, 4783.75);
});
await t('planWrite: keeps a hand-kept total and adds to it', () => {
  const w = planWrite({ payment_1: '250, x, 2026-01-01', total_amount_paid: '1250' }, { ref: 'pi_newpayment', amountUsd: 500, currency: 'USD', date: '2026-10-01' });
  assert.equal(w.total, 1750);
});
await t('planWrite: same reference already present → nothing written (pd-apply app fee)', () => {
  const w = planWrite({ payment_1: '250, pi_3ULbJdAY32Ud1Dlw3z9ByIDS, 2026-10-01' }, { ref: 'pi_3ULbJdAY32Ud1Dlw3z9ByIDS', amountUsd: 250, date: '2026-10-01' });
  assert.deepEqual(w, { action: 'already', slot: 1, why: 'reference' });
});
await t('planWrite: same amount within 3 days → treated as the hand entry', () => {
  const w = planWrite({ payment_2: '2250, 20261016GMQFMP01015544, 2026-10-17' }, { ref: 'TRANSFER-1', amountUsd: 2250, date: '2026-10-16' });
  assert.equal(w.action, 'already'); assert.equal(w.why, 'amount_and_date');
  assert.equal(planWrite({ payment_2: '2250, ref, 2026-09-01' }, { ref: 'TRANSFER-1', amountUsd: 2250, date: '2026-10-16' }).action, 'write');
});
await t('planWrite: all 15 slots used → full', () => {
  const props = Object.fromEntries(Array.from({ length: 15 }, (_, i) => [`payment_${i + 1}`, `10, r${i}, 2025-01-01`]));
  assert.equal(planWrite(props, { ref: 'pi_x1234567', amountUsd: 5, date: '2026-01-01' }).action, 'full');
});
await t('card surcharge removed only when it divides back to whole dollars', () => {
  assert.equal(removeSurcharge(258.75, 0.035).credited, 250);
  assert.equal(removeSurcharge(2328.75, 0.035).credited, 2250);
  assert.equal(removeSurcharge(2250, 0.035).credited, 2250);
  assert.equal(removeSurcharge(258.75, 0).credited, 258.75);
});
await t('Stripe charge → ledger row', () => {
  const r = fromStripeCharge({ id: 'ch_1', status: 'succeeded', paid: true, amount: 232875, currency: 'usd', created: 1760000000,
    payment_intent: { id: 'pi_ABC', metadata: { hubspot_deal_id: '65383262849' } }, billing_details: { name: 'Jane Gragg', email: 'Jane@x.com' }, description: 'Balance' },
    { surchargeRate: 0.035 });
  assert.equal(r.external_id, 'pi_ABC'); assert.equal(r.amount, 2250); assert.equal(r.gross, 2328.75);
  assert.equal(r.payer_email, 'jane@x.com'); assert.equal(r.metadata.hubspot_deal_id, '65383262849'); assert.ok(r.fee_note);
  assert.equal(fromStripeCharge({ status: 'failed', paid: false }), null);
  assert.equal(fromStripeCharge({ id: 'c', status: 'succeeded', paid: true, amount: 5000, currency: 'jpy', created: 1 }).amount, 5000);
});
await t('Wise credit → ledger row, fee added back; conversions ignored', () => {
  const r = fromWiseTransaction({ type: 'CREDIT', date: '2026-10-17T03:00:00Z', amount: { value: 2243.89, currency: 'USD' }, totalFees: { value: 6.11, currency: 'USD' },
    details: { type: 'DEPOSIT', senderName: 'MARK GRAGG', paymentReference: 'Grace Gragg Japan' }, referenceNumber: 'TRANSFER-555' });
  assert.equal(r.amount, 2250); assert.equal(r.external_id, 'TRANSFER-555'); assert.equal(r.payer_name, 'MARK GRAGG');
  assert.equal(fromWiseTransaction({ type: 'CREDIT', amount: { value: 10, currency: 'USD' }, details: { type: 'CONVERSION' } }), null);
  assert.equal(fromWiseTransaction({ type: 'DEBIT', amount: { value: -10 }, details: { type: 'DEPOSIT' } }), null);
});
await t('names and ids in references', () => {
  assert.equal(studentNameOf('Grace Gragg - Japan Mini Semester'), 'Grace Gragg');
  assert.equal(studentNameOf('Isaac John McCartney — Nepal 2028'), 'Isaac John McCartney');
  assert.deepEqual(dealIdsIn('PD-65383262849 balance'), ['65383262849']);
  assert.deepEqual(dealIdsIn('20261016GMQFMP01015544'), []);
  const deals = [{ id: '1', name: 'Grace Gragg - Japan' }, { id: '2', name: 'Tom Gragg - Fiji' }, { id: '3', name: 'Grace Smith - Bali' }];
  assert.deepEqual(dealsNamedIn('Payment for GRACE GRAGG', deals).map((d) => d.id), ['1']);
  assert.deepEqual(dealsNamedIn('Gragg family', deals), []);
});
await t('matcher order: metadata → reference id → email → student name → sender name → review', async () => {
  const D = (id, name, amount = 10000, paid = 0) => ({ id, name, amount, paid });
  const base = { dealById: async (id) => (id === '111111111' ? D('111111111', 'A B - X') : null), dealsForEmail: async () => [], dealsForPerson: async () => [], openDeals: async () => [D('5', 'Grace Gragg - Japan')] };
  assert.equal((await matchPayment({ metadata: { deal_id: '111111111' } }, base)).method, 'metadata');
  assert.equal((await matchPayment({ metadata: {}, reference: 'deal 111111111' }, base)).method, 'reference_id');
  assert.equal((await matchPayment({ metadata: {}, payer_email: 'a@b.c' }, { ...base, dealsForEmail: async () => [D('7', 'Z Y - Q')] })).dealId, '7');
  // two deals on the email, one fully paid → the owing one
  assert.equal((await matchPayment({ metadata: {}, payer_email: 'a@b.c' }, { ...base, dealsForEmail: async () => [D('7', 'Z Y - Q', 100, 100), D('8', 'Z Y - R', 100, 0)] })).dealId, '8');
  assert.equal((await matchPayment({ metadata: {}, reference: 'grace gragg' }, base)).method, 'student_name');
  assert.equal((await matchPayment({ metadata: {}, payer_name: 'Mark Gragg' }, { ...base, dealsForPerson: async () => [D('9', 'Grace Gragg - Japan')] })).method, 'sender_name');
  const r = await matchPayment({ metadata: {}, payer_email: 'a@b.c' }, { ...base, dealsForEmail: async () => [D('7', 'A A - X'), D('8', 'B B - Y')] });
  assert.equal(r.candidates.length, 2); assert.match(r.review, /More than one/);
});
await t('Wise profile found from the token when WISE_PROFILE_ID is unset', async () => {
  const { wiseBusinessProfileId } = await import('../netlify/functions/_shared/payment-sources.mjs');
  const fake = (profiles) => async () => ({ ok: true, status: 200, headers: new Headers(), json: async () => profiles });
  await assert.rejects(wiseBusinessProfileId({ WISE_API_TOKEN: 't' }, fake([{ id: 1, type: 'PERSONAL' }])), /can't see a business profile/);
  await assert.rejects(wiseBusinessProfileId({ WISE_API_TOKEN: 't' }, fake([{ id: 2, type: 'BUSINESS' }, { id: 3, type: 'BUSINESS' }])), /set WISE_PROFILE_ID/);
  assert.equal(await wiseBusinessProfileId({ WISE_API_TOKEN: 't' }, fake([{ id: 1, type: 'PERSONAL' }, { id: 4242, type: 'BUSINESS' }])), '4242');
});
await t('Stripe keys config', () => {
  assert.deepEqual(stripeAccounts({ STRIPE_SECRET_KEY: 'sk_1' }), [{ label: 'stripe', key: 'sk_1' }]);
  assert.deepEqual(stripeAccounts({ STUDENT_PAYMENTS_STRIPE_KEYS: 'pd:rk_a, pe:rk_b' }), [{ label: 'pd', key: 'rk_a' }, { label: 'pe', key: 'rk_b' }]);
});
await t('formatAmount', () => { assert.equal(formatAmount(2250), '2250'); assert.equal(formatAmount(1228.5), '1228.50'); });

await t('bank account-holder names → first/last variants', () => {
  const v = (s) => nameVariants(s).map((x) => `${x.first}/${x.last}`);
  assert.deepEqual(v('ROBERT J SMITH'), ['robert/smith']);
  assert.deepEqual(v('SMITH, ROBERT J'), ['robert/smith']);
  assert.deepEqual(v('MR ROBERT SMITH JR'), ['robert/smith']);
  assert.deepEqual(v('MARIA GARCIA LOPEZ'), ['maria/lopez', 'maria/garcia lopez']);
  assert.deepEqual(v('ROBERT OR JANE SMITH'), ['robert/smith', 'jane/smith']);
  assert.deepEqual(v('Robert & Jane Smith'), ['robert/smith', 'jane/smith']);
  assert.deepEqual(v('ROBERT SMITH AND JANE DOE'), ['robert/smith', 'jane/doe']);
  assert.deepEqual(v('SMITH'), []);
  assert.deepEqual(v('José Núñez'), ['jose/nunez']);
});
await t('contact fits the bank name word-for-word, case-insensitive', () => {
  const vs = nameVariants('ROBERT J SMITH');
  assert.ok(contactFits({ firstname: 'Robert', lastname: 'Smith' }, vs));
  assert.ok(contactFits({ firstname: 'robert james', lastname: 'SMITH' }, vs));
  assert.ok(!contactFits({ firstname: 'Roberta', lastname: 'Smith' }, vs));
  assert.ok(!contactFits({ firstname: 'Rob', lastname: 'Smith' }, vs)); // nicknames are not guessed
  assert.ok(contactFits({ firstname: 'Maria', lastname: 'Garcia Lopez' }, nameVariants('MARIA GARCIA LOPEZ')));
  assert.ok(contactFits({ firstname: 'Maria', lastname: 'Lopez' }, nameVariants('MARIA GARCIA LOPEZ')));
});
await t('deal ID in reference: name must agree when the reference names a student', async () => {
  const deals = { '111111111': { id: '111111111', name: 'Amy Lee - Bali', amount: 9000, paid: 0 }, '222222222': { id: '222222222', name: 'Ben Lee - Fiji', amount: 9000, paid: 0 } };
  const d = { dealById: async (id) => deals[id] || null, dealsForEmail: async () => [], dealsForPerson: async () => [], openDeals: async () => Object.values(deals) };
  assert.equal((await matchPayment({ metadata: {}, reference: 'PD-111111111 Amy Lee' }, d)).dealId, '111111111');
  assert.equal((await matchPayment({ metadata: {}, reference: 'PD-111111111' }, d)).dealId, '111111111');
  assert.equal((await matchPayment({ metadata: {}, reference: 'PD-111111111 balance from R Lee' }, d)).dealId, '111111111');
  const swapped = await matchPayment({ metadata: {}, reference: 'PD-111111111 Ben Lee' }, d);
  assert.match(swapped.review, /deal ID 111111111 \(Amy Lee\) but names Ben Lee/);
  assert.deepEqual(swapped.candidates.map((c) => c.id), ['111111111', '222222222']);
});
await t('HubSpot person lookup: searches by word, keeps only fitting contacts, gives up on common names', async () => {
  process.env.HUBSPOT_TOKEN = 'test';
  const calls = [];
  let contacts = [];
  hubStudent.__setFetch(async (url, init) => {
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ url, body });
    const json = (x) => ({ ok: true, status: 200, json: async () => x });
    if (url.includes('/contacts/search')) return json({ results: contacts });
    if (url.includes('/associations/contacts/deals')) return json({ results: body.inputs.map((i) => ({ from: { id: i.id }, to: [{ toObjectId: 900 + Number(i.id) }] })) });
    if (url.includes('/deals/batch/read')) return json({ results: body.inputs.map((i) => ({ id: i.id, properties: { dealname: `Kid ${i.id} - X`, pipeline: '74755425', amount: '9000' } })) });
    throw new Error(url);
  });
  contacts = [{ id: '1', properties: { firstname: 'Robert', lastname: 'Smith' } }, { id: '2', properties: { firstname: 'Roberta', lastname: 'Smith' } }];
  const found = await hubStudent.dealsForPerson('SMITH, ROBERT J');
  assert.deepEqual(found.map((x) => x.id), ['901']);
  const f = calls[0].body.filterGroups[0].filters;
  assert.equal(f[0].operator, 'CONTAINS_TOKEN'); assert.equal(f[0].value, 'robert'); assert.equal(f[1].value, 'smith');
  contacts = Array.from({ length: 6 }, (_, i) => ({ id: String(i + 1), properties: { firstname: 'John', lastname: 'Smith' } }));
  assert.deepEqual(await hubStudent.dealsForPerson('JOHN SMITH'), []);
  hubStudent.__setFetch(fetch);
});

const seed = JSON.parse(readFileSync(new URL('../apply-form/seed-schema.json', import.meta.url)));
await t('application rows: private fields left out by default and counted', () => {
  const answers = { hasPassport: 'Yes', medications: 'X1234567', schoolYear: 'College - Freshman' };
  const { sections, omittedPrivate } = applicationRows(seed, answers);
  const all = sections.flatMap((s) => s.rows.map((r) => r.value));
  assert.ok(!all.includes('X1234567')); assert.ok(omittedPrivate > 0); assert.ok(all.includes('College - Freshman'));
  const withPrivate = applicationRows(seed, answers, { includePrivate: true }).sections.flatMap((s) => s.rows.map((r) => r.value));
  assert.ok(withPrivate.includes('X1234567'));
});
await t('application PDF builds', () => {
  const bytes = buildApplicationPdf({ app: { id: 'a1', first_name: 'Zoë', last_name: 'Ng', email: 'z@x.com', program: 'Japan Mini Semester', term: 'Spring 2027', step2_at: new Date().toISOString(), answers: { schoolYear: 'High School Graduate', homeAddress: { addr_line1: '1 Main St', city: 'Boulder', state: 'CO', postal: '80301', country: 'United States' } } }, schema: seed });
  assert.equal(String.fromCharCode(...bytes.slice(0, 5)), '%PDF-'); assert.ok(bytes.length > 2000);
  assert.equal(pdfText('“Hi” — 日本'), '"Hi" - ??');
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
await pool.query(readFileSync(new URL('../MIGRATION-apply.sql', import.meta.url), 'utf8'));
await pool.query(readFileSync(new URL('../MIGRATION-student-payments.sql', import.meta.url), 'utf8'));
await pool.query('TRUNCATE deal_payments, apply_files, applications, apply_form_versions, apply_forms CASCADE');
await pool.query('UPDATE student_payment_state SET lock_until = NULL');
const sql = async (s, ...v) => (await pool.query(s.reduce((a, x, i) => a + x + (i < v.length ? `$${i + 1}` : ''), ''), v)).rows;
sql.query = async (text, p = []) => (await pool.query(text, p)).rows;

const run = await import('../netlify/functions/_shared/student-payments-run.mjs');
run.__setSql(sql);
const { toDeal } = await import('../netlify/functions/_shared/hubspot-student.mjs');
const deals = new Map([
  ['65383262849', { id: '65383262849', properties: { dealname: 'Grace Gragg - Japan Mini Semester', amount: '10500', deal_currency_code: 'USD', pipeline: '74755425', payment_1: '250, pi_APPFEE0001, 2026-10-01' } }],
  ['700000001', { id: '700000001', properties: { dealname: 'Tom Ali - Fiji', amount: '9000', deal_currency_code: 'USD', pipeline: '74755425' } }],
]);
const writes = []; const notes = [];
const fakeHub = {
  getDeal: async (id) => toDeal(deals.get(String(id)) || null),
  updateDeal: async (id, props) => { writes.push({ id, props }); Object.assign(deals.get(id).properties, props); },
  dealsForEmail: async (e) => (e === 'mum@ali.com' ? [toDeal(deals.get('700000001'))] : []),
  dealsForPerson: async () => [],
  openStudentDeals: async () => [...deals.values()].map(toDeal),
  uploadFile: async () => 'file-1',
  createNote: async (n) => { notes.push(n); return `note-${notes.length}`; },
  linkNoteToDeal: async () => ({}),
};
const old = new Date(Date.now() - 60 * 60_000);
const sec = Math.floor(old.getTime() / 1000);
run.__setDeps({
  hub: fakeHub,
  stripeAccounts: () => [{ label: 'pd', key: 'sk' }],
  listStripeCharges: async () => [
    { id: 'ch_fee', status: 'succeeded', paid: true, amount: 25875, currency: 'usd', created: sec, payment_intent: { id: 'pi_APPFEE0001', metadata: {} } },
    { id: 'ch_bal', status: 'succeeded', paid: true, amount: 232875, currency: 'usd', created: sec, payment_intent: { id: 'pi_BAL0000001', metadata: { hubspot_deal_id: '65383262849' } } },
    { id: 'ch_ali', status: 'succeeded', paid: true, amount: 100000, currency: 'usd', created: sec, billing_details: { email: 'mum@ali.com' }, payment_intent: { id: 'pi_ALI0000001', metadata: {} } },
    { id: 'ch_who', status: 'succeeded', paid: true, amount: 50000, currency: 'usd', created: sec, billing_details: { name: 'Someone Else' }, payment_intent: { id: 'pi_WHO0000001', metadata: {} } },
  ],
  listWiseCredits: async () => [{ balance: { id: 1, currency: 'NZD' }, transactions: [
    { type: 'CREDIT', date: old.toISOString(), amount: { value: 4000, currency: 'NZD' }, details: { type: 'DEPOSIT', senderName: 'R ALI', paymentReference: 'Tom Ali balance' }, referenceNumber: 'TRANSFER-1' },
  ] }],
  usdRate: async (cur) => (cur === 'USD' ? 1 : 0.5),
  buildPdf: () => new Uint8Array([37, 80, 68, 70]),
});

await t('first pass: ingests, logs matched, queues the rest, skips the app fee already on the deal', async () => {
  const r = await run.runSync({ budgetMs: 10_000 });
  assert.equal(r.ingest.stripe.added, 4); assert.equal(r.ingest.wise.added, 1);
  const rows = Object.fromEntries((await sql.query('SELECT external_id, status, slot, deal_id, amount_usd FROM deal_payments')).map((x) => [x.external_id, x]));
  assert.equal(rows.pi_APPFEE0001.status, 'already_logged');
  assert.equal(rows.pi_BAL0000001.status, 'logged'); assert.equal(rows.pi_BAL0000001.slot, 2); assert.equal(Number(rows.pi_BAL0000001.amount_usd), 2250);
  assert.equal(rows.pi_ALI0000001.status, 'logged');
  assert.equal(rows['TRANSFER-1'].status, 'logged'); assert.equal(Number(rows['TRANSFER-1'].amount_usd), 2000);
  assert.equal(rows.pi_WHO0000001.status, 'review');
  const g = deals.get('65383262849').properties;
  assert.equal(g.payment_2, '2250, pi_BAL0000001, ' + old.toISOString().slice(0, 10)); assert.equal(g.total_amount_paid, '2500');
  const a = deals.get('700000001').properties;
  assert.equal(a.payment_1.split(',')[0], '1000'); assert.match(a.payment_2, /^2000, TRANSFER-1, .*, NZD 4000\.00 @ 0\.5000$/); assert.equal(a.total_amount_paid, '3000');
});
await t('second pass is a no-op (idempotent)', async () => {
  const before = writes.length;
  const r = await run.runSync({ budgetMs: 10_000 });
  assert.equal(r.ingest.stripe.added, 0); assert.equal(writes.length, before);
});
await t('lock stops overlapping passes', async () => {
  assert.equal(await run.acquireLock(), true);
  assert.deepEqual(await run.runSync({}), { skipped: 'locked' });
  await pool.query('UPDATE student_payment_state SET lock_until = NULL');
});

const { default: handler } = await import('../netlify/functions/student-payments.mjs');
const ops = { email: 'o@pd.org', name: 'Ops', roles: ['operations'] };
const deps = (user) => ({ verifiedUser: async () => user, accessInputs: async () => ({ grants: null, dashboard: { slug: 'student-payments', allowedRoles: ['admin', 'operations', 'admissions'] } }) });
const call = async (user, body, qs = '') => {
  const res = await handler(new Request(`https://d/api/student-payments${qs}`, body ? { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } } : {}), {}, deps(user));
  return { status: res.status, body: await res.json() };
};
await t('API: access, queue, manual assign', async () => {
  assert.equal((await call(null, null, '?action=summary')).status, 401);
  assert.equal((await call({ ...ops, roles: ['outreach'] }, null, '?action=summary')).status, 403);
  const s = await call(ops, null, '?action=summary');
  assert.equal(s.body.counts.review, 1);
  const { body: { payments } } = await call(ops, null, '?action=list&status=attention');
  assert.equal(payments.length, 1);
  const r = await call(ops, { action: 'assign', id: payments[0].id, dealId: '700000001' });
  assert.equal(r.body.payment.status, 'logged'); assert.equal(r.body.payment.slot, 3); assert.equal(r.body.payment.resolved_by, 'Ops');
  assert.equal(deals.get('700000001').properties.total_amount_paid, '3500');
  assert.equal((await call(ops, { action: 'assign', id: payments[0].id, dealId: '700000001' })).status, 409);
  assert.equal((await call(ops, { action: 'sync', days: 30 })).status, 403);
});

await t('application PDFs attach once, then relink when the deal appears', async () => {
  await pool.query(`INSERT INTO apply_forms (id, draft, published) VALUES ('pd-application', $1, $1)`, [JSON.stringify(seed)]);
  await pool.query(`INSERT INTO applications (token_hash, email, first_name, last_name, status, step2_at, hubspot_contact_id, answers)
    VALUES ('t1', 'a@x.com', 'Amy', 'Lee', 'step2', now(), '101', '{}'), ('t2', 'b@x.com', 'Bo', 'Ng', 'step1', NULL, '102', '{}')`);
  let r = await run.attachApplicationPdfs({ deadline: Date.now() + 5000 });
  assert.equal(r.attached, 1); assert.equal(r.remaining, 0); assert.equal(notes[0].contactId, '101'); assert.equal(notes[0].dealId, null);
  await pool.query(`UPDATE applications SET hubspot_deal_id = '555' WHERE token_hash = 't1'`);
  r = await run.attachApplicationPdfs({ deadline: Date.now() + 5000 });
  assert.equal(r.relinked, 1); assert.equal(r.attached, 0);
  const [a] = await sql.query(`SELECT pdf_deal_id FROM applications WHERE token_hash = 't1'`);
  assert.equal(a.pdf_deal_id, '555');
});

await pool.end();
console.log(`${n} passed`);

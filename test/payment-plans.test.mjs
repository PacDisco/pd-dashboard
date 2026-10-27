// node test/payment-plans.test.mjs — the Payment Plans report (pure).
import assert from 'node:assert/strict';
import { buildReport } from '../netlify/functions/payment-plans.mjs';

let n = 0; const t = (name, fn) => { fn(); n++; console.log('  ✓', name); };
const today = '2026-11-15';
const sched = (rows) => rows.map(([due, amount, status, extra = {}]) => ({ due, amount, kind: due === '2026-10-27' ? 'deposit' : 'instalment', status, ...extra }));
const monthly = {
  id: 'a1', first_name: 'Sam', last_name: 'Lee', email: 'sam@x.org', program: 'South America Gap Semester', term: 'Fall 2027', status: 'paid',
  paid_at: '2026-10-01', payment: { base: 250 }, hubspot_deal_id: '900',
  decision: { outcome: 'accepted' },
  enrolment: { offer: { tuition: 15500 }, choice: { plan: 'monthly', method: 'card', rate: 0.035 }, deposit: { status: 'paid', paidAt: '2026-10-27T10:00:00Z', fee: 78.75 },
    schedule: sched([['2026-10-27', 2250, 'paid', { paidAt: '2026-10-27T10:00:00Z' }], ['2026-11-27', 1625, 'scheduled'], ['2026-12-27', 1625, 'scheduled'], ['2027-01-27', 1625, 'failed', { attempts: 1, nextAttemptAt: '2027-01-30T18:00:00Z' }]]) },
};
const later = {
  id: 'a2', first_name: 'Ann', last_name: 'Bee', email: 'ann@x.org', program: 'Hawaii Mini Semester', term: 'Spring 2027', status: 'paid', paid_at: '2026-10-01', payment: { base: 250 },
  decision: { outcome: 'accepted' },
  enrolment: { offer: { tuition: 11500 }, choice: { plan: 'later', method: 'ach', rate: 0 }, deposit: { status: 'paid', paidAt: '2026-11-01T10:00:00Z' },
    schedule: [{ due: '2026-11-01', amount: 2250, kind: 'deposit', status: 'paid', paidAt: '2026-11-01T10:00:00Z' }, { due: '2026-11-10', amount: 9000, kind: 'balance', manual: true, status: 'due' }] },
};
const pending = {
  id: 'a3', first_name: 'Cy', last_name: 'Dee', email: 'cy@x.org', program: 'Bali Summer Program', term: 'Summer 2027', status: 'paid', paid_at: '2026-11-01', payment: { base: 250 },
  decision: { outcome: 'accepted', holdUntil: '2026-11-20T18:00:00Z' }, enrolment: { offer: { tuition: 9000, holdUntil: '2026-11-20T18:00:00Z' } },
};
const declined = { id: 'a4', first_name: 'No', email: 'no@x.org', decision: { outcome: 'declined' }, enrolment: {} };
const R = buildReport([monthly, later, pending, declined], { today, rates: { card: 0.035, ach: 0 } });

t('families: plan, paid, still to pay, next payment, problems; declined left out', () => {
  assert.deepEqual(R.families.map((f) => f.id).sort(), ['a1', 'a2', 'a3']);
  const s = R.families.find((f) => f.id === 'a1');
  assert.equal(s.paid, 2500); assert.equal(s.remaining, 4875); assert.equal(s.state, 'problem');
  assert.deepEqual(s.next, { date: '2026-11-27', amount: 1625, kind: 'automatic', status: 'scheduled' });
  assert.match(s.problems[0], /failed ×1/);
  const a = R.families.find((f) => f.id === 'a2');
  assert.equal(a.state, 'problem'); assert.match(a.problems[0], /was due 2026-11-10/);
  const c = R.families.find((f) => f.id === 'a3');
  assert.equal(c.state, 'awaitingDeposit'); assert.equal(c.next.amount, 2250); assert.equal(c.unscheduled, 9000 - 250 - 2250);
});

t('months: received in the past, automatic / family pays / at risk / pending deposits ahead', () => {
  const m = Object.fromEntries(R.months.map((x) => [x.month, x]));
  assert.equal(R.months[0].month, '2026-08'); assert.equal(R.months.length, 16);
  assert.equal(m['2026-10'].received, 2250);
  assert.equal(m['2026-11'].received, 2250);
  assert.equal(m['2026-11'].automatic, 1625);
  assert.equal(m['2026-11'].atRisk, 9000, 'overdue balance shows as at risk this month');
  assert.equal(m['2026-11'].pendingDeposit, 2250);
  assert.equal(m['2026-12'].automatic, 1625);
  assert.equal(m['2027-01'].atRisk, 1625, 'failed → at its retry date');
  assert.equal(m['2026-12'].fees, 56.88, 'card fee estimate on top');
});

t('totals', () => {
  assert.equal(R.kpis.received, 4500);
  assert.equal(R.kpis.receivedThisMonth, 2250);
  assert.equal(R.kpis.next30, 1625 + 9000);
  assert.equal(R.kpis.atRisk, 9000 + 1625);
  assert.equal(R.kpis.pendingDeposits, 2250); assert.equal(R.kpis.pendingDepositCount, 1);
  assert.equal(R.kpis.scheduled, 3250);
  assert.deepEqual(R.terms, ['Fall 2027', 'Spring 2027', 'Summer 2027']);
  assert.ok(R.upcoming.every((u) => u.date <= '2027-01-14'));
});

t('withdrawn after the deposit: received kept, nothing expected', () => {
  const w = { ...monthly, id: 'w1', enrolment: { ...monthly.enrolment, withdrawn: { at: '2026-11-02' }, schedule: monthly.enrolment.schedule.map((p, i) => i ? { ...p, status: 'cancelled' } : p) } };
  const r = buildReport([w], { today });
  assert.equal(r.families[0].state, 'withdrawn'); assert.equal(r.kpis.scheduled, 0); assert.equal(r.kpis.received, 2250);
});

console.log(`\n${n} passed`);

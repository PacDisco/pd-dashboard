/**
 * Unit test for dropped students on the Enrollment dashboard.
 *
 * The rule under test, which is the whole point of the feature:
 *
 *   a dropped student is NOT counted as a student,
 *   but their deal amount and their payments ARE still counted in the money.
 *
 * Plus the guard rails around the endpoint that records a drop: it must refuse
 * an unauthenticated caller, refuse a drop with no reason, and never report
 * success when the store could not be read.
 *
 * Usage: node test/enrollment-drops.test.mjs
 */

import assert from 'node:assert/strict';

process.env.HUBSPOT_TOKEN = 'test-token';

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  ok   ${name}`);
    passed++;
  } catch (err) {
    console.error(`  FAIL ${name}\n       ${err.message}`);
    failed++;
  }
}
async function testAsync(name, fn) {
  try {
    await fn();
    console.log(`  ok   ${name}`);
    passed++;
  } catch (err) {
    console.error(`  FAIL ${name}\n       ${err.message}`);
    failed++;
  }
}

// ═══════════════════════════════════════════
// FIXTURES
// ═══════════════════════════════════════════
const FALL_PIPELINE = '74958084';
const CLOSED_WON = '143476017';

const deal = (id, name, amount, paid, program = 'Australia & Bali Semester') => ({
  id,
  properties: {
    dealname: `${name} - ${program}`,
    pipeline: FALL_PIPELINE,
    dealstage: CLOSED_WON,
    pd_program: program,
    travel_year: '2026',
    amount: String(amount),
    total_amount_paid: String(paid)
  }
});

const DEALS = [
  deal('101', 'Alex Channing', 15500, 15500),
  deal('102', 'Chloe Moore', 15500, 17750),
  // Delaney drops. Her $15,500 deal and the $15,500 she paid stay in the money.
  deal('103', 'Delaney Hixon', 15500, 15500),
  // Samuel is on College Credit: already out of BOTH counts, drop or no drop.
  deal('104', 'Samuel Custodio', 10000, 10000, 'College Credit Semester')
];

const DROP_MAP = {
  '103': {
    reason: 'Withdrew for medical reasons',
    droppedBy: 'Jake',
    droppedByEmail: 'jake@boulderdigitalmedia.com',
    droppedAt: '2026-08-20T02:00:00.000Z',
    studentName: 'Delaney Hixon'
  }
};

const mod = await import('../netlify/functions/enrollment.js?drops=1');
const { processDeals, groupBySeason, countsAsMoney, countsAsStudent } = mod;

const processed = processDeals(DEALS, new Map(), new Set(), new Map(), null, DROP_MAP);
const byId = Object.fromEntries(processed.map((d) => [d.id, d]));

// ═══════════════════════════════════════════
// THE COUNTING RULE
// ═══════════════════════════════════════════
console.log('\nDropped students — counting rule\n');

test('a dropped student is not counted as a student', () => {
  assert.equal(countsAsStudent(byId['103']), false);
});

test("a dropped student's money still counts", () => {
  assert.equal(countsAsMoney(byId['103']), true);
});

test('an active student counts both ways', () => {
  assert.equal(countsAsStudent(byId['101']), true);
  assert.equal(countsAsMoney(byId['101']), true);
});

test('the headcount drops by exactly one', () => {
  // 4 deals: 2 active, 1 dropped, 1 College Credit (never counted either way).
  assert.equal(processed.filter(countsAsStudent).length, 2);
});

test('the money total is unchanged by the drop', () => {
  const total = processed.filter(countsAsMoney).reduce((s, d) => s + d.amount, 0);
  // 15500 + 15500 + 15500 (dropped, still counted). College Credit is excluded.
  assert.equal(total, 46500);
});

test('what a dropped student paid still counts as collected', () => {
  const paid = processed.filter(countsAsMoney).reduce((s, d) => s + d.totalPaid, 0);
  // 15500 + 17750 + 15500 (dropped, still counted).
  assert.equal(paid, 48750);
});

test('outstanding stays consistent — no phantom debt from a dropped student', () => {
  const money = processed.filter(countsAsMoney);
  const amount = money.reduce((s, d) => s + d.amount, 0);
  const paid = money.reduce((s, d) => s + d.totalPaid, 0);
  assert.equal(amount - paid, -2250); // Chloe's overpayment, nothing else
});

test('a College Credit student is excluded from both counts, drop or not', () => {
  assert.equal(countsAsStudent(byId['104']), false);
  assert.equal(countsAsMoney(byId['104']), false);
});

// ═══════════════════════════════════════════
// WHAT THE ROW CARRIES
// ═══════════════════════════════════════════
console.log('\nDropped students — the record on the row\n');

test('the dropped row carries its reason, who marked it and when', () => {
  assert.equal(byId['103'].dropped, true);
  assert.equal(byId['103'].dropReason, 'Withdrew for medical reasons');
  assert.equal(byId['103'].droppedBy, 'Jake');
  assert.equal(byId['103'].droppedAt, '2026-08-20T02:00:00.000Z');
});

test('an undropped row says so explicitly rather than leaving the field missing', () => {
  assert.equal(byId['101'].dropped, false);
  assert.equal(byId['101'].dropReason, '');
});

test('the student keeps their row — dropping is not deleting', () => {
  assert.equal(processed.length, 4);
  assert.ok(byId['103'], 'the dropped student is still in the table');
});

test('no drop records at all leaves every count as it was', () => {
  const none = processDeals(DEALS, new Map(), new Set(), new Map(), null, {});
  assert.equal(none.filter(countsAsStudent).length, 3);
  assert.equal(none.every((d) => d.dropped === false), true);
});

// ═══════════════════════════════════════════
// SEASON TABS
// ═══════════════════════════════════════════
console.log('\nDropped students — season tab badges\n');

const { current, past } = groupBySeason(processed);
const tabs = current.concat(past);

test('one season tab is produced for these deals', () => {
  assert.equal(tabs.length, 1);
  assert.equal(tabs[0].key, 'Fall 2026');
});

test('the tab badge counts students, not dropped students', () => {
  assert.equal(tabs[0].countedDeals, 2);
});

test('the tab reports how many dropped students it is hiding from the badge', () => {
  assert.equal(tabs[0].droppedDeals, 1);
});

test('the dropped student is still listed under the tab', () => {
  assert.equal(tabs[0].deals.length, 4);
});

// ═══════════════════════════════════════════
// THE ENDPOINT
// ═══════════════════════════════════════════
console.log('\n/api/enrollment-status — guard rails\n');

const status = (await import('../netlify/functions/enrollment-status.mjs')).default;

const post = (body, headers = {}) => new Request('https://example.test/api/enrollment-status', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...headers },
  body: JSON.stringify(body)
});

await testAsync('an unauthenticated POST is refused', async () => {
  const res = await status(post({ dealId: '103', action: 'drop', reason: 'x' }));
  assert.equal(res.status, 401);
});

await testAsync('a forged nf_jwt cookie is refused, not decoded', async () => {
  // A hand-rolled token claiming the admin role. Verification is what stops it;
  // decoding would let it through.
  const forged = 'aaa.' + Buffer.from(JSON.stringify({ app_metadata: { roles: ['admin'] } })).toString('base64') + '.bbb';
  const realFetch = globalThis.fetch;
  process.env.URL = 'https://example.test';
  globalThis.fetch = async () => new Response('unauthorized', { status: 401 });
  try {
    const res = await status(post({ dealId: '103', action: 'drop', reason: 'x' }, { cookie: `nf_jwt=${forged}` }));
    assert.equal(res.status, 401);
  } finally {
    globalThis.fetch = realFetch;
  }
});

// The remaining cases need a caller Identity accepts. Stub GoTrue.
const asUser = (roles) => {
  const realFetch = globalThis.fetch;
  process.env.URL = 'https://example.test';
  globalThis.fetch = async (url) => {
    if (String(url).includes('/.netlify/identity/user')) {
      return new Response(JSON.stringify({
        email: 'jake@boulderdigitalmedia.com',
        app_metadata: { roles },
        user_metadata: { full_name: 'Jake' }
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    // Any HubSpot call — the note — succeeds quietly.
    return new Response(JSON.stringify({ id: '1' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  return () => { globalThis.fetch = realFetch; };
};

await testAsync('a signed-in user without a permitted role is refused', async () => {
  const restore = asUser(['viewer']);
  try {
    // A distinct token, so the 5-minute auth cache can't serve a previous user.
    const res = await status(post({ dealId: '103', action: 'drop', reason: 'x' }, { authorization: 'Bearer token-viewer' }));
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.match(body.error, /roles/i);
  } finally { restore(); }
});

await testAsync('a drop with no reason is refused', async () => {
  const restore = asUser(['admin']);
  try {
    const res = await status(post({ dealId: '103', action: 'drop', reason: '   ' }, { authorization: 'Bearer token-admin-1' }));
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /reason/i);
  } finally { restore(); }
});

await testAsync('a non-numeric dealId is refused', async () => {
  const restore = asUser(['admin']);
  try {
    const res = await status(post({ dealId: 'not-a-deal', action: 'drop', reason: 'x' }, { authorization: 'Bearer token-admin-2' }));
    assert.equal(res.status, 400);
  } finally { restore(); }
});

await testAsync('an unknown action is refused', async () => {
  const restore = asUser(['admin']);
  try {
    const res = await status(post({ dealId: '103', action: 'expel', reason: 'x' }, { authorization: 'Bearer token-admin-3' }));
    assert.equal(res.status, 400);
  } finally { restore(); }
});

await testAsync('an unreachable store fails loudly instead of reporting success', async () => {
  // Netlify Blobs is not configured outside the Netlify runtime, so this is the
  // real failure path: it must not answer ok.
  const restore = asUser(['admin']);
  try {
    const res = await status(post({ dealId: '103', action: 'drop', reason: 'Withdrew' }, { authorization: 'Bearer token-admin-4' }));
    assert.ok(res.status >= 500, `expected a 5xx, got ${res.status}`);
    const body = await res.json();
    assert.equal(body.ok, undefined);
    assert.match(body.error, /Nothing was saved|Could not save/);
  } finally { restore(); }
});

await testAsync('GET still answers when the store is unreachable, and says so', async () => {
  const res = await status(new Request('https://example.test/api/enrollment-status'));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.deepEqual(body.drops, {});
  assert.ok(body.error, 'the reason the records are missing must be reported');
});

console.log(`\n${passed}/${passed + failed} passed`);
if (failed) process.exit(1);

/**
 * Unit test for the Cash Forecast role gate.
 *
 * `fetch` is stubbed for Netlify Identity, so nothing external is touched and
 * no Xero or Blobs call is made — the gate is supposed to return before any of
 * that happens, and these assertions prove it does.
 *
 * Why this test exists: `/api/*` is excluded from auth-gate.js, so these
 * functions are the ONLY thing standing between the open internet and group
 * bank balances across four entities. If the gate regresses, nothing else
 * catches it.
 *
 * Covers:
 *   - no token at all → 401
 *   - a forged/rejected token → 401 (GoTrue says no)
 *   - a valid user with no cash role → 404, not 403, and no data
 *   - a read-only cash role → passes read, refused 403 on write
 *   - an admin/operations user → passes both
 *   - the role check reads GoTrue's answer, not the token's own claims
 *
 * Usage: node test/cash-forecast-auth.test.mjs
 */

import assert from 'node:assert/strict';

process.env.URL = 'https://dash.example.invalid';
process.env.EDITOR_EMAILS = '';   // unused by this module; roles come from Identity

// ═══════════════════════════════════════════
// STUB STATE
// ═══════════════════════════════════════════
let identityOk = true;
let identityRoles = ['admin'];
let identityEmail = 'someone@boulderdigitalmedia.com';
const calls = { identity: 0 };

const jsonResponse = (obj, status = 200) => new Response(JSON.stringify(obj), {
  status, headers: { 'Content-Type': 'application/json' }
});

globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.includes('/.netlify/identity/user')) {
    calls.identity++;
    if (!identityOk) return new Response('unauthorized', { status: 401 });
    return jsonResponse({
      email: identityEmail,
      app_metadata: { roles: identityRoles },
      user_metadata: { full_name: 'Test User' }
    });
  }
  throw new Error(`Unexpected outbound fetch in test: ${u}`);
};

const { requireCashRole, canEdit } = await import('../netlify/functions/_shared/cash-access.mjs');

/** A request carrying a bearer token. The token's CONTENT is irrelevant — the
 *  point of verifiedUser is that GoTrue decides, not the token's own claims. */
function req(token = 'any-token-at-all') {
  return new Request('https://dash.example.invalid/api/cash-forecast', {
    headers: token ? { authorization: `Bearer ${token}` } : {}
  });
}

// Each case uses a distinct token so verifiedUser's 5-minute cache can't leak
// one case's identity into the next.
let n = 0;
const freshToken = () => `token-${++n}`;

/* ---------- no token ---------- */
{
  const res = await requireCashRole(new Request('https://dash.example.invalid/api/cash-forecast'), 'read');
  assert.ok(res instanceof Response, 'must refuse, not return a user');
  assert.equal(res.status, 401);
  console.log('✓ no token → 401');
}

/* ---------- token GoTrue rejects ---------- */
{
  identityOk = false;
  const res = await requireCashRole(req(freshToken()), 'read');
  assert.ok(res instanceof Response);
  assert.equal(res.status, 401, 'a token GoTrue rejects must not pass');
  identityOk = true;
  console.log('✓ forged / expired token → 401');
}

/* ---------- authenticated but not a cash role ---------- */
{
  identityRoles = ['admissions'];
  identityEmail = 'advisor@pacificdiscovery.org';
  const res = await requireCashRole(req(freshToken()), 'read');
  assert.ok(res instanceof Response);
  assert.equal(res.status, 404, 'must be 404, not 403 — do not confirm the API exists');
  const body = await res.json();
  assert.equal(body.error, 'Not found');
  assert.ok(!('assumptions' in body) && !('forecast' in body), 'and must leak no data');
  console.log('✓ wrong role → 404 with no data');
}

/* ---------- outreach, flights, unearthed, contractor are all excluded ---------- */
{
  for (const role of ['outreach', 'flights', 'unearthed', 'contractor']) {
    identityRoles = [role];
    const res = await requireCashRole(req(freshToken()), 'read');
    assert.ok(res instanceof Response, `${role} must not reach cash data`);
    assert.equal(res.status, 404, `${role} → 404`);
  }
  console.log('✓ outreach / flights / unearthed / contractor all refused');
}

/* ---------- operations: read and write ---------- */
{
  identityRoles = ['operations'];
  identityEmail = 'ops@pacificdiscovery.org';

  const read = await requireCashRole(req(freshToken()), 'read');
  assert.ok(!(read instanceof Response), 'operations must pass read');
  assert.equal(read.email, 'ops@pacificdiscovery.org');
  assert.ok(canEdit(read), 'operations is in WRITE_ROLES');

  const write = await requireCashRole(req(freshToken()), 'write');
  assert.ok(!(write instanceof Response), 'operations must pass write');
  console.log('✓ operations passes read and write');
}

/* ---------- admin ---------- */
{
  identityRoles = ['admin'];
  const write = await requireCashRole(req(freshToken()), 'write');
  assert.ok(!(write instanceof Response), 'admin must pass write');
  console.log('✓ admin passes write');
}

/* ---------- a role in READ_ROLES but not WRITE_ROLES gets 403 on write ----------
   READ_ROLES and WRITE_ROLES are currently identical, so this asserts the
   MECHANISM rather than today's config: if someone later adds a view-only role
   to READ_ROLES, writes must still be refused, and with 403 (the resource
   exists, you may see it) rather than 404. */
{
  const access = await import('../netlify/functions/_shared/cash-access.mjs');
  const original = [...access.WRITE_ROLES];
  try {
    // Simulate a view-only role by removing it from WRITE_ROLES.
    access.WRITE_ROLES.length = 0;
    access.WRITE_ROLES.push('admin');

    identityRoles = ['operations'];
    const read = await requireCashRole(req(freshToken()), 'read');
    assert.ok(!(read instanceof Response), 'view-only role still reads');
    assert.equal(canEdit(read), false, 'but canEdit is false');

    const write = await requireCashRole(req(freshToken()), 'write');
    assert.ok(write instanceof Response);
    assert.equal(write.status, 403, 'view-only role → 403 on write, not 404');
  } finally {
    access.WRITE_ROLES.length = 0;
    access.WRITE_ROLES.push(...original);
  }
  console.log('✓ read-only role is refused writes with 403');
}

/* ---------- the gate does not trust the token's own claims ---------- */
{
  // A caller forging admin inside the JWT payload. GoTrue is the authority and
  // reports `admissions`, so the forged claim must have no effect.
  identityRoles = ['admissions'];
  const forged = Buffer.from(JSON.stringify({ app_metadata: { roles: ['admin'] } })).toString('base64url');
  const res = await requireCashRole(req(`header.${forged}.sig`), 'read');
  assert.ok(res instanceof Response);
  assert.equal(res.status, 404, 'roles must come from GoTrue, never from the token body');
  console.log('✓ forged admin claim in the token is ignored');
}

/* ---------- the endpoint itself refuses before touching Blobs or Xero ---------- */
{
  const { default: forecastFn } = await import('../netlify/functions/cash-forecast.mjs');
  const res = await forecastFn(new Request('https://dash.example.invalid/api/cash-forecast'));
  assert.equal(res.status, 401, 'unauthenticated GET must 401');
  // If it had reached loadAssumptions it would have thrown on getStore outside
  // Netlify, so a clean 401 also proves the gate runs first.
  console.log('✓ cash-forecast refuses before any Blobs/Xero call');
}

assert.ok(calls.identity > 0, 'the test actually exercised Identity verification');
console.log(`\nAll cash-forecast auth tests passed (${calls.identity} Identity checks).`);

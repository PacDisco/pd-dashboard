/**
 * Unit test for /api/shirt-orders — Shopify credential handling and the order
 * guardrails. `fetch` is stubbed for Netlify Identity, Shopify OAuth, Shopify
 * Admin GraphQL and HubSpot, so nothing external is touched.
 *
 * Covers what would cost money or ship a shirt to the wrong place:
 *   - the client credentials grant is used, cached, and refreshed on a 401
 *   - a permanent shpat_ token takes precedence and skips the exchange
 *   - whitespace pasted into a Netlify env var doesn't break auth
 *   - rejected credentials produce an actionable message, not "401"
 *   - an unauthenticated or under-privileged caller cannot order
 *   - out-of-stock and bad-address orders are refused before Shopify is called
 *   - a HubSpot note failure does NOT report the order as failed
 *
 * Usage: node test/shirt-orders-auth.test.mjs
 */

import assert from 'node:assert/strict';

process.env.URL = 'https://dash.example.invalid';
process.env.HUBSPOT_TOKEN = 'hs-token';
process.env.SHOPIFY_STORE_DOMAIN = 'pure-exploration.myshopify.com';

// ═══════════════════════════════════════════
// STUB STATE
// ═══════════════════════════════════════════
const calls = { oauth: 0, graphql: 0, notes: 0, associations: 0 };
let graphqlTokensSeen = [];
let identityRoles = ['admin'];
let identityOk = true;
let oauthStatus = 200;
let oauthToken = 'minted-token-1';
let graphqlStatusQueue = [];      // shift()ed per call; undefined → 200
let orderCreateUserErrors = [];
let hubspotShouldFail = false;
let inventoryQuantity = 34;
let denyField = null;   // e.g. 'orders' → simulate a missing read_orders scope
let denyUntilRefresh = false;  // deny only while the FIRST minted token is in use

const jsonResponse = (obj, status = 200) => new Response(JSON.stringify(obj), {
  status, headers: { 'Content-Type': 'application/json' }
});

const PRODUCT_RESPONSE = () => ({
  data: {
    product: {
      id: 'gid://shopify/Product/1',
      title: 'Pacific Discovery T-Shirt',
      featuredMedia: { preview: { image: { url: 'https://cdn.example.invalid/tee.png' } } },
      variants: {
        nodes: [
          { id: 'gid://shopify/ProductVariant/1', title: 'M', sku: 'IM-PD-TEE-M', price: '20.00', inventoryQuantity, availableForSale: true },
          { id: 'gid://shopify/ProductVariant/3', title: 'L', sku: 'IM-PD-TEE-L', price: '20.00', inventoryQuantity, availableForSale: true },
          { id: 'gid://shopify/ProductVariant/2', title: '3XL', sku: 'IM-PD-TEE-3XL', price: '20.00', inventoryQuantity: 0, availableForSale: false }
        ]
      }
    }
  }
});

const ORDERS_RESPONSE = {
  data: {
    orders: {
      nodes: [{
        id: 'gid://shopify/Order/999', name: '#1042', createdAt: '2026-08-01T10:00:00Z',
        tags: ['pd-shirt', 'pd-deal-101'],
        displayFulfillmentStatus: 'UNFULFILLED', displayFinancialStatus: 'PAID',
        lineItems: { nodes: [{ quantity: 1, title: 'Pacific Discovery T-Shirt', variantTitle: 'M' }] }
      }],
      pageInfo: { hasNextPage: false, endCursor: null }
    }
  }
};

const ORDER_CREATE_RESPONSE = () => ({
  data: {
    orderCreate: {
      userErrors: orderCreateUserErrors,
      order: orderCreateUserErrors.length ? null : {
        id: 'gid://shopify/Order/1000', name: '#1043',
        createdAt: '2026-08-18T01:00:00Z',
        displayFinancialStatus: 'PAID', displayFulfillmentStatus: 'UNFULFILLED',
        totalPriceSet: { shopMoney: { amount: '20.00', currencyCode: 'USD' } }
      }
    }
  }
});

globalThis.fetch = async (url, init) => {
  const u = String(url);

  if (u.includes('/.netlify/identity/user')) {
    if (!identityOk) return new Response('nope', { status: 401 });
    return jsonResponse({ email: 'jake@example.invalid', app_metadata: { roles: identityRoles } });
  }

  if (u.includes('/admin/oauth/access_token')) {
    calls.oauth++;
    if (oauthStatus !== 200) return jsonResponse({ error: 'invalid_client' }, oauthStatus);
    // Assert the grant is formed the way Shopify documents.
    const body = String(init.body || '');
    assert.match(body, /grant_type=client_credentials/);
    assert.match(body, /client_id=/);
    assert.match(body, /client_secret=/);
    return jsonResponse({ access_token: oauthToken, scope: 'write_orders,read_orders', expires_in: 86399 });
  }

  if (u.includes('/admin/api/') && u.includes('graphql.json')) {
    calls.graphql++;
    graphqlTokensSeen.push(init.headers['X-Shopify-Access-Token']);
    const status = graphqlStatusQueue.length ? graphqlStatusQueue.shift() : 200;
    if (status !== 200) return new Response('[API] Invalid API key or access token', { status });
    const q = JSON.parse(init.body).query;
    // A token minted before the scope was granted is denied; the second one works.
    if (denyUntilRefresh && q.includes('ShirtOrders') && calls.oauth < 2) {
      return jsonResponse({ errors: [{ message: 'Access denied for orders field.' }] });
    }
    if (denyField && q.includes('ShirtOrders') && denyField === 'orders') {
      return jsonResponse({ errors: [{ message: 'Access denied for orders field.' }] });
    }
    if (denyField && q.includes('ShirtProduct') && denyField === 'product') {
      return jsonResponse({ errors: [{ message: 'Access denied for product field.' }] });
    }
    if (q.includes('ShirtProduct')) return jsonResponse(PRODUCT_RESPONSE());
    if (q.includes('ShirtOrders')) return jsonResponse(ORDERS_RESPONSE);
    if (q.includes('CreateShirtOrder')) return jsonResponse(ORDER_CREATE_RESPONSE());
    throw new Error(`unexpected GraphQL: ${q.slice(0, 60)}`);
  }

  if (u.includes('/crm/v3/objects/notes')) {
    calls.notes++;
    if (hubspotShouldFail) return new Response('boom', { status: 500 });
    return jsonResponse({ id: 'note-1' });
  }
  if (u.includes('/associations/default/deals/')) {
    calls.associations++;
    return new Response(null, { status: 204 });
  }

  throw new Error(`unexpected fetch: ${u}`);
};

// ═══════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════
const results = [];
const check = (name, fn) => {
  try { fn(); results.push(['ok  ', name]); }
  catch (err) { results.push(['FAIL', `${name} — ${err.message}`]); }
};

let runCounter = 0;
/** Fresh module import so the token cache starts empty. */
async function freshModule() {
  runCounter++;
  return import(`../netlify/functions/shirt-orders.mjs?run=${runCounter}`);
}

const req = (method, body) => new Request('https://dash.example.invalid/api/shirt-orders', {
  method,
  headers: { cookie: 'nf_jwt=fake-token-' + runCounter, 'Content-Type': 'application/json' },
  body: body ? JSON.stringify(body) : undefined
});

const GOOD_ORDER = {
  dealId: '101',
  studentName: 'Abigail Dailey',
  email: 'abbydailey8@example.invalid',
  size: 'Large',            // deliberately the application's wording, not "L"
  quantity: 1,
  address: {
    address1: '4145 Captain Jack ln', address2: '', city: 'Colorado Springs',
    province: 'Colorado', provinceCode: 'Colorado', zip: '80924', countryCode: 'US'
  }
};

const reset = () => {
  calls.oauth = 0; calls.graphql = 0; calls.notes = 0; calls.associations = 0;
  graphqlTokensSeen = [];
  identityRoles = ['admin']; identityOk = true;
  oauthStatus = 200; oauthToken = 'minted-token-1';
  graphqlStatusQueue = []; orderCreateUserErrors = [];
  hubspotShouldFail = false; inventoryQuantity = 34; denyField = null; denyUntilRefresh = false;
  delete process.env.SHOPIFY_ADMIN_TOKEN;
  process.env.SHOPIFY_CLIENT_ID = 'client-id';
  process.env.SHOPIFY_CLIENT_SECRET = 'client-secret';
};

// ═══════════════════════════════════════════
// 1. Client credentials grant
// ═══════════════════════════════════════════
reset();
let mod = await freshModule();
let resp = await mod.default(req('GET'));
let data = await resp.json();

check('GET succeeds using the client credentials grant', () => {
  assert.equal(resp.status, 200);
  assert.equal(data.ok, true);
  assert.equal(data.product.title, 'Pacific Discovery T-Shirt');
});
check('the minted token is sent to the Admin API', () => {
  assert.ok(graphqlTokensSeen.length >= 2);
  assert.ok(graphqlTokensSeen.every((t) => t === 'minted-token-1'), `saw ${JSON.stringify(graphqlTokensSeen)}`);
});
check('the token is minted once and reused across calls in the same request', () => {
  assert.equal(calls.oauth, 1, `exchanged ${calls.oauth} times for ${calls.graphql} GraphQL calls`);
});
check('existing orders are keyed back to the deal id from the tag', () => {
  assert.ok(data.ordersByDeal['101']);
  assert.equal(data.ordersByDeal['101'][0].orderName, '#1042');
  assert.match(data.ordersByDeal['101'][0].adminUrl, /admin\.shopify\.com\/store\/pure-exploration\/orders\/999/);
});

// Second call on the same warm module must not re-exchange.
await mod.default(req('GET'));
check('a warm container reuses the cached token', () => {
  assert.equal(calls.oauth, 1, 'should still be a single exchange after a second request');
});

// ═══════════════════════════════════════════
// 2. Whitespace tolerance + shpat_ precedence
// ═══════════════════════════════════════════
reset();
process.env.SHOPIFY_CLIENT_ID = '  client-id\n';
process.env.SHOPIFY_CLIENT_SECRET = ' client-secret ';
mod = await freshModule();
resp = await mod.default(req('GET'));
check('whitespace pasted into the Netlify env vars is tolerated', () => {
  assert.equal(resp.status, 200);
  assert.equal(calls.oauth, 1);
});

reset();
process.env.SHOPIFY_ADMIN_TOKEN = '  shpat_permanent  ';
mod = await freshModule();
resp = await mod.default(req('GET'));
check('a permanent shpat_ token takes precedence and skips the exchange', () => {
  assert.equal(resp.status, 200);
  assert.equal(calls.oauth, 0, 'must not hit the OAuth endpoint when a fixed token exists');
  assert.ok(graphqlTokensSeen.every((t) => t === 'shpat_permanent'), `saw ${JSON.stringify(graphqlTokensSeen)}`);
});

// ═══════════════════════════════════════════
// 3. Token refresh on 401
// ═══════════════════════════════════════════
reset();
mod = await freshModule();
graphqlStatusQueue = [401];   // first GraphQL call rejects the cached token
oauthToken = 'minted-token-1';
resp = await mod.default(req('GET'));
check('a 401 on a minted token triggers one refresh and retry', () => {
  assert.equal(resp.status, 200, 'the retry should succeed');
  assert.equal(calls.oauth, 2, 'expected exactly one initial mint plus one refresh');
});

reset();
mod = await freshModule();
await mod.default(req('GET'));
check('concurrent cold-start queries share a single token exchange', () => {
  assert.equal(calls.oauth, 1, `GET issues two parallel Shopify queries but minted ${calls.oauth} tokens`);
  assert.ok(calls.graphql >= 2, 'both queries should still have run');
});

// ═══════════════════════════════════════════
// 4. Rejected credentials are actionable
// ═══════════════════════════════════════════
reset();
oauthStatus = 401;
mod = await freshModule();
resp = await mod.default(req('GET'));
data = await resp.json();
check('rejected client credentials explain what to check', () => {
  assert.equal(resp.status, 502);
  assert.match(data.error, /rejected the client credentials/i);
  assert.match(data.error, /INSTALLED/i, 'the app-not-installed case is the most common cause');
});

reset();
delete process.env.SHOPIFY_CLIENT_ID;
delete process.env.SHOPIFY_CLIENT_SECRET;
mod = await freshModule();
resp = await mod.default(req('GET'));
data = await resp.json();
check('missing credentials name both supported styles', () => {
  assert.equal(resp.status, 500);
  assert.match(data.error, /SHOPIFY_CLIENT_ID/);
  assert.match(data.error, /SHOPIFY_ADMIN_TOKEN/);
});

// ═══════════════════════════════════════════
// 5. Caller authorisation
// ═══════════════════════════════════════════
reset();
identityOk = false;
mod = await freshModule();
resp = await mod.default(req('POST', GOOD_ORDER));
data = await resp.json();
check('an unverifiable session cannot order', () => {
  assert.equal(resp.status, 401);
  assert.equal(calls.graphql, 0, 'Shopify must not be touched');
});

reset();
identityRoles = [];
mod = await freshModule();
resp = await mod.default(req('POST', GOOD_ORDER));
check('a user with no dashboard role cannot order', async () => {});
results.pop();
check('a user with no dashboard role cannot order', () => {
  assert.equal(resp.status, 403);
  assert.equal(calls.graphql, 0);
});

reset();
identityRoles = ['outreach'];   // a real role, but not an ordering one
mod = await freshModule();
resp = await mod.default(req('POST', GOOD_ORDER));
data = await resp.json();
check('a role outside SHIRT_ORDER_ROLES cannot order, and is told which are allowed', () => {
  assert.equal(resp.status, 403);
  assert.match(data.error, /admin, operations, programs, admissions/);
  assert.equal(calls.graphql, 0);
});

// ═══════════════════════════════════════════
// 6. Order validation
// ═══════════════════════════════════════════
reset();
mod = await freshModule();
resp = await mod.default(req('POST', Object.assign({}, GOOD_ORDER, { size: 'Enormous' })));
data = await resp.json();
check('an unrecognised size is refused before Shopify is called', () => {
  assert.equal(resp.status, 400);
  assert.match(data.error, /Unrecognised shirt size/);
  assert.equal(calls.graphql, 0);
});

reset();
mod = await freshModule();
resp = await mod.default(req('POST', Object.assign({}, GOOD_ORDER, {
  address: Object.assign({}, GOOD_ORDER.address, { countryCode: 'Freedonia' })
})));
data = await resp.json();
check('an unresolvable country is refused with the offending value quoted', () => {
  assert.equal(resp.status, 400);
  assert.match(data.error, /Freedonia/);
  assert.equal(calls.graphql, 0);
});

reset();
mod = await freshModule();
resp = await mod.default(req('POST', Object.assign({}, GOOD_ORDER, { quantity: 999 })));
data = await resp.json();
check('an absurd quantity is capped', () => {
  assert.equal(resp.status, 400);
  assert.match(data.error, /capped at 20/);
});

reset();
mod = await freshModule();
resp = await mod.default(req('POST', Object.assign({}, GOOD_ORDER, { size: '3XL' })));
data = await resp.json();
check('an out-of-stock size is refused with the real remaining count', () => {
  assert.equal(resp.status, 409);
  assert.match(data.error, /Only 0 of size 3XL/);
});

reset();
inventoryQuantity = 1;
mod = await freshModule();
resp = await mod.default(req('POST', Object.assign({}, GOOD_ORDER, { quantity: 5 })));
data = await resp.json();
check('ordering more than stock on hand is refused', () => {
  assert.equal(resp.status, 409);
  assert.match(data.error, /Only 1 of size L/);
});

// ═══════════════════════════════════════════
// 7. Happy path
// ═══════════════════════════════════════════
reset();
mod = await freshModule();
resp = await mod.default(req('POST', GOOD_ORDER));
data = await resp.json();
check('a valid order is created and reported back with its Shopify identity', () => {
  assert.equal(resp.status, 200);
  assert.equal(data.ok, true);
  assert.equal(data.size, 'L', '"Large" from the application must normalise to the L variant');
  assert.equal(data.order.orderName, '#1043');
  assert.equal(data.order.financialStatus, 'PAID');
  assert.match(data.order.adminUrl, /orders\/1000$/);
  assert.equal(data.warning, null);
});
check('the order is logged as a note associated to the deal', () => {
  assert.equal(calls.notes, 1);
  assert.equal(calls.associations, 1);
});

// ═══════════════════════════════════════════
// 8. Shopify userErrors and HubSpot failure
// ═══════════════════════════════════════════
reset();
orderCreateUserErrors = [{ field: ['shippingAddress', 'zip'], message: 'is not valid' }];
mod = await freshModule();
resp = await mod.default(req('POST', GOOD_ORDER));
data = await resp.json();
check('a Shopify userError is surfaced with its field path', () => {
  assert.equal(resp.status, 422);
  assert.match(data.error, /shippingAddress\.zip: is not valid/);
  assert.equal(calls.notes, 0, 'nothing to log when nothing was created');
});

reset();
hubspotShouldFail = true;
mod = await freshModule();
resp = await mod.default(req('POST', GOOD_ORDER));
data = await resp.json();
check('a HubSpot note failure is a warning, never a failed order', () => {
  assert.equal(resp.status, 200, 'the shirt is already ordered — reporting failure would cause a double-order');
  assert.equal(data.ok, true);
  assert.equal(data.order.orderName, '#1043');
  assert.match(data.warning, /logging it to HubSpot failed/);
});

// ═══════════════════════════════════════════
// 8b. Missing scopes degrade, they don't break
// ═══════════════════════════════════════════
reset();
denyField = 'orders';
mod = await freshModule();
resp = await mod.default(req('GET'));
data = await resp.json();
check('a missing read_orders still returns the product so ordering works', () => {
  assert.equal(resp.status, 200, 'the optional half must not fail the endpoint');
  assert.equal(data.ok, true);
  assert.equal(data.product.title, 'Pacific Discovery T-Shirt');
  assert.deepEqual(data.ordersByDeal, {}, 'no badge data, but no crash');
});
check('the missing scope is named, not just the denied field', () => {
  assert.match(data.ordersWarning, /read_orders/);
  assert.match(data.ordersWarning, /Ordering still works/);
});

// Ordering itself must still succeed with read_orders absent.
reset();
denyField = 'orders';
mod = await freshModule();
resp = await mod.default(req('POST', GOOD_ORDER));
data = await resp.json();
check('an order can still be placed without read_orders', () => {
  assert.equal(resp.status, 200);
  assert.equal(data.order.orderName, '#1043');
});

// A denied product read IS fatal — nothing can be ordered without variants.
reset();
denyField = 'product';
mod = await freshModule();
resp = await mod.default(req('GET'));
data = await resp.json();
check('a denied product read fails loudly and names read_products', () => {
  assert.equal(resp.status, 502);
  assert.match(data.error, /read_products/);
  assert.match(data.error, /Dev Dashboard/);
});

// A newly granted scope must not require waiting out the 24h token cache.
reset();
denyUntilRefresh = true;
mod = await freshModule();
resp = await mod.default(req('GET'));
data = await resp.json();
check('access-denied on a cached token triggers a re-mint, not a day of waiting', () => {
  assert.equal(resp.status, 200);
  assert.ok(calls.oauth >= 2, `expected a refresh mint, saw ${calls.oauth} exchange(s)`);
  assert.equal(data.ordersWarning, null, 'the retry should have succeeded, leaving no warning');
  assert.ok(data.ordersByDeal['101'], 'orders should be readable after the re-mint');
});

// ═══════════════════════════════════════════
// 9. Method handling
// ═══════════════════════════════════════════
reset();
mod = await freshModule();
const opts = await mod.default(new Request('https://dash.example.invalid/api/shirt-orders', { method: 'OPTIONS' }));
check('CORS preflight is answered without requiring auth', () => {
  assert.equal(opts.status, 204);
  assert.equal(opts.headers.get('Access-Control-Allow-Origin'), '*');
});

resp = await mod.default(req('DELETE'));
check('unsupported methods are rejected', () => assert.equal(resp.status, 405));

check('the endpoint is mounted at /api/shirt-orders', () => {
  assert.equal(mod.config.path, '/api/shirt-orders');
});

// ═══════════════════════════════════════════
// REPORT
// ═══════════════════════════════════════════
let failed = 0;
for (const [status, name] of results) {
  if (status === 'FAIL') failed++;
  console.log(`  ${status} ${name}`);
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);

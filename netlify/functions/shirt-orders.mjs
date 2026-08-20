/**
 * Netlify serverless function — T-shirt ordering for the Enrollment dashboard.
 *
 *   GET  /api/shirt-orders   → the shirt product's live variants + every shirt
 *                              order already placed, keyed by HubSpot deal id.
 *                              Drives the "Ordered" badge and the stock hints
 *                              in the size dropdown.
 *   POST /api/shirt-orders   → create a real, paid order in the Pure Exploration
 *                              Shopify store for one student, then log a note on
 *                              their HubSpot deal.
 *
 * ------------------------------------------------------------------------
 * AUTHORISATION — read this before changing anything
 * ------------------------------------------------------------------------
 * This endpoint spends money and ships physical goods. It lives under `/api/*`,
 * which the site's `Role=` redirects do NOT cover and which `auth-gate.js`
 * explicitly excludes, so the check in this file is the only thing standing in
 * front of it.
 *
 * It therefore VERIFIES the Netlify Identity token against GoTrue rather than
 * merely decoding it — the same reasoning as jotform-file.mjs. Decoding alone is
 * safe at the edge only because Netlify's CDN has already signature-checked
 * `nf_jwt` before auth-gate runs; there is no such rule in front of this
 * function, so an unverified decode would let anyone forge
 * `Cookie: nf_jwt=<header>.<base64 {"app_metadata":{"roles":["admin"]}}>.<junk>`
 * and post orders to the store.
 *
 * NOTE: `context.clientContext` is NOT available to v2 (default-export)
 * functions. Don't reintroduce it; it is silently undefined.
 *
 * ------------------------------------------------------------------------
 * ENVIRONMENT
 * ------------------------------------------------------------------------
 *   Shopify credentials — set ONE of these two styles:
 *     SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET
 *                             from a Dev Dashboard app (Settings → Credentials).
 *                             Exchanged for a 24h token via the client
 *                             credentials grant; refreshed automatically.
 *     SHOPIFY_ADMIN_TOKEN     a permanent shpat_… token from a custom app
 *                             created inside the store admin. Takes precedence.
 *   Either way the app must be installed on the store and configured with
 *   write_orders, read_orders, read_products and write_customers.
 *
 *   SHOPIFY_STORE_DOMAIN      optional. Default pure-exploration.myshopify.com
 *   SHOPIFY_API_VERSION       optional. Default 2026-04
 *   SHOPIFY_TSHIRT_PRODUCT_ID optional. Default is the Pacific Discovery T-Shirt
 *   SHIRT_ORDER_ROLES         optional. Comma-separated roles allowed to order.
 *                             Default: admin,operations,programs,admissions
 *   HUBSPOT_TOKEN             required for the deal note (order still succeeds
 *                             if the note fails — see below).
 */

import shirt from './_shared/shirt.js';

// ═══════════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════════
const SHOPIFY_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN || 'pure-exploration.myshopify.com';
const SHOPIFY_VERSION = process.env.SHOPIFY_API_VERSION || '2026-04';
const TSHIRT_PRODUCT_ID = process.env.SHOPIFY_TSHIRT_PRODUCT_ID || 'gid://shopify/Product/9345666973947';
const HUBSPOT_BASE = 'https://api.hubapi.com';

// Every shirt order carries this tag, which is how GET finds them again.
const SHIRT_TAG = 'pd-shirt';
// Plus a per-deal tag, so one Shopify query can be fanned back out to rows.
const dealTag = (dealId) => `pd-deal-${dealId}`;

const DEFAULT_ORDER_ROLES = ['admin', 'operations', 'programs', 'admissions'];

const MAX_QUANTITY = 20;

// ═══════════════════════════════════════════
// RESPONSE HELPERS
// ═══════════════════════════════════════════
const JSON_HEADERS = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
  'Access-Control-Allow-Origin': '*'
};

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });

// ═══════════════════════════════════════════
// AUTH — verified, not decoded. See the header comment.
// ═══════════════════════════════════════════
const AUTH_CACHE_MS = 5 * 60 * 1000;
const _authCache = new Map(); // token -> { ts, user }

function bearerFrom(req) {
  const auth = req.headers.get('authorization') || '';
  const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
  if (m) return m[1].trim();
  const cookie = req.headers.get('cookie') || '';
  const c = cookie.match(/(?:^|;\s*)nf_jwt=([^;]+)/);
  return c ? decodeURIComponent(c[1]) : null;
}

/**
 * Verify the caller's Identity token with GoTrue.
 * Returns null when there is no usable session, otherwise
 * { roles: string[], email: string, name: string }.
 */
async function verifiedUser(req) {
  const token = bearerFrom(req);
  if (!token) return null;

  const hit = _authCache.get(token);
  if (hit && Date.now() - hit.ts < AUTH_CACHE_MS) return hit.user;

  const siteUrl = (process.env.URL || process.env.DEPLOY_PRIME_URL || '').replace(/\/+$/, '');
  if (!siteUrl) {
    console.error('[shirt-orders] URL env var missing — cannot verify Identity token');
    return null;
  }

  let res;
  try {
    res = await fetch(`${siteUrl}/.netlify/identity/user`, {
      headers: { Authorization: `Bearer ${token}` }
    });
  } catch (e) {
    console.error('[shirt-orders] Identity verification request failed:', e.message);
    return null;
  }
  if (!res.ok) return null; // expired, revoked or forged

  let raw;
  try { raw = await res.json(); } catch { return null; }

  const user = {
    roles: (raw && raw.app_metadata && raw.app_metadata.roles) || [],
    email: (raw && raw.email) || '',
    name: (raw && raw.user_metadata && raw.user_metadata.full_name) || ''
  };

  if (_authCache.size > 500) {
    const now = Date.now();
    for (const [k, v] of _authCache) if (now - v.ts >= AUTH_CACHE_MS) _authCache.delete(k);
  }
  _authCache.set(token, { ts: Date.now(), user });
  return user;
}

function orderRoles() {
  const raw = process.env.SHIRT_ORDER_ROLES;
  if (!raw) return DEFAULT_ORDER_ROLES;
  const list = raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  return list.length ? list : DEFAULT_ORDER_ROLES;
}

// ═══════════════════════════════════════════
// SHOPIFY AUTHENTICATION
// ═══════════════════════════════════════════
// Two supported credential styles, because Shopify offers two and which one you
// have depends on where the app was created:
//
//   1. CLIENT CREDENTIALS GRANT (SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET).
//      What you get from an app created in the Shopify Dev Dashboard — its
//      Settings → Credentials page shows a Client ID and a Secret and no
//      permanent token. We exchange them for a 24-hour access token at
//      POST https://{shop}/admin/oauth/access_token and cache it in the warm
//      container. Shopify restricts this grant to apps developed by your own
//      organisation and installed in stores you own, which is exactly this case.
//
//   2. A PERMANENT ADMIN API TOKEN (SHOPIFY_ADMIN_TOKEN, starts with shpat_).
//      What you get from a custom app created inside the store admin. Simpler,
//      never expires, so if it is set we use it and skip the exchange.
//
// Either way the app must be INSTALLED on the store, and the scopes come from
// the app's configuration — not from the token request.
const SHOPIFY_OAUTH_TOKEN_URL = `https://${SHOPIFY_DOMAIN}/admin/oauth/access_token`;

// Minted tokens live 24h. Refresh 5 minutes early so a request never sets off
// with a token that expires mid-flight.
const TOKEN_SKEW_MS = 5 * 60 * 1000;
let _tokenCache = null;   // { token, expiresAt }
// The scope list Shopify returns with the token — i.e. what the INSTALL actually
// granted, which is not necessarily what the app version declares. The gap
// between those two is the single most confusing failure in this integration, so
// keep it to hand and report it.
let _grantedScopes = '';
// GET fires two Shopify queries concurrently, and on a cold container both
// would race to mint their own token — two OAuth round trips for one request,
// and needless load on an endpoint Shopify rate-limits. Concurrent callers
// share the in-flight exchange instead.
let _tokenInFlight = null; // Promise<string> | null

const envTrimmed = (name) => String(process.env[name] || '').trim();

async function accessToken(forceRefresh) {
  if (!forceRefresh && _tokenInFlight) return _tokenInFlight;
  if (forceRefresh) _tokenInFlight = null;
  const p = mintAccessToken(forceRefresh);
  // Only share a pending exchange, never a settled/rejected one.
  _tokenInFlight = p;
  try {
    return await p;
  } finally {
    if (_tokenInFlight === p) _tokenInFlight = null;
  }
}

async function mintAccessToken(forceRefresh) {
  // Style 2 — a permanent token wins if present.
  const direct = envTrimmed('SHOPIFY_ADMIN_TOKEN');
  if (direct) return direct;

  // Style 1 — client credentials grant.
  const clientId = envTrimmed('SHOPIFY_CLIENT_ID');
  const clientSecret = envTrimmed('SHOPIFY_CLIENT_SECRET');
  if (!clientId || !clientSecret) {
    const err = new Error(
      'No Shopify credentials are set in Netlify. Set either SHOPIFY_CLIENT_ID + ' +
      'SHOPIFY_CLIENT_SECRET (from your Dev Dashboard app: Settings → Credentials), ' +
      'or SHOPIFY_ADMIN_TOKEN (a store-admin custom app token starting with shpat_).'
    );
    err.status = 500;
    throw err;
  }

  if (!forceRefresh && _tokenCache && Date.now() < _tokenCache.expiresAt) {
    return _tokenCache.token;
  }

  const resp = await fetch(SHOPIFY_OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret
    }).toString()
  });

  const body = await resp.text();
  if (!resp.ok) {
    console.error(`[shirt-orders] token exchange failed ${resp.status} on ${SHOPIFY_DOMAIN}: ${body.slice(0, 300)}`);
    const err = new Error(
      resp.status === 401 || resp.status === 400
        ? `Shopify rejected the client credentials for ${SHOPIFY_DOMAIN}. Check that ` +
          'SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET match the Dev Dashboard app exactly ' +
          '(the Secret is only shown in full once — rotate it and re-copy if unsure), and ' +
          'that the app is INSTALLED on this store. The client credentials grant only works ' +
          'for apps your own organisation developed, installed in a store you own.'
        : `Shopify returned HTTP ${resp.status} when exchanging client credentials for an access token.`
    );
    err.status = 502;
    err.detail = body.slice(0, 300);
    throw err;
  }

  let parsed;
  try { parsed = JSON.parse(body); }
  catch {
    const err = new Error('Shopify returned a non-JSON response to the token request');
    err.status = 502;
    throw err;
  }

  if (!parsed.access_token) {
    const err = new Error('Shopify\'s token response contained no access_token');
    err.status = 502;
    err.detail = body.slice(0, 300);
    throw err;
  }

  _grantedScopes = String(parsed.scope || '');
  const ttlMs = (Number(parsed.expires_in) || 86399) * 1000;
  _tokenCache = { token: parsed.access_token, expiresAt: Date.now() + Math.max(ttlMs - TOKEN_SKEW_MS, 30_000) };
  console.log(`[shirt-orders] minted a Shopify access token (scopes: ${parsed.scope || 'unknown'}, ttl ${Math.round(ttlMs / 1000)}s)`);
  return _tokenCache.token;
}

/** True when tokens are minted rather than fixed, so a 401 is worth one retry. */
const usingClientCredentials = () => !envTrimmed('SHOPIFY_ADMIN_TOKEN');

// Which access scope each field we query depends on. Used to turn Shopify's
// "Access denied for orders field" into something you can act on.
const SCOPE_FOR_FIELD = {
  orders: 'read_orders',
  order: 'read_orders',
  ordercreate: 'write_orders',
  product: 'read_products',
  products: 'read_products',
  customer: 'write_customers',
  customers: 'write_customers'
};

function scopeAdviceFor(field, rawMessage) {
  const scope = SCOPE_FOR_FIELD[String(field).toLowerCase()];
  if (!scope) return rawMessage;

  const granted = _grantedScopes
    ? _grantedScopes.split(',').map((x) => x.trim()).filter(Boolean)
    : [];
  const hasIt = granted.includes(scope);
  const grantedNote = granted.length
    ? ` The access token currently grants: ${granted.join(', ')}.`
    : '';

  // Two very different situations, and telling them apart saves a lot of time.
  if (hasIt) {
    // Declared, granted, still refused — not a scope-list problem.
    return `Shopify denied access to "${field}" even though the token grants ${scope}.` +
      grantedNote +
      ' That usually means the data is gated behind protected-customer-data approval ' +
      'for this app, rather than a missing scope.';
  }
  return `Shopify denied access to "${field}" — the ${scope} scope is not granted to ` +
    'this installation.' + grantedNote +
    ' If the scope IS listed on your released app version, the install itself is still ' +
    'on the old scope set: re-install the app on the store (Dev Dashboard → Home → ' +
    'Install app) to trigger the approval prompt for the new scopes. Releasing a ' +
    'version does not re-grant scopes on its own.';
}

// ═══════════════════════════════════════════
// SHOPIFY ADMIN GRAPHQL
// ═══════════════════════════════════════════
/** Does this 200 response carry a missing-scope error? */
function isAccessDenied(resp) {
  if (resp.status !== 200) return false;
  if (!/access denied/i.test(resp.text)) return false;
  try {
    const body = JSON.parse(resp.text);
    return Boolean(body.errors && body.errors.some((e) => /access denied/i.test(e.message || '')));
  } catch {
    return false;
  }
}

async function shopify(query, variables) {
  let resp = await shopifyOnce(query, variables, false);

  // A cached token can be invalidated early by a secret rotation or an app
  // reinstall. That reads as a 401, so mint a fresh one and try once more
  // before surfacing an error to the user.
  if (resp.status === 401 && usingClientCredentials()) {
    console.warn('[shirt-orders] 401 with a minted token — refreshing and retrying once');
    resp = await shopifyOnce(query, variables, true);
    return handleShopifyResponse(resp);
  }

  // Scopes are baked into the token at the moment it is minted, and a token
  // lives 24 hours. So after you add a scope in the Dev Dashboard and approve
  // it on the store, a token cached from BEFORE that change still lacks the new
  // scope — and Shopify reports that as an access-denied error inside a 200, not
  // a 401, so the refresh-on-401 path above never fires. The result would be a
  // "missing scope" message persisting for up to a day after the scope was
  // actually granted, with nothing the user could do but wait or redeploy.
  // Treat access-denied as a signal that the token may be stale: mint once more
  // and retry. If it is genuinely missing, the second answer says so too.
  if (usingClientCredentials() && isAccessDenied(resp)) {
    console.warn('[shirt-orders] access denied on a cached token — the app scopes may have changed since it was minted; refreshing and retrying once');
    _tokenCache = null;
    resp = await shopifyOnce(query, variables, true);
  }

  return handleShopifyResponse(resp);
}

async function shopifyOnce(query, variables, forceRefresh) {
  const token = await accessToken(forceRefresh);
  const resp = await fetch(`https://${SHOPIFY_DOMAIN}/admin/api/${SHOPIFY_VERSION}/graphql.json`, {
    method: 'POST',
    headers: {
      'X-Shopify-Access-Token': token,
      'Content-Type': 'application/json',
      Accept: 'application/json'
    },
    body: JSON.stringify({ query, variables: variables || {} })
  });
  return { status: resp.status, ok: resp.ok, text: await resp.text() };
}

function handleShopifyResponse(resp) {
  const text = resp.text;
  if (!resp.ok) {
    console.error(`[shirt-orders] Shopify HTTP ${resp.status} on ${SHOPIFY_DOMAIN} (api ${SHOPIFY_VERSION}): ${text.slice(0, 500)}`);

    // Shopify's own bodies for these are unhelpful ("[API] Invalid API key or
    // access token"), and the fix differs per status, so say which one it is.
    let msg;
    if (resp.status === 401) {
      msg = usingClientCredentials()
        ? `Shopify rejected the minted access token for ${SHOPIFY_DOMAIN}, even after a refresh. ` +
          'Confirm the Dev Dashboard app is installed on this store and that its ' +
          'SHOPIFY_CLIENT_ID / SHOPIFY_CLIENT_SECRET are current.'
        : `Shopify rejected SHOPIFY_ADMIN_TOKEN for ${SHOPIFY_DOMAIN}. It must be a ` +
          'store-admin custom app\'s "Admin API access token" (starts with shpat_), not ' +
          'an API key or secret. If your app came from the Dev Dashboard there is no such ' +
          'token — unset SHOPIFY_ADMIN_TOKEN and set SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET instead.';
    } else if (resp.status === 403) {
      msg = 'Shopify accepted the credentials but refused the request — the app is ' +
        'missing a scope. It needs write_orders, read_orders, read_products and ' +
        'write_customers. Scopes come from the app\'s configuration, so update them ' +
        'there and release a new app version, then retry.';
    } else if (resp.status === 404) {
      msg = `No Shopify Admin API at ${SHOPIFY_DOMAIN} (api version ${SHOPIFY_VERSION}). ` +
        'SHOPIFY_STORE_DOMAIN must be the myshopify.com domain, not the ' +
        'customer-facing domain, and SHOPIFY_API_VERSION must still be supported.';
    } else if (resp.status === 429) {
      msg = 'Shopify rate-limited the dashboard. Wait a moment and try again — nothing was created.';
    } else {
      msg = `Shopify returned HTTP ${resp.status}. Nothing was created.`;
    }

    const err = new Error(msg);
    err.status = 502;
    err.detail = text.slice(0, 500);
    throw err;
  }

  let body;
  try { body = JSON.parse(text); }
  catch {
    const err = new Error('Shopify returned a non-JSON response');
    err.status = 502;
    err.detail = text.slice(0, 300);
    throw err;
  }

  // GraphQL transport-level errors (bad field, throttled, missing scope).
  if (body.errors && body.errors.length) {
    const msg = body.errors.map((e) => e.message).join('; ');
    console.error(`[shirt-orders] Shopify GraphQL errors: ${msg}`);

    // Shopify reports a missing scope as "Access denied for <field> field",
    // which names the field but not the scope you have to add. Translate it,
    // because the fix is a specific checkbox in a specific place.
    const denied = /access denied for (\w+) field/i.exec(msg);
    const err = new Error(denied ? scopeAdviceFor(denied[1], msg) : msg);
    err.status = 502;
    err.missingScope = denied ? SCOPE_FOR_FIELD[denied[1].toLowerCase()] || null : null;
    throw err;
  }

  return body.data;
}

/** admin.shopify.com deep link for an order, derived from the store handle. */
function adminOrderUrl(orderGid) {
  const numeric = String(orderGid || '').split('/').pop();
  const handle = SHOPIFY_DOMAIN.replace(/\.myshopify\.com$/i, '');
  return numeric ? `https://admin.shopify.com/store/${handle}/orders/${numeric}` : '';
}

// The variant list changes rarely; cache it per warm container.
const PRODUCT_CACHE_MS = 5 * 60 * 1000;
let _productCache = null; // { at, product }

const PRODUCT_QUERY = `
  query ShirtProduct($id: ID!) {
    product(id: $id) {
      id
      title
      featuredMedia { preview { image { url } } }
      variants(first: 50) {
        nodes {
          id
          title
          sku
          price
          inventoryQuantity
          availableForSale
        }
      }
    }
  }
`;

async function fetchShirtProduct(force) {
  const now = Date.now();
  if (!force && _productCache && now - _productCache.at < PRODUCT_CACHE_MS) {
    return _productCache.product;
  }
  const data = await shopify(PRODUCT_QUERY, { id: TSHIRT_PRODUCT_ID });
  const p = data && data.product;
  if (!p) {
    const err = new Error(`Shirt product ${TSHIRT_PRODUCT_ID} not found in Shopify`);
    err.status = 500;
    throw err;
  }

  // Map each Shopify variant onto a normalised size code so the dashboard's
  // size dropdown and the incoming POST speak the same language.
  const variants = (p.variants && p.variants.nodes ? p.variants.nodes : []).map((v) => ({
    id: v.id,
    title: v.title,
    size: shirt.normalizeShirtSize(v.title) || v.title,
    sku: v.sku || '',
    price: v.price || '',
    inventoryQuantity: typeof v.inventoryQuantity === 'number' ? v.inventoryQuantity : null,
    availableForSale: Boolean(v.availableForSale)
  }));

  const product = {
    id: p.id,
    title: p.title,
    imageUrl: (p.featuredMedia && p.featuredMedia.preview && p.featuredMedia.preview.image && p.featuredMedia.preview.image.url) || '',
    variants
  };

  _productCache = { at: now, product };
  return product;
}

const ORDERS_QUERY = `
  query ShirtOrders($cursor: String) {
    orders(first: 100, after: $cursor, query: "tag:'${SHIRT_TAG}'", sortKey: CREATED_AT, reverse: true) {
      nodes {
        id
        name
        createdAt
        tags
        displayFulfillmentStatus
        displayFinancialStatus
        lineItems(first: 5) {
          nodes { quantity title variantTitle }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

/**
 * Every shirt order ever placed through this dashboard, grouped by deal id.
 * Read from Shopify rather than tracked locally so the badge tells the truth
 * even if someone cancels or edits an order in the Shopify admin.
 */
async function fetchOrdersByDeal() {
  const byDeal = {};
  let cursor = null;
  let pages = 0;

  // 100 per page, hard stop at 20 pages (2,000 orders). If we ever exceed that,
  // the loop stops and logs rather than silently truncating — see the warning.
  while (pages < 20) {
    const data = await shopify(ORDERS_QUERY, { cursor });
    const conn = (data && data.orders) || {};
    for (const o of (conn.nodes || [])) {
      const tags = o.tags || [];
      const dealTags = tags.filter((t) => /^pd-deal-/.test(t));
      if (!dealTags.length) continue;
      const items = (o.lineItems && o.lineItems.nodes ? o.lineItems.nodes : []).map((li) => ({
        quantity: li.quantity,
        size: li.variantTitle || '',
        title: li.title || ''
      }));
      const record = {
        orderId: o.id,
        orderName: o.name,
        createdAt: o.createdAt,
        adminUrl: adminOrderUrl(o.id),
        fulfillmentStatus: o.displayFulfillmentStatus || '',
        financialStatus: o.displayFinancialStatus || '',
        items
      };
      for (const t of dealTags) {
        const dealId = t.replace(/^pd-deal-/, '');
        if (!dealId) continue;
        if (!byDeal[dealId]) byDeal[dealId] = [];
        byDeal[dealId].push(record);
      }
    }
    pages++;
    if (!conn.pageInfo || !conn.pageInfo.hasNextPage) return byDeal;
    cursor = conn.pageInfo.endCursor;
  }

  console.warn('[shirt-orders] hit the 20-page order scan cap — older shirt orders were not read, so some rows may show as un-ordered');
  return byDeal;
}

const ORDER_CREATE = `
  mutation CreateShirtOrder($order: OrderCreateOrderInput!, $options: OrderCreateOptionsInput) {
    orderCreate(order: $order, options: $options) {
      userErrors { field message }
      order {
        id
        name
        createdAt
        displayFinancialStatus
        displayFulfillmentStatus
        totalPriceSet { shopMoney { amount currencyCode } }
      }
    }
  }
`;

// ═══════════════════════════════════════════
// HUBSPOT — audit note on the deal
// ═══════════════════════════════════════════
async function hubspot(path, init) {
  const token = process.env.HUBSPOT_TOKEN;
  if (!token) throw new Error('HUBSPOT_TOKEN env var is missing');
  const res = await fetch(`${HUBSPOT_BASE}${path}`, {
    ...(init || {}),
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...((init && init.headers) || {})
    }
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`HubSpot ${res.status} on ${path}: ${body.slice(0, 300)}`);
  }
  // The association PUT returns 204 with no body.
  const text = await res.text();
  return text ? JSON.parse(text) : {};
}

function escapeHtml(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * Log the order on the deal so there is an audit trail in HubSpot: what was
 * ordered, where it shipped, who clicked the button, and a link to the Shopify
 * order. Best-effort — the shirt is already ordered by the time this runs, so a
 * HubSpot failure must not be reported to the user as an order failure.
 */
async function logDealNote({ dealId, studentName, size, quantity, address, order, actor }) {
  const lines = [
    '<strong>T-shirt ordered</strong> via the Student Enrollment dashboard',
    `Student: ${escapeHtml(studentName || '—')}`,
    `Size: ${escapeHtml(size)} &nbsp;·&nbsp; Quantity: ${escapeHtml(String(quantity))}`,
    `Shopify order: <a href="${escapeHtml(adminOrderUrl(order.id))}">${escapeHtml(order.name)}</a>`,
    `Ships to: ${escapeHtml(shirt.formatAddressLine(address)) || '—'}`,
    `Ordered by: ${escapeHtml(actor || 'unknown')}`
  ];
  const note = await hubspot('/crm/v3/objects/notes', {
    method: 'POST',
    body: JSON.stringify({
      properties: {
        hs_timestamp: String(Date.now()),
        hs_note_body: lines.join('<br>')
      }
    })
  });
  // Default association type for note→deal (214). Using /associations/default
  // lets HubSpot pick it rather than hard-coding the numeric id.
  await hubspot(`/crm/v4/objects/notes/${note.id}/associations/default/deals/${encodeURIComponent(dealId)}`, {
    method: 'PUT'
  });
  return note.id;
}

// ═══════════════════════════════════════════
// HANDLER
// ═══════════════════════════════════════════
export default async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization'
      }
    });
  }

  const user = await verifiedUser(req);
  if (user === null) return json(401, { error: 'Sign in required, or your session expired — reload the dashboard.' });
  if (!user.roles.length) return json(403, { error: 'Your account has no dashboard role.' });

  if (req.method === 'GET') return handleGet();
  if (req.method === 'POST') return handlePost(req, user);
  return json(405, { error: 'GET or POST only' });
};

async function handleGet() {
  // The two queries are independent and only one of them is load-bearing.
  // Reading the product is what makes ordering possible at all; reading past
  // orders only powers the "Ordered" badge. They also need different scopes, so
  // treat them separately — a store that has granted write_orders/read_products
  // but not read_orders should still be able to order shirts, just without
  // duplicate detection. Failing the whole endpoint over the optional half is
  // what turned a missing scope into "the feature is broken".
  const [productResult, ordersResult] = await Promise.allSettled([
    fetchShirtProduct(false),
    fetchOrdersByDeal()
  ]);

  if (productResult.status === 'rejected') {
    const err = productResult.reason || {};
    console.error(`[shirt-orders] GET failed — cannot read the product: ${err.message}`);
    return json(err.status || 500, { error: err.message, detail: err.detail || null });
  }

  let ordersByDeal = {};
  let ordersWarning = null;
  if (ordersResult.status === 'fulfilled') {
    ordersByDeal = ordersResult.value;
  } else {
    const err = ordersResult.reason || {};
    console.error(`[shirt-orders] existing orders unavailable: ${err.message}`);
    ordersWarning = err.missingScope
      ? `Can't check which students already have a shirt — the app is missing the ${err.missingScope} scope. ` +
        'Ordering still works, but the "Ordered" badge is hidden and duplicates are not detected.'
      : `Can't check which students already have a shirt: ${err.message} ` +
        'Ordering still works, but duplicates are not detected.';
  }

  return json(200, { ok: true, product: productResult.value, ordersByDeal, ordersWarning });
}

async function handlePost(req, user) {
  const allowed = orderRoles();
  if (!user.roles.some((r) => allowed.includes(String(r).toLowerCase()))) {
    return json(403, {
      error: `Ordering shirts requires one of these roles: ${allowed.join(', ')}. Yours: ${user.roles.join(', ') || 'none'}.`
    });
  }

  let body;
  try { body = await req.json(); }
  catch { return json(400, { error: 'Invalid JSON body' }); }

  const dealId = String(body.dealId || '').trim();
  const studentName = String(body.studentName || '').trim();
  const email = String(body.email || '').trim();
  const size = shirt.normalizeShirtSize(body.size);
  const quantity = Number.parseInt(body.quantity, 10);

  if (!dealId) return json(400, { error: 'dealId is required' });
  if (!/^\d+$/.test(dealId)) return json(400, { error: 'dealId must be a HubSpot record id' });
  if (!size) return json(400, { error: `Unrecognised shirt size: ${JSON.stringify(body.size)}` });
  if (!Number.isFinite(quantity) || quantity < 1) return json(400, { error: 'quantity must be 1 or more' });
  if (quantity > MAX_QUANTITY) return json(400, { error: `quantity is capped at ${MAX_QUANTITY} per order` });

  // Validate the address before touching Shopify so a bad address produces a
  // clear message rather than an opaque GraphQL userError.
  const addr = body.address || {};
  const shipping = shirt.toShopifyAddress(addr, studentName);
  if (!shipping.address1) return json(400, { error: 'Street address is required' });
  if (!shipping.city) return json(400, { error: 'City is required' });
  if (!shipping.countryCode) {
    return json(400, { error: `Country "${addr.country || addr.countryCode || ''}" could not be matched to a shipping country — pick one from the list.` });
  }
  if (!shirt.addressIsShippable({
    address1: shipping.address1,
    city: shipping.city,
    provinceCode: shipping.provinceCode,
    countryCode: shipping.countryCode
  })) {
    return json(400, { error: `A state/province is required for ${shipping.countryCode} — use its code, e.g. NY or CA.` });
  }

  try {
    // Resolve the variant for this size, forcing a fresh read so the stock check
    // reflects reality rather than a five-minute-old cache.
    const product = await fetchShirtProduct(true);
    const variant = product.variants.find((v) => v.size === size);
    if (!variant) {
      return json(400, {
        error: `${product.title} has no "${size}" variant. Available: ${product.variants.map((v) => v.size).join(', ')}.`
      });
    }
    if (variant.inventoryQuantity !== null && variant.inventoryQuantity < quantity) {
      return json(409, {
        error: `Only ${variant.inventoryQuantity} of size ${size} left in stock (you asked for ${quantity}). Restock in Shopify, or order a different size.`
      });
    }

    const nameBits = studentName.split(/\s+/).filter(Boolean);
    const orderInput = {
      lineItems: [{
        variantId: variant.id,
        quantity,
        // MUST be set explicitly. orderCreate is an order-INGESTION mutation —
        // it takes the line item's attributes as given rather than deriving them
        // from the variant, so an unspecified requiresShipping lands as false
        // even though every shirt variant has requiresShipping: true. The result
        // is an order Shopify considers to need no shipping: it skips the
        // fulfillment/shipping workflow, so no label gets bought and the box
        // never goes out. These are physical shirts; say so.
        requiresShipping: true
      }],
      shippingAddress: shipping,
      // Marked paid on purpose: these shirts are included in the program fee,
      // so the order should land in fulfilment without an amount owing.
      financialStatus: 'PAID',
      tags: [SHIRT_TAG, dealTag(dealId)],
      note: `Pacific Discovery program shirt for ${studentName || 'student'} — ordered from the Student Enrollment dashboard by ${user.email || 'unknown'}.`,
      // customAttributes surface on the order in the Shopify admin, so whoever
      // packs the box can see who it is for without opening HubSpot.
      customAttributes: [
        { key: 'PD Student', value: studentName || '—' },
        { key: 'PD Deal ID', value: dealId },
        { key: 'Ordered by', value: user.email || 'unknown' }
      ]
    };
    if (email) {
      orderInput.email = email;
      orderInput.customer = {
        toUpsert: {
          email,
          firstName: nameBits[0] || '',
          lastName: nameBits.slice(1).join(' ') || ''
        }
      };
      orderInput.buyerAcceptsMarketing = false;
    }

    const options = {
      // Off by default: the student did not buy this, so a receipt would confuse
      // them. The dashboard exposes a checkbox for the rare case you want one.
      sendReceipt: Boolean(body.sendReceipt),
      sendFulfillmentReceipt: false,
      // Obey the product's inventory policy so we cannot oversell a size.
      inventoryBehaviour: 'DECREMENT_OBEYING_POLICY'
    };

    const data = await shopify(ORDER_CREATE, { order: orderInput, options });
    const result = (data && data.orderCreate) || {};

    if (result.userErrors && result.userErrors.length) {
      const msg = result.userErrors
        .map((e) => `${(e.field || []).join('.') || 'order'}: ${e.message}`)
        .join('; ');
      console.error(`[shirt-orders] orderCreate userErrors for deal ${dealId}: ${msg}`);
      return json(422, { error: `Shopify rejected the order — ${msg}` });
    }
    if (!result.order) {
      return json(502, { error: 'Shopify did not return an order. Nothing was created.' });
    }

    const order = result.order;
    console.log(`[shirt-orders] created ${order.name} for deal ${dealId} (${size} ×${quantity}) by ${user.email}`);

    // Audit note. Deliberately after the order and deliberately non-fatal: the
    // shirt is already on its way, so a HubSpot hiccup is a warning, not a
    // failure the user should read as "try again" (which would double-order).
    let noteWarning = null;
    try {
      await logDealNote({
        dealId,
        studentName,
        size,
        quantity,
        address: Object.assign({}, addr, { countryCode: shipping.countryCode, provinceCode: shipping.provinceCode }),
        order,
        actor: user.email || user.name
      });
    } catch (err) {
      console.error(`[shirt-orders] note failed for deal ${dealId}: ${err.message}`);
      noteWarning = `The order was created (${order.name}) but logging it to HubSpot failed: ${err.message}`;
    }

    // The order list cache lives in Shopify, but our product cache now holds
    // stale inventory. Drop it so the next dropdown shows the new numbers.
    _productCache = null;

    return json(200, {
      ok: true,
      dealId,
      size,
      quantity,
      order: {
        orderId: order.id,
        orderName: order.name,
        createdAt: order.createdAt,
        adminUrl: adminOrderUrl(order.id),
        financialStatus: order.displayFinancialStatus || '',
        fulfillmentStatus: order.displayFulfillmentStatus || '',
        total: (order.totalPriceSet && order.totalPriceSet.shopMoney)
          ? `${order.totalPriceSet.shopMoney.amount} ${order.totalPriceSet.shopMoney.currencyCode}`
          : ''
      },
      shippedTo: shirt.formatAddressLine(Object.assign({}, addr, { countryCode: shipping.countryCode })),
      warning: noteWarning
    });
  } catch (err) {
    console.error(`[shirt-orders] POST failed for deal ${dealId}: ${err.message}`);
    return json(err.status || 500, { error: err.message, detail: err.detail || null });
  }
}

export const config = { path: '/api/shirt-orders' };

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
 *   SHOPIFY_ADMIN_TOKEN       required. Admin API access token (shpat_…) for a
 *                             custom app with write_orders, read_orders,
 *                             read_products and write_customers.
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
// SHOPIFY ADMIN GRAPHQL
// ═══════════════════════════════════════════
async function shopify(query, variables) {
  const token = process.env.SHOPIFY_ADMIN_TOKEN;
  if (!token) {
    const err = new Error('SHOPIFY_ADMIN_TOKEN is not set in Netlify');
    err.status = 500;
    throw err;
  }

  const resp = await fetch(`https://${SHOPIFY_DOMAIN}/admin/api/${SHOPIFY_VERSION}/graphql.json`, {
    method: 'POST',
    headers: {
      'X-Shopify-Access-Token': token,
      'Content-Type': 'application/json',
      Accept: 'application/json'
    },
    body: JSON.stringify({ query, variables: variables || {} })
  });

  const text = await resp.text();
  if (!resp.ok) {
    console.error(`[shirt-orders] Shopify HTTP ${resp.status}: ${text.slice(0, 500)}`);
    const err = new Error(`Shopify returned ${resp.status}`);
    err.status = resp.status === 401 || resp.status === 403 ? 502 : 502;
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
    const err = new Error(msg);
    err.status = 502;
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
  try {
    // Both calls hit Shopify; run them together.
    const [product, ordersByDeal] = await Promise.all([
      fetchShirtProduct(false),
      fetchOrdersByDeal()
    ]);
    return json(200, { ok: true, product, ordersByDeal });
  } catch (err) {
    console.error(`[shirt-orders] GET failed: ${err.message}`);
    return json(err.status || 500, { error: err.message, detail: err.detail || null });
  }
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
      lineItems: [{ variantId: variant.id, quantity }],
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

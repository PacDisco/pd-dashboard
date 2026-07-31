// netlify/functions/stripe.js
//
// Proxies the Stripe REST API so the secret key never ships to the browser.
//
// Endpoints:
//   GET /api/stripe?action=charges&limit=100&starting_after=ch_xxx&created_gte=...&created_lte=...
//       -> list charges with optional pagination + date filter (unix seconds)
//   GET /api/stripe?action=charge&id=ch_xxx
//       -> full charge object (expanded with customer + balance_transaction + payment_intent)
//   GET /api/stripe?action=summary&created_gte=...&created_lte=...
//       -> aggregate KPIs for the given window (paginates charges internally)
//
// Environment:
//   STRIPE_SECRET_KEY  — required. Set in Netlify Site settings → Environment variables.
//
// Note: Stripe's `created` filter uses Unix seconds. The UI sends ISO dates and
// this function converts them.

const STRIPE_API = "https://api.stripe.com/v1";

function send(status, body, extraHeaders = {}) {
  return {
    statusCode: status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  };
}

function qs(params) {
  const parts = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "") continue;
    if (Array.isArray(v)) {
      for (const item of v) parts.push(`${encodeURIComponent(k)}[]=${encodeURIComponent(item)}`);
    } else if (typeof v === "object") {
      for (const [kk, vv] of Object.entries(v)) {
        if (vv === undefined || vv === null || vv === "") continue;
        parts.push(`${encodeURIComponent(k)}[${encodeURIComponent(kk)}]=${encodeURIComponent(vv)}`);
      }
    } else {
      parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
    }
  }
  return parts.join("&");
}

async function stripeGET(path, params, key) {
  const url = `${STRIPE_API}${path}${params ? `?${qs(params)}` : ""}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${key}`,
      "Stripe-Version": "2024-06-20",
    },
  });
  const body = await res.json();
  if (!res.ok) {
    const msg = body?.error?.message || `Stripe ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    err.detail = body;
    throw err;
  }
  return body;
}

function parseWindow(params) {
  const out = {};
  if (params.created_gte) {
    const d = new Date(params.created_gte);
    if (!isNaN(d)) out.gte = Math.floor(d.getTime() / 1000);
  }
  if (params.created_lte) {
    const d = new Date(params.created_lte);
    if (!isNaN(d)) out.lte = Math.floor(d.getTime() / 1000);
  }
  return out;
}

async function handleCharges(params, key) {
  const window = parseWindow(params);
  const stripeParams = {
    limit: Math.min(parseInt(params.limit || "100", 10) || 100, 100),
    expand: ["data.customer"],
  };
  if (params.starting_after) stripeParams.starting_after = params.starting_after;
  if (window.gte || window.lte) stripeParams.created = window;
  const data = await stripeGET("/charges", stripeParams, key);
  return send(200, {
    has_more: data.has_more,
    data: (data.data || []).map(simplifyCharge),
  });
}

async function handleCharge(params, key) {
  if (!params.id) return send(400, { error: "Missing id" });
  const data = await stripeGET(`/charges/${encodeURIComponent(params.id)}`, {
    expand: ["customer", "balance_transaction", "payment_intent", "invoice"],
  }, key);
  return send(200, data);
}

// Lightweight summary: paginate up to N pages of charges for the window and aggregate.
async function handleSummary(params, key) {
  const window = parseWindow(params);
  const MAX_PAGES = 10; // 1000 charges cap to keep function fast
  let starting_after;
  let count = 0, succeeded = 0, failed = 0, refunded_count = 0;
  let grossCents = 0, refundedCents = 0, netCents = 0;
  let currency = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const stripeParams = { limit: 100, expand: [] };
    if (starting_after) stripeParams.starting_after = starting_after;
    if (window.gte || window.lte) stripeParams.created = window;
    const res = await stripeGET("/charges", stripeParams, key);
    for (const c of res.data || []) {
      count++;
      if (!currency && c.currency) currency = c.currency;
      if (c.status === "succeeded") {
        succeeded++;
        grossCents += c.amount || 0;
        refundedCents += c.amount_refunded || 0;
        netCents += (c.amount || 0) - (c.amount_refunded || 0);
        if ((c.amount_refunded || 0) > 0) refunded_count++;
      } else if (c.status === "failed") {
        failed++;
      }
    }
    if (!res.has_more || !res.data?.length) break;
    starting_after = res.data[res.data.length - 1].id;
  }
  return send(200, {
    count,
    succeeded,
    failed,
    refunded_count,
    grossCents,
    refundedCents,
    netCents,
    currency: currency || "usd",
    capped: count >= MAX_PAGES * 100,
  });
}

// Keep list rows small — the full object is fetched again when a row is clicked.
function simplifyCharge(c) {
  return {
    id: c.id,
    amount: c.amount,
    amount_refunded: c.amount_refunded,
    currency: c.currency,
    status: c.status,
    paid: c.paid,
    refunded: c.refunded,
    created: c.created,
    description: c.description,
    receipt_email: c.receipt_email,
    customer_id: typeof c.customer === "object" ? c.customer?.id : c.customer,
    customer_email:
      (typeof c.customer === "object" ? c.customer?.email : null) ||
      c.billing_details?.email ||
      c.receipt_email ||
      null,
    customer_name:
      (typeof c.customer === "object" ? c.customer?.name : null) ||
      c.billing_details?.name ||
      null,
    payment_method_brand: c.payment_method_details?.card?.brand,
    payment_method_last4: c.payment_method_details?.card?.last4,
    failure_message: c.failure_message,
  };
}

// Search across the ENTIRE account (not just the current window).
// Charge search supports amount, card last4, customer, metadata, status — but
// NOT customer name/email directly. So name/email terms are resolved through
// Customer search first, then charges are looked up by those customer IDs.
function escapeQ(s) {
  return String(s).replace(/["\\]/g, (m) => "\\" + m);
}

async function findCustomerIds(query, key) {
  try {
    const res = await stripeGET("/customers/search", { query, limit: 20 }, key);
    return (res.data || []).map((c) => c.id);
  } catch {
    return [];
  }
}

async function handleSearch(params, key) {
  const q = (params.q || "").trim();
  if (!q) return send(400, { error: "Missing search term (q)" });

  // Direct charge ID → retrieve it.
  if (/^ch_[A-Za-z0-9]+$/.test(q)) {
    try {
      const c = await stripeGET(`/charges/${encodeURIComponent(q)}`, { expand: ["customer"] }, key);
      return send(200, { data: [simplifyCharge(c)], has_more: false, query: q });
    } catch {
      return send(200, { data: [], has_more: false, query: q, note: "No charge with that ID." });
    }
  }

  let searchQuery = null;

  if (/^cus_[A-Za-z0-9]+$/.test(q)) {
    searchQuery = `customer:"${escapeQ(q)}"`;
  } else if (q.includes("@")) {
    const ids = await findCustomerIds(`email~"${escapeQ(q)}"`, key);
    if (!ids.length) return send(200, { data: [], has_more: false, query: q, note: "No customers match that email." });
    searchQuery = ids.slice(0, 10).map((id) => `customer:"${id}"`).join(" OR ");
  } else if (/^\$?\s*\d[\d.,]*$/.test(q)) {
    const cents = Math.round(parseFloat(q.replace(/[^\d.]/g, "")) * 100);
    if (/^\d{4}$/.test(q)) {
      // 4 digits: could be a card last4 OR a whole-dollar amount — match either.
      searchQuery = `payment_method_details.card.last4:${q} OR amount:${cents}`;
    } else if (!Number.isNaN(cents)) {
      searchQuery = `amount:${cents}`;
    }
  } else {
    // Free text → treat as a customer name (Stripe can't search charge names).
    const nameClause = q.length >= 3 ? `name~"${escapeQ(q)}"` : `name:"${escapeQ(q)}"`;
    const ids = await findCustomerIds(nameClause, key);
    if (!ids.length) return send(200, { data: [], has_more: false, query: q, note: "No customers match that name." });
    searchQuery = ids.slice(0, 10).map((id) => `customer:"${id}"`).join(" OR ");
  }

  if (!searchQuery) return send(200, { data: [], has_more: false, query: q });

  const res = await stripeGET("/charges/search", {
    query: searchQuery,
    limit: 100,
    expand: ["data.customer"],
  }, key);
  return send(200, {
    data: (res.data || []).map(simplifyCharge),
    has_more: !!res.has_more,
    query: q,
  });
}

export const handler = async (event) => {
  if (event.httpMethod !== "GET") return send(405, { error: "Method not allowed" });
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    return send(500, {
      error: "STRIPE_SECRET_KEY is not set on this site. Add it under Site configuration → Environment variables and redeploy.",
    });
  }
  const params = event.queryStringParameters || {};
  const action = params.action || "charges";
  try {
    if (action === "charges") return await handleCharges(params, key);
    if (action === "charge") return await handleCharge(params, key);
    if (action === "summary") return await handleSummary(params, key);
    if (action === "search") return await handleSearch(params, key);
    return send(400, { error: `Unknown action: ${action}` });
  } catch (err) {
    const status = err.status || 500;
    return send(status, { error: err.message, detail: err.detail });
  }
};

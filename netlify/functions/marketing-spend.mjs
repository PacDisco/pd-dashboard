// netlify/functions/marketing-spend.mjs
//
// Monthly ad spend per channel — the one input on the Marketing Performance
// dashboard that has no upstream API behind it.
//
// Everything else that dashboard shows is read live from HubSpot and Jotform
// via sales-funnel-data.mjs. Google Ads and Meta are not connected to this
// stack, so spend is entered by hand. This function is the store for it, so
// cost-per-outcome can be joined to the live funnel without routing through
// the Google Sheet that /lead-data-sheet/ still uses.
//
// Data model: MIGRATION-marketing-spend.sql (table marketing_spend,
// unique on (month, channel)).
//
// Routes (?action=... , or JSON body { action } on POST):
//   GET   list    ?from=YYYY-MM&to=YYYY-MM
//                 -> { months, channels, spend: { [channel]: number[] },
//                      rows: [...], generatedAt }
//                 spend[channel][i] is amount_nzd for months[i]; 0 when unset.
//   POST  upsert  { rows: [{ month, channel, amount, currency?, fxToNzd?, note? }] }
//                 -> { written, rows }
//
// Reads are open, matching sales-funnel-data.mjs — /api/* sits outside the
// edge auth gate and the aggregate is not sensitive. Writes are gated: this
// is business data that ends up in board reporting, and an unauthenticated
// POST would let anyone rewrite the cost base. See _shared/identity.mjs.
//
// Env vars:
//   NETLIFY_DATABASE_URL   Neon; auto-injected by Netlify DB
//   URL / DEPLOY_PRIME_URL used by verifiedUser to reach GoTrue

import { neon } from "@neondatabase/serverless";
import { verifiedUser, actorName } from "./_shared/identity.mjs";

// Channel labels MUST match those emitted by sales-funnel-data.mjs
// (HUBSPOT_SOURCE_LABELS + CHANNEL_FIELD_TO_LABEL). A spend row whose channel
// is not in this set would never join to a funnel column, so it is rejected at
// write time rather than silently ignored on the dashboard.
const CHANNELS = [
  "Paid Search",
  "Paid Social",
  "Organic Search",
  "Organic Social",
  "Email Marketing",
  "Direct Traffic",
  "Referrals",
  "Other Campaigns",
  "Offline Sources",
  "AI Referrals",
];
const CHANNEL_SET = new Set(CHANNELS);

const JSON_HEADERS = { "Content-Type": "application/json" };

let _sql;
function sql() {
  if (!_sql) {
    const url = process.env.NETLIFY_DATABASE_URL;
    if (!url) throw new Error("NETLIFY_DATABASE_URL not configured");
    _sql = neon(url);
  }
  return _sql;
}

function json(status, payload, extraHeaders = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...JSON_HEADERS, ...extraHeaders },
  });
}

// -------- month helpers (the API speaks 'YYYY-MM', the table stores DATE) --

const YM_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

function isYM(s) {
  return typeof s === "string" && YM_RE.test(s);
}

function ymToDate(ym) {
  return `${ym}-01`;
}

function dateToYM(d) {
  // node-postgres hands back a Date for DATE columns; the driver may also
  // return a plain string depending on the parser. Handle both.
  if (d instanceof Date) {
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  }
  return String(d).slice(0, 7);
}

function monthsBetween(fromYM, toYM) {
  const [fy, fm] = fromYM.split("-").map(Number);
  const [ty, tm] = toYM.split("-").map(Number);
  const out = [];
  let y = fy;
  let m = fm;
  // Guard against an inverted or absurd range producing an unbounded loop.
  while ((y < ty || (y === ty && m <= tm)) && out.length < 120) {
    out.push(`${y}-${String(m).padStart(2, "0")}`);
    m++;
    if (m > 12) {
      m = 1;
      y++;
    }
  }
  return out;
}

function defaultRange() {
  const now = new Date();
  const to = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  const back = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 12, 1));
  const from = `${back.getUTCFullYear()}-${String(back.getUTCMonth() + 1).padStart(2, "0")}`;
  return { from, to };
}

function num(v, fallback = 0) {
  const n = typeof v === "number" ? v : parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
}

// -------- handlers --------

async function handleList(url) {
  const def = defaultRange();
  const fromYM = url.searchParams.get("from") || def.from;
  const toYM = url.searchParams.get("to") || def.to;

  if (!isYM(fromYM) || !isYM(toYM)) {
    return json(400, { error: "from and to must be YYYY-MM" });
  }
  const months = monthsBetween(fromYM, toYM);
  if (!months.length) {
    return json(400, { error: "`from` must not be after `to`" });
  }

  const db = sql();
  const rows = await db`
    SELECT month, channel, amount, currency, fx_to_nzd, amount_nzd, note, updated_at, updated_by
    FROM marketing_spend
    WHERE month >= ${ymToDate(months[0])}
      AND month <= ${ymToDate(months[months.length - 1])}
    ORDER BY month ASC, channel ASC
  `;

  // spend[channel] is an array aligned to months, so the dashboard can index
  // it the same way it indexes the funnel arrays from sales-funnel-data.
  const spend = {};
  for (const c of CHANNELS) spend[c] = months.map(() => 0);

  const out = [];
  for (const r of rows) {
    const ym = dateToYM(r.month);
    const idx = months.indexOf(ym);
    const channel = r.channel;
    if (idx < 0) continue;
    if (!spend[channel]) spend[channel] = months.map(() => 0);
    spend[channel][idx] = num(r.amount_nzd);
    out.push({
      month: ym,
      channel,
      amount: num(r.amount),
      currency: r.currency,
      fxToNzd: num(r.fx_to_nzd, 1),
      amountNzd: num(r.amount_nzd),
      note: r.note || null,
      updatedAt: r.updated_at,
      updatedBy: r.updated_by || null,
    });
  }

  return json(
    200,
    {
      months,
      channels: CHANNELS,
      spend,
      rows: out,
      generatedAt: new Date().toISOString(),
    },
    { "Cache-Control": "no-store" }
  );
}

async function handleUpsert(body, user) {
  const rows = Array.isArray(body?.rows) ? body.rows : null;
  if (!rows || !rows.length) {
    return json(400, { error: "Body must be { rows: [...] } with at least one row" });
  }
  if (rows.length > 500) {
    return json(400, { error: "Too many rows in one request (max 500)" });
  }

  // Validate everything before writing anything — a partial write of a spend
  // grid is worse than a rejected one, because the reader can't tell which
  // cells landed.
  const clean = [];
  for (const [i, r] of rows.entries()) {
    if (!isYM(r?.month)) {
      return json(400, { error: `rows[${i}].month must be YYYY-MM` });
    }
    if (!CHANNEL_SET.has(r?.channel)) {
      return json(400, {
        error: `rows[${i}].channel "${r?.channel}" is not a recognised channel. ` +
          `Must be one of: ${CHANNELS.join(", ")}`,
      });
    }
    const amount = num(r.amount, NaN);
    if (!Number.isFinite(amount) || amount < 0) {
      return json(400, { error: `rows[${i}].amount must be a number >= 0` });
    }
    const currency = (r.currency || "NZD").toUpperCase();
    const fx = num(r.fxToNzd, currency === "NZD" ? 1 : NaN);
    if (!Number.isFinite(fx) || fx <= 0) {
      return json(400, {
        error: `rows[${i}].fxToNzd must be a positive number when currency is not NZD`,
      });
    }
    clean.push({
      month: ymToDate(r.month),
      channel: r.channel,
      amount,
      currency,
      fx,
      amountNzd: Math.round(amount * fx * 100) / 100,
      note: typeof r.note === "string" && r.note.trim() ? r.note.trim() : null,
    });
  }

  const db = sql();
  const actor = actorName(user);
  let written = 0;
  for (const c of clean) {
    await db`
      INSERT INTO marketing_spend (month, channel, amount, currency, fx_to_nzd, amount_nzd, note, updated_by, updated_at)
      VALUES (${c.month}, ${c.channel}, ${c.amount}, ${c.currency}, ${c.fx}, ${c.amountNzd}, ${c.note}, ${actor}, NOW())
      ON CONFLICT (month, channel) DO UPDATE SET
        amount     = EXCLUDED.amount,
        currency   = EXCLUDED.currency,
        fx_to_nzd  = EXCLUDED.fx_to_nzd,
        amount_nzd = EXCLUDED.amount_nzd,
        note       = EXCLUDED.note,
        updated_by = EXCLUDED.updated_by,
        updated_at = NOW()
    `;
    written++;
  }

  return json(200, { written, rows: clean.length, updatedBy: actor });
}

export default async (req) => {
  try {
    const url = new URL(req.url);
    const method = req.method.toUpperCase();

    let body = null;
    if (method === "POST") {
      try {
        body = await req.json();
      } catch {
        return json(400, { error: "Body must be valid JSON" });
      }
    }

    const action = (url.searchParams.get("action") || body?.action || (method === "GET" ? "list" : "")).toLowerCase();

    if (method === "GET" && action === "list") {
      return await handleList(url);
    }

    if (method === "POST" && action === "upsert") {
      // Writes require a real, GoTrue-verified session. /api/* is outside the
      // edge auth gate, so this is the only thing standing in front of the
      // cost base.
      const user = await verifiedUser(req, "marketing-spend");
      if (!user) {
        return json(401, { error: "Sign in required to edit spend." });
      }
      const roles = user.roles || [];
      if (!roles.includes("admin") && !roles.includes("outreach") && !roles.includes("operations")) {
        return json(403, { error: "Your role can't edit marketing spend." });
      }
      return await handleUpsert(body, user);
    }

    return json(400, {
      error: `Unknown action "${action}". Use GET ?action=list or POST ?action=upsert.`,
    });
  } catch (err) {
    console.error("marketing-spend:", err);
    return json(500, { error: err.message });
  }
};

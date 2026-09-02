// netlify/functions/budget-admin.mjs
//
// Admin surface for Field Budget — the instructor expense app that replaced the
// on-the-ground Google Sheet. Instructors log spend against per-programme
// budgets from a separate Netlify site; this is where those budgets get
// created, funded and assigned.
//
// WHY THIS TALKS TO THE DATABASE DIRECTLY
// ---------------------------------------
// The obvious alternative was for this dashboard to call the field app's API
// cross-origin with a shared session cookie. That would force both sites onto
// the same registrable domain, need CORS with credentials, and fail silently
// when a browser decided the cookie was third-party. Reading the same Postgres
// the field app writes to is the same shape as every other function here, and
// the caller is already authenticated by Netlify Identity.
//
// Data model: MIGRATION-field-budget.sql. All money is integer minor units
// (PEN 40.50 -> 4050) with an explicit currency on every row.
//
// Routes (?action=..., or JSON body { action } on POST):
//   GET   list        -> { budgets, categories, assignments, spend }
//   GET   entries     ?budget=<id>  -> { entries }
//   GET   export      ?budget=<id>  -> text/csv, for reconciliation
//   POST  create      { name, currency, default_rate, categories[], emails[] }
//   POST  update      { budget_id, name?, default_rate?, starts_on?, ends_on?,
//                       funded_base?, categories?: [{id?, name, allocated, parent_id?}] }
//
// Categories are one level deep. Allocation sits on any node: a parent may hold
// its own alongside children with theirs, and totals roll up. The database
// enforces the single level with a trigger — see
// MIGRATION-field-budget-subcategories.sql.
//   POST  assign      { budget_id, emails[] }
//   POST  unassign    { budget_id, email }
//   POST  set-status  { budget_id, status }  active | closed
//
// Unlike marketing-spend.mjs, READS are gated here too. /api/* sits outside the
// edge auth gate, and this payload contains instructor email addresses — staff
// PII rather than an aggregate. Writes additionally require a role.
//
// Env vars:
//   FIELD_BUDGET_DATABASE_URL  Neon for the field app. Falls back to
//                              NETLIFY_DATABASE_URL if you keep one database.
//   URL / DEPLOY_PRIME_URL     used by verifiedUser to reach GoTrue

import { neon } from "@neondatabase/serverless";
import { verifiedUser } from "./_shared/identity.mjs";

const WRITE_ROLES = ["admin", "programs", "operations"];

let _sql;
function sql() {
  if (!_sql) {
    const url = process.env.FIELD_BUDGET_DATABASE_URL || process.env.NETLIFY_DATABASE_URL;
    if (!url) throw new Error("FIELD_BUDGET_DATABASE_URL is not set");
    _sql = neon(url);
  }
  return _sql;
}

const JSON_HEADERS = { "Content-Type": "application/json", "Cache-Control": "no-store" };
const json = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });

// Gmail-style +tags and case differences are the classic silent-empty-state
// bug: an admin types Katie.Smith@ and the Google account is katie.smith@, and
// the instructor sees "no budgets assigned" with nothing to explain it. The
// field app normalises identically on the way in.
function normaliseEmail(raw) {
  if (!raw) return null;
  const trimmed = String(raw).trim().toLowerCase();
  const at = trimmed.lastIndexOf("@");
  if (at < 1) return null;
  const local = trimmed.slice(0, at).split("+")[0];
  const domain = trimmed.slice(at + 1);
  if (!local || !domain) return null;
  return `${local}@${domain}`;
}

// Postgres returns bigint as a string to protect precision. Coerce once at the
// boundary rather than scattering Number() through the page.
const money = (v) => (v === null || v === undefined ? null : Number(v));

// Keep only well-formed { CUR: positiveNumber } pairs. A bad rate silently
// mis-converts every entry made against it, so a junk value is dropped rather
// than stored.
function cleanRates(raw) {
  const out = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [code, value] of Object.entries(raw)) {
    const cur = String(code).trim().toUpperCase();
    const n = Number(value);
    if (/^[A-Z]{3}$/.test(cur) && Number.isFinite(n) && n > 0) out[cur] = n;
  }
  return out;
}

/* ---------------------------------------------------------------- reads --- */

async function handleList() {
  const db = sql();
  const [budgets, categories, assignments, spend, receipts] = await Promise.all([
    db`select * from budgets order by created_at desc`,
    // Order by the PARENT's position, then parent-before-children, then the
    // child's own position. Grouping on coalesce(parent_id, id) looks right but
    // sorts on a random id string, which silently discards sort_order.
    db`select c.* from categories c
         left join categories p on p.id = c.parent_id
        order by coalesce(p.sort_order, c.sort_order),
                 (c.parent_id is not null),
                 c.sort_order,
                 c.id`,
    db`select * from assignments order by email`,
    db`select budget_id, category_id, sum(budget_amount)::bigint as spent, count(*)::int as n
         from entries where entry_type in ('expense','correction')
         group by budget_id, category_id`,
    db`select budget_id, count(*)::int as n
         from entries where receipt_file_id is not null group by budget_id`,
  ]);

  return json(200, {
    budgets: budgets.map((b) => ({
      ...b,
      funded_base: money(b.funded_base),
      default_rate: Number(b.default_rate),
      rates: b.rates || {},
    })),
    categories: categories.map((c) => ({ ...c, allocated: money(c.allocated) })),
    assignments,
    spend: spend.map((s) => ({ ...s, spent: money(s.spent) })),
    receipts,
    generatedAt: new Date().toISOString(),
  });
}

async function handleEntries(budgetId) {
  if (!budgetId) return json(400, { error: "budget is required" });
  const rows = await sql()`
    select e.*, c.name as category_name
      from entries e
      left join categories c on c.id = e.category_id
     where e.budget_id = ${budgetId}
     order by e.spent_on desc, e.created_at desc
     limit 1000`;
  return json(200, {
    entries: rows.map((e) => ({
      ...e,
      amount: money(e.amount),
      budget_amount: money(e.budget_amount),
      actual_base: money(e.actual_base),
      rate: Number(e.rate),
    })),
  });
}

// CSV for reconciliation against the bank statement. Amounts are written as
// decimals here because this is leaving the system for a spreadsheet.
async function handleExport(budgetId) {
  if (!budgetId) return json(400, { error: "budget is required" });
  const db = sql();
  const [[budget], rows] = await Promise.all([
    db`select * from budgets where id = ${budgetId}`,
    db`select e.*, c.name as category_name
         from entries e left join categories c on c.id = e.category_id
        where e.budget_id = ${budgetId}
        order by e.spent_on, e.created_at`,
  ]);
  if (!budget) return json(404, { error: "No such budget" });

  const esc = (v) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const head = [
    "date", "type", "instructor", "category", "description", "method",
    "amount", "currency", "rate", `budget_amount_${budget.currency}`,
    "actual_nzd", "receipt",
  ];
  const lines = [head.join(",")];
  for (const e of rows) {
    lines.push([
      e.spent_on, e.entry_type, e.email, e.category_name || "", e.description,
      e.payment_method, (Number(e.amount) / 100).toFixed(2), e.currency,
      Number(e.rate), (Number(e.budget_amount) / 100).toFixed(2),
      e.actual_base === null ? "" : (Number(e.actual_base) / 100).toFixed(2),
      e.receipt_link || "",
    ].map(esc).join(","));
  }

  const slug = budget.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  return new Response(lines.join("\n"), {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="field-budget-${slug}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}

/* --------------------------------------------------------------- writes --- */

async function handleCreate(body) {
  const db = sql();
  const name = (body.name || "").trim();
  const currency = (body.currency || "").trim().toUpperCase();
  if (!name) return json(400, { error: "Give the budget a name." });
  if (!/^[A-Z]{3}$/.test(currency)) return json(400, { error: "Currency must be a 3-letter code." });

  const rows = (body.categories || [])
    .map((c) => ({
      name: (c.name || "").trim(),
      allocated: Math.round(Number(c.allocated) || 0),
      parent_index: c.parent_index ?? null,
    }))
    .filter((c) => c.name);
  if (!rows.length) return json(400, { error: "Add at least one category." });

  const id = body.id || `bud_${crypto.randomUUID().slice(0, 8)}`;
  const base = (body.base_currency || "NZD").trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(base)) return json(400, { error: "Base currency must be a 3-letter code." });
  const rates = cleanRates(body.rates);
  // default_rate stays populated as a fallback for anything reading the old
  // single-rate field.
  const fallback = rates[base] || Number(body.default_rate) || 1;

  await db`
    insert into budgets (id, name, currency, base_currency, default_rate, rates, funded_base, starts_on, ends_on)
    values (${id}, ${name}, ${currency}, ${base},
            ${fallback}, ${JSON.stringify(rates)},
            ${body.funded_base ? Math.round(Number(body.funded_base)) : null},
            ${body.starts_on || null}, ${body.ends_on || null})`;

  // The page sends children as { parent_index } because nothing has an id yet.
  // Parents are inserted first so the reference resolves.
  const ids = [];
  for (const [i, c] of rows.entries()) {
    ids[i] = `cat_${crypto.randomUUID().slice(0, 8)}`;
  }
  // sort_order is a position among siblings, so parents count 1..n and each
  // parent's children count 1..m independently.
  let parentPos = 0;
  for (const [i, c] of rows.entries()) {
    if (c.parent_index !== null && c.parent_index !== undefined) continue;
    parentPos += 1;
    await db`
      insert into categories (id, budget_id, name, allocated, sort_order)
      values (${ids[i]}, ${id}, ${c.name}, ${c.allocated}, ${parentPos})`;
  }
  const childPos = {};
  for (const [i, c] of rows.entries()) {
    if (c.parent_index === null || c.parent_index === undefined) continue;
    const parent = ids[c.parent_index];
    if (!parent) continue;
    childPos[parent] = (childPos[parent] || 0) + 1;
    await db`
      insert into categories (id, budget_id, name, allocated, sort_order, parent_id)
      values (${ids[i]}, ${id}, ${c.name}, ${c.allocated}, ${childPos[parent]}, ${parent})`;
  }

  // A category that gained children stores 0: its displayed figure is the sum
  // of those children. Without this, an amount typed before the subcategories
  // were added would quietly inflate the total.
  await db`update categories set allocated = 0
            where budget_id = ${id}
              and id in (select distinct parent_id from categories
                          where budget_id = ${id} and parent_id is not null)`;

  const assigned = [];
  for (const raw of body.emails || []) {
    const em = normaliseEmail(raw);
    if (!em) continue;
    await db`insert into assignments (budget_id, email) values (${id}, ${em})
             on conflict do nothing`;
    assigned.push(em);
  }

  return json(201, { id, assigned });
}

async function handleUpdate(body) {
  const db = sql();
  const id = body.budget_id;
  if (!id) return json(400, { error: "budget_id is required" });

  const [budget] = await db`select * from budgets where id = ${id}`;
  if (!budget) return json(404, { error: "No such budget" });

  // Currency is deliberately not editable. Entries already carry amounts and
  // frozen conversions in the old currency; changing it would silently
  // reinterpret every historic figure.
  const name = body.name === undefined ? budget.name : String(body.name).trim();
  if (!name) return json(400, { error: "Name can't be empty." });

  const base = body.base_currency === undefined
    ? budget.base_currency
    : String(body.base_currency).trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(base)) return json(400, { error: "Base currency must be a 3-letter code." });

  const rates = body.rates === undefined ? (budget.rates || {}) : cleanRates(body.rates);
  const fallback = rates[base] || Number(budget.default_rate) || 1;

  await db`
    update budgets set
      name          = ${name},
      base_currency = ${base},
      rates         = ${JSON.stringify(rates)},
      default_rate  = ${fallback},
      starts_on    = ${body.starts_on === undefined ? budget.starts_on : (body.starts_on || null)},
      ends_on      = ${body.ends_on === undefined ? budget.ends_on : (body.ends_on || null)},
      funded_base  = ${body.funded_base === undefined
                        ? budget.funded_base
                        : (body.funded_base === null || body.funded_base === ""
                            ? null : Math.round(Number(body.funded_base)))},
      updated_at   = now()
    where id = ${id}`;

  if (!Array.isArray(body.categories)) return json(200, { id, categories: null });

  const existing = await db`select id from categories where budget_id = ${id}`;
  const keep = new Set(body.categories.map((c) => c.id).filter(Boolean));
  const removing = existing.map((c) => c.id).filter((cid) => !keep.has(cid));

  // A category with entries against it can't be deleted — the ledger is
  // append-only and orphaning rows would make historic spend unattributable.
  if (removing.length) {
    // A parent's children cascade on delete, so their spend blocks removal too.
    const kids = await db`select id from categories where parent_id = any(${removing})`;
    const affected = [...removing, ...kids.map((k) => k.id)];
    const used = await db`
      select category_id, count(*)::int as n from entries
       where category_id = any(${affected}) group by category_id`;
    if (used.length) {
      const names = await db`select id, name from categories where id = any(${used.map((u) => u.category_id)})`;
      return json(409, {
        error: `Can't remove ${names.map((n) => n.name).join(", ")} — spend is already logged against ${names.length === 1 ? "it" : "them"}. Set the allocation to 0 instead.`,
      });
    }
    await db`delete from categories where id = any(${removing})`;
  }

  // Two passes: parents first so a brand-new parent exists before its brand-new
  // child references it. Rows carry either parent_id (existing) or parent_index
  // (a parent created in this same save).
  const resolved = [];
  let parentPos = 0;
  for (const [i, c] of body.categories.entries()) {
    const cname = (c.name || "").trim();
    if (!cname) { resolved[i] = null; continue; }
    const isChild = c.parent_id != null || c.parent_index != null;
    if (isChild) { resolved[i] = c.id || null; continue; }
    parentPos += 1;
    const allocated = Math.round(Number(c.allocated) || 0);
    if (c.id) {
      await db`update categories set name = ${cname}, allocated = ${allocated},
                 sort_order = ${parentPos}, parent_id = null
                where id = ${c.id} and budget_id = ${id}`;
      resolved[i] = c.id;
    } else {
      const nid = `cat_${crypto.randomUUID().slice(0, 8)}`;
      await db`insert into categories (id, budget_id, name, allocated, sort_order)
               values (${nid}, ${id}, ${cname}, ${allocated}, ${parentPos})`;
      resolved[i] = nid;
    }
  }

  // sort_order is a position among siblings, so children count from 1 within
  // each parent rather than continuing the flat index.
  const childPos = {};
  for (const [i, c] of body.categories.entries()) {
    const cname = (c.name || "").trim();
    if (!cname) continue;
    if (c.parent_id == null && c.parent_index == null) continue;
    const parent = c.parent_id ?? resolved[c.parent_index];
    if (!parent) continue;
    childPos[parent] = (childPos[parent] || 0) + 1;
    const allocated = Math.round(Number(c.allocated) || 0);
    if (c.id) {
      await db`update categories set name = ${cname}, allocated = ${allocated},
                 sort_order = ${childPos[parent]}, parent_id = ${parent}
                where id = ${c.id} and budget_id = ${id}`;
    } else {
      await db`insert into categories (id, budget_id, name, allocated, sort_order, parent_id)
               values (${`cat_${crypto.randomUUID().slice(0, 8)}`}, ${id}, ${cname}, ${allocated}, ${childPos[parent]}, ${parent})`;
    }
  }

  await db`update categories set allocated = 0
            where budget_id = ${id}
              and id in (select distinct parent_id from categories
                          where budget_id = ${id} and parent_id is not null)`;

  return json(200, { id, categories: body.categories.length });
}

async function handleAssign(body) {
  const db = sql();
  if (!body.budget_id) return json(400, { error: "budget_id is required" });
  const added = [];
  const skipped = [];
  for (const raw of body.emails || []) {
    const em = normaliseEmail(raw);
    if (!em) { skipped.push(raw); continue; }
    await db`insert into assignments (budget_id, email) values (${body.budget_id}, ${em})
             on conflict do nothing`;
    added.push(em);
  }
  return json(200, { added, skipped });
}

async function handleUnassign(body) {
  const em = normaliseEmail(body.email);
  if (!body.budget_id || !em) return json(400, { error: "budget_id and email are required" });
  // Entries already logged stay put — they are an append-only record of what
  // was spent, not a property of who currently has access.
  await sql()`delete from assignments where budget_id = ${body.budget_id} and email = ${em}`;
  return json(200, { removed: em });
}

async function handleSetStatus(body) {
  if (!body.budget_id || !["active", "closed"].includes(body.status)) {
    return json(400, { error: "budget_id and status (active|closed) are required" });
  }
  await sql()`update budgets set status = ${body.status}, updated_at = now()
              where id = ${body.budget_id}`;
  return json(200, { budget_id: body.budget_id, status: body.status });
}

/* ---------------------------------------------------------------- entry --- */

export default async (req) => {
  const url = new URL(req.url);
  let body = {};
  if (req.method === "POST") {
    try { body = await req.json(); } catch { body = {}; }
  }
  const action = url.searchParams.get("action") || body.action || "list";

  try {
    // Reads are gated as well as writes: this payload carries instructor email
    // addresses, and /api/* is outside the edge auth gate.
    const user = await verifiedUser(req, "budget-admin");
    if (!user) return json(401, { error: "Sign in to view programme budgets." });

    if (req.method === "GET") {
      if (action === "list") return await handleList();
      if (action === "entries") return await handleEntries(url.searchParams.get("budget"));
      if (action === "export") return await handleExport(url.searchParams.get("budget"));
      return json(400, { error: `Unknown action "${action}".` });
    }

    if (req.method === "POST") {
      const roles = user.roles || [];
      if (!roles.some((r) => WRITE_ROLES.includes(r))) {
        return json(403, { error: "Your role can't change programme budgets." });
      }
      if (action === "create") return await handleCreate(body);
      if (action === "update") return await handleUpdate(body);
      if (action === "assign") return await handleAssign(body);
      if (action === "unassign") return await handleUnassign(body);
      if (action === "set-status") return await handleSetStatus(body);
      return json(400, { error: `Unknown action "${action}".` });
    }

    return json(405, { error: "Method not allowed" });
  } catch (err) {
    console.error("budget-admin:", err);
    return json(500, { error: err.message });
  }
};

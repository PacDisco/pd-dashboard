// test/field-budget-brands.test.mjs
//
// budget-admin.mjs serves two brands from one handler. Run:
//   npm run test:field-brands
//
// The failure that matters is cross-brand: an Unearthed admin's request
// reaching Pacific Discovery's database (or the reverse), or a PD-only role
// being allowed to change Unearthed budgets. Nothing here talks to a real
// database — fetch is stubbed, and the Neon HTTP driver's requests are
// recorded by host so we can see which database each request hit.

import assert from "node:assert/strict";

const PD_DB = "postgresql://u:p@pd-db.example.neon.tech/neondb";
const UE_DB = "postgresql://u:p@ue-db.example.neon.tech/neondb";

process.env.URL = "https://dash.test";
process.env.FIELD_BUDGET_DATABASE_URL = PD_DB;
process.env.UE_FIELD_BUDGET_DATABASE_URL = UE_DB;
delete process.env.NETLIFY_DATABASE_URL;

// identity.mjs caches the user per bearer token, so each role set gets its own.
let roles = ["admin"];
const dbHits = [];

globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === "string" ? input : input.url;
  if (url.endsWith("/.netlify/identity/user")) {
    return new Response(JSON.stringify({ email: "a@x.org", app_metadata: { roles } }), { status: 200 });
  }
  if (/neon\.tech\//.test(url)) {
    // The driver posts to an api.* host and names the database in a header.
    const conn = new Headers(init.headers).get("neon-connection-string") || "";
    dbHits.push(new URL(conn.replace(/^postgres(ql)?:/, "https:")).hostname);
    // Every list query gets an empty result set.
    const body = JSON.parse(init.body || "{}");
    const one = { fields: [], rows: [], command: "SELECT", rowCount: 0, rowAsArray: false };
    return new Response(JSON.stringify(Array.isArray(body.queries) ? { results: body.queries.map(() => one) } : one),
      { status: 200, headers: { "content-type": "application/json" } });
  }
  throw new Error(`unexpected fetch ${url}`);
};

const { default: pd } = await import("../netlify/functions/budget-admin.mjs");
const { default: ue } = await import("../netlify/functions/budget-admin-ue.mjs");

const bearer = () => ({ authorization: `Bearer t-${roles.join("-")}` });
const get = (h, action = "list") =>
  h(new Request(`https://dash.test/api/x?action=${action}`, { headers: bearer() }));
const post = (h, body) =>
  h(new Request("https://dash.test/api/x", {
    method: "POST", headers: { ...bearer(), "content-type": "application/json" },
    body: JSON.stringify(body),
  }));

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test("PD handler reads only the PD database", async () => {
  dbHits.length = 0;
  const res = await get(pd);
  assert.equal(res.status, 200, await res.clone().text());
  assert.ok(dbHits.length > 0);
  assert.deepEqual([...new Set(dbHits)], ["pd-db.example.neon.tech"]);
});

test("UE handler reads only the UE database", async () => {
  dbHits.length = 0;
  const res = await get(ue);
  assert.equal(res.status, 200, await res.clone().text());
  assert.ok(dbHits.length > 0);
  assert.deepEqual([...new Set(dbHits)], ["ue-db.example.neon.tech"]);
});

test("concurrent requests keep their own database", async () => {
  dbHits.length = 0;
  await Promise.all([get(pd), get(ue), get(pd), get(ue)]);
  const n = (h) => dbHits.filter((x) => x === h).length;
  assert.equal(n("pd-db.example.neon.tech"), n("ue-db.example.neon.tech"));
});

test("UE has no fallback to another database", async () => {
  const saved = process.env.UE_FIELD_BUDGET_DATABASE_URL;
  delete process.env.UE_FIELD_BUDGET_DATABASE_URL;
  process.env.NETLIFY_DATABASE_URL = PD_DB;
  dbHits.length = 0;
  try {
    const res = await get(ue);
    assert.equal(res.status, 500);
    assert.match((await res.json()).error, /UE_FIELD_BUDGET_DATABASE_URL is not set/);
    assert.equal(dbHits.length, 0);
  } finally {
    process.env.UE_FIELD_BUDGET_DATABASE_URL = saved;
    delete process.env.NETLIFY_DATABASE_URL;
  }
});

test("write roles are per brand", async () => {
  const bad = { action: "set-status", budget_id: "b1", status: "nope" }; // 400 once past the role gate
  roles = ["programs"];
  assert.equal((await post(pd, bad)).status, 400, "programs may write PD");
  assert.equal((await post(ue, bad)).status, 403, "programs may not write UE");
  roles = ["unearthed"];
  assert.equal((await post(ue, bad)).status, 400, "unearthed may write UE");
  assert.equal((await post(pd, bad)).status, 403, "unearthed may not write PD");
  roles = ["admin"];
});

let failed = 0;
for (const [name, fn] of tests) {
  try { await fn(); console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.log(`  ✗ ${name}\n    ${err.stack || err.message}`); }
}
console.log(failed ? `\n${failed} failed` : `\nall ${tests.length} passed`);
process.exit(failed ? 1 : 0);

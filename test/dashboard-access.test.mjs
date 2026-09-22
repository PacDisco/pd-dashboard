// test/dashboard-access.test.mjs
//
// The per-person access rule. Run: npm run test:access
//
// These cover the three things that would actually hurt in production:
//   1. an explicit empty list must mean "nothing", not "fall back to roles"
//   2. anyone without a list yet must keep exactly the access roles gave them
//   3. admin bypasses everything

import assert from "node:assert/strict";
import {
  BASELINE_ROLE,
  canAccess,
  emailKey,
  grantedSlugs,
  hasGrantRecord,
  normalizeGrants,
  seedGrantsFromRoles,
  visibleDashboards,
} from "../netlify/edge-functions/lib/dashboard-access.js";

const DASHBOARDS = [
  { slug: "flights", title: "Flights", category: "Operations", allowedRoles: ["admin", "operations", "flights"] },
  { slug: "invoices", title: "Invoices", category: "Finance", allowedRoles: ["admin", "operations"] },
  { slug: "pipeline", title: "Pipeline", category: "Enrollment", allowedRoles: ["admin", "admissions", "outreach"] },
  { slug: "ue-applications", title: "UE Applications", category: "Unearthed", allowedRoles: ["admin"] },
  { slug: "unearthed-stripe", title: "UE Stripe", category: "General", allowedRoles: [] },
];

const byslug = (s) => DASHBOARDS.find((d) => d.slug === s);
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// ── normalization ───────────────────────────────────────────────────────────

test("normalizeGrants lowercases emails and slugs and de-duplicates", () => {
  const g = normalizeGrants({
    users: { "  Jake@Example.COM ": ["Flights", "flights", " Invoices "] },
  });
  assert.deepEqual(Object.keys(g.users), ["jake@example.com"]);
  assert.deepEqual(g.users["jake@example.com"], ["flights", "invoices"]);
});

test("normalizeGrants keeps an empty list as an empty list", () => {
  // Dropping the key would silently promote the person back to role-based
  // access — the exact bug this whole change exists to remove.
  const g = normalizeGrants({ users: { "nobody@example.com": [] } });
  assert.deepEqual(g.users["nobody@example.com"], []);
  assert.equal(hasGrantRecord(g, "nobody@example.com"), true);
});

test("normalizeGrants survives junk", () => {
  const g = normalizeGrants({ users: { "a@b.c": "not-an-array", "": ["x"], 12: ["y"] } });
  assert.deepEqual(g.users["a@b.c"], []);
  assert.equal(g.users[""], undefined);
});

test("emailKey and grantedSlugs are case- and whitespace-insensitive", () => {
  const g = normalizeGrants({ users: { "jake@example.com": ["flights"] } });
  assert.equal(emailKey("  JAKE@Example.com "), "jake@example.com");
  assert.deepEqual(grantedSlugs(g, "JAKE@EXAMPLE.COM"), ["flights"]);
  assert.equal(grantedSlugs(g, "someone-else@example.com"), null);
});

// ── the rule ────────────────────────────────────────────────────────────────

test("admin sees everything, granted or not", () => {
  const grants = normalizeGrants({ users: { "boss@example.com": [] } });
  for (const d of DASHBOARDS) {
    assert.equal(
      canAccess({ email: "boss@example.com", roles: ["admin"], slug: d.slug, dashboard: d, grants }),
      true,
      `admin blocked from ${d.slug}`
    );
  }
});

test("an explicit list is exactly what the person gets", () => {
  const grants = normalizeGrants({ users: { "amy@example.com": ["invoices"] } });
  const opts = { email: "amy@example.com", roles: [BASELINE_ROLE], grants };
  assert.equal(canAccess({ ...opts, slug: "invoices", dashboard: byslug("invoices") }), true);
  assert.equal(canAccess({ ...opts, slug: "flights", dashboard: byslug("flights") }), false);
});

test("an explicit list beats the roles the person happens to hold", () => {
  // Amy is in `operations`, which used to mean flights + invoices. Her list
  // says invoices only, and the list wins — in both directions.
  const grants = normalizeGrants({ users: { "amy@example.com": ["invoices", "pipeline"] } });
  const opts = { email: "amy@example.com", roles: ["operations"], grants };
  assert.equal(canAccess({ ...opts, slug: "flights", dashboard: byslug("flights") }), false, "role should not add access");
  assert.equal(canAccess({ ...opts, slug: "pipeline", dashboard: byslug("pipeline") }), true, "grant should add access her roles never gave her");
});

test("an explicit empty list means no dashboards, even with roles", () => {
  const grants = normalizeGrants({ users: { "amy@example.com": [] } });
  assert.equal(
    canAccess({ email: "amy@example.com", roles: ["operations", "admissions"], slug: "flights", dashboard: byslug("flights"), grants }),
    false
  );
});

test("no grant record at all falls back to roles, unchanged", () => {
  const grants = normalizeGrants({ users: { "someone-else@example.com": ["flights"] } });
  const opts = { email: "bob@example.com", roles: ["operations"], grants };
  assert.equal(canAccess({ ...opts, slug: "flights", dashboard: byslug("flights") }), true);
  assert.equal(canAccess({ ...opts, slug: "invoices", dashboard: byslug("invoices") }), true);
  assert.equal(canAccess({ ...opts, slug: "pipeline", dashboard: byslug("pipeline") }), false);
});

test("missing grants document entirely falls back to roles", () => {
  // This is the state on the very first deploy, and the state after a blob
  // read failure. Nobody should gain or lose anything.
  for (const grants of [null, undefined, {}, { users: {} }]) {
    const g = grants && grants.users ? normalizeGrants(grants) : grants;
    assert.equal(
      canAccess({ email: "bob@example.com", roles: ["flights"], slug: "flights", dashboard: byslug("flights"), grants: g }),
      true
    );
    assert.equal(
      canAccess({ email: "bob@example.com", roles: ["flights"], slug: "invoices", dashboard: byslug("invoices"), grants: g }),
      false
    );
  }
});

test("empty allowedRoles stays admin-only under the fallback", () => {
  assert.equal(
    canAccess({ email: "bob@example.com", roles: ["operations"], slug: "unearthed-stripe", dashboard: byslug("unearthed-stripe"), grants: null }),
    false
  );
});

test("a signed-in person with no roles and no grant gets nothing", () => {
  for (const d of DASHBOARDS) {
    assert.equal(canAccess({ email: "new@example.com", roles: [], slug: d.slug, dashboard: d, grants: null }), false);
  }
});

test("an unknown slug is denied rather than defaulting open", () => {
  const grants = normalizeGrants({ users: { "amy@example.com": ["invoices"] } });
  assert.equal(canAccess({ email: "amy@example.com", roles: [], slug: "", dashboard: null, grants }), false);
  assert.equal(canAccess({ email: "amy@example.com", roles: [], slug: "made-up", dashboard: null, grants }), false);
});

test("slug matching ignores case", () => {
  const grants = normalizeGrants({ users: { "amy@example.com": ["invoices"] } });
  assert.equal(canAccess({ email: "amy@example.com", roles: [], slug: "Invoices", dashboard: byslug("invoices"), grants }), true);
});

// ── listing ─────────────────────────────────────────────────────────────────

test("visibleDashboards mirrors canAccess", () => {
  const grants = normalizeGrants({ users: { "amy@example.com": ["invoices", "ue-applications"] } });
  const seen = visibleDashboards({ email: "amy@example.com", roles: ["operations"], dashboards: DASHBOARDS, grants })
    .map((d) => d.slug);
  assert.deepEqual(seen, ["invoices", "ue-applications"]);
});

// ── migration ───────────────────────────────────────────────────────────────

test("seedGrantsFromRoles reproduces today's access exactly", () => {
  const users = [
    { email: "Boss@example.com", roles: ["admin"] },
    { email: "ops@example.com", roles: ["operations"] },
    { email: "adm@example.com", roles: ["admissions"] },
    { email: "nobody@example.com", roles: [] },
  ];
  const seeded = seedGrantsFromRoles(users, DASHBOARDS);
  assert.deepEqual(seeded["boss@example.com"], DASHBOARDS.map((d) => d.slug), "admin gets everything");
  assert.deepEqual(seeded["ops@example.com"], ["flights", "invoices"]);
  assert.deepEqual(seeded["adm@example.com"], ["pipeline"]);
  assert.deepEqual(seeded["nobody@example.com"], []);

  // And applying the seed must not move anyone.
  const grants = normalizeGrants({ users: seeded });
  for (const u of users) {
    for (const d of DASHBOARDS) {
      const before = canAccess({ email: u.email, roles: u.roles, slug: d.slug, dashboard: d, grants: null });
      const after = canAccess({ email: u.email, roles: u.roles, slug: d.slug, dashboard: d, grants });
      assert.equal(after, before, `${u.email} → ${d.slug} changed across the migration`);
    }
  }
});

// ── run ─────────────────────────────────────────────────────────────────────

let failed = 0;
for (const [name, fn] of tests) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.error(`  ✗ ${name}\n    ${err.message}`);
  }
}
console.log(`\n${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);

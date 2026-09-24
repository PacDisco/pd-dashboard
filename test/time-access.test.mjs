// test/time-access.test.mjs
//
// Who can do what in Time Tracker. Run: npm run test:time-access
//
// This is a permission boundary with money on the far side of it, so the tests
// are written the unfriendly way round: they assert what each role CANNOT do,
// and they fail if a new action is added without a decision being recorded for
// it. A gap here doesn't crash — it quietly lets the wrong person change a rate.

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

const require = createRequire(import.meta.url);
const { _internals } = require("../netlify/functions/time-tracking.js");
const { capabilitiesFor, accessProblem, ACTION_ACCESS, MANAGER_ROLES, REVIEWER_ROLES } = _internals;

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

const caller = (...roles) => {
  const caps = capabilitiesFor(roles);
  return { roles, isManager: caps.manage, canReview: caps.review };
};

const NOBODY = caller();
const CONTRACTOR = caller("contractor");
const OPERATIONS = caller("operations");
const REVIEWER = caller("timesheet-reviewer");
const ADMIN = caller("admin");

const allows = (who, action) => accessProblem(who, action) === null;

// ── the tiers ───────────────────────────────────────────────────────────────

test("an admin is both tiers", () => {
  const c = capabilitiesFor(["admin"]);
  assert.equal(c.manage, true);
  assert.equal(c.review, true, "a manager is always a reviewer");
});

test("a reviewer reviews but does not manage", () => {
  const c = capabilitiesFor(["timesheet-reviewer"]);
  assert.equal(c.review, true);
  assert.equal(c.manage, false, "the whole point of the role");
});

test("no role, and every unrelated role, gets neither", () => {
  for (const roles of [[], ["contractor"], ["operations"], ["programs"], ["member"], ["outreach", "flights"]]) {
    const c = capabilitiesFor(roles);
    assert.equal(c.review, false, roles.join(",") || "(none)");
    assert.equal(c.manage, false, roles.join(",") || "(none)");
  }
});

test("roles that aren't an array don't crash into a permission", () => {
  for (const junk of [null, undefined, "admin", 7, {}]) {
    const c = capabilitiesFor(junk);
    assert.equal(c.review, false, String(junk));
    assert.equal(c.manage, false, String(junk));
  }
});

test("holding a second role alongside doesn't dilute or widen", () => {
  assert.deepEqual(capabilitiesFor(["contractor", "timesheet-reviewer"]), { review: true, manage: false });
  assert.deepEqual(capabilitiesFor(["timesheet-reviewer", "admin"]), { review: true, manage: true });
});

// ── the table ───────────────────────────────────────────────────────────────

test("every route has a recorded decision", () => {
  // The list is duplicated here on purpose. Adding a route to the function
  // without adding it to ACTION_ACCESS should fail here rather than inherit
  // whatever the loosest default happens to be.
  const routes = [
    "me", "entries", "projects", "start", "stop", "discard",
    "create-entry", "update-entry", "delete-entry", "import-entries", "undo-import",
    "contractors", "approvals", "approve", "unapprove",
    "save-contractor", "save-project", "delete-project", "push-payment", "restore-exact",
  ];
  for (const r of routes) {
    assert.ok(ACTION_ACCESS[r], `no access level recorded for "${r}"`);
    assert.ok(["self", "review", "manage"].includes(ACTION_ACCESS[r]), `"${r}" has an unknown level`);
  }
  assert.deepEqual(Object.keys(ACTION_ACCESS).sort(), [...routes].sort(),
    "ACTION_ACCESS and the route list have diverged");
});

test("money moves only for an admin", () => {
  // The four that change what someone is owed, plus the migration that rewrites
  // recorded minutes.
  for (const action of ["save-contractor", "save-project", "delete-project", "push-payment", "restore-exact"]) {
    assert.equal(allows(ADMIN, action), true, `admin should do ${action}`);
    assert.equal(allows(REVIEWER, action), false, `a reviewer must NOT ${action}`);
    assert.equal(allows(OPERATIONS, action), false);
    assert.equal(allows(CONTRACTOR, action), false);
    assert.equal(allows(NOBODY, action), false);
  }
});

test("a reviewer sees the team and signs a period off", () => {
  for (const action of ["contractors", "approvals", "approve", "unapprove"]) {
    assert.equal(allows(REVIEWER, action), true, `a reviewer should ${action}`);
    assert.equal(allows(ADMIN, action), true);
    assert.equal(allows(OPERATIONS, action), false, `operations must NOT ${action}`);
    assert.equal(allows(CONTRACTOR, action), false);
    assert.equal(allows(NOBODY, action), false);
  }
});

test("approving is allowed but paying is not — that's the whole seam", () => {
  assert.equal(allows(REVIEWER, "approve"), true);
  assert.equal(allows(REVIEWER, "push-payment"), false);
});

test("self-service is open to everyone signed in", () => {
  for (const action of ["me", "entries", "start", "stop", "create-entry", "update-entry", "delete-entry"]) {
    assert.equal(allows(NOBODY, action), true, `${action} is self-service`);
  }
});

test("an unknown action isn't granted by the table", () => {
  // It falls through to the router's own 400 rather than being waved past.
  assert.equal(accessProblem(NOBODY, "drop-tables"), null);
  assert.equal(ACTION_ACCESS["drop-tables"], undefined);
});

test("the refusal names the role that would help", () => {
  assert.match(accessProblem(OPERATIONS, "contractors"), /timesheet-reviewer/);
  assert.match(accessProblem(REVIEWER, "push-payment"), /admin/);
});

// ── the wiring ──────────────────────────────────────────────────────────────
// Three lines in the function carry this boundary. They are checked here
// because losing any one of them fails open, quietly, with every test above
// still passing.

const SOURCE = readFileSync(new URL("../netlify/functions/time-tracking.js", import.meta.url), "utf8");

test("the table is enforced before any handler runs", () => {
  assert.match(SOURCE, /const denied = accessProblem\(caller, action\);\s*\n\s*if \(denied\) return bad\(denied, 403\);/,
    "accessProblem must be called and acted on before dispatch");
});

test("reading someone else's entries asks for review, not manage", () => {
  assert.match(SOURCE, /targetContractorId\(caller, self, qs\.contractor_id, 'review'\)/);
});

test("writing an entry against someone else still asks for manage", () => {
  // No fourth argument — the default. A reviewer may read another person's
  // time; putting hours on their timesheet is a different act.
  assert.match(SOURCE, /targetContractorId\(caller, self, body\.contractor_id\)/);
});

// ── the role lists themselves ───────────────────────────────────────────────

test("the manager list is still admin alone", () => {
  // Widening this silently hands out rates and payments, so it gets its own
  // assertion rather than being implied by the cases above.
  assert.deepEqual(MANAGER_ROLES, ["admin"]);
});

test("the reviewer list adds exactly one role", () => {
  assert.deepEqual([...REVIEWER_ROLES].sort(), ["admin", "timesheet-reviewer"]);
});

let failed = 0;
for (const [name, fn] of tests) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.error(`  ✗ ${name}\n    ${err.message}`); }
}
console.log(`\n${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);

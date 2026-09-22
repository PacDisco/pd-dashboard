// test/dashboard-access.smoke.mjs
//
// Drives the real index.html in a browser against a stubbed /api, so the
// person-first access editor is exercised end to end: who shows up, what the
// checkboxes do, and — the bit worth catching — exactly what PUT body lands on
// the server when you press Save.
//
// Run: npm run test:access-ui

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { chromium } from "playwright";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const DASHBOARDS = [
  { slug: "flights", title: "Flights", category: "Operations", icon: "✈️", allowedRoles: ["admin", "operations", "flights"], url: "/flights/" },
  { slug: "invoices", title: "Invoices", category: "Finance", icon: "📄", allowedRoles: ["admin", "operations"], url: "/invoices/" },
  { slug: "pipeline", title: "Pipeline", category: "Enrollment", icon: "🪜", allowedRoles: ["admin", "admissions"], url: "/pipeline/" },
];
const USERS = [
  { id: "u-admin", email: "jake@example.com", full_name: "Jake", roles: ["admin"], invited: false },
  { id: "u-megan", email: "Megan@example.com", full_name: "Megan Nyhuis", roles: ["admissions"], invited: false },
  { id: "u-new", email: "newbie@example.com", full_name: "New Person", roles: [], invited: true },
];

// ── a static server for the page ────────────────────────────────────────────
const server = http.createServer((req, res) => {
  const file = req.url === "/" ? "/index.html" : req.url.split("?")[0];
  try {
    const body = fs.readFileSync(path.join(ROOT, file));
    res.writeHead(200, { "Content-Type": file.endsWith(".html") ? "text/html" : "text/plain" });
    res.end(body);
  } catch {
    res.writeHead(404).end("nope");
  }
});
await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
const page = await browser.newPage();

let savedGrants = null;
let patchedRoles = [];
let grantsState = { version: 1, users: {} };

// Stub the Identity widget (the real one is a CDN script we don't want to hit).
await page.route("**/netlify-identity-widget.js", (route) =>
  route.fulfill({
    contentType: "application/javascript",
    body: `
      const u = { email: "jake@example.com", user_metadata: { full_name: "Jake" },
                  app_metadata: { roles: ["admin"] }, jwt: async () => "stub.jwt.token" };
      const handlers = {};
      window.netlifyIdentity = {
        on: (e, fn) => { handlers[e] = fn; },
        init: () => { setTimeout(() => handlers.init && handlers.init(u), 0); },
        currentUser: () => u, open(){}, close(){}, logout(){},
      };`,
  })
);

await page.route("**/.netlify/functions/config", async (route) => {
  const req = route.request();
  if (req.method() === "PUT") {
    savedGrants = JSON.parse(req.postData() || "{}").grants;
    grantsState = { version: 1, users: savedGrants };
    return route.fulfill({ json: { ok: true, users: Object.keys(savedGrants).length } });
  }
  return route.fulfill({
    json: { generatedAt: new Date().toISOString(), isAdmin: true, dashboards: DASHBOARDS, grants: grantsState },
  });
});

await page.route("**/.netlify/functions/users**", async (route) => {
  const req = route.request();
  if (req.method() === "PATCH") {
    patchedRoles.push({ url: req.url(), roles: JSON.parse(req.postData() || "{}").roles });
    return route.fulfill({ json: { ok: true } });
  }
  return route.fulfill({ json: { users: USERS, total: USERS.length } });
});

const errors = [];
page.on("pageerror", (e) => errors.push(e.message));

// ── run ─────────────────────────────────────────────────────────────────────
const checks = [];
const check = async (name, fn) => {
  try { await fn(); checks.push([name, null]); }
  catch (err) { checks.push([name, err.message]); }
};

await page.goto(base, { waitUntil: "domcontentloaded" });
await page.waitForSelector(".card", { timeout: 10000 });

await check("admin sees every dashboard on the grid", async () => {
  assert.equal(await page.locator(".card").count(), DASHBOARDS.length);
});

await check("grid tags read role-based before anything is assigned", async () => {
  assert.equal((await page.locator(".role-tag").first().textContent()).trim(), "role-based");
});

await page.click("#adminBtn");
await page.waitForSelector(".person", { timeout: 10000 });

await check("everyone in Identity is listed, by name", async () => {
  const names = await page.locator(".person .who").allTextContents();
  assert.deepEqual(names, ["Jake", "Megan Nyhuis", "New Person"]);
});

await check("an admin's row says so, and their checkboxes are locked", async () => {
  await page.locator('.person[data-email="jake@example.com"]').click();
  assert.match(await page.locator(".person.active .meta").last().textContent(), /admin/);
  assert.equal(await page.locator(".grant-item input:disabled").count(), DASHBOARDS.length);
});

await check("an unassigned person is flagged as still running on roles", async () => {
  await page.locator('.person[data-email="megan@example.com"]').click();
  assert.match(await page.locator("#grantPane .banner").first().textContent(), /still comes from their roles/);
  assert.equal(await page.locator(".grant-item input:checked").count(), 0);
});

await check("ticking a dashboard updates that person's summary", async () => {
  await page.locator('.grant-item[data-slug="invoices"] input').check();
  await page.locator('.grant-item[data-slug="pipeline"] input').check();
  assert.match(await page.locator(".person.active .meta").last().textContent(), /2 dashboards/);
});

await check("All / None act on the selected person only", async () => {
  await page.click("#grantNone");
  assert.match(await page.locator(".person.active .meta").last().textContent(), /no dashboards/);
  await page.click("#grantAll");
  assert.equal(await page.locator(".grant-item input:checked").count(), DASHBOARDS.length);
  await page.click("#grantNone");
  await page.locator('.grant-item[data-slug="pipeline"] input').check();
});

await check("seeding from roles reproduces today's access", async () => {
  page.once("dialog", (d) => d.accept());
  await page.click("#seedBtn");
  await page.waitForTimeout(150);
  await page.locator('.person[data-email="megan@example.com"]').click();
  // admissions → pipeline only
  const checked = await page.locator(".grant-item input:checked").count();
  assert.equal(checked, 1);
  assert.equal(await page.locator('.grant-item[data-slug="pipeline"] input').isChecked(), true);
});

await check("Save sends one grants map keyed by lowercased email", async () => {
  await page.click("#savePermsBtn");
  await page.waitForTimeout(400);
  assert.ok(savedGrants, "no PUT body captured");
  assert.deepEqual(Object.keys(savedGrants).sort(), ["jake@example.com", "megan@example.com", "newbie@example.com"]);
  assert.deepEqual(savedGrants["megan@example.com"], ["pipeline"]);
  assert.deepEqual(savedGrants["jake@example.com"].sort(), DASHBOARDS.map((d) => d.slug).sort());
  assert.deepEqual(savedGrants["newbie@example.com"], [], "a person with no roles seeds to nothing");
});

await check("nobody gets a baseline role they don't need", async () => {
  // newbie ended up with an empty list, so there's nothing to reach — and
  // handing out `member` regardless would be quiet privilege creep.
  assert.deepEqual(patchedRoles, []);
});

await check("granting a role-less person gets them the member role", async () => {
  await page.locator('.person[data-email="newbie@example.com"]').click();
  await page.locator('.grant-item[data-slug="flights"] input').check();
  await page.click("#savePermsBtn");
  await page.waitForTimeout(400);
  assert.equal(patchedRoles.length, 1, "expected exactly one role PATCH");
  assert.match(patchedRoles[0].url, /u-new/);
  assert.deepEqual(patchedRoles[0].roles, ["member"]);
  assert.deepEqual(savedGrants["newbie@example.com"], ["flights"]);
});

await check("saved counts show up on the grid", async () => {
  await page.click("#closeModalBtn");
  const tags = await page.locator(".role-tag").allTextContents();
  assert.ok(tags.some((t) => /person|people/.test(t)), `expected a people count, got ${JSON.stringify(tags)}`);
});

await check("no uncaught page errors", async () => {
  assert.deepEqual(errors, []);
});

await browser.close();
server.close();

let failed = 0;
for (const [name, err] of checks) {
  if (err) { failed++; console.error(`  ✗ ${name}\n    ${err}`); }
  else console.log(`  ✓ ${name}`);
}
console.log(`\n${checks.length - failed}/${checks.length} passed`);
process.exit(failed ? 1 : 0);

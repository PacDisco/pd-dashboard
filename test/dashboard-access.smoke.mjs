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
await page.waitForSelector(".matrix", { timeout: 10000 });

const cell = (email, slug) => page.locator(`.matrix input[data-email="${email}"][data-slug="${slug}"]`);
const colHeader = (email) => page.locator(`.col-person[data-email="${email}"]`);

await check("there is a column per person, in name order", async () => {
  const names = await page.locator(".col-person .pname").allTextContents();
  assert.deepEqual(names, ["Jake", "Megan Nyhuis", "New Person"]);
});

await check("there is a row per dashboard", async () => {
  assert.equal(await page.locator(".matrix tbody tr").count(), DASHBOARDS.length);
});

await check("an admin's column is ticked throughout and locked", async () => {
  assert.equal(await colHeader("jake@example.com").locator(".pmeta.admin").count(), 1);
  const boxes = page.locator('.matrix input[data-email="jake@example.com"]');
  assert.equal(await boxes.count(), DASHBOARDS.length);
  for (let i = 0; i < DASHBOARDS.length; i++) {
    assert.equal(await boxes.nth(i).isChecked(), true);
    assert.equal(await boxes.nth(i).isDisabled(), true);
  }
});

await check("an unassigned column is shaded and shows what roles give them", async () => {
  assert.equal(await colHeader("megan@example.com").locator(".pmeta.roles").count(), 1);
  // Megan is `admissions` → pipeline only.
  assert.equal(await cell("megan@example.com", "pipeline").isChecked(), true);
  assert.equal(await cell("megan@example.com", "flights").isChecked(), false);
  assert.equal(await cell("megan@example.com", "invoices").isChecked(), false);
  assert.equal(await page.locator('.matrix td.cell.inherited input[data-email="megan@example.com"]').count(), DASHBOARDS.length);
});

await check("ticking an inherited cell keeps what was on screen and adds the change", async () => {
  await cell("megan@example.com", "invoices").check();
  // pipeline came from her role and must survive being written down.
  assert.equal(await cell("megan@example.com", "pipeline").isChecked(), true);
  assert.equal(await cell("megan@example.com", "invoices").isChecked(), true);
  assert.equal(await cell("megan@example.com", "flights").isChecked(), false);
  assert.equal(await colHeader("megan@example.com").locator(".pmeta.roles").count(), 0, "column should no longer read as role-based");
  assert.equal((await colHeader("megan@example.com").locator(".pmeta").textContent()).trim(), "2");
});

await check("unticking removes just that one", async () => {
  await cell("megan@example.com", "invoices").uncheck();
  assert.equal((await colHeader("megan@example.com").locator(".pmeta").textContent()).trim(), "1");
});

await check("clicking a person's name fills then clears their column", async () => {
  await colHeader("newbie@example.com").click();
  for (const d of DASHBOARDS) assert.equal(await cell("newbie@example.com", d.slug).isChecked(), true);
  await colHeader("newbie@example.com").click();
  for (const d of DASHBOARDS) assert.equal(await cell("newbie@example.com", d.slug).isChecked(), false);
});

await check("clicking a person's name does nothing to an admin", async () => {
  await colHeader("jake@example.com").click();
  const boxes = page.locator('.matrix input[data-email="jake@example.com"]');
  for (let i = 0; i < DASHBOARDS.length; i++) assert.equal(await boxes.nth(i).isChecked(), true);
});

await check("clicking a dashboard gives it to everyone shown, then takes it back", async () => {
  await page.locator('.row-toggle[data-slug="flights"]').click();
  assert.equal(await cell("megan@example.com", "flights").isChecked(), true);
  assert.equal(await cell("newbie@example.com", "flights").isChecked(), true);
  await page.locator('.row-toggle[data-slug="flights"]').click();
  assert.equal(await cell("megan@example.com", "flights").isChecked(), false);
  assert.equal(await cell("newbie@example.com", "flights").isChecked(), false);
});

await check("filtering narrows the columns", async () => {
  await page.fill("#peopleFilter", "megan");
  assert.equal(await page.locator(".col-person").count(), 1);
  await page.fill("#peopleFilter", "");
  assert.equal(await page.locator(".col-person").count(), 3);
});

await check("seeding from roles reproduces today's access", async () => {
  page.once("dialog", (d) => d.accept());
  await page.click("#seedBtn");
  await page.waitForTimeout(150);
  assert.equal(await cell("megan@example.com", "pipeline").isChecked(), true);
  assert.equal(await cell("megan@example.com", "invoices").isChecked(), false);
  for (const d of DASHBOARDS) assert.equal(await cell("newbie@example.com", d.slug).isChecked(), false, "no roles → nothing");
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
  assert.deepEqual(patchedRoles, []);
});

await check("granting a role-less person gets them the member role", async () => {
  await cell("newbie@example.com", "flights").check();
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

// npm run test:lead-alerts-ui
// Drives the real Lead Alerts phone app (/lead-alerts/) in headless Chromium
// at phone size against an in-memory /api/lead-alerts. Netlify Identity and
// the browser push service are stubbed. Skips cleanly without Playwright.
//
//   PW_CHROMIUM=/path/to/chrome  use a specific Chromium build
//   SHOTS=dir                    save screenshots there
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

let chromium, devices;
try { ({ chromium, devices } = await import("playwright")); } catch { console.log("SKIP: playwright not installed"); process.exit(0); }

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".png": "image/png", ".webmanifest": "application/manifest+json" };
const SHOTS = process.env.SHOTS;

const min = (m) => new Date(Date.now() - m * 60_000).toISOString();
const db = {
  seenAt: min(30),
  events: [
    { id: "app2:a", type: "app_submitted", label: "Application submitted", occurredAt: min(4), detectedAt: min(3), name: "Jane Doe", email: "jane@example.com", phone: "+1 555 0100", detail: "Southeast Asia Semester · Fall 2027", source: "", hubspotUrl: "https://app.hubspot.com/contacts/1/record/0-1/9" },
    { id: "quiz:b", type: "quiz", label: "Quiz completed", occurredAt: min(22), detectedAt: min(21), name: "Sam Lee", email: "sam@example.com", phone: "", detail: "Result: The Explorer", source: "", hubspotUrl: null },
    { id: "hs:c", type: "new_lead", label: "New lead", occurredAt: min(75), detectedAt: min(74), name: "Kai Moana", email: "kai@example.com", phone: "+1 555 0300", detail: "Booklet download", source: "Paid social", hubspotUrl: "https://app.hubspot.com/x" },
    { id: "app1:d", type: "app_started", label: "Application started", occurredAt: min(200), detectedAt: min(199), name: "Ana Ruiz", email: "ana@example.com", phone: "", detail: "Fall 2027", source: "", hubspotUrl: null, handledAt: min(180), handledBy: "Megan", handledHow: "Marked contacted" },
  ],
  calls: [],
  prefs: { tz: null, schedule: null, always: true, availableNow: true, nextChangeAt: null },
};
// One that came in overnight while she was off: its hour starts at 9am tomorrow-ish.
const later = new Date(Date.now() + 5 * 3600_000).toISOString();
db.events.push({ id: "quiz:night", type: "quiz", label: "Quiz completed", occurredAt: min(10), detectedAt: min(31), name: "Nora Night", email: "nora@example.com", phone: "", detail: "", source: "", hubspotUrl: null,
  offHours: true, clockStartAt: later, dueAt: new Date(Date.parse(later) + 3600_000).toISOString() });
function feed() {
  const seen = Date.parse(db.seenAt);
  const events = db.events.map((e) => ({ handledAt: null, handledBy: "", handledHow: "", ...e, isNew: Date.parse(e.detectedAt) > seen }));
  const open = events.filter((e) => !e.handledAt);
  return { events, seenAt: db.seenAt, newCount: events.filter((e) => e.isNew).length,
    stats: { open: open.length, overdue: open.filter((e) => Date.now() - Date.parse(e.occurredAt) > 3600_000).length, medianMinutes: 20, withinHourPct: 100, handled: 1 },
    prefs: db.prefs, me: { email: "advisor@pacificdiscovery.org", isAdmin: true }, devices: db.calls.filter((c) => c.path.endsWith("/subscribe")).length ? 1 : 0,
    vapidPublicKey: "BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U",
    followUpMinutes: 60, remindAfterMinutes: 45, generatedAt: new Date().toISOString() };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname.startsWith("/api/")) {
    let body = "";
    for await (const c of req) body += c;
    const json = body ? JSON.parse(body) : undefined;
    db.calls.push({ path: url.pathname, method: req.method, body: json, auth: req.headers.authorization });
    const send = (status, j) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(j)); };
    if (req.headers.authorization !== "Bearer test-jwt") return send(401, { error: "Not signed in" });
    if (url.pathname === "/api/lead-alerts" && req.method === "GET") return send(200, feed());
    if (url.pathname === "/api/lead-alerts/seen") { db.seenAt = new Date().toISOString(); return send(200, { ok: true }); }
    if (url.pathname === "/api/lead-alerts/handled") {
      const e = db.events.find((x) => x.id === json.id);
      Object.assign(e, json.undo ? { handledAt: null, handledBy: "", handledHow: "" } : { handledAt: new Date().toISOString(), handledBy: "Advisor", handledHow: "Marked contacted" });
      return send(200, { ok: true, event: { ...e, isNew: false } });
    }
    if (url.pathname === "/api/lead-alerts/subscribe") return send(200, { ok: true });
    if (url.pathname === "/api/lead-alerts/prefs") {
      db.prefs = json.schedule
        ? { tz: json.tz, schedule: json.schedule, always: false, availableNow: false, nextChangeAt: new Date(Date.now() + 3600_000).toISOString() }
        : { tz: json.tz, schedule: null, always: true, availableNow: true, nextChangeAt: null };
      return send(200, { ok: true, prefs: db.prefs });
    }
    if (url.pathname === "/api/tile-badges") return send(200, { ok: true });
    return send(404, { error: "unhandled" });
  }
  let file = path.join(ROOT, decodeURIComponent(url.pathname));
  if (file.endsWith("/")) file += "index.html";
  if (!file.startsWith(ROOT) || !fs.existsSync(file)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const ORIGIN = `http://localhost:${server.address().port}`;

// Netlify Identity widget stub: signed in unless window.__signedOut.
const IDENTITY_STUB = `
  window.netlifyIdentity = (() => {
    const h = {}; let user = window.__signedOut ? null : { email: "advisor@pacificdiscovery.org", user_metadata: { full_name: "Advisor" }, jwt: async () => "test-jwt" };
    return { on: (e, f) => { (h[e] = h[e] || []).push(f); }, init: () => setTimeout(() => (h.init || []).forEach((f) => f(user)), 0),
             currentUser: () => user, open: () => {}, close: () => {}, logout: () => { user = null; (h.logout || []).forEach((f) => f()); } };
  })();`;
// The headless browser has no push service; fake a subscription.
const PUSH_STUB = `
  if (window.PushManager) {
    let sub = null;
    PushManager.prototype.getSubscription = async () => sub;
    PushManager.prototype.subscribe = async () => (sub = { endpoint: "https://push.example/1", toJSON: () => ({ endpoint: "https://push.example/1", keys: { p256dh: "p", auth: "a" } }), unsubscribe: async () => { sub = null; return true; } });
  }`;

const browser = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
const errors = [];
async function phone({ ios = false, signedOut = false } = {}) {
  const base = ios ? devices["iPhone 14"] : devices["Pixel 7"];
  const ctx = await browser.newContext({ ...base, permissions: ["notifications", "clipboard-read", "clipboard-write"], defaultBrowserType: undefined, timezoneId: "America/Los_Angeles" });
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
  await ctx.route(/identity\.netlify\.com/, (r) => r.fulfill({ contentType: "text/javascript", body: IDENTITY_STUB }));
  await ctx.addInitScript(`window.__signedOut = ${signedOut}; window.__nav = []; window.__laNavigate = (u) => window.__nav.push(u); ${PUSH_STUB}`);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  return { ctx, page };
}

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test("signed out → sign-in screen", async () => {
  const { ctx, page } = await phone({ signedOut: true });
  await page.goto(`${ORIGIN}/lead-alerts/`);
  await page.waitForSelector("#gate:not([hidden])");
  assert.equal(await page.isVisible("#app"), false);
  await ctx.close();
});

test("feed: red bubble counts what's new since last open; overdue is flagged; oldest open first", async () => {
  const { ctx, page } = await phone();
  await page.goto(`${ORIGIN}/lead-alerts/`);
  await page.waitForSelector(".card");
  assert.equal(await page.textContent("#bubble"), "2");
  assert.equal(await page.isVisible("#bubble"), true);
  const names = await page.$$eval(".card .name", (els) => els.map((e) => e.textContent));
  assert.deepEqual(names, ["Kai Moana", "Sam Lee", "Jane Doe", "Nora Night"], "soonest due first; the off-hours one last");
  assert.match(await page.textContent("#ev-quiz\\:night .clock"), /Came in off-hours · due/);
  assert.equal(await page.isVisible("#ev-quiz\\:night .chip.off"), true);
  assert.equal(await page.$$eval(".card.overdue", (els) => els.length), 1);
  assert.match(await page.textContent("#ev-hs\\:c .clock"), /Overdue by/);
  assert.match(await page.textContent("#ev-app2\\:a .clock"), /min left · follow up by/);
  assert.equal(await page.$$eval(".newdot", (els) => els.length), 2);
  assert.equal(await page.getAttribute("#ev-app2\\:a [data-copy]", "aria-disabled"), null);
  assert.equal(await page.getAttribute("#ev-quiz\\:b [data-copy]", "aria-disabled"), "true", "no phone → nothing to copy");
  assert.equal(await page.getAttribute("#ev-app2\\:a a.act", "href"), "https://app.hubspot.com/contacts/1/record/0-1/9");
  assert.equal(await page.getAttribute("#ev-quiz\\:b a.act", "aria-disabled"), "true", "not in HubSpot yet → no HubSpot button");
  // Opening the app marks everything seen, and clears the landing-page tile bubble too.
  await page.waitForTimeout(200);
  assert.ok(db.calls.some((c) => c.path === "/api/lead-alerts/seen"));
  assert.ok(db.calls.some((c) => c.path === "/api/tile-badges" && c.body.slug === "lead-alerts"));
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, "lead-alerts-feed.png"), fullPage: true });
  await ctx.close();
});

test("reopening after seen: no bubble", async () => {
  const { ctx, page } = await phone();
  await page.goto(`${ORIGIN}/lead-alerts/`);
  await page.waitForSelector(".card");
  assert.equal(await page.isVisible("#bubble"), false);
  await ctx.close();
});

test("Copy number and Open Aircall (Android launches the Aircall app by package)", async () => {
  const { ctx, page } = await phone();
  await page.goto(`${ORIGIN}/lead-alerts/`);
  await page.waitForSelector(".card");
  const labels = await page.$$eval("#ev-app2\\:a .act span", (els) => els.map((e) => e.textContent));
  assert.deepEqual(labels, ["Copy number", "Open Aircall", "HubSpot", "Contacted"]);
  await page.click("#ev-app2\\:a [data-copy]");
  await page.waitForFunction(() => /Number copied/.test(document.querySelector("#toast").textContent));
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), "+1 555 0100");
  await page.evaluate(() => navigator.clipboard.writeText(""));
  await page.click("#ev-app2\\:a [data-aircall]");
  await page.waitForFunction(() => window.__nav.length > 0);
  assert.match(await page.evaluate(() => window.__nav.pop()), /^intent:#Intent;.*package=com\.aircall;end$/);
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), "+1 555 0100", "Open Aircall copies the number first");
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, "lead-alerts-buttons.png") });
  await ctx.close();
});

test("Contacted moves a card to Done; Undo brings it back", async () => {
  const { ctx, page } = await phone();
  await page.goto(`${ORIGIN}/lead-alerts/`);
  await page.waitForSelector(".card");
  await page.click("#ev-quiz\\:b [data-done]");
  await page.waitForFunction(() => !document.querySelector("#ev-quiz\\:b"));
  assert.equal(await page.textContent("#nOpen"), "3");
  await page.click('.tab[data-tab="done"]');
  await page.waitForSelector("#ev-quiz\\:b .clock.ok");
  assert.match(await page.textContent("#ev-quiz\\:b .clock"), /Marked contacted by Advisor/);
  await page.click("#ev-quiz\\:b [data-undo]");
  await page.waitForFunction(() => !document.querySelector("#ev-quiz\\:b"));
  assert.equal(db.events.find((e) => e.id === "quiz:b").handledAt, null);
  await ctx.close();
});

test("Turn on notifications registers this phone with the server", async () => {
  const { ctx, page } = await phone();
  await page.goto(`${ORIGIN}/lead-alerts/`);
  await page.waitForSelector("#enableBtn");
  await page.click("#enableBtn");
  await page.waitForFunction(() => !document.querySelector("#enableBtn"));
  const call = db.calls.find((c) => c.path === "/api/lead-alerts/subscribe");
  assert.equal(call.body.subscription.endpoint, "https://push.example/1");
  assert.equal(await page.isVisible("#testBtn"), true);
  await ctx.close();
});

test("available hours: defaults to 24/7; set weekdays 9–5; held state is shown", async () => {
  const { ctx, page } = await phone();
  await page.goto(`${ORIGIN}/lead-alerts/`);
  await page.waitForSelector("#duty:not([hidden])");
  assert.match(await page.textContent("#duty"), /On 24\/7/);
  await page.click("#duty");
  await page.waitForSelector("#hoursBg:not([hidden])");
  assert.equal(await page.isChecked("#hAlways"), true);
  assert.equal(await page.isVisible("#hDays"), false);
  await page.click("#hAlways");
  await page.click('[data-preset="weekdays"]');
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, "lead-alerts-hours.png") });
  await page.click("#hSave");
  await page.waitForSelector("#hoursBg", { state: "hidden" });
  const call = db.calls.filter((c) => c.path === "/api/lead-alerts/prefs").pop();
  assert.equal(call.body.tz, "America/Los_Angeles");
  assert.equal(call.body.schedule.days.length, 7);
  assert.deepEqual(call.body.schedule.days[0], []);
  assert.deepEqual(call.body.schedule.days[1], [{ s: "09:00", e: "17:00" }]);
  await page.waitForFunction(() => /alerts are being held/.test(document.querySelector("#duty").textContent));
  assert.equal(await page.$eval("#duty", (el) => el.classList.contains("off")), true);
  // Back to 24/7.
  await page.click("#duty");
  await page.click("#hAlways");
  await page.click("#hSave");
  await page.waitForFunction(() => /On 24\/7/.test(document.querySelector("#duty").textContent));
  assert.equal(db.calls.filter((c) => c.path === "/api/lead-alerts/prefs").pop().body.schedule, null);
  await ctx.close();
});

test("iPhone: Open Aircall goes to aircall://", async () => {
  const { ctx, page } = await phone({ ios: true });
  await page.goto(`${ORIGIN}/lead-alerts/`);
  await page.waitForSelector(".card");
  assert.equal(await page.isVisible("#openAcBtn"), true);
  await page.click("#ev-app2\\:a [data-aircall]");
  await page.waitForFunction(() => window.__nav.length > 0);
  assert.equal(await page.evaluate(() => window.__nav.pop()), "aircall://");
  await ctx.close();
});

test("iPhone in Safari (not installed) is told to add it to the Home Screen", async () => {
  const { ctx, page } = await phone({ ios: true });
  await page.goto(`${ORIGIN}/lead-alerts/`);
  await page.waitForSelector(".card");
  assert.match(await page.textContent("#setup"), /Add this to your Home Screen first/);
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, "lead-alerts-ios-install.png") });
  await ctx.close();
});

test("manifest + service worker are valid", async () => {
  const m = JSON.parse(fs.readFileSync(path.join(ROOT, "lead-alerts/manifest.webmanifest"), "utf8"));
  assert.equal(m.display, "standalone");
  for (const i of m.icons) assert.ok(fs.existsSync(path.join(ROOT, i.src)), i.src);
  const { ctx, page } = await phone();
  await page.goto(`${ORIGIN}/lead-alerts/`);
  const scope = await page.evaluate(async () => (await navigator.serviceWorker.ready).scope);
  assert.equal(new URL(scope).pathname, "/lead-alerts/");
  await ctx.close();
});

let failed = 0;
for (const [name, fn] of tests) {
  try { await fn(); console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.error(`  ✗ ${name}\n    ${e.stack || e.message}`); }
}
if (errors.length) { failed++; console.error("page errors:\n  " + errors.join("\n  ")); }
await browser.close();
server.close();
console.log(failed ? `\n${failed} failed` : `\nall ${tests.length} passed`);
process.exit(failed ? 1 : 0);

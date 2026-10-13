// npm run test:popups-ui
// 1. Drives the real popup designer (/popups/) in headless Chromium against an
//    in-memory /api/popups that uses the real validation code.
// 2. Loads the real embed script on a fake pacificdiscovery.org page and
//    checks targeting, timing, the form, and what gets submitted.
// Skips cleanly without Playwright.
//
//   PW_CHROMIUM=/path/to/chrome  use a specific Chromium build
//   SHOTS=dir                    save screenshots there
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { normalizePopup, validateDoc, blankPopup, FIELD_DEFS, matchPage, publicConfig } from "../netlify/functions/_shared/popups-core.mjs";
import { embedScript, previewScript } from "../netlify/functions/_shared/popup-runtime.mjs";

let chromium;
try { ({ chromium } = await import("playwright")); } catch { console.log("SKIP: playwright not installed"); process.exit(0); }

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DASH = "https://dash.test";
const SITE = "https://www.pacificdiscovery.org";
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json" };

const db = { rev: 0, popups: [], saves: 0 };
const PROPS = [
  { name: "firstname", label: "First Name", type: "string", fieldType: "text", options: [] },
  { name: "phone", label: "Phone Number", type: "string", fieldType: "phonenumber", options: [] },
  { name: "program_interest", label: "Program Interest", type: "enumeration", fieldType: "select", options: [{ label: "South America Semester", value: "SAS" }, { label: "Southeast Asia Semester", value: "SEA" }] },
  { name: "program_dates", label: "Program Dates", type: "enumeration", fieldType: "select", options: [{ label: "Spring 2027", value: "spring_2027" }, { label: "Fall 2027", value: "fall_2027" }] },
];

function popupsApi(method, url, body) {
  const action = url.searchParams.get("action") || body?.action;
  if (method === "GET" && action === "list") return [200, { rev: db.rev, popups: db.popups, stats: { [db.popups[0]?.id]: db.popups[0] ? { submits: 3, last: new Date().toISOString() } : undefined }, blank: blankPopup("New popup"), fieldDefs: FIELD_DEFS, embedUrl: `${DASH}/api/popup-embed` }];
  if (method === "GET" && action === "properties") return [200, { properties: PROPS }];
  if (action === "save") {
    if (body.rev !== db.rev) return [409, { error: "conflict" }];
    const doc = { rev: db.rev + 1, popups: body.popups.map(normalizePopup) };
    const problem = validateDoc(doc);
    if (problem) return [400, { error: problem }];
    Object.assign(db, doc);
    db.saves++;
    return [200, { rev: db.rev, popups: db.popups }];
  }
  return [400, { error: `unhandled ${action}` }];
}

const browser = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const submits = [];

await ctx.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
await ctx.route(`${DASH}/**`, async (route) => {
  const req = route.request();
  const url = new URL(req.url());
  if (url.pathname === "/api/popups") {
    const [status, body] = popupsApi(req.method(), url, req.postData() ? JSON.parse(req.postData()) : null);
    return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
  }
  if (url.pathname === "/api/popup-embed") {
    const js = url.searchParams.has("runtime") ? previewScript(matchPage) : embedScript(matchPage, publicConfig(db, DASH), `${DASH}/api/popup-submit`);
    return route.fulfill({ status: 200, contentType: "application/javascript", body: js });
  }
  if (url.pathname === "/api/popup-submit") {
    submits.push(JSON.parse(req.postData()));
    return route.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": SITE }, body: '{"ok":true}' });
  }
  if (url.pathname === "/api/popups-gmail") {
    if (req.method() === "POST") { const b = JSON.parse(req.postData()); db.gmailTests = (db.gmailTests || []).concat([b]); return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, to: b.to }) }); }
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ configured: true, connected: true, email: "info@pacificdiscovery.org", by: "Jake", at: new Date().toISOString(), redirectUri: `${DASH}/api/popups-gmail?action=callback`, lastError: "" }) });
  }
  if (url.pathname === "/api/program-pages") {
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ programs: [{ slug: "japan-mini-semester", name: "Japan Mini Semester", status: "live" }] }) });
  }
  let file = path.join(ROOT, decodeURIComponent(url.pathname));
  if (file.endsWith("/")) file += "index.html";
  if (!file.startsWith(ROOT) || !fs.existsSync(file)) return route.fulfill({ status: 404, body: "nf" });
  return route.fulfill({ status: 200, contentType: TYPES[path.extname(file)] || "application/octet-stream", body: fs.readFileSync(file) });
});
await ctx.route(`${SITE}/**`, (route) => route.fulfill({
  status: 200, contentType: "text/html",
  body: `<!doctype html><html><head><title>Program</title><style>blockquote,button,input{all:unset;color:red!important}</style></head><body style="height:3000px"><h1>Site page</h1><script>window.dataLayer=[];window._hsq=[];</script><script src="${DASH}/api/popup-embed" async></script></body></html>`,
}));

let passed = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); passed++; if (process.env.VERBOSE) console.log("ok", msg); };
const shot = async (p, name) => { if (process.env.SHOTS) await p.screenshot({ path: path.join(process.env.SHOTS, `${name}.png`) }); };
const preview = () => page.frameLocator("#frame");

// ── designer ────────────────────────────────────────────────────────────
await page.goto(`${DASH}/popups/`);
await page.waitForSelector("#list-body .empty");
ok(await page.locator("#gtm-code").textContent() === `<script src="${DASH}/api/popup-embed" async></script>`, "GTM snippet shown");
await page.locator("#list-body [data-new]").click();
await page.waitForSelector("#view-editor:not(.hidden)");
ok(db.popups.length === 1 && db.saves === 1, "new popup saved (off)");
await page.waitForFunction(() => document.querySelector("#frame").contentDocument.querySelector("[data-pd-popup]"));
const shadowText = (sel) => page.evaluate((s) => {
  const host = document.querySelector("#frame").contentDocument.querySelector("[data-pd-popup]");
  const el = host && host.shadowRoot.querySelector(s);
  return el ? el.textContent : null;
}, sel);
ok((await shadowText(".h")) === "Get the full itinerary and dates", "preview shows the popup");

await page.locator('[data-path="headline"]').fill("Plan your gap semester");
await page.waitForTimeout(400);
ok((await shadowText(".h")) === "Plan your gap semester", "preview updates as you type");

await page.locator('.tabs [data-tab="form"]').click();
await page.waitForSelector('[data-fopts="program"]');
await page.waitForFunction(() => document.querySelector('[data-fopts="program"]').value.includes("South America Semester | SAS"));
ok(true, "program choices filled from HubSpot");
ok(await page.locator('select[data-fprop="program"]').inputValue() === "program_interest", "program maps to program_interest");
await page.locator('[data-fon="phone"]').check({ force: true });
await page.waitForTimeout(400);
ok(await page.evaluate(() => !!document.querySelector("#frame").contentDocument.querySelector("[data-pd-popup]").shadowRoot.querySelector('input[name="phone"]')), "phone field appears in preview");
await page.locator('[data-fon="role"]').check({ force: true });
await page.locator('[data-fon="term"]').check({ force: true });

await page.locator("#notify-emails").fill("admissions@pacificdiscovery.org\nJake@BoulderDigitalMedia.com");
await page.locator("#notify-emails").blur();
await page.waitForSelector(".gmail.ok");
ok((await page.locator(".gmail.ok b").textContent()).includes("info@pacificdiscovery.org"), "shows the connected sending mailbox");
await page.locator("#gm-test").click();
await page.waitForFunction(() => document.querySelector(".toast")?.textContent.startsWith("Test email sent"));
ok(db.gmailTests?.[0]?.to.length === 2, "test email goes to the notification list");
await page.locator(".gmail.ok").scrollIntoViewIfNeeded();
await shot(page, "popup-notify");

await page.locator('.tabs [data-tab="where"]').click();
await page.locator('[name=pmode][value=include]').check();
await page.locator('[data-addrule="/programs/*"]').click();
await page.locator("#addprog").selectOption("/programs/japan-mini-semester");
ok((await page.locator("#prules").inputValue()).split("\n").length === 2, "pages added from quick buttons");
await page.locator("#t-delay").fill("2");
await page.locator("#t-exit").uncheck();

await page.locator('.tabs [data-tab="style"]').click();
await page.locator('[data-layout="slide"]').click();
await page.waitForTimeout(400);
ok(await page.evaluate(() => !!document.querySelector("#frame").contentDocument.querySelector("[data-pd-popup]").shadowRoot.querySelector(".card.slide")), "layout switches in preview");
await page.locator('[data-layout="modal"]').click();
await page.locator("#dev-mobile").click();
await page.waitForTimeout(500);
await shot(page, "popup-editor-mobile");
await page.locator("#dev-desktop").click();

ok((await page.locator("#ed-save").textContent()).includes("Unsaved"), "unsaved changes flagged");
await page.locator("#btn-save").click();
await page.waitForFunction(() => document.querySelector("#ed-save").textContent.startsWith("Saved"));
ok(db.popups[0].headline === "Plan your gap semester" && db.popups[0].pages.rules.includes("/programs/*"), "saved");
ok(db.popups[0].fields.find((f) => f.key === "program").options.length === 2, "HubSpot choices saved");
ok(JSON.stringify(db.popups[0].notify.emails) === JSON.stringify(["admissions@pacificdiscovery.org", "jake@boulderdigitalmedia.com"]), "notification list saved");

// switch it on — role dropdown has its default choices so it's valid
await page.locator(".bar .switch").click();
await page.waitForFunction(() => document.querySelector("#ed-on-lbl").textContent === "On");
ok(db.popups[0].enabled === true, "switched on");
await shot(page, "popup-editor");

await page.locator("#btn-back").click();
await page.waitForSelector("table.list");
ok((await page.locator("table.list .chip").first().textContent()) === "On", "list shows On");

// ── the website ─────────────────────────────────────────────────────────
const site = await ctx.newPage();
site.on("pageerror", (e) => errors.push(`site: ${e.message}`));
if (process.env.VERBOSE) site.on("console", (m) => console.log("site console:", m.text()));
await site.goto(`${SITE}/apply`);
await site.waitForTimeout(2600);
ok(await site.locator("[data-pd-popup]").count() === 0, "not on a page outside its rules");

await site.goto(`${SITE}/programs/south-america-gap-semester`);
ok(await site.locator("[data-pd-popup]").count() === 0, "waits for its delay");
if (process.env.VERBOSE) console.log(await site.evaluate(() => [typeof window.__pdPopups, document.scripts.length, JSON.stringify(window.dataLayer)]), errors);
await site.waitForSelector("[data-pd-popup]", { state: "attached", timeout: 4000 });
const sr = (sel) => site.locator("[data-pd-popup]").locator(sel); // Playwright pierces open shadow roots
ok((await sr(".h").textContent()) === "Plan your gap semester", "appears after 2s on a program page");
ok(await sr(".go").evaluate((b) => getComputedStyle(b).color) === "rgb(255, 255, 255)", "site CSS can't restyle the popup");
await shot(site, "popup-site");

await sr(".go").click();
ok((await sr('.f[data-k="email"] .msg').textContent()).length > 0, "required email flagged");
ok(submits.length === 0, "nothing sent while invalid");
await sr('input[name="firstname"]').fill("Anna");
await sr('input[name="email"]').fill("anna@example.com");
await sr('select[name="program"]').selectOption("SEA");
await sr('select[name="role"]').selectOption("Parent");
await site.waitForTimeout(1600); // humans take more than 1.5s
await sr(".go").click();
await sr(".done").waitFor();
ok(submits.length === 1, "submitted once");
const s0 = submits[0];
ok(s0.popup === db.popups[0].id && s0.fields.email === "anna@example.com" && s0.fields.program === "SEA" && s0.fields.role === "Parent", "submitted the right values");
ok(s0.page.uri === `${SITE}/programs/south-america-gap-semester` && s0.t > 1500 && s0.website === "", "page, timing and honeypot sent");
const dl = await site.evaluate(() => window.dataLayer.map((e) => e.event));
ok(dl.includes("pd_popup_view") && dl.includes("pd_popup_submit"), "GTM events pushed");
ok(await site.evaluate(() => JSON.stringify(window._hsq).includes("anna@example.com")), "HubSpot tracking identifies the visitor");

await site.reload();
await site.waitForTimeout(2600);
ok(await site.locator("[data-pd-popup]").count() === 0, "never shown again after signing up");

// closing hides it for the set number of days
const site2 = await ctx.newPage();
await site2.goto(`${SITE}/programs/japan-mini-semester`);
await site2.evaluate(() => localStorage.clear());
await site2.reload();
await site2.waitForSelector("[data-pd-popup]", { state: "attached", timeout: 4000 });
await site2.keyboard.press("Escape");
ok(await site2.locator("[data-pd-popup]").count() === 0, "Esc closes");
await site2.reload();
await site2.waitForTimeout(2600);
ok(await site2.locator("[data-pd-popup]").count() === 0, "stays closed after closing");

// phones: bottom sheet
const phone = await browser.newContext({ viewport: { width: 390, height: 800 }, isMobile: true });
await phone.route(`${DASH}/**`, (r) => r.fulfill({ status: 200, contentType: "application/javascript", body: embedScript(matchPage, publicConfig(db, DASH), `${DASH}/api/popup-submit`) }));
await phone.route(`${SITE}/**`, (r) => r.fulfill({ status: 200, contentType: "text/html", body: `<!doctype html><meta name=viewport content="width=device-width"><body style="height:2000px"><script src="${DASH}/api/popup-embed"></script>` }));
const mob = await phone.newPage();
await mob.goto(`${SITE}/programs/x`);
await mob.waitForSelector("[data-pd-popup]", { state: "attached", timeout: 4000 });
const box = await mob.locator("[data-pd-popup]").locator(".card").boundingBox();
ok(box && box.width >= 380 && Math.round(box.y + box.height) >= 795, "full-width bottom sheet on phones");
await shot(mob, "popup-phone");

ok(errors.length === 0, `no page errors: ${errors.join(" | ")}`);
await browser.close();
console.log(`popups smoke: ${passed} assertions passed`);

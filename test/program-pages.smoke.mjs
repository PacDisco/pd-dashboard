// npm run test:program-pages-ui
// Drives the real Program Pages editor in headless Chromium against an
// in-memory mock of /api/program-pages. Skips cleanly without Playwright.
//
//   PW_CHROMIUM=/path/to/chrome  use a specific Chromium build
//   SHOTS=dir                    save screenshots there
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

let chromium;
try { ({ chromium } = await import("playwright")); } catch { console.log("SKIP: playwright not installed"); process.exit(0); }

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ORIGIN = "http://dash.test";
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json" };

const db = { pages: {}, saves: [], publishes: [] };
const user = { email: "jake@pd.org", name: "Jake", canPublish: true };

function apiResponse(method, url, body) {
  const action = url.searchParams.get("action") || body?.action;
  const summary = (p) => ({ slug: p.slug, name: p.draft.name, status: p.published ? (p.rev > p.pubRev ? "changes" : "live") : "draft", draftRev: p.rev, publishedRev: p.pubRev || null, updatedAt: new Date().toISOString(), updatedBy: "Jake" });
  if (method === "GET" && action === "list") return [200, { programs: Object.values(db.pages).map(summary), user }];
  if (method === "GET" && action === "get") {
    const p = db.pages[url.searchParams.get("slug")];
    return p ? [200, { program: { ...summary(p), draft: p.draft } }] : [404, { error: "Not found" }];
  }
  if (method === "GET" && action === "versions") return [200, { versions: [] }];
  if (action === "create") { db.pages[body.slug] = { slug: body.slug, draft: body.data, rev: 1 }; return [201, { slug: body.slug, rev: 1 }]; }
  if (action === "save") {
    const p = db.pages[body.slug];
    if (p.rev !== body.rev) return [409, { error: "conflict", conflict: { rev: p.rev } }];
    p.draft = body.draft; p.rev++; db.saves.push(body.draft);
    return [200, { rev: p.rev }];
  }
  if (action === "publish") { const p = db.pages[body.slug]; p.published = p.draft; p.pubRev = p.rev; db.publishes.push(body); return [200, { publishedRev: p.rev, build: { triggered: true } }]; }
  return [400, { error: `unhandled ${action}` }];
}

const browser = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
await page.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
await page.route(/pd-program-pages\.netlify\.app/, (r) => r.fulfill({ status: 404, body: "" }));
await page.route(`${ORIGIN}/**`, async (route) => {
  const req = route.request();
  const url = new URL(req.url());
  if (url.pathname === "/api/program-drive") {
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ clientId: "1-x.apps.googleusercontent.com", apiKey: "test-picker-key-0123456789abcdef", appId: "123456789" }) });
  }
  if (url.pathname === "/api/program-media" && req.method() === "POST") {
    db.mediaUploads = (db.mediaUploads || 0) + 1;
    return route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ key: "drive1.jpg", url: `${ORIGIN}/api/program-media?key=drive1.jpg` }) });
  }
  if (url.pathname.startsWith("/api/program-pages")) {
    const [status, body] = apiResponse(req.method(), url, req.postData() ? JSON.parse(req.postData()) : null);
    return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
  }
  let file = path.join(ROOT, decodeURIComponent(url.pathname));
  if (file.endsWith("/")) file += "index.html";
  if (!file.startsWith(ROOT) || !fs.existsSync(file)) return route.fulfill({ status: 404, body: "nf" });
  return route.fulfill({ status: 200, contentType: TYPES[path.extname(file)] || "application/octet-stream", body: fs.readFileSync(file) });
});

// Fake Google Identity + Picker + Drive, so the editor's Drive flow runs offline.
const FAKE_GAPI = `window.gapi={load:(n,cb)=>cb()};window.google=window.google||{};(function(){
  const chain=function(){return new Proxy({}, {get:(t,k)=>k==='build'?()=>({setVisible(){setTimeout(()=>window.__pickCb({action:'picked',docs:[{id:'drive_file_123',name:'machu.jpg',description:'Sunrise over Machu Picchu',mimeType:'image/jpeg'}]}),10)}}):(k==='setCallback'?(cb)=>{window.__pickCb=cb;return p}:()=>p)});};
  let p; function PickerBuilder(){p=chain();return p;}
  function DocsView(){const v=new Proxy({}, {get:()=>()=>v});return v;}
  google.picker={PickerBuilder,DocsView,ViewId:{DOCS_IMAGES:'images'},Feature:{SUPPORT_DRIVES:'sd'},Response:{ACTION:'action',DOCUMENTS:'docs'},Action:{PICKED:'picked'},Document:{ID:'id',NAME:'name',DESCRIPTION:'description'}};
})();`;
const FAKE_GSI = `window.google=window.google||{};google.accounts={oauth2:{initTokenClient:(o)=>{const c={callback:o.callback,requestAccessToken(){window.__tokenRequests=(window.__tokenRequests||0)+1;setTimeout(()=>c.callback({access_token:'user-token',expires_in:3600}),5)}};return c;}}};`;
const driveDownloads = [];
await page.route("https://apis.google.com/js/api.js", (r) => r.fulfill({ status: 200, contentType: "text/javascript", body: FAKE_GAPI }));
await page.route("https://accounts.google.com/gsi/client", (r) => r.fulfill({ status: 200, contentType: "text/javascript", body: FAKE_GSI }));
await page.route("https://www.googleapis.com/drive/v3/files/**", (r) => {
  driveDownloads.push({ url: r.request().url(), auth: r.request().headers().authorization });
  return r.fulfill({ status: 200, contentType: "image/jpeg", headers: { "access-control-allow-origin": "*" }, body: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]) });
});

let passed = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); passed++; };
const shot = async (name) => { if (process.env.SHOTS) await page.screenshot({ path: path.join(process.env.SHOTS, `${name}.png`) }); };
const S = () => page.evaluate(() => JSON.parse(JSON.stringify(window.__pdp.S.data)));
const frame = () => page.frameLocator("#frame");

await page.goto(`${ORIGIN}/program-pages/`);
await page.getByRole("button", { name: "Start with South America" }).click();
ok(await page.locator("#new-slug").inputValue() === "south-america-gap-semester", "starter prefills the address");
await page.getByRole("button", { name: "Create page" }).click();
await frame().locator(".pdp--edit").waitFor();
ok(page.url().endsWith("#/edit/south-america-gap-semester"), "opens the editor");
await shot("01-editor");

// Live review widgets in the hero: GoAbroad shows its real iframe, GoOverseas a
// placeholder (no third-party script runs in the editor). Click → panel fields.
ok(await frame().locator('[data-item="hero.widgets.0"] iframe[src^="https://www.goabroad.com/reviews/generator/"]').count() === 1, "GoAbroad widget iframe");
ok(await frame().locator("script[src*='gooverseas']").count() === 0, "no GoOverseas script in the editor");
await frame().locator('[data-item="hero.widgets.1"]').click();
ok((await page.locator(".insp-head h2").textContent()) === "Live review widget 2 of 2", "widget selected");
ok((await page.locator('#f-hero_widgets_1_type').inputValue()) === "GoOverseas", "type shown in panel");
await page.locator('#f-hero_widgets_1_code').fill("not a widget");
await page.waitForTimeout(400);
ok(/isn't recognised/.test(await frame().locator('[data-item="hero.widgets.1"]').textContent()), "bad code flagged on the page");
await page.locator('#f-hero_widgets_1_code').fill("43632");
await page.waitForTimeout(400);
ok(/#43632/.test(await frame().locator('[data-item="hero.widgets.1"]').textContent()), "bare ID accepted");
await shot("01b-review-widgets");

// Inline text edit → autosave
const h1 = frame().locator('[data-f="hero.headline"]');
await h1.click();
await page.keyboard.press("Control+End");
await page.keyboard.type(" — 2027");
await page.waitForTimeout(1700);
ok(db.saves.length >= 1, "autosaved");
ok(db.saves.at(-1).hero.headline.endsWith("— 2027"), "saved the typed text");
ok(await page.locator("#ed-save").textContent() === "All changes saved", "save state shown");

// Select a week, delete via the on-page toolbar, undo
await frame().locator('[data-item="itinerary.weeks.1"] .pdp-week__num').click();
ok((await page.locator(".insp-head h2").textContent()) === "Week 2 of 10", "panel shows the selected week");
await shot("02-week-selected");
// Pick this week's photo from Google Drive (Google Picker, signed in as the editor)
await page.evaluate(() => { window.__pdp.S.data.itinerary.weeks[1].imageAlt = ''; });
await page.getByRole("button", { name: "From Google Drive" }).first().click();
await page.waitForTimeout(800);
ok(await page.evaluate(() => window.__tokenRequests) === 1, "asked Google for the editor's own token");
ok(driveDownloads.length === 1 && driveDownloads[0].url.includes("/files/drive_file_123?alt=media&supportsAllDrives=true"), "downloaded the picked file (shared drives too)");
ok(driveDownloads[0].auth === "Bearer user-token", "with the editor's token");
ok(db.mediaUploads === 1, "stored through /api/program-media");
ok((await S()).itinerary.weeks[1].image.endsWith("key=drive1.jpg"), "week photo set from Drive");
ok((await S()).itinerary.weeks[1].imageAlt === "Sunrise over Machu Picchu", "alt text from the Drive description");
await frame().locator('[data-item="itinerary.weeks.1"] .pdp-week__num').click();
await frame().locator('.pde-tools button[data-op="del"]').click();
ok((await S()).itinerary.weeks.length === 9, "deleted a week");
await page.locator("#btn-undo").click();
ok((await S()).itinerary.weeks.length === 10, "undo brings it back");

// Add an FAQ from the on-page + button
await frame().locator('[data-add="faq.items"]').click();
ok((await S()).faq.items.length === 7, "added a question");
ok((await page.locator(".insp-head h2").textContent()) === "Question 7 of 7", "new question is selected");

// Structured value: click tuition on the page → panel field → page updates
await frame().locator('[data-group="facts"] [data-v="facts.tuition"]').click();
const tuition = page.locator('#f-facts_tuition');
await tuition.fill("16000");
await page.waitForTimeout(400);
ok((await frame().locator('[data-group="facts"] [data-v="facts.tuition"]').textContent()) === "$16,000", "price updates on the page");

// Hide a section
await page.getByRole("button", { name: "Sections" }).click();
await page.locator('[data-sec-toggle="instructors"]').uncheck();
await page.waitForTimeout(400);
ok(await frame().locator('[data-sec="instructors"].pde-hidden').count() === 1, "section hidden (faded in editor)");

// Phone preview
await page.getByRole("button", { name: "Phone" }).click();
await page.waitForTimeout(400);
ok((await page.locator("#frame").boundingBox()).width <= 392, "phone preview width");
await shot("03-phone");
await page.getByRole("button", { name: "Desktop" }).click();

// Publish is blocked while placeholders show
await page.locator("#btn-publish").click();
await page.locator("#dlg-pub[open]").waitFor();
ok(await page.locator("#pub-go").isDisabled(), "publish blocked by placeholders");
ok(/placeholder/.test(await page.locator("#pub-checks").textContent()), "explains why");
await shot("04-publish-checks");
await page.locator('#pub-checks [data-show]').first().click();
ok(!(await page.locator("#dlg-pub").evaluate((d) => d.open)), "Show me closes the dialog");

// Clean the placeholders the quick way and publish
await page.evaluate(() => {
  const S = window.__pdp.S;
  (function walk(o) { for (const k in o) { if (typeof o[k] === "string") o[k] = o[k].replace(/\[[^\]]{2,}\]/g, "TBC"); else if (o[k] && typeof o[k] === "object") walk(o[k]); } })(S.data);
  S.dirty = true;
});
await page.locator("#btn-publish").click();
await page.locator("#dlg-pub[open]").waitFor();
ok(!(await page.locator("#pub-go").isDisabled()), "publish enabled once clean");
await page.locator("#pub-note").fill("Smoke test");
await page.locator("#pub-go").click();
await page.waitForTimeout(400);
ok(db.publishes.length === 1 && db.publishes[0].note === "Smoke test", "published with note");
ok((await page.locator("#ed-status").textContent()) === "Live", "status is Live");

ok(errors.length === 0, `no page errors: ${errors.join(" | ")}`);
await browser.close();
console.log(`program-pages smoke: ${passed} assertions passed`);

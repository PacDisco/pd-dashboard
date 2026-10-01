// npm run test:program-pages
// Pure checks on the Program Pages endpoints: validation, access, the build
// token and image sniffing. No network, no database.
import test from "node:test";
import assert from "node:assert/strict";
import { checkSlug, checkDoc, statusOf, MAX_DOC_BYTES, triggerBuild } from "../netlify/functions/program-pages.mjs";
import { requireEditor, tokenOk, publishRoles } from "../netlify/functions/_shared/program-pages-access.mjs";
import { sniff, newKey, KEY_RE } from "../netlify/functions/program-media.mjs";

const req = (headers = {}) => new Request("https://dash.test/api/program-pages", { headers });

test("slugs", () => {
  assert.equal(checkSlug("south-america-gap-semester"), null);
  for (const bad of ["", "South-America", "a--b", "-a", "a-", "a b", "../x", "x".repeat(81), "api", "new"]) {
    assert.ok(checkSlug(bad), bad);
  }
});

test("documents", () => {
  assert.equal(checkDoc({ name: "South America" }), null);
  assert.ok(checkDoc(null));
  assert.ok(checkDoc([]));
  assert.ok(checkDoc({ name: "" }));
  assert.ok(checkDoc({ name: "x".repeat(121) }));
  assert.ok(checkDoc({ name: "x", hero: { image: "data:image/png;base64,AAAA" } }));
  assert.ok(checkDoc({ name: "x", settings: { applyUrl: "javascript:alert(1)" } }));
  assert.ok(checkDoc({ name: "x", pad: "y".repeat(MAX_DOC_BYTES) }));
});

test("status", () => {
  assert.equal(statusOf({ draft_rev: 3, published_rev: null }), "draft");
  assert.equal(statusOf({ draft_rev: 3, published_rev: 3 }), "live");
  assert.equal(statusOf({ draft_rev: 4, published_rev: 3 }), "changes");
  assert.equal(statusOf({ draft_rev: 4, published_rev: 3, archived_at: new Date() }), "archived");
});

const deps = (user, grants = null, dashboard = { slug: "program-pages", allowedRoles: ["admin", "outreach", "programs", "admissions"] }) => ({
  verifiedUser: async () => user,
  accessInputs: async () => ({ grants, dashboard }),
});

test("no session → 401", async () => {
  const r = await requireEditor(req(), "t", deps(null));
  assert.ok(r instanceof Response);
  assert.equal(r.status, 401);
});

test("role fallback: admissions can edit but not publish; outreach can publish", async () => {
  const a = await requireEditor(req(), "t", deps({ email: "a@pd.org", roles: ["member", "admissions"], name: "A" }));
  assert.ok(!(a instanceof Response));
  assert.equal(a.canPublish, false);
  const o = await requireEditor(req(), "t", deps({ email: "o@pd.org", roles: ["member", "outreach"], name: "O" }));
  assert.equal(o.canPublish, true);
});

test("a role outside the dashboard's allowed roles → 403", async () => {
  const r = await requireEditor(req(), "t", deps({ email: "f@pd.org", roles: ["member", "flights"] }));
  assert.equal(r.status, 403);
});

test("per-person grants override roles, both ways", async () => {
  const grants = { version: 1, users: { "f@pd.org": ["program-pages"], "o@pd.org": ["enrollment"] } };
  const f = await requireEditor(req(), "t", deps({ email: "F@pd.org", roles: ["member", "flights"] }, grants));
  assert.ok(!(f instanceof Response));
  const o = await requireEditor(req(), "t", deps({ email: "o@pd.org", roles: ["member", "outreach"] }, grants));
  assert.equal(o.status, 403);
});

test("admin always passes and can publish", async () => {
  const r = await requireEditor(req(), "t", deps({ email: "j@pd.org", roles: ["admin"] }, { version: 1, users: { "j@pd.org": [] } }));
  assert.equal(r.canPublish, true);
});

test("publish roles are configurable", () => {
  const prev = process.env.PROGRAM_PAGES_PUBLISH_ROLES;
  process.env.PROGRAM_PAGES_PUBLISH_ROLES = " Admin , programs ";
  assert.deepEqual(publishRoles(), ["admin", "programs"]);
  if (prev === undefined) delete process.env.PROGRAM_PAGES_PUBLISH_ROLES; else process.env.PROGRAM_PAGES_PUBLISH_ROLES = prev;
});

test("build token", () => {
  delete process.env.PROGRAM_PAGES_BUILD_TOKEN;
  assert.equal(tokenOk(req({ authorization: "Bearer anything" })), false, "unset token must close the path");
  process.env.PROGRAM_PAGES_BUILD_TOKEN = "short";
  assert.equal(tokenOk(req({ authorization: "Bearer short" })), false, "weak token refused");
  process.env.PROGRAM_PAGES_BUILD_TOKEN = "a".repeat(40);
  assert.equal(tokenOk(req({ authorization: `Bearer ${"a".repeat(40)}` })), true);
  assert.equal(tokenOk(req({ authorization: `Bearer ${"a".repeat(39)}b` })), false);
  assert.equal(tokenOk(req({})), false);
  assert.equal(tokenOk(req({ cookie: `nf_jwt=${"a".repeat(40)}` })), false);
  delete process.env.PROGRAM_PAGES_BUILD_TOKEN;
});

test("image sniffing refuses look-alikes", () => {
  const jpg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]).buffer;
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]).buffer;
  const webp = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]).buffer;
  const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>').buffer;
  assert.equal(sniff(jpg), "image/jpeg");
  assert.equal(sniff(png), "image/png");
  assert.equal(sniff(webp), "image/webp");
  assert.equal(sniff(svg), null);
});

test("media keys are unguessable and path-safe", () => {
  const k = newKey("image/jpeg", new Date("2026-10-01T00:00:00Z"));
  assert.match(k, /^202610-[0-9a-f]{18}\.jpg$/);
  assert.ok(KEY_RE.test(k));
  assert.ok(!KEY_RE.test("../secrets"));
  assert.ok(!KEY_RE.test("a/b.jpg"));
});

test("publishing without a build hook says so instead of failing", async () => {
  delete process.env.PROGRAM_SITE_BUILD_HOOK;
  const r = await triggerBuild("x");
  assert.equal(r.triggered, false);
  assert.match(r.message, /PROGRAM_SITE_BUILD_HOOK/);
});

// npm run test:popups
// Pure checks for website popups: data model, page targeting, submission
// checks and the HubSpot mapping (HubSpot itself is mocked).
import test from "node:test";
import assert from "node:assert/strict";
import {
  blankPopup, normalizePopup, validateDoc, matchPage, publicConfig, checkSubmission,
  hubspotProperties, noteText, safeUrl, FIELD_DEFS,
} from "../netlify/functions/_shared/popups-core.mjs";
import { embedScript, previewScript } from "../netlify/functions/_shared/popup-runtime.mjs";
import { upsertContact, HubSpotError } from "../netlify/functions/_shared/popups-hubspot.mjs";
import { requirePopupEditor } from "../netlify/functions/_shared/popups-access.mjs";
import { allowedOrigins, throttled } from "../netlify/functions/popup-submit.mjs";

const on = (p, keys) => ({ ...p, fields: p.fields.map((f) => ({ ...f, on: f.key === "email" || keys.includes(f.key) })) });

test("page targeting", () => {
  const inc = { mode: "include", rules: ["/programs/*", "/", "https://www.pacificdiscovery.org/about-us/"] };
  assert.ok(matchPage("/programs/south-america-gap-semester", inc));
  assert.ok(matchPage("/programs/south-america-gap-semester/", inc), "trailing slash");
  assert.ok(matchPage("/", inc), "homepage");
  assert.ok(matchPage("/about-us", inc), "full URL rule");
  assert.ok(!matchPage("/apply", inc));
  assert.ok(!matchPage("/programsx", { mode: "include", rules: ["/programs/*"] }));
  assert.ok(matchPage("/Programs/Japan-Mini-Semester", { mode: "include", rules: ["/programs/japan-mini-semester"] }), "case-insensitive");
  const exc = { mode: "exclude", rules: ["/apply*"] };
  assert.ok(!matchPage("/apply", exc) && !matchPage("/apply/step-2", exc) && matchPage("/programs/x", exc));
  assert.ok(matchPage("/anything", { mode: "all", rules: [] }));
  assert.ok(matchPage("/a.b", { mode: "include", rules: ["/a.b"] }) && !matchPage("/axb", { mode: "include", rules: ["/a.b"] }), "dots are literal");
});

test("normalize clamps and fills", () => {
  const p = normalizePopup({ id: "x!", layout: "weird", accent: "red", image: "javascript:alert(1)", trigger: { delay: -5, scroll: 500 }, fields: [{ key: "email", on: false }, { key: "nope", on: true }] });
  assert.match(p.id, /^p[a-z0-9]+$/);
  assert.equal(p.layout, "modal");
  assert.equal(p.accent, "#F15B39");
  assert.equal(p.image, "");
  assert.equal(p.trigger.delay, 0);
  assert.equal(p.trigger.scroll, 100);
  assert.equal(p.fields.length, FIELD_DEFS.length);
  assert.ok(p.fields.find((f) => f.key === "email").on, "email is always on");
  assert.equal(p.fields[0].key, "email", "designer's order kept");
  assert.equal(safeUrl("/api/popup-embed?img=a"), "/api/popup-embed?img=a");
  assert.equal(safeUrl("//evil.test/x"), "");
});

test("save validation", () => {
  const p = blankPopup("A");
  assert.equal(validateDoc({ popups: [p] }), null);
  assert.match(validateDoc({ popups: [{ ...p, enabled: true, headline: "" }] }), /headline/);
  assert.match(validateDoc({ popups: [{ ...p, enabled: true, pages: { mode: "include", rules: [] } }] }), /no pages/);
  assert.match(validateDoc({ popups: [p, p] }), /share the id/);
  assert.equal(validateDoc({ popups: [on(p, ["program"])] }), null, "drafts can be incomplete");
  assert.match(validateDoc({ popups: [{ ...on(p, ["program"]), enabled: true }] }), /no options/, "dropdown with no choices can't go live");
});

test("public config: live popups only, no HubSpot property names", () => {
  const a = { ...blankPopup("A"), enabled: true };
  const b = blankPopup("B");
  const cfg = publicConfig({ popups: [a, b] }, "https://dash.test");
  assert.equal(cfg.length, 1);
  assert.ok(!JSON.stringify(cfg).includes("program_interest"));
  assert.ok(!("updatedBy" in cfg[0]));
  const withImg = publicConfig({ popups: [{ ...a, image: "/api/popup-embed?img=k1" }] }, "https://dash.test");
  assert.equal(withImg[0].image, "https://dash.test/api/popup-embed?img=k1");
});

test("submission checks", () => {
  const p = normalizePopup({ ...on(blankPopup(), ["firstname", "phone", "program"]), fields: undefined });
  const pop = on(normalizePopup(blankPopup()), ["firstname", "phone", "program"]);
  pop.fields.find((f) => f.key === "firstname").required = true;
  pop.fields.find((f) => f.key === "program").options = [{ label: "South America", value: "SAS" }];
  let r = checkSubmission(pop, { email: "bad", firstname: "", phone: "abc", program: "Nope" });
  assert.deepEqual(Object.keys(r.errors).sort(), ["email", "firstname", "phone", "program"]);
  r = checkSubmission(pop, { email: "Anna@Example.com ", firstname: "Anna", phone: "+64 21 555 1234", program: "SAS", lastname: "ignored (field off)" });
  assert.deepEqual(r.errors, {});
  assert.deepEqual(r.values, { email: "anna@example.com", firstname: "Anna", phone: "+64 21 555 1234", program: "SAS" });
  assert.ok(p);
});

test("HubSpot properties: tag, new lead, lifecycle never backwards", () => {
  const pop = on(normalizePopup(blankPopup()), ["firstname", "program"]);
  const values = { email: "a@b.co", firstname: "Anna", program: "SAS" };
  const fresh = hubspotProperties(pop, values, null);
  assert.deepEqual(fresh, { firstname: "Anna", email: "a@b.co", program_interest: "SAS", company_tag: "Pacific Discovery", hs_lead_status: "NEW", lifecyclestage: "lead" });
  const customer = hubspotProperties(pop, values, { lifecyclestage: "customer" });
  assert.equal(customer.hs_lead_status, "NEW", "always a new lead (Jake's choice)");
  assert.ok(!("lifecyclestage" in customer), "never moved backwards");
  assert.equal(hubspotProperties(pop, values, { lifecyclestage: "subscriber" }).lifecyclestage, "lead");
  assert.equal(hubspotProperties(pop, values, { company_tag: "Pure Exploration" }, true).company_tag, "Pure Exploration;Pacific Discovery", "multi-select tag keeps other brands");
  assert.equal(hubspotProperties(pop, values, { company_tag: "Pacific Discovery;Unearthed" }, true).company_tag, "Pacific Discovery;Unearthed");
  const unmapped = { ...pop, fields: pop.fields.map((f) => (f.key === "program" ? { ...f, property: "" } : f)) };
  assert.ok(!("program_interest" in hubspotProperties(unmapped, values, null)), "field set to 'don't save'");
  pop.fields.find((f) => f.key === "program").options = [{ label: "South America", value: "SAS" }];
  assert.match(noteText(pop, values, { uri: "https://www.pacificdiscovery.org/programs/x" }), /Program of interest: South America/);
});

function mockHubSpot({ existing = null, props, failFirstWrite = false } = {}) {
  const calls = [];
  let writes = 0;
  const fetchImpl = async (url, init = {}) => {
    const path = url.replace("https://api.hubapi.com", "");
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ path, method: init.method || "GET", body });
    const ok = (j) => new Response(JSON.stringify(j), { status: 200 });
    if (path.startsWith("/crm/v3/properties/contacts")) return ok({ results: props });
    if (path === "/crm/v3/objects/contacts/search") return ok({ results: existing ? [existing] : [] });
    if (path.startsWith("/crm/v3/objects/contacts")) {
      writes++;
      if (failFirstWrite && writes === 1) return new Response('{"message":"Property values were not valid"}', { status: 400 });
      return ok({ id: existing ? existing.id : "901" });
    }
    if (path === "/crm/v3/objects/notes") return ok({ id: "n1" });
    return new Response("nf", { status: 404 });
  };
  return { calls, fetchImpl };
}
const PROPS = [
  { name: "email", label: "Email", type: "string", fieldType: "text", options: [] },
  { name: "firstname", label: "First name", type: "string", fieldType: "text", options: [] },
  { name: "company_tag", label: "Company tag", type: "enumeration", fieldType: "checkbox", options: [{ label: "Pacific Discovery", value: "Pacific Discovery" }, { label: "Pure Exploration", value: "Pure Exploration" }] },
  { name: "hs_lead_status", label: "Lead status", type: "enumeration", fieldType: "select", options: [{ label: "New", value: "NEW" }] },
  { name: "lifecyclestage", label: "Lifecycle", type: "enumeration", fieldType: "radio", options: [{ label: "Lead", value: "lead" }] },
  { name: "program_interest", label: "Program interest", type: "enumeration", fieldType: "select", options: [{ label: "South America", value: "SAS" }] },
].map((p) => ({ ...p, hidden: false, calculated: false }));

test("upsert: new contact, update, bad values never lose the lead", async () => {
  process.env.HUBSPOT_TOKEN = "test-token";
  const pop = on(normalizePopup(blankPopup("Booklet")), ["firstname", "program"]);
  const quiet = { warn() {} };

  let hs = mockHubSpot({ props: PROPS });
  let r = await upsertContact(pop, { email: "a@b.co", firstname: "Anna", program: "SAS" }, { uri: "/programs/x" }, { fetchImpl: hs.fetchImpl, log: quiet });
  assert.equal(r.created, true);
  const create = hs.calls.find((c) => c.path === "/crm/v3/objects/contacts" && c.method === "POST");
  assert.equal(create.body.properties.company_tag, "Pacific Discovery");
  assert.equal(create.body.properties.hs_lead_status, "NEW");
  assert.ok(hs.calls.some((c) => c.path === "/crm/v3/objects/notes"), "note added");

  hs = mockHubSpot({ props: PROPS, existing: { id: "55", properties: { lifecyclestage: "opportunity", company_tag: "Pure Exploration" } } });
  r = await upsertContact(pop, { email: "a@b.co", firstname: "Anna", program: "Not an option" }, {}, { fetchImpl: hs.fetchImpl, log: quiet });
  const patch = hs.calls.find((c) => c.method === "PATCH");
  assert.equal(patch.path, "/crm/v3/objects/contacts/55");
  assert.equal(patch.body.properties.company_tag, "Pure Exploration;Pacific Discovery");
  assert.ok(!("lifecyclestage" in patch.body.properties));
  assert.ok(!("program_interest" in patch.body.properties), "invalid dropdown value left out");
  assert.deepEqual(r.dropped, ["program_interest=Not an option"]);

  hs = mockHubSpot({ props: PROPS, failFirstWrite: true });
  r = await upsertContact(pop, { email: "c@d.co", firstname: "Cal", program: "SAS" }, {}, { fetchImpl: hs.fetchImpl, log: quiet });
  const writes = hs.calls.filter((c) => c.path === "/crm/v3/objects/contacts" && c.method === "POST");
  assert.equal(writes.length, 2, "retried");
  assert.ok(!("program_interest" in writes[1].body.properties) && writes[1].body.properties.email === "c@d.co");

  hs = mockHubSpot({ props: PROPS });
  const failing = async (u, i) => (u.endsWith("/crm/v3/objects/contacts/search") ? new Response("boom", { status: 500 }) : hs.fetchImpl(u, i));
  await assert.rejects(() => upsertContact(pop, { email: "e@f.co" }, {}, { fetchImpl: failing, log: quiet }), HubSpotError);
});

test("embed + preview scripts are valid JavaScript and escape </script>", () => {
  const p = { ...blankPopup("X"), enabled: true, headline: "</script><script>alert(1)</script>" };
  const js = embedScript(matchPage, publicConfig({ popups: [p] }, "https://d"), "https://d/api/popup-submit");
  assert.doesNotThrow(() => new Function(js));
  assert.ok(!js.includes("</script>"));
  assert.doesNotThrow(() => new Function(previewScript(matchPage)));
});

test("access and submit guards", async () => {
  const deny = await requirePopupEditor(new Request("https://d/api/popups"), { verifiedUser: async () => null });
  assert.equal(deny.status, 401);
  const inputs = async () => ({ grants: null, dashboard: { slug: "popups", allowedRoles: ["admin", "outreach"] } });
  const no = await requirePopupEditor(new Request("https://d/api/popups"), { verifiedUser: async () => ({ email: "x@y", roles: ["flights"] }), accessInputs: inputs });
  assert.equal(no.status, 403);
  const yes = await requirePopupEditor(new Request("https://d/api/popups"), { verifiedUser: async () => ({ email: "x@y", roles: ["outreach"], name: "X" }), accessInputs: inputs });
  assert.equal(yes.actor, "X");
  delete process.env.POPUP_ALLOWED_ORIGINS;
  assert.deepEqual(allowedOrigins(), ["https://www.pacificdiscovery.org", "https://pacificdiscovery.org"]);
  const t0 = 1_000_000;
  for (let i = 0; i < 6; i++) assert.equal(throttled("1.2.3.4", t0 + i), false);
  assert.equal(throttled("1.2.3.4", t0 + 10), true);
  assert.equal(throttled("1.2.3.4", t0 + 70_000), false, "window resets");
});

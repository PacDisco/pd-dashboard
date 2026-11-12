// node test/booklet.test.mjs
// Info booklet requests from program/landing pages: validation, the booklet
// link rule, the HubSpot mapping (mocked) and the visitor email.
import test from "node:test";
import assert from "node:assert/strict";
import {
  bookletOrigins, bookletUrlOf, checkBooklet, bookletForm, visitorEmail, cleanPage, matchOption,
} from "../netlify/functions/_shared/booklet-core.mjs";
import { hubspotProperties, noteText } from "../netlify/functions/_shared/popups-core.mjs";
import { notificationEmail } from "../netlify/functions/_shared/popups-gmail.mjs";

test("booklet link comes only from the published page, and only a real link", () => {
  assert.equal(bookletUrlOf({ settings: { bookletUrl: " https://x.co/a.pdf " } }), "https://x.co/a.pdf");
  assert.equal(bookletUrlOf({ settings: { bookletUrl: "https://www.pacificdiscovery.org/admissions/request-program-booklet" } }), "");
  assert.equal(bookletUrlOf({ settings: { bookletUrl: "javascript:alert(1)" } }), "");
  assert.equal(bookletUrlOf({ settings: {} }), "");
  assert.equal(bookletUrlOf(null), "");
});

test("origins: default www, apex and the program site; env overrides", () => {
  assert.deepEqual(bookletOrigins({}), ["https://www.pacificdiscovery.org", "https://pacificdiscovery.org", "https://pd-program-pages.netlify.app"]);
  assert.deepEqual(bookletOrigins({ BOOKLET_ALLOWED_ORIGINS: "https://a.test/, https://b.test" }), ["https://a.test", "https://b.test"]);
});

test("validation", () => {
  let r = checkBooklet({ firstname: " Ana ", lastname: "Li", email: "ANA@X.CO", phone: "021 555 0100", role: "Parent" });
  assert.deepEqual(r.errors, {});
  assert.deepEqual(r.values, { firstname: "Ana", lastname: "Li", email: "ana@x.co", phone: "021 555 0100", role: "Parent" });
  assert.equal(checkBooklet({ firstname: "Ana", lastname: "Li", email: "ana@x.co", role: "Parent" }).errors.phone, "Please enter your phone number.");
  r = checkBooklet({ firstname: "Ana", lastname: "Li", email: "ana@x.co", phone: " +1 (415) 555-0100 ", role: "Student" });
  assert.equal(r.values.phone, "+1 (415) 555-0100");
  r = checkBooklet({ firstname: "", lastname: "", email: "nope", phone: "call me", role: "Teacher" });
  assert.deepEqual(Object.keys(r.errors).sort(), ["email", "firstname", "lastname", "phone", "role"]);
  assert.deepEqual(Object.keys(checkBooklet(null).errors).length, 5);
});

test("form maps to HubSpot like a popup", () => {
  const form = bookletForm({ slug: "south-america-gap-semester", name: "South America Gap Semester" }, {});
  const vals = { firstname: "Ana", lastname: "Li", email: "ana@x.co", role: "Student", program: "South America Gap Semester" };
  const props = hubspotProperties(form, vals, null, false);
  assert.equal(props.company_tag, "Pacific Discovery");
  assert.equal(props.hs_lead_status, "NEW");
  assert.equal(props.lifecyclestage, "lead");
  assert.equal(props.program_interest, "South America Gap Semester");
  assert.ok(!("role" in props) && !("" in props), "role is note-only by default");
  assert.equal(hubspotProperties(form, { ...vals, phone: "+64 21 555 0100" }, null).phone, "+64 21 555 0100");
  const note = noteText(form, vals, { uri: "https://www.pacificdiscovery.org/programs/south-america-gap-semester" });
  assert.match(note, /Website popup: Info booklet: South America Gap Semester/);
  assert.match(note, /I am a…: Student/);
  assert.match(notificationEmail(form, vals, {}, null).subject, /Ana Li · South America Gap Semester/);

  const custom = bookletForm({ slug: "x", name: "X" }, { BOOKLET_ROLE_PROPERTY: "persona", BOOKLET_PROGRAM_PROPERTY: "none", BOOKLET_NOTIFY_EMAILS: "a@b.co, bad, C@D.co" });
  assert.equal(hubspotProperties(custom, { ...vals, program: "X" }, null).persona, "Student");
  assert.ok(!("program_interest" in hubspotProperties(custom, { ...vals, program: "X" }, null)));
  assert.deepEqual(custom.notify.emails, ["a@b.co", "c@d.co"]);
  const landing = bookletForm({ slug: "why-pacific-discovery", name: "Why PD", template: "landing" }, {});
  assert.ok(!("program_interest" in hubspotProperties(landing, { ...vals, program: "Why PD" }, null)), "landing pages don't set a program");
});

test("matchOption finds the program's dropdown value", () => {
  const prop = { options: [{ label: "South America Gap Semester", value: "SAS" }, { label: "New Zealand & Fiji Summer", value: "nzf" }, { label: "Bali", value: "bali-summer" }] };
  assert.equal(matchOption(prop, "South America gap semester", "x"), "SAS");
  assert.equal(matchOption(prop, "New Zealand and Fiji Summer", "x"), "nzf");
  assert.equal(matchOption(prop, "Bali Summer Program", "bali-summer"), "bali-summer");
  assert.equal(matchOption(prop, "Japan", "japan"), "");
  assert.equal(matchOption(undefined, "Japan", "japan"), "");
});

test("visitor email carries the link, escaped", () => {
  const m = visitorEmail({ values: { firstname: "<b>Ana</b>" }, programName: "South America", url: "https://x.co/a.pdf?a=1&b=2", pageUrl: "https://www.pacificdiscovery.org/programs/sa" });
  assert.equal(m.subject, "Your South America booklet");
  assert.ok(m.text.includes("https://x.co/a.pdf?a=1&b=2"));
  assert.ok(m.html.includes('href="https://x.co/a.pdf?a=1&amp;b=2"'));
  assert.ok(!m.html.includes("<b>Ana</b>"));
  assert.ok(m.html.includes("Back to the program page"));
  assert.equal(visitorEmail({ values: {}, programName: "Why", url: "https://x.co", landing: true }).subject, "Your Pacific Discovery program booklet");
});

test("cleanPage only trusts our own origins for the back link", () => {
  const o = bookletOrigins({});
  assert.equal(cleanPage({ uri: "https://www.pacificdiscovery.org/programs/x#get-booklet" }, o).safe, "https://www.pacificdiscovery.org/programs/x");
  assert.equal(cleanPage({ uri: "https://evil.test/x" }, o).safe, "");
});

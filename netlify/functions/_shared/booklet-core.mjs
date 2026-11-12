// netlify/functions/_shared/booklet-core.mjs
//
// Info booklet requests from program and landing pages (pd-program-pages).
// Pure functions only, so test/booklet.test.mjs can cover them.
//
// The live page never contains the booklet's URL. A visitor fills in the
// booklet form; /api/booklet-request looks the URL up from the PUBLISHED page
// (program_pages.published.settings.bookletUrl), saves the lead to HubSpot,
// emails the visitor the link and returns it so the page can open it.

import { isEmail } from "./popups-core.mjs";

export const ROLES = [
  { label: "Student", value: "Student" },
  { label: "Parent or guardian", value: "Parent" },
];

const DEFAULT_ORIGINS = "https://www.pacificdiscovery.org,https://pacificdiscovery.org,https://pd-program-pages.netlify.app";

export function bookletOrigins(env = process.env) {
  return (env.BOOKLET_ALLOWED_ORIGINS || DEFAULT_ORIGINS).split(",").map((s) => s.trim().replace(/\/+$/, "")).filter(Boolean);
}

export const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const LEGACY_RE = /\/request-program-booklet\/?(?:[?#]|$)/i;

/** Same rule as the template's isGatedBooklet(): http(s), and not the old request-form page. */
export function bookletUrlOf(published) {
  const u = String(published?.settings?.bookletUrl ?? "").trim();
  if (!/^https?:\/\/[^\s/]+\.[^\s]+/i.test(u) || LEGACY_RE.test(u)) return "";
  return u;
}

const str = (v, max) => (typeof v === "string" ? v : v == null ? "" : String(v)).trim().slice(0, max);

/** Check the visitor's details. @returns {{ errors: Record<string,string>, values: Record<string,string> }} */
export function checkBooklet(input) {
  const errors = {};
  const values = {
    firstname: str(input?.firstname, 100),
    lastname: str(input?.lastname, 100),
    email: str(input?.email, 200).toLowerCase(),
    phone: str(input?.phone, 30),
    role: str(input?.role, 40),
  };
  if (!values.firstname) errors.firstname = "Please enter your first name.";
  if (!values.lastname) errors.lastname = "Please enter your last name.";
  if (!isEmail(values.email)) errors.email = "Please enter a valid email address.";
  if (!values.phone) errors.phone = "Please enter your phone number.";
  else if (!/^[+()\d\s.\-]{6,30}$/.test(values.phone)) errors.phone = "Please enter a valid phone number.";
  if (!ROLES.some((r) => r.value === values.role)) errors.role = "Please choose student or parent.";
  return { errors, values };
}

/**
 * A popup-shaped description of the booklet form, so the popups' HubSpot code
 * (upsertContact: contact, company_tag, lead status, timeline note + PDF) and
 * team notification email can be reused as they are.
 *
 * Env (optional):
 *   BOOKLET_ROLE_PROPERTY     HubSpot property for student/parent (default: none, note only)
 *   BOOKLET_PROGRAM_PROPERTY  HubSpot property for the program (default program_interest;
 *                             set to "none" to skip). The value is the page's name; if the
 *                             property is a dropdown without that option it's left out.
 */
export function bookletForm({ slug, name, template }, env = process.env) {
  const prop = (v, d) => {
    const s = String(v ?? d).trim();
    return s === "none" || !/^[a-z0-9_]{1,100}$/.test(s) ? "" : s;
  };
  const programName = String(name || slug).slice(0, 120);
  return {
    id: `booklet-${slug}`,
    name: `Info booklet: ${programName}`,
    template: template === "landing" ? "landing" : "program",
    fields: [
      { key: "firstname", label: "First name", on: true, required: true, property: "firstname" },
      { key: "lastname", label: "Last name", on: true, required: true, property: "lastname" },
      { key: "email", label: "Email", on: true, required: true, property: "email" },
      { key: "phone", label: "Phone", on: true, required: true, property: "phone" },
      { key: "role", label: "I am a…", on: true, required: true, property: prop(env.BOOKLET_ROLE_PROPERTY, ""), options: ROLES },
      { key: "program", label: "Booklet", on: true, required: false, property: template === "landing" ? "" : prop(env.BOOKLET_PROGRAM_PROPERTY, "program_interest"), options: [{ label: programName, value: programName }] },
    ],
    notify: { emails: String(env.BOOKLET_NOTIFY_EMAILS || "").split(",").map((s) => s.trim().toLowerCase()).filter(isEmail).slice(0, 10) },
  };
}

/**
 * The dropdown value of a HubSpot property that matches this page, e.g. the
 * program_interest option labelled "South America Gap Semester" (or whose value
 * is the slug). Compared ignoring case, punctuation and "&"/"and".
 * @returns {string} the option's value, or "" when nothing matches
 */
export function matchOption(property, name, slug) {
  const norm = (v) => String(v ?? "").toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim();
  const want = [norm(name), norm(slug)].filter(Boolean);
  for (const o of property?.options || []) {
    if (want.includes(norm(o.label)) || want.includes(norm(o.value))) return String(o.value);
  }
  return "";
}

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

/** The email the visitor gets, with the link to come back to. */
export function visitorEmail({ values, programName, url, landing = false, pageUrl = "" }) {
  const what = landing ? "Pacific Discovery program booklet" : `${programName} booklet`;
  const subject = `Your ${what}`;
  const hi = values.firstname ? `Hi ${values.firstname},` : "Hi,";
  const text = [
    hi,
    "",
    `Thanks for your interest in Pacific Discovery. Here's the link to your ${what}, so you can come back to it any time:`,
    "",
    url,
    "",
    "It has every week of the itinerary, what's included, costs and dates.",
    "",
    "Questions? Just reply to this email and one of our advisors will get back to you.",
    "",
    "The Pacific Discovery team",
    "https://www.pacificdiscovery.org",
  ].join("\n");
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.55;color:#2f2f2f;max-width:560px">
<p style="margin:0 0 4px;font-size:12px;letter-spacing:.1em;text-transform:uppercase;color:#F15B39;font-weight:bold">Your info booklet</p>
<h1 style="margin:0 0 14px;font-family:Georgia,serif;font-weight:normal;font-size:26px;line-height:1.2;color:#2f2f2f">${esc(landing ? "Your program booklet" : programName)}</h1>
<p style="margin:0 0 12px">${esc(hi)}</p>
<p style="margin:0 0 18px">Thanks for your interest in Pacific Discovery. Here’s the link to your booklet, so you can come back to it any time. It has every week of the itinerary, what’s included, costs and dates.</p>
<p style="margin:0 0 22px"><a href="${esc(url)}" style="display:inline-block;background:#F15B39;color:#ffffff;text-decoration:none;padding:13px 24px;border-radius:999px;font-weight:bold">Open the booklet</a></p>
${pageUrl ? `<p style="margin:0 0 12px"><a href="${esc(pageUrl)}" style="color:#288195">Back to the ${esc(landing ? "page" : "program page")}</a></p>` : ""}
<p style="margin:0 0 12px">Questions? Just reply to this email and one of our advisors will get back to you.</p>
<p style="margin:0;color:#5f666b">The Pacific Discovery team<br><a href="https://www.pacificdiscovery.org" style="color:#288195">pacificdiscovery.org</a></p>
<p style="margin:22px 0 0;font-size:12px;color:#8a9196">If the button doesn’t work, copy this link into your browser: ${esc(url)}</p></div>`;
  return { subject, text, html };
}

/** The visitor's page, trimmed and only if it's one of ours (for the "back to" link). */
export function cleanPage(page, origins) {
  const uri = String(page?.uri || "").slice(0, 500);
  let ok = "";
  try {
    const u = new URL(uri);
    if (origins.includes(u.origin)) { u.hash = ""; ok = u.toString(); }
  } catch { /* ignore */ }
  return { uri: ok || uri.replace(/[^\x20-\x7e]/g, ""), title: String(page?.title || "").slice(0, 200), safe: ok };
}

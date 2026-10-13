// netlify/functions/_shared/popups-core.mjs
//
// Website popups: the data model, validation, page targeting and the
// HubSpot mapping. Pure functions only (no I/O), so test/popups.test.mjs can
// cover them and the editor, the embed script and the submit endpoint all
// agree on one set of rules.
//
// A popup is designed in /popups/ (the dashboard), stored in Netlify Blobs
// (store "popups", key "doc"), served to pacificdiscovery.org by
// /api/popup-embed (loaded from a GTM Custom HTML tag) and submitted to
// /api/popup-submit, which writes the contact into HubSpot.

export const LAYOUTS = ["modal", "slide", "bar"];
export const IMAGE_POS = ["top", "side", "none"];
export const DEVICES = ["all", "desktop", "mobile"];
export const PAGE_MODES = ["all", "include", "exclude"];
export const MAX_POPUPS = 30;
export const MAX_DOC_BYTES = 256 * 1024;

// The fields a popup can collect. `property` is the HubSpot contact property
// it writes to (editable in the designer, e.g. a custom "persona" property).
export const FIELD_DEFS = [
  { key: "firstname", label: "First name", type: "text", property: "firstname", autocomplete: "given-name" },
  { key: "lastname", label: "Last name", type: "text", property: "lastname", autocomplete: "family-name" },
  { key: "email", label: "Email", type: "email", property: "email", autocomplete: "email", locked: true },
  { key: "phone", label: "Phone", type: "tel", property: "phone", autocomplete: "tel" },
  { key: "role", label: "I am a…", type: "select", property: "", options: [{ label: "Student", value: "Student" }, { label: "Parent or guardian", value: "Parent" }] },
  { key: "program", label: "Program of interest", type: "select", property: "program_interest", options: [] },
  { key: "term", label: "When would you like to travel?", type: "select", property: "program_dates", options: [] },
];

// Every popup submission is tagged like this in HubSpot.
export const HUBSPOT_TAG = { property: "company_tag", value: "Pacific Discovery" };
export const LEAD_STATUS = { property: "hs_lead_status", value: "NEW" };
// HubSpot refuses to move lifecycle stage backwards, so "lead" is only set
// when the contact is new or still at one of these earlier stages.
export const EARLY_STAGES = ["", "subscriber", "lead"];

const str = (v, max = 400) => (typeof v === "string" ? v : v == null ? "" : String(v)).slice(0, max);
const bool = (v, d = false) => (typeof v === "boolean" ? v : d);
const num = (v, d, min, max) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : d;
};
const pick = (v, list, d) => (list.includes(v) ? v : d);
const HEX_RE = /^#[0-9a-f]{6}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const PROP_RE = /^[a-z0-9_]{1,100}$/;

export function newId() {
  return "p" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

export function blankPopup(name = "New popup") {
  return normalizePopup({
    id: newId(),
    name,
    enabled: false,
    layout: "modal",
    imagePos: "side",
    image: "",
    imageAlt: "",
    accent: "#F15B39",
    eyebrow: "Free program guide",
    headline: "Get the full itinerary and dates",
    body: "Tell us a little about you and we’ll send the program booklet, with every week of the itinerary, costs and dates.",
    button: "Send me the booklet",
    privacy: "We’ll only use your details to send you program information. Unsubscribe any time.",
    success: { headline: "Thanks! Check your inbox.", body: "One of our advisors will be in touch soon.", linkText: "", linkUrl: "" },
    fields: FIELD_DEFS.map((f) => ({ key: f.key, on: ["firstname", "email", "program"].includes(f.key), required: ["firstname", "email"].includes(f.key) })),
    pages: { mode: "all", rules: [] },
    devices: "all",
    trigger: { delay: 8, scroll: 0, exit: true },
    frequency: { hideDays: 7 },
  });
}

/** Fill defaults and clamp every value to a safe shape. */
export function normalizePopup(p = {}) {
  const fieldsIn = Array.isArray(p.fields) ? p.fields : [];
  const fields = FIELD_DEFS.map((def) => {
    const f = fieldsIn.find((x) => x && x.key === def.key) || {};
    const options = (Array.isArray(f.options) && f.options.length ? f.options : def.options || [])
      .filter((o) => o && (o.value != null || o.label != null))
      .slice(0, 80)
      .map((o) => ({ label: str(o.label ?? o.value, 120), value: str(o.value ?? o.label, 120) }));
    const property = typeof f.property === "string" ? f.property.trim() : def.property;
    return {
      key: def.key,
      on: def.locked ? true : bool(f.on, false),
      required: def.locked ? true : bool(f.required, false),
      label: str(f.label, 120) || def.label,
      property: property === "" || PROP_RE.test(property) ? property : def.property,
      ...(def.type === "select" ? { options } : {}),
    };
  });
  // Keep the designer's field order (email can move too), default order otherwise.
  const order = fieldsIn.map((f) => f && f.key).filter((k) => FIELD_DEFS.some((d) => d.key === k));
  fields.sort((a, b) => {
    const ia = order.indexOf(a.key), ib = order.indexOf(b.key);
    return (ia < 0 ? 99 + FIELD_DEFS.findIndex((d) => d.key === a.key) : ia) - (ib < 0 ? 99 + FIELD_DEFS.findIndex((d) => d.key === b.key) : ib);
  });
  const rules = (Array.isArray(p.pages?.rules) ? p.pages.rules : [])
    .map((r) => str(r, 300).trim()).filter(Boolean).slice(0, 50);
  const s = p.success || {};
  return {
    id: /^[a-z0-9]{4,40}$/i.test(p.id || "") ? p.id : newId(),
    name: str(p.name, 80).trim() || "Popup",
    enabled: bool(p.enabled, false),
    starts: DATE_RE.test(p.starts || "") ? p.starts : "",
    ends: DATE_RE.test(p.ends || "") ? p.ends : "",
    layout: pick(p.layout, LAYOUTS, "modal"),
    imagePos: pick(p.imagePos, IMAGE_POS, "side"),
    image: safeUrl(p.image),
    imageAlt: str(p.imageAlt, 200),
    accent: HEX_RE.test(p.accent || "") ? p.accent : "#F15B39",
    eyebrow: str(p.eyebrow, 80),
    headline: str(p.headline, 160),
    body: str(p.body, 600),
    button: str(p.button, 60) || "Submit",
    privacy: str(p.privacy, 300),
    success: { headline: str(s.headline, 160) || "Thank you!", body: str(s.body, 600), linkText: str(s.linkText, 60), linkUrl: safeUrl(s.linkUrl) },
    fields,
    pages: { mode: pick(p.pages?.mode, PAGE_MODES, "all"), rules },
    devices: pick(p.devices, DEVICES, "all"),
    trigger: { delay: num(p.trigger?.delay, 8, 0, 600), scroll: num(p.trigger?.scroll, 0, 0, 100), exit: bool(p.trigger?.exit, false) },
    frequency: { hideDays: num(p.frequency?.hideDays, 7, 0, 365) },
    updatedAt: str(p.updatedAt, 40),
    updatedBy: str(p.updatedBy, 120),
  };
}

/** http(s) or site-relative only; anything else (javascript:, data:) becomes "". */
export function safeUrl(v) {
  const s = str(v, 1000).trim();
  if (!s) return "";
  if (/^https?:\/\/[^\s"'<>]+$/i.test(s)) return s;
  if (/^\/[^\s"'<>]*$/.test(s) && !s.startsWith("//")) return s;
  return "";
}

/** Problems that should stop a save (the editor shows them). */
export function validateDoc(doc) {
  if (!doc || !Array.isArray(doc.popups)) return "Expected { popups: [...] }.";
  if (doc.popups.length > MAX_POPUPS) return `At most ${MAX_POPUPS} popups.`;
  const size = Buffer.byteLength(JSON.stringify(doc), "utf8");
  if (size > MAX_DOC_BYTES) return `Too much content (${Math.round(size / 1024)} KB).`;
  const ids = new Set();
  for (const p of doc.popups) {
    if (ids.has(p.id)) return `Two popups share the id ${p.id}.`;
    ids.add(p.id);
    if (p.enabled && !p.headline) return `“${p.name}” needs a headline before it can be switched on.`;
    if (p.enabled && p.pages.mode !== "all" && !p.pages.rules.length) return `“${p.name}” is set to specific pages but has no pages listed.`;
    for (const f of p.fields) {
      if (p.enabled && f.on && f.options && !f.options.length) return `“${p.name}”: the “${f.label}” dropdown has no options.`;
    }
  }
  return null;
}

/**
 * Does a page path match a popup's page rules?
 * Rules are paths ("/programs/south-america-gap-semester"), full URLs, or
 * patterns with * ("/programs/*"). Trailing slashes and query strings are
 * ignored. Kept free of outside references: the embed script inlines it.
 */
export function matchPage(pathname, pages) {
  function clean(p) {
    p = String(p || "").trim();
    var m = /^https?:\/\/[^/]+(\/[^?#]*)?/i.exec(p);
    if (m) p = m[1] || "/";
    p = p.split("?")[0].split("#")[0];
    if (p.charAt(0) !== "/") p = "/" + p;
    if (p.length > 1) p = p.replace(/\/+$/, "");
    return p.toLowerCase();
  }
  function hit(path, rule) {
    var r = clean(rule);
    if (r.indexOf("*") < 0) return r === path;
    var re = new RegExp("^" + r.split("*").map(function (s) { return s.replace(/[.+?^${}()|[\]\\]/g, "\\$&"); }).join(".*") + "$");
    return re.test(path);
  }
  var path = clean(pathname);
  var mode = (pages && pages.mode) || "all";
  var rules = (pages && pages.rules) || [];
  if (mode === "all") return true;
  var any = false;
  for (var i = 0; i < rules.length; i++) if (hit(path, rules[i])) { any = true; break; }
  return mode === "include" ? any : !any;
}

/** What the public embed script gets: live popups only, no internal notes. */
export function publicConfig(doc, origin) {
  return (doc?.popups || []).filter((p) => p.enabled).map((p) => ({
    id: p.id,
    name: p.name,
    starts: p.starts,
    ends: p.ends,
    layout: p.layout,
    imagePos: p.image ? p.imagePos : "none",
    image: imageUrl(p.image, origin),
    imageAlt: p.imageAlt,
    accent: p.accent,
    eyebrow: p.eyebrow,
    headline: p.headline,
    body: p.body,
    button: p.button,
    privacy: p.privacy,
    success: p.success,
    fields: p.fields.filter((f) => f.on).map((f) => {
      const def = FIELD_DEFS.find((d) => d.key === f.key);
      return { key: f.key, label: f.label, type: def.type, required: f.required, autocomplete: def.autocomplete || "", ...(f.options ? { options: f.options } : {}) };
    }),
    pages: p.pages,
    devices: p.devices,
    trigger: p.trigger,
    frequency: p.frequency,
  }));
}

/** Uploaded images are stored as "media:<key>" and served by /api/popup-embed. */
export function imageUrl(v, origin = "") {
  if (typeof v === "string" && v.startsWith("/api/popup-embed?img=")) return `${origin}${v}`;
  return v || "";
}

const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[a-z]{2,}$/i;

/**
 * Check a submission against the popup it claims to come from.
 * @returns {{ errors: Record<string,string>, values: Record<string,string> }}
 */
export function checkSubmission(popup, input) {
  const errors = {};
  const values = {};
  const fields = popup.fields.filter((f) => f.on);
  for (const f of fields) {
    let v = str(input?.[f.key], 300).trim();
    if (!v) {
      if (f.required) errors[f.key] = `${f.label} is required.`;
      continue;
    }
    if (f.key === "email") {
      v = v.toLowerCase();
      if (!EMAIL_RE.test(v)) { errors[f.key] = "Please enter a valid email address."; continue; }
    }
    if (f.key === "phone" && !/^[+()\d\s.\-]{6,30}$/.test(v)) { errors[f.key] = "Please enter a valid phone number."; continue; }
    if (f.options) {
      const opt = f.options.find((o) => o.value === v);
      if (!opt) { errors[f.key] = `Please choose a ${f.label.toLowerCase()}.`; continue; }
    }
    values[f.key] = v;
  }
  return { errors, values };
}

/**
 * The HubSpot contact properties for a submission.
 * @param popup    normalized popup
 * @param values   checked values (checkSubmission)
 * @param existing the contact's current properties, or null if new
 * @param tagMulti true when company_tag is a multi-select (values joined by ";")
 */
export function hubspotProperties(popup, values, existing, tagMulti = false) {
  const props = {};
  for (const f of popup.fields) {
    if (!f.on || !f.property || values[f.key] == null) continue;
    props[f.property] = values[f.key];
  }
  props.email = values.email;
  const tag = HUBSPOT_TAG.value;
  if (tagMulti) {
    const have = String(existing?.[HUBSPOT_TAG.property] || "").split(";").map((s) => s.trim()).filter(Boolean);
    props[HUBSPOT_TAG.property] = have.includes(tag) ? have.join(";") : [...have, tag].join(";");
  } else {
    props[HUBSPOT_TAG.property] = tag;
  }
  props[LEAD_STATUS.property] = LEAD_STATUS.value;
  const stage = String(existing?.lifecyclestage || "");
  if (!existing || EARLY_STAGES.includes(stage)) props.lifecyclestage = "lead";
  return props;
}

/** A readable note for the contact's timeline. */
export function noteText(popup, values, page) {
  const lines = [`Website popup: ${popup.name}`];
  if (page?.uri) lines.push(`Page: ${str(page.uri, 300)}`);
  for (const f of popup.fields) {
    if (!f.on || values[f.key] == null) continue;
    const opt = f.options?.find((o) => o.value === values[f.key]);
    lines.push(`${f.label}: ${opt ? opt.label : values[f.key]}`);
  }
  return lines.join("\n");
}

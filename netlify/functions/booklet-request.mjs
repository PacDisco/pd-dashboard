// netlify/functions/booklet-request.mjs
//
// PUBLIC. A visitor asking for a program's info booklet from a program or
// landing page (pd-program-pages: "Get the itinerary", "Download full
// itinerary", landing-page booklet buttons).
//
//   1. Looks up the booklet link from the PUBLISHED page (Page settings →
//      Info booklet download link). The page itself never contains it, and the
//      visitor can't choose it, so this can't be used to email arbitrary links.
//   2. Saves the lead to HubSpot exactly like a website popup sign-up
//      (company_tag = Pacific Discovery, Lead status = New, Lifecycle = Lead
//      unless further along, timeline note + PDF).
//   3. Emails the visitor the link through the Gmail mailbox connected in
//      Website Popups (Connect Gmail).
//   4. Optionally emails the team (BOOKLET_NOTIFY_EMAILS, comma separated).
//   5. Answers { ok, url, emailed } and the page opens the booklet.
//
// The visitor always gets the booklet once their details are valid, even if
// HubSpot or Gmail is having a bad moment (both failures are logged).
//
// Request (JSON): { slug, fields: {firstname, lastname, email, role}, page: {uri, title}, website, t }
//   website = honeypot (must be empty); t = ms since the form opened.
//
// Only accepted from BOOKLET_ALLOWED_ORIGINS (default www + apex
// pacificdiscovery.org and https://pd-program-pages.netlify.app).

import { neon } from "@neondatabase/serverless";
import { bookletOrigins, bookletUrlOf, checkBooklet, bookletForm, visitorEmail, cleanPage, matchOption, SLUG_RE } from "./_shared/booklet-core.mjs";
import { notificationEmail, sendMail } from "./_shared/popups-gmail.mjs";
import { popupStore } from "./_shared/popups-store.mjs";
import { upsertContact, contactProperties } from "./_shared/popups-hubspot.mjs";

function respond(body, status, origin) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      ...(origin ? { "Access-Control-Allow-Origin": origin, Vary: "Origin" } : {}),
    },
  });
}

// Light per-instance throttle: 6 requests a minute per IP.
const hits = new Map();
function throttled(ip, now = Date.now()) {
  const list = (hits.get(ip) || []).filter((t) => now - t < 60_000);
  list.push(now);
  hits.set(ip, list);
  if (hits.size > 5000) hits.clear();
  return list.length > 6;
}

// Published pages change rarely; keep lookups for a minute per instance.
const pageCache = new Map();
async function publishedPage(slug) {
  const hit = pageCache.get(slug);
  if (hit && Date.now() - hit.at < 60_000) return hit.page;
  const url = process.env.NETLIFY_DATABASE_URL;
  if (!url) throw new Error("NETLIFY_DATABASE_URL not configured");
  const rows = await neon(url)`
    SELECT name, published FROM program_pages
    WHERE slug = ${slug} AND published IS NOT NULL AND archived_at IS NULL
    LIMIT 1`;
  const page = rows[0] ? { name: rows[0].published?.name || rows[0].name, template: rows[0].published?.template, url: bookletUrlOf(rows[0].published) } : null;
  pageCache.set(slug, { at: Date.now(), page });
  if (pageCache.size > 200) pageCache.clear();
  return page;
}

export default async (req, context) => {
  const origins = bookletOrigins();
  const origin = (req.headers.get("origin") || "").replace(/\/+$/, "");
  const ok = origins.includes(origin) ? origin : "";

  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: ok ? 204 : 403,
      headers: ok ? {
        "Access-Control-Allow-Origin": ok,
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Max-Age": "86400",
        Vary: "Origin",
      } : {},
    });
  }
  if (req.method !== "POST") return respond({ error: "POST only." }, 405, ok);
  if (!ok) return respond({ error: "Not allowed from this site." }, 403, "");

  const ip = context?.ip || req.headers.get("x-nf-client-connection-ip") || "unknown";
  if (throttled(ip)) return respond({ error: "Too many tries. Please wait a minute and try again." }, 429, ok);

  let body;
  try { body = await req.json(); } catch { return respond({ error: "Bad request." }, 400, ok); }

  const slug = String(body?.slug || "");
  if (!SLUG_RE.test(slug) || slug.length > 80) return respond({ error: "This booklet isn't available. Please refresh the page." }, 404, ok);

  let page;
  try { page = await publishedPage(slug); } catch (e) {
    console.error("[booklet-request] page lookup failed:", e.message);
    return respond({ error: "Sorry, something went wrong on our side. Please try again in a moment." }, 502, ok);
  }
  if (!page || !page.url) return respond({ error: "This booklet isn't available right now. Please refresh the page." }, 404, ok);

  const { errors, values } = checkBooklet(body.fields || {});
  if (Object.keys(errors).length) return respond({ error: "Please check the highlighted fields.", errors }, 400, ok);

  // Bots: filled the hidden field, or submitted faster than a person could.
  // Let them "through" but store and send nothing.
  if (body?.website || Number(body?.t) < 1000) return respond({ ok: true, url: page.url, emailed: false }, 200, ok);

  const landing = page.template === "landing";
  const form = bookletForm({ slug, name: page.name, template: page.template });
  const prog = form.fields.find((f) => f.key === "program");
  // Use the program's own option in the HubSpot dropdown (e.g. program_interest)
  // when there is one; otherwise the property is left out and only the note has it.
  if (prog.property) {
    const props = await contactProperties().catch(() => null);
    const value = matchOption(props?.find((x) => x.name === prog.property), page.name, slug);
    if (value) prog.options = [{ label: prog.options[0].label, value }];
  }
  const vals = { ...values, program: prog.options[0].value };
  const where = cleanPage(body.page, origins);

  // HubSpot and the two emails run side by side; none of them can block the booklet.
  const store = popupStore();
  const conn = await store.get("gmail", { type: "json" }).catch(() => null);
  const [contact, emailed] = await Promise.all([
    upsertContact(form, vals, where).then((c) => {
      console.log(`[booklet-request] ${slug} → contact ${c.id} (${c.created ? "new" : "updated"})`);
      return c;
    }).catch((e) => { console.error("[booklet-request] HubSpot failed:", e.message); return null; }),
    sendVisitor(conn, store, { values, programName: page.name, url: page.url, landing, pageUrl: where.safe }),
  ]);
  if (form.notify.emails.length && conn?.refreshToken) {
    try {
      await sendMail(conn, { to: form.notify.emails, replyTo: values.email, ...notificationEmail(form, vals, where, contact) });
    } catch (e) { console.error("[booklet-request] team email failed:", e.message); }
  }
  if (!contact && !emailed) console.error(`[booklet-request] ${slug}: LEAD NOT SAVED for ${values.email} (HubSpot and Gmail both failed)`);
  return respond({ ok: true, url: page.url, emailed }, 200, ok);
};

/** Email the visitor their link. Never throws. */
async function sendVisitor(conn, store, args) {
  if (!conn?.refreshToken) { console.warn("[booklet-request] no Gmail mailbox connected (Website Popups → Connect Gmail); visitor not emailed"); return false; }
  try {
    const msg = visitorEmail(args);
    const replyTo = process.env.BOOKLET_REPLY_TO || "";
    await sendMail(conn, { to: [args.values.email], fromName: "Pacific Discovery", ...(replyTo ? { replyTo } : {}), ...msg });
    return true;
  } catch (e) {
    console.error("[booklet-request] visitor email failed:", e.message);
    try {
      await store.setJSON("gmail", { ...conn, lastError: `${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC: ${e.message.slice(0, 200)}` });
    } catch { /* ignore */ }
    return false;
  }
}

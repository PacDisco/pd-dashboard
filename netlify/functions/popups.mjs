// netlify/functions/popups.mjs
//
// The popup designer's API (dashboard page /popups/). Every route needs a
// signed-in user with access to the Website Popups dashboard.
//
//   GET  ?action=list         → { rev, popups, stats, blank, fieldDefs, user, embedUrl }
//   GET  ?action=properties   → { properties }  HubSpot contact properties + options
//   POST { action:"save", rev, popups } → { rev } | 409 { error, rev }
//   POST ?action=upload       raw image body (image/jpeg|png|webp|gif) → { url }
//
// Saving is what makes a change live: switched-on popups are served to the
// website by /api/popup-embed within about a minute (CDN cache).

import crypto from "node:crypto";
import { requirePopupEditor, json } from "./_shared/popups-access.mjs";
import { normalizePopup, validateDoc, blankPopup, FIELD_DEFS } from "./_shared/popups-core.mjs";
import { popupStore, readDoc, writeDoc, readStats } from "./_shared/popups-store.mjs";
import { contactProperties } from "./_shared/popups-hubspot.mjs";

const TYPES = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif" };
const MAX_IMG = 3 * 1024 * 1024;

function sniff(buf) {
  const b = new Uint8Array(buf.slice(0, 12));
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return "image/gif";
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "image/webp";
  return null;
}

export default async (req) => {
  const user = await requirePopupEditor(req);
  if (user instanceof Response) return user;
  const url = new URL(req.url);
  const action = url.searchParams.get("action");
  const store = popupStore();

  try {
    if (req.method === "GET" && action === "list") {
      const [doc, stats] = await Promise.all([readDoc(store), readStats(store)]);
      return json({ ...doc, stats, blank: blankPopup("New popup"), fieldDefs: FIELD_DEFS, user: { email: user.email, name: user.name }, embedUrl: `${url.origin}/api/popup-embed` });
    }

    if (req.method === "GET" && action === "properties") {
      try {
        return json({ properties: await contactProperties() });
      } catch (e) {
        return json({ error: `Couldn't load HubSpot properties: ${e.message}` }, 502);
      }
    }

    if (req.method === "POST" && action === "upload") {
      const declared = (req.headers.get("content-type") || "").split(";")[0].trim();
      if (!TYPES[declared]) return json({ error: "Upload a JPG, PNG, WebP or GIF." }, 415);
      const buf = await req.arrayBuffer();
      if (!buf.byteLength || buf.byteLength > MAX_IMG) return json({ error: "Images must be under 3 MB." }, 413);
      if (sniff(buf) !== declared) return json({ error: "That file isn't the image type it claims to be." }, 415);
      const key = `${Date.now().toString(36)}-${crypto.randomBytes(6).toString("hex")}.${TYPES[declared]}`;
      await store.set(`img/${key}`, buf, { metadata: { type: declared, by: user.actor } });
      return json({ url: `/api/popup-embed?img=${key}` }, 201);
    }

    if (req.method === "POST") {
      let body;
      try { body = await req.json(); } catch { return json({ error: "Bad JSON." }, 400); }
      if (body?.action !== "save") return json({ error: "Unknown action." }, 400);
      const current = await readDoc(store);
      if (Number(body.rev) !== current.rev) {
        return json({ error: "Someone else saved popups since you opened this page. Reload to see their changes.", rev: current.rev }, 409);
      }
      const now = new Date().toISOString();
      const before = new Map(current.popups.map((p) => [p.id, JSON.stringify({ ...p, updatedAt: "", updatedBy: "" })]));
      const popups = (Array.isArray(body.popups) ? body.popups : []).map((p) => {
        const n = normalizePopup(p);
        // Only stamp the popups that actually changed.
        const same = before.get(n.id) === JSON.stringify({ ...n, updatedAt: "", updatedBy: "" });
        return same ? current.popups.find((x) => x.id === n.id) : { ...n, updatedAt: now, updatedBy: user.actor };
      });
      const doc = { rev: current.rev + 1, popups };
      const problem = validateDoc(doc);
      if (problem) return json({ error: problem }, 400);
      await writeDoc(doc, store);
      return json({ rev: doc.rev, popups });
    }

    return json({ error: "Unknown action." }, 400);
  } catch (e) {
    console.error("[popups]", e);
    return json({ error: "Something went wrong saving popups." }, 500);
  }
};

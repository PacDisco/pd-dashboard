// netlify/functions/program-media.mjs
//
// Images for program pages, stored in Netlify Blobs (store "program-media").
//
//   POST /api/program-media            raw image body; Content-Type image/jpeg|png|webp|gif
//                                      header X-Filename optional (kept as metadata)
//                                      → { key, url }
//   GET  /api/program-media?key=…      the image bytes
//   GET  /api/program-media?action=list → recent uploads, for the editor's picker
//
// Who can do what:
//   - Uploading and listing need a Program Pages editor (Identity, verified).
//   - Reading an image needs an editor session (the editor preview sends the
//     nf_jwt cookie) OR the build token, which is how pd-program-pages copies
//     images into its own static output at build time. The public never loads
//     images from the dashboard.
//
// SVG is refused on purpose: an SVG is a document that can carry script.
// The editor resizes photos to max 2400px before uploading, which keeps
// uploads well under the 6 MB function body limit.

import crypto from "node:crypto";
import { getStore } from "@netlify/blobs";
import { requireEditor, json, tokenOk } from "./_shared/program-pages-access.mjs";

const TYPES = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif" };
const MAX_BYTES = 5 * 1024 * 1024;
export const KEY_RE = /^[a-z0-9][a-z0-9._-]{0,150}$/i;

function media() {
  return getStore({ name: "program-media", consistency: "strong" });
}

export function newKey(type, now = new Date()) {
  const ym = `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  return `${ym}-${crypto.randomBytes(9).toString("hex")}.${TYPES[type]}`;
}

/** Cheap magic-number check so a renamed file can't pose as an image. */
export function sniff(buf) {
  const b = new Uint8Array(buf.slice(0, 12));
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return "image/gif";
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "image/webp";
  return null;
}

async function upload(req) {
  const user = await requireEditor(req, "program-media");
  if (user instanceof Response) return user;
  const declared = (req.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  if (!TYPES[declared]) return json({ error: "Upload a JPG, PNG, WebP or GIF image." }, 415);
  const buf = await req.arrayBuffer();
  if (!buf.byteLength) return json({ error: "Empty upload." }, 400);
  if (buf.byteLength > MAX_BYTES) return json({ error: "Image is over 5 MB. Try a smaller one." }, 413);
  const actual = sniff(buf);
  if (actual !== declared) return json({ error: "That file isn't the image type it claims to be." }, 415);

  const stored = await storeImage(buf, { name: req.headers.get("x-filename"), actor: user.actor, origin: new URL(req.url).origin });
  return json(stored, 201);
}

/**
 * Store an already-validated image and return its editor URL. Shared with
 * program-drive.mjs so Drive imports land in the same place as uploads.
 * Re-checks the bytes itself, so callers can't store a non-image by mistake.
 */
export async function storeImage(buf, { name = "", actor = "unknown", source = "upload", origin = "" } = {}, store = media()) {
  const type = sniff(buf);
  if (!type) throw new Error("Not a JPG, PNG, WebP or GIF image");
  if (buf.byteLength > MAX_BYTES) throw new Error("Image is over 5 MB");
  const key = newKey(type);
  const clean = String(name || "").replace(/[^\w .()-]/g, "").slice(0, 120);
  await store.set(key, buf, { metadata: { type, name: clean, source, uploadedBy: actor, uploadedAt: new Date().toISOString(), bytes: buf.byteLength } });
  const base = (process.env.URL || origin).replace(/\/+$/, "");
  return { key, url: `${base}/api/program-media?key=${encodeURIComponent(key)}` };
}

async function listRecent(req) {
  const user = await requireEditor(req, "program-media");
  if (user instanceof Response) return user;
  const { blobs } = await media().list();
  const keys = blobs.map((b) => b.key).sort().reverse().slice(0, 60);
  const origin = (process.env.URL || new URL(req.url).origin).replace(/\/+$/, "");
  const items = await Promise.all(keys.map(async (key) => {
    const meta = await media().getMetadata(key).catch(() => null);
    return { key, url: `${origin}/api/program-media?key=${encodeURIComponent(key)}`, name: meta?.metadata?.name || "", uploadedAt: meta?.metadata?.uploadedAt || null };
  }));
  return json({ items });
}

async function serve(req, key) {
  if (!KEY_RE.test(key)) return json({ error: "Bad key" }, 400);
  if (!tokenOk(req)) {
    const user = await requireEditor(req, "program-media");
    if (user instanceof Response) return user;
  }
  const res = await media().getWithMetadata(key, { type: "arrayBuffer" });
  if (!res) return json({ error: "Not found" }, 404);
  const type = TYPES[res.metadata?.type] ? res.metadata.type : "application/octet-stream";
  return new Response(res.data, {
    status: 200,
    headers: {
      "Content-Type": type,
      "Cache-Control": "private, max-age=3600",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
    },
  });
}

export default async (req) => {
  try {
    const url = new URL(req.url);
    if (req.method === "POST") return await upload(req);
    if (req.method === "GET") {
      if (url.searchParams.get("action") === "list") return await listRecent(req);
      return await serve(req, url.searchParams.get("key") || "");
    }
    return json({ error: "Method not allowed" }, 405);
  } catch (err) {
    console.error("program-media:", err);
    return json({ error: "Image request failed." }, 500);
  }
};

// netlify/functions/_shared/popups-store.mjs
//
// Popups live in Netlify Blobs, store "popups":
//   doc      { rev, popups: [...] }        the designs (one small document)
//   stats    { [id]: { submits, last } }   submission counts for the list view
//   img/<k>  uploaded images (served publicly by /api/popup-embed?img=<k>)

import { getStore } from "@netlify/blobs";
import { normalizePopup } from "./popups-core.mjs";

export function popupStore() {
  try {
    return getStore({ name: "popups", consistency: "strong" });
  } catch {
    const siteID = process.env.NETLIFY_SITE_ID || process.env.SITE_ID;
    const token = process.env.NETLIFY_BLOBS_TOKEN || process.env.NETLIFY_API_TOKEN;
    return getStore({ name: "popups", consistency: "strong", siteID, token });
  }
}

export async function readDoc(store = popupStore()) {
  const raw = await store.get("doc", { type: "json" }).catch(() => null);
  return { rev: Number(raw?.rev) || 0, popups: (raw?.popups || []).map(normalizePopup) };
}

export async function writeDoc(doc, store = popupStore()) {
  await store.setJSON("doc", doc);
}

export async function readStats(store = popupStore()) {
  return (await store.get("stats", { type: "json" }).catch(() => null)) || {};
}

export async function bumpStats(id, store = popupStore()) {
  // Counts are a convenience for the list view; HubSpot is the record.
  const stats = await readStats(store);
  const s = stats[id] || { submits: 0, last: null };
  s.submits += 1;
  s.last = new Date().toISOString();
  stats[id] = s;
  await store.setJSON("stats", stats);
}

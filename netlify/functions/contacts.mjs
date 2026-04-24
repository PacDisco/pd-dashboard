/**
 * netlify/functions/contacts.mjs
 *
 * Returns the cached Pacific Discovery contacts snapshot from Netlify Blobs.
 * The dashboard HTML calls this on page load.
 *
 * If the blob is empty (first deploy before the scheduler runs), returns an
 * empty payload with a note; the dashboard will show a "Not yet refreshed"
 * state and the user can click the Refresh button.
 */

import { getStore } from "@netlify/blobs";

const STORE_NAME = "pd-dashboard";
const BLOB_KEY = "snapshot";

export default async (req) => {
  try {
    const store = getStore(STORE_NAME);
    const payload = await store.get(BLOB_KEY, { type: "json" });
    if (!payload) {
      return new Response(JSON.stringify({
        generatedAt: null,
        total: 0,
        rows: [],
        portalId: 3855728,
        filters: { company_tag: "Pacific Discovery", hs_lead_status: "NEW" },
        note: "No snapshot yet. Trigger /.netlify/functions/refresh-contacts."
      }), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "cache-control": "no-store"
        }
      });
    }
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: {
        "content-type": "application/json",
        // Browsers revalidate every minute; Netlify CDN can hold briefly.
        "cache-control": "public, max-age=60, s-maxage=60, stale-while-revalidate=600"
      }
    });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: err?.message || String(err) }), {
      status: 500,
      headers: { "content-type": "application/json" }
    });
  }
};

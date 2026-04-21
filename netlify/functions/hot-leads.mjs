// netlify/functions/hot-leads.mjs
//
// Read endpoint the frontend hits to display the dashboard.
// Serves the JSON written by refresh-hot-leads.mjs from Netlify Blobs.
// No HubSpot token exposure to the browser.
//
// URL: /.netlify/functions/hot-leads

import { getStore } from "@netlify/blobs";

export default async () => {
  const store = getStore({ name: "hot-leads", consistency: "strong" });
  const payload = await store.get("hot-leads.json", { type: "json" });

  if (!payload) {
    return new Response(
      JSON.stringify({
        summary: { generatedAt: null, counts: { total: 0, Sale: 0, Opportunity: 0, Applicant: 0 }, totalPipelineValue: 0, pipelinesScanned: [], recencyDays: 14 },
        records: [],
        message: "No feed yet — run the refresh function once to populate.",
      }),
      { status: 200, headers: { "content-type": "application/json", "cache-control": "public, max-age=60" } },
    );
  }

  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: {
      "content-type": "application/json",
      // Short cache so a manual refresh via URL is snappy.
      "cache-control": "public, max-age=60",
    },
  });
};

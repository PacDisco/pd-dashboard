// netlify/functions/hot-leads.mjs
//
// Read endpoint the frontend hits to display the dashboard.
// Serves the JSON written by refresh-hot-leads.mjs from Netlify Blobs.
// No HubSpot token exposure to the browser.
//
// URL: /.netlify/functions/hot-leads

import { getStore } from "@netlify/blobs";

export default async (req) => {
  const url = new URL(req.url);
  const includeExcluded = url.searchParams.get("include_excluded") === "true";
  const store = getStore({ name: "hot-leads", consistency: "strong" });
  const [payload, flags, exclusions] = await Promise.all([
    store.get("hot-leads.json", { type: "json" }),
    store.get("flags.json", { type: "json" }),
    store.get("exclusions.json", { type: "json" }),
  ]);

  const flagMap = flags || {};
  const exclMap = exclusions || {};

  if (!payload) {
    return new Response(
      JSON.stringify({
        summary: { generatedAt: null, counts: { total: 0, Opportunity: 0, Applicant: 0, SQL: 0, HotLead: 0, Excluded: 0 }, totalPipelineValue: 0, pipelinesScanned: { applicant: [], opportunity: [] }, recencyDays: 14 },
        records: [],
        flagCount: Object.keys(flagMap).length,
        exclusionCount: Object.keys(exclMap).length,
        message: "No feed yet — run the refresh function once to populate.",
      }),
      { status: 200, headers: { "content-type": "application/json", "cache-control": "public, max-age=30" } },
    );
  }

  // Merge live flag + exclusion state into the records.
  const existingIds = new Set(payload.records.map(r => r.contactId));
  let records = payload.records.map(r => {
    const f = flagMap[r.contactId];
    const x = exclMap[r.contactId];
    const flagPart = f
      ? { isHotLead: true,  hotLeadFlaggedAt: f.flaggedAt, hotLeadFlaggedBy: f.flaggedBy, hotLeadNote: f.note }
      : { isHotLead: false };
    const exclPart = x
      ? { isExcluded: true, excludedAt: x.excludedAt, excludedBy: x.excludedBy, exclusionReason: x.reason }
      : { isExcluded: false };
    return { ...r, ...flagPart, ...exclPart };
  });

  // Any contact that's been flagged but isn't in the refresh output still
  // surfaces as a "Hot Lead" stub so the flag isn't invisible.
  for (const [contactId, f] of Object.entries(flagMap)) {
    if (!existingIds.has(contactId)) {
      records.push({
        contactId,
        name: `Contact ${contactId}`,
        email: null,
        bucket: "Hot Lead",
        stageLabel: "Manually flagged",
        pipelineLabel: null,
        amount: null,
        owner: null,
        lastActivity: f.flaggedAt,
        daysSinceTouch: Math.round((Date.now() - new Date(f.flaggedAt).getTime()) / 86400000),
        daysInStage: null,
        isHotLead: true,
        hotLeadFlaggedAt: f.flaggedAt,
        hotLeadFlaggedBy: f.flaggedBy,
        hotLeadNote: f.note,
        contactUrl: `https://app.hubspot.com/contacts/3855728/record/0-1/${contactId}?utm_source=hot_leads_dashboard`,
        dealUrl: null,
      });
    }
  }

  // Re-sort so Hot Lead flags always appear first.
  const bucketRank = { "Hot Lead": -1, "Opportunity": 0, "Applicant": 1, "SQL": 2 };
  records.sort((a, b) => {
    // Flagged always above unflagged within the same bucket
    if (a.isHotLead !== b.isHotLead) return a.isHotLead ? -1 : 1;
    const rd = (bucketRank[a.bucket] ?? 99) - (bucketRank[b.bucket] ?? 99);
    if (rd) return rd;
    if (a.bucket === "SQL" && b.bucket === "SQL") return (b.sqlScore || 0) - (a.sqlScore || 0);
    return new Date(b.lastActivity || 0) - new Date(a.lastActivity || 0);
  });

  // Filter out excluded contacts by default. Caller can pass
  // ?include_excluded=true to see them (for un-exclude management).
  const excludedCount = records.filter(r => r.isExcluded).length;
  if (!includeExcluded) {
    records = records.filter(r => !r.isExcluded);
  }

  const mergedSummary = {
    ...payload.summary,
    counts: {
      ...(payload.summary?.counts || {}),
      HotLead: records.filter(r => r.isHotLead).length,
      Excluded: excludedCount,
      total: records.length,
    },
  };

  return new Response(JSON.stringify({ ...payload, summary: mergedSummary, records, flagCount: Object.keys(flagMap).length, exclusionCount: Object.keys(exclMap).length }), {
    status: 200,
    headers: {
      "content-type": "application/json",
      // Short cache so flags appear quickly but we don't hammer Blobs.
      "cache-control": "public, max-age=30",
    },
  });
};

// netlify/functions/program-pages-export.mjs
//
// GET /api/program-pages-export
//
// The ONE endpoint the public pd-program-pages build calls. Returns published
// program pages only — never drafts, never archived pages, never who edited
// what. Authenticated with `Authorization: Bearer <PROGRAM_PAGES_BUILD_TOKEN>`
// (the same value is set on both Netlify sites). No Identity session works
// here and the token works nowhere else except reading program media.
//
// Rotating the token: set a new value on both sites, then redeploy
// pd-program-pages.

import { neon } from "@neondatabase/serverless";
import { json, tokenOk } from "./_shared/program-pages-access.mjs";

export default async (req) => {
  if (req.method !== "GET") return json({ error: "Method not allowed" }, 405);
  if (!tokenOk(req)) return json({ error: "Not found" }, 404);
  try {
    const url = process.env.NETLIFY_DATABASE_URL;
    if (!url) throw new Error("NETLIFY_DATABASE_URL not configured");
    const rows = await neon(url)`
      SELECT slug, published, published_at FROM program_pages
      WHERE published IS NOT NULL AND archived_at IS NULL
      ORDER BY slug`;
    return json({
      generatedAt: new Date().toISOString(),
      programs: rows.map((r) => ({ slug: r.slug, publishedAt: r.published_at, data: r.published })),
    });
  } catch (err) {
    console.error("program-pages-export:", err);
    return json({ error: "Export failed" }, 500);
  }
};

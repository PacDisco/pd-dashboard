// netlify/functions/program-pages-nightly.mjs
//
// Rebuilds pd-program-pages once a day so date-driven content stays right
// without anyone publishing: the hero's "Next departure" moves on to the next
// session, and sessions that have started drop off the Dates list.
//
// Runs only when at least one page is published. Uses the same build hook as
// publishing (PROGRAM_SITE_BUILD_HOOK).
//
// 13:00 UTC = 2am in New Zealand (NZDT), 1am NZST — after the date has changed
// for NZ, and still the same calendar day in the US.

import { neon } from "@neondatabase/serverless";
import { triggerBuild } from "./program-pages.mjs";

export const config = { schedule: "0 13 * * *" };

export default async () => {
  try {
    const url = process.env.NETLIFY_DATABASE_URL;
    if (!url) throw new Error("NETLIFY_DATABASE_URL not configured");
    const [{ n }] = await neon(url)`SELECT count(*)::int AS n FROM program_pages WHERE published IS NOT NULL AND archived_at IS NULL`;
    if (!n) return new Response("No published program pages; skipped.");
    const r = await triggerBuild(`Nightly refresh (${n} published page${n === 1 ? "" : "s"})`);
    if (!r.triggered) console.warn("program-pages-nightly:", r.message);
    return new Response(r.triggered ? "Rebuild triggered." : r.message);
  } catch (err) {
    console.error("program-pages-nightly:", err);
    return new Response("Failed", { status: 500 });
  }
};

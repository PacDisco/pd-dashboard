// netlify/edge-functions/lib/tile-badges.js
//
// Which dashboards show a "new submissions" bubble on their landing-page tile.
// Shared by the edge auth gate (which records a visit when someone opens one
// of these dashboards) and netlify/functions/tile-badges.mjs (which counts).
//
// Plain JS with no imports so both runtimes (Deno edge, Node functions) and
// the tests can load it. The per-dashboard counting logic lives in
// netlify/functions/_shared/tile-badge-sources.mjs — add a slug there AND here.

export const BADGED_SLUGS = new Set([
  "apply-form",
  "field-budget",
  "instructor-checkins",
  "instructor-field-reports",
  "instructors",
  "invoices",
  "popups",
  "sign-inbox",
  "student-uploads",
  "ue-applications",
]);

/**
 * True when `pathname` is the dashboard's own landing page (/slug, /slug/,
 * /slug/index.html). Sub-pages like /apply-form/quiz.html don't count as
 * "having looked at the new submissions".
 */
export function isDashboardRoot(pathname, slug) {
  const p = String(pathname || "").toLowerCase().replace(/\/index\.html$/, "/").replace(/\/+$/, "");
  return p === `/${String(slug || "").toLowerCase()}`;
}

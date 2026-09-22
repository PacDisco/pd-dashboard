// netlify/edge-functions/lib/dashboard-access.js
//
// THE access rule for "may this person open this dashboard?", in one place.
//
// Why it lives under netlify/edge-functions/: the edge runtime only bundles
// code reachable from the edge functions directory, and Netlify only registers
// files at the TOP level of that directory as edge functions — anything in a
// subdirectory is shared code. Node functions import it from here with a
// relative path, so there is exactly one copy of the rule rather than two that
// drift apart.
//
// This file must stay dependency-free (no @netlify/blobs, no node: imports) so
// it runs unchanged in Deno (edge), Node (functions) and the test runner.
//
// ─────────────────────────────────────────────────────────────────────────────
// The model
//
//   Access to a dashboard is granted PER PERSON, by email.
//
//   The grants document (Netlify Blobs → store "dashboards", key "grants"):
//     { "version": 1,
//       "updatedAt": "2026-09-22T...",
//       "users": { "jake@boulderdigitalmedia.com": ["flights", "invoices"] } }
//
//   Resolution order:
//     1. `admin` role  → everything, always. (Unchanged.)
//     2. The person has a grant record → they see exactly what it lists.
//        An empty array is a real answer: "nothing". It is NOT a fall-through.
//     3. No grant record at all → fall back to the legacy role rule
//        (dashboard.allowedRoles ∩ the person's roles).
//
//   Step 3 is what makes this deployable without a flag day: before anyone has
//   been given an explicit list, every user keeps precisely the access they
//   have today. As people are granted lists one by one, each one moves onto
//   the new rule independently. Once everyone has a record, roles no longer
//   affect visibility at all — they only gate in-app powers (approving
//   timesheets, writing marketing spend, marking a student dropped, …), which
//   is why they are still read and still edited in the admin screen.

export const ADMIN_ROLE = "admin";

// Every signed-in person carries this role. It exists solely so the coarse
// `Role=` backstop in _redirects can say "a known user" without naming a job
// function — a person whose access is entirely per-dashboard may legitimately
// hold no functional role at all. See scripts/build-manifest.js.
export const BASELINE_ROLE = "member";

/** Lowercase + trim an email for use as a grants key. Returns "" if unusable. */
export function emailKey(email) {
  return typeof email === "string" ? email.trim().toLowerCase() : "";
}

/**
 * Coerce whatever came out of the blob (or off the wire) into a known shape.
 * Unknown keys are dropped, slugs are lowercased and de-duplicated, and any
 * non-array value becomes an empty array rather than disappearing — losing a
 * key would silently promote someone back to the legacy role rule.
 */
export function normalizeGrants(raw) {
  const users = {};
  const src = raw && typeof raw === "object" && raw.users && typeof raw.users === "object"
    ? raw.users
    : {};
  for (const [rawEmail, slugs] of Object.entries(src)) {
    const key = emailKey(rawEmail);
    if (!key) continue;
    const list = Array.isArray(slugs) ? slugs : [];
    users[key] = [...new Set(
      list.filter((s) => typeof s === "string" && s.trim()).map((s) => s.trim().toLowerCase())
    )];
  }
  return {
    version: 1,
    updatedAt: (raw && typeof raw.updatedAt === "string") ? raw.updatedAt : null,
    users,
  };
}

/**
 * The person's explicit dashboard list, or null when they have no record and
 * therefore still fall back to roles. Distinguishing null from [] is the whole
 * point — see the header.
 */
export function grantedSlugs(grants, email) {
  const key = emailKey(email);
  if (!key || !grants || !grants.users) return null;
  const list = grants.users[key];
  return Array.isArray(list) ? list : null;
}

export function hasGrantRecord(grants, email) {
  return grantedSlugs(grants, email) !== null;
}

export function isAdmin(roles) {
  return Array.isArray(roles) && roles.includes(ADMIN_ROLE);
}

/**
 * May this person open this dashboard?
 *
 * @param {object}   opts
 * @param {string}   opts.email      caller's email (from the Identity JWT)
 * @param {string[]} opts.roles      caller's app_metadata.roles
 * @param {string}   opts.slug       dashboard slug (case-insensitive)
 * @param {object}   [opts.dashboard] manifest entry — only needed for the
 *                                    legacy fallback (its allowedRoles)
 * @param {object}   [opts.grants]   normalized grants document
 */
export function canAccess({ email, roles = [], slug, dashboard = null, grants = null }) {
  if (isAdmin(roles)) return true;

  const wanted = typeof slug === "string" ? slug.trim().toLowerCase() : "";
  if (!wanted) return false;

  const granted = grantedSlugs(grants, email);
  if (granted) return granted.includes(wanted);

  // Legacy fallback: role-based, exactly as before.
  const allowed = (dashboard && Array.isArray(dashboard.allowedRoles)) ? dashboard.allowedRoles : [];
  if (!allowed.length) return false;                    // empty = admin-only
  return allowed.some((r) => Array.isArray(roles) && roles.includes(r));
}

/** Filter a manifest down to what this person may see. */
export function visibleDashboards({ email, roles = [], dashboards = [], grants = null }) {
  return (dashboards || []).filter((d) =>
    canAccess({ email, roles, slug: d.slug, dashboard: d, grants })
  );
}

/**
 * One-time migration helper: what each person's explicit list WOULD be if we
 * froze today's role-based access into per-person grants. Used by the "Seed
 * from current roles" action in the admin screen so switching over doesn't
 * change anyone's access on day one.
 *
 * Admins are seeded with every slug — they'd see everything regardless, but a
 * populated list means their row reads honestly in the UI.
 */
export function seedGrantsFromRoles(users, dashboards) {
  const out = {};
  for (const u of users || []) {
    const key = emailKey(u && u.email);
    if (!key) continue;
    const roles = Array.isArray(u.roles) ? u.roles : [];
    out[key] = (dashboards || [])
      .filter((d) => isAdmin(roles) || canAccess({ email: key, roles, slug: d.slug, dashboard: d, grants: null }))
      .map((d) => String(d.slug).toLowerCase());
  }
  return out;
}

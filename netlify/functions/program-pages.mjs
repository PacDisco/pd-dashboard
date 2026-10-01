// netlify/functions/program-pages.mjs
//
// Drafts, publishing and version history for public program pages
// (www.pacificdiscovery.org/programs/<slug>). The editor UI is
// /program-pages/; the public site is the separate pd-program-pages repo,
// which only ever sees PUBLISHED content via program-pages-export.mjs.
//
// Data: MIGRATION-program-pages.sql (program_pages, program_page_versions).
//
// Every route requires a verified Identity session with access to the
// program-pages dashboard (see _shared/program-pages-access.mjs). Publishing
// additionally needs a publishing role.
//
// Routes (GET ?action=…, POST JSON { action, … }):
//   GET  list                         → { programs: [...], user }
//   GET  get       ?slug=             → { program }
//   GET  versions  ?slug=             → { versions: [...] }        (no data)
//   GET  version   ?id=               → { version }                (with data)
//   POST create    { slug, name, data? }
//   POST save      { slug, rev, draft }          → { rev }  | 409 { conflict }
//   POST publish   { slug, rev, note? }          → { publishedAt, build }
//   POST unpublish { slug }
//   POST restore   { slug, rev, versionId }      → { rev, draft }
//   POST archive   { slug } / unarchive { slug }
//
// Env:
//   NETLIFY_DATABASE_URL          Neon (auto-injected by Netlify DB)
//   PROGRAM_SITE_BUILD_HOOK       Netlify build hook URL of pd-program-pages
//   PROGRAM_PAGES_PUBLISH_ROLES   optional, default "admin,outreach,programs"

import { neon } from "@neondatabase/serverless";
import { requireEditor, json } from "./_shared/program-pages-access.mjs";

export const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const MAX_DOC_BYTES = 512 * 1024;
const RESERVED = new Set(["new", "admin", "api", "programs", "index"]);

let _sql;
function db() {
  if (!_sql) {
    const url = process.env.NETLIFY_DATABASE_URL;
    if (!url) throw new Error("NETLIFY_DATABASE_URL not configured");
    _sql = neon(url);
  }
  return _sql;
}

// ── validation (pure; covered by test/program-pages.test.mjs) ──────────────

export function checkSlug(slug) {
  if (typeof slug !== "string" || !SLUG_RE.test(slug) || slug.length > 80) {
    return "Slug must be lowercase letters, numbers and single hyphens (e.g. south-america-gap-semester).";
  }
  if (RESERVED.has(slug)) return `"${slug}" is reserved.`;
  return null;
}

export function checkDoc(doc) {
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return "Page content must be an object.";
  const size = Buffer.byteLength(JSON.stringify(doc), "utf8");
  if (size > MAX_DOC_BYTES) return `Page content is too large (${Math.round(size / 1024)} KB; max ${MAX_DOC_BYTES / 1024} KB).`;
  if (typeof doc.name !== "string" || !doc.name.trim()) return "The page needs a program name.";
  if (doc.name.length > 120) return "Program name is too long.";
  // Images must be http(s) URLs (the editor uploads to /api/program-media).
  // data: URIs would bloat the row and bypass the media pipeline.
  let bad = null;
  (function walk(v) {
    if (bad) return;
    if (typeof v === "string") { if (/^\s*(data|javascript|vbscript):/i.test(v)) bad = v.slice(0, 40); return; }
    if (Array.isArray(v)) return v.forEach(walk);
    if (v && typeof v === "object") Object.values(v).forEach(walk);
  })(doc);
  if (bad) return `Unsupported link or image (${bad}…). Upload images instead of pasting them.`;
  return null;
}

export function statusOf(row) {
  if (row.archived_at) return "archived";
  if (!row.published_rev) return "draft";
  return row.draft_rev > row.published_rev ? "changes" : "live";
}

function summary(row) {
  return {
    slug: row.slug,
    name: row.name,
    status: statusOf(row),
    draftRev: row.draft_rev,
    publishedRev: row.published_rev,
    publishedAt: row.published_at,
    publishedBy: row.published_by,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
    createdAt: row.created_at,
  };
}

// ── build hook ─────────────────────────────────────────────────────────────

export async function triggerBuild(reason) {
  const hook = process.env.PROGRAM_SITE_BUILD_HOOK;
  if (!hook) return { triggered: false, message: "PROGRAM_SITE_BUILD_HOOK is not set, so the public site was not rebuilt." };
  try {
    const u = new URL(hook);
    u.searchParams.set("trigger_title", String(reason).slice(0, 120));
    const res = await fetch(u, { method: "POST", body: "{}" });
    return res.ok ? { triggered: true } : { triggered: false, message: `Build hook returned HTTP ${res.status}.` };
  } catch (e) {
    return { triggered: false, message: `Build hook failed: ${e.message}` };
  }
}

// ── handlers ───────────────────────────────────────────────────────────────

async function list(url, user) {
  const sql = db();
  const archived = url.searchParams.get("archived") === "1";
  const rows = archived
    ? await sql`SELECT slug, name, draft_rev, published_rev, published_at, published_by, updated_at, updated_by, created_at, archived_at FROM program_pages ORDER BY name`
    : await sql`SELECT slug, name, draft_rev, published_rev, published_at, published_by, updated_at, updated_by, created_at, archived_at FROM program_pages WHERE archived_at IS NULL ORDER BY name`;
  return json({
    programs: rows.map(summary),
    user: { email: user.email, name: user.actor, canPublish: user.canPublish },
  });
}

async function get(url) {
  const slug = url.searchParams.get("slug") || "";
  if (checkSlug(slug)) return json({ error: "Bad slug" }, 400);
  const [row] = await db()`SELECT * FROM program_pages WHERE slug = ${slug}`;
  if (!row) return json({ error: "Not found" }, 404);
  return json({ program: { ...summary(row), draft: row.draft, hasPublished: !!row.published } });
}

async function versions(url) {
  const slug = url.searchParams.get("slug") || "";
  if (checkSlug(slug)) return json({ error: "Bad slug" }, 400);
  const rows = await db()`
    SELECT id, kind, rev, note, created_at, created_by FROM program_page_versions
    WHERE slug = ${slug} ORDER BY created_at DESC LIMIT 100`;
  return json({ versions: rows.map((r) => ({ id: Number(r.id), kind: r.kind, rev: r.rev, note: r.note, createdAt: r.created_at, createdBy: r.created_by })) });
}

async function version(url) {
  const id = Number(url.searchParams.get("id"));
  if (!Number.isInteger(id) || id <= 0) return json({ error: "Bad id" }, 400);
  const [r] = await db()`SELECT id, slug, kind, rev, note, data, created_at, created_by FROM program_page_versions WHERE id = ${id}`;
  if (!r) return json({ error: "Not found" }, 404);
  return json({ version: { id: Number(r.id), slug: r.slug, kind: r.kind, rev: r.rev, note: r.note, data: r.data, createdAt: r.created_at, createdBy: r.created_by } });
}

async function create(body, user) {
  const slug = String(body.slug || "").trim();
  const slugErr = checkSlug(slug);
  if (slugErr) return json({ error: slugErr }, 400);
  const doc = body.data && typeof body.data === "object" ? { ...body.data } : {};
  doc.name = String(body.name || doc.name || "").trim();
  const err = checkDoc(doc);
  if (err) return json({ error: err }, 400);
  const rows = await db()`
    INSERT INTO program_pages (slug, name, draft, created_by, updated_by)
    VALUES (${slug}, ${doc.name}, ${JSON.stringify(doc)}::jsonb, ${user.actor}, ${user.actor})
    ON CONFLICT (slug) DO NOTHING
    RETURNING slug, draft_rev`;
  if (!rows.length) return json({ error: `A page with the address "${slug}" already exists.` }, 409);
  return json({ slug, rev: rows[0].draft_rev }, 201);
}

async function save(body, user) {
  const slug = String(body.slug || "");
  if (checkSlug(slug)) return json({ error: "Bad slug" }, 400);
  const rev = Number(body.rev);
  if (!Number.isInteger(rev)) return json({ error: "rev is required" }, 400);
  const err = checkDoc(body.draft);
  if (err) return json({ error: err }, 400);
  const sql = db();
  const rows = await sql`
    UPDATE program_pages
       SET draft = ${JSON.stringify(body.draft)}::jsonb, name = ${body.draft.name.trim()},
           draft_rev = draft_rev + 1, updated_at = now(), updated_by = ${user.actor}
     WHERE slug = ${slug} AND draft_rev = ${rev} AND archived_at IS NULL
     RETURNING draft_rev, updated_at`;
  if (rows.length) return json({ rev: rows[0].draft_rev, savedAt: rows[0].updated_at });
  const [cur] = await sql`SELECT draft_rev, updated_by, updated_at, archived_at FROM program_pages WHERE slug = ${slug}`;
  if (!cur) return json({ error: "Not found" }, 404);
  if (cur.archived_at) return json({ error: "This page is archived. Unarchive it to edit." }, 409);
  return json({
    error: `${cur.updated_by || "Someone"} saved this page while you were editing.`,
    conflict: { rev: cur.draft_rev, updatedBy: cur.updated_by, updatedAt: cur.updated_at },
  }, 409);
}

async function publish(body, user) {
  if (!user.canPublish) return json({ error: "You can edit drafts, but publishing needs a publisher. Ask an admin." }, 403);
  const slug = String(body.slug || "");
  if (checkSlug(slug)) return json({ error: "Bad slug" }, 400);
  const rev = Number(body.rev);
  if (!Number.isInteger(rev)) return json({ error: "rev is required" }, 400);
  const note = typeof body.note === "string" ? body.note.trim().slice(0, 300) : null;
  const sql = db();
  // Publish exactly the revision the person was looking at — never a newer
  // draft someone else saved a moment ago.
  const rows = await sql`
    UPDATE program_pages
       SET published = draft, published_rev = draft_rev, published_at = now(), published_by = ${user.actor}
     WHERE slug = ${slug} AND draft_rev = ${rev} AND archived_at IS NULL
     RETURNING published, published_rev, published_at`;
  if (!rows.length) return json({ error: "The page changed since you last saved. Reload, check it, then publish again." }, 409);
  await sql`
    INSERT INTO program_page_versions (slug, kind, rev, data, note, created_by)
    VALUES (${slug}, 'publish', ${rows[0].published_rev}, ${JSON.stringify(rows[0].published)}::jsonb, ${note}, ${user.actor})`;
  const build = await triggerBuild(`Published ${slug} (rev ${rev}) by ${user.actor}`);
  return json({ publishedAt: rows[0].published_at, publishedRev: rows[0].published_rev, build });
}

async function unpublish(body, user) {
  if (!user.canPublish) return json({ error: "Only publishers can take a page offline." }, 403);
  const slug = String(body.slug || "");
  if (checkSlug(slug)) return json({ error: "Bad slug" }, 400);
  const sql = db();
  const [prev] = await sql`SELECT published, published_rev FROM program_pages WHERE slug = ${slug}`;
  if (!prev) return json({ error: "Not found" }, 404);
  if (!prev.published) return json({ ok: true, build: { triggered: false, message: "Already offline." } });
  await sql`UPDATE program_pages SET published = NULL, published_rev = NULL, published_at = NULL, published_by = NULL WHERE slug = ${slug}`;
  await sql`INSERT INTO program_page_versions (slug, kind, rev, data, created_by)
            VALUES (${slug}, 'unpublish', ${prev.published_rev}, ${JSON.stringify(prev.published)}::jsonb, ${user.actor})`;
  return json({ ok: true, build: await triggerBuild(`Unpublished ${slug} by ${user.actor}`) });
}

async function restore(body, user) {
  const slug = String(body.slug || "");
  if (checkSlug(slug)) return json({ error: "Bad slug" }, 400);
  const id = Number(body.versionId);
  const rev = Number(body.rev);
  if (!Number.isInteger(id) || !Number.isInteger(rev)) return json({ error: "versionId and rev are required" }, 400);
  const sql = db();
  const [v] = await sql`SELECT data FROM program_page_versions WHERE id = ${id} AND slug = ${slug}`;
  if (!v) return json({ error: "Version not found" }, 404);
  const rows = await sql`
    UPDATE program_pages
       SET draft = ${JSON.stringify(v.data)}::jsonb, name = ${String(v.data?.name || slug)},
           draft_rev = draft_rev + 1, updated_at = now(), updated_by = ${user.actor}
     WHERE slug = ${slug} AND draft_rev = ${rev}
     RETURNING draft_rev`;
  if (!rows.length) return json({ error: "The page changed since you opened it. Reload and try again." }, 409);
  return json({ rev: rows[0].draft_rev, draft: v.data });
}

async function setArchived(body, user, archive) {
  if (!user.canPublish) return json({ error: "Only publishers can archive pages." }, 403);
  const slug = String(body.slug || "");
  if (checkSlug(slug)) return json({ error: "Bad slug" }, 400);
  const sql = db();
  if (archive) {
    const [row] = await sql`SELECT published FROM program_pages WHERE slug = ${slug}`;
    if (!row) return json({ error: "Not found" }, 404);
    if (row.published) return json({ error: "Unpublish the page before archiving it." }, 409);
    await sql`UPDATE program_pages SET archived_at = now(), updated_by = ${user.actor} WHERE slug = ${slug}`;
  } else {
    await sql`UPDATE program_pages SET archived_at = NULL, updated_by = ${user.actor} WHERE slug = ${slug}`;
  }
  return json({ ok: true });
}

export default async (req) => {
  try {
    const url = new URL(req.url);
    const method = req.method.toUpperCase();
    const user = await requireEditor(req, "program-pages");
    if (user instanceof Response) return user;

    if (method === "GET") {
      const action = url.searchParams.get("action") || "list";
      if (action === "list") return await list(url, user);
      if (action === "get") return await get(url);
      if (action === "versions") return await versions(url);
      if (action === "version") return await version(url);
      return json({ error: `Unknown action "${action}"` }, 400);
    }
    if (method === "POST") {
      let body;
      try { body = await req.json(); } catch { return json({ error: "Body must be JSON" }, 400); }
      switch (body?.action) {
        case "create": return await create(body, user);
        case "save": return await save(body, user);
        case "publish": return await publish(body, user);
        case "unpublish": return await unpublish(body, user);
        case "restore": return await restore(body, user);
        case "archive": return await setArchived(body, user, true);
        case "unarchive": return await setArchived(body, user, false);
        default: return json({ error: `Unknown action "${body?.action}"` }, 400);
      }
    }
    return json({ error: "Method not allowed" }, 405);
  } catch (err) {
    console.error("program-pages:", err);
    return json({ error: "Something went wrong saving the page. Try again; if it keeps happening, tell Jake." }, 500);
  }
};

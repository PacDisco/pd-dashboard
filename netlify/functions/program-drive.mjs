// netlify/functions/program-drive.mjs
//
// Google Drive photo picker for the Program Pages editor.
//
//   GET  /api/program-drive?action=list&folder=<id>&q=<search>&pageToken=…
//        → { root, folder, path:[{id,name}], folders:[…], images:[…], nextPageToken }
//   GET  /api/program-drive?action=thumb&id=<fileId>     a small preview (JPEG)
//   POST /api/program-drive  { action:"import", id }     → { key, url, name, description }
//
// How access works
//   - Uses the dashboard's existing Google service account (lib/google-creds.cjs),
//     but with the READ-ONLY Drive scope. This function can't change anything in Drive.
//   - The service account only sees what's been shared with it. On top of that, this
//     function only serves files inside ONE folder tree: PROGRAM_PAGES_DRIVE_FOLDER_ID
//     (e.g. a "Program Photos" folder or shared drive). Anything else gets a 404, even
//     if the service account can see it because of another dashboard.
//   - Every request needs a Program Pages editor session (same rule as program-pages).
//   - Imports are copied into the program-media store, the same place uploads go. The
//     public site never links to Drive, so moving or unsharing a Drive file later
//     won't break a published page.
//
// iPhone HEIC photos and anything over 5 MB are imported through Drive's own
// JPEG rendition at 2400px, so they arrive web-ready without a resize step.

import { google } from "googleapis";
import googleCreds from "./lib/google-creds.cjs";
import { requireEditor, json } from "./_shared/program-pages-access.mjs";
import { storeImage } from "./program-media.mjs";

const ID_RE = /^[A-Za-z0-9_-]{10,120}$/;
const DIRECT_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
const MAX_DIRECT = 5 * 1024 * 1024;
const FOLDER_MIME = "application/vnd.google-apps.folder";
const FILE_FIELDS = "id,name,mimeType,size,parents,description,thumbnailLink,imageMediaMetadata(width,height),modifiedTime";

let _drive;
async function defaultDrive() {
  if (!_drive) {
    const raw = await googleCreds.getServiceAccount();
    if (!raw) throw new Error("Google service account not configured");
    const creds = JSON.parse(raw);
    if (creds.private_key && creds.private_key.includes("\\n")) creds.private_key = creds.private_key.replace(/\\n/g, "\n");
    const auth = new google.auth.GoogleAuth({ credentials: creds, scopes: ["https://www.googleapis.com/auth/drive.readonly"] });
    const client = await auth.getClient();
    _drive = google.drive({ version: "v3", auth: client });
    _drive._pdAuth = client; // for fetching thumbnailLink renditions
  }
  return _drive;
}

/** Build the handler. `deps` lets the tests swap in a fake Drive and session. */
export function makeHandler(deps = {}) {
  const getDrive = deps.drive || defaultDrive;
  const editor = deps.requireEditor || requireEditor;
  const save = deps.storeImage || storeImage;
  const fetchFn = deps.fetch || ((...a) => fetch(...a));
  const parentsCache = new Map(); // fileId -> parents[] (warm-container cache)

  const rootId = () => process.env.PROGRAM_PAGES_DRIVE_FOLDER_ID || "";
  const common = { supportsAllDrives: true };

  async function meta(drive, id, fields = FILE_FIELDS) {
    const { data } = await drive.files.get({ fileId: id, fields, ...common });
    if (data.parents) parentsCache.set(data.id, data.parents);
    return data;
  }

  /** Is `id` the root or somewhere under it? Walks up at most 12 levels. */
  async function insideRoot(drive, id) {
    const root = rootId();
    let frontier = [id];
    for (let depth = 0; depth < 12 && frontier.length; depth++) {
      if (frontier.includes(root)) return true;
      const next = [];
      for (const f of frontier) {
        let parents = parentsCache.get(f);
        if (!parents) {
          try { parents = (await meta(drive, f, "id,parents")).parents || []; } catch { parents = []; }
          parentsCache.set(f, parents);
        }
        next.push(...parents);
      }
      frontier = [...new Set(next)];
    }
    return frontier.includes(root);
  }

  function imageOut(f) {
    return {
      id: f.id,
      name: f.name,
      mimeType: f.mimeType,
      size: f.size ? Number(f.size) : null,
      width: f.imageMediaMetadata?.width || null,
      height: f.imageMediaMetadata?.height || null,
      modifiedTime: f.modifiedTime || null,
      thumb: `/api/program-drive?action=thumb&id=${encodeURIComponent(f.id)}`,
    };
  }

  async function list(url) {
    const drive = await getDrive();
    const root = rootId();
    const folderId = url.searchParams.get("folder") || root;
    if (!ID_RE.test(folderId)) return json({ error: "Bad folder" }, 400);
    if (!(await insideRoot(drive, folderId))) return json({ error: "Not found" }, 404);
    const q = (url.searchParams.get("q") || "").trim().slice(0, 80);
    const pageToken = url.searchParams.get("pageToken") || undefined;
    const esc = (s) => s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");

    const folder = await meta(drive, folderId, "id,name,parents");
    // Breadcrumbs back up to the root.
    const path = [];
    let cur = folder;
    for (let i = 0; i < 12 && cur; i++) {
      path.unshift({ id: cur.id, name: cur.id === root ? "Program photos" : cur.name });
      if (cur.id === root) break;
      const p = (cur.parents || [])[0];
      cur = p ? await meta(drive, p, "id,name,parents") : null;
    }

    let files = [];
    let nextPageToken = null;
    if (q) {
      // Search the whole picture library, then keep only what's under the root.
      const r = await drive.files.list({
        q: `name contains '${esc(q)}' and mimeType contains 'image/' and trashed = false`,
        fields: `nextPageToken, files(${FILE_FIELDS})`, pageSize: 60, orderBy: "modifiedTime desc",
        includeItemsFromAllDrives: true, ...common,
      });
      for (const f of r.data.files || []) {
        if (f.parents) parentsCache.set(f.id, f.parents);
        if (await insideRoot(drive, f.id)) files.push(f);
      }
    } else {
      const r = await drive.files.list({
        q: `'${esc(folderId)}' in parents and trashed = false and (mimeType = '${FOLDER_MIME}' or mimeType contains 'image/')`,
        fields: `nextPageToken, files(${FILE_FIELDS})`, pageSize: 100, orderBy: "folder,name", pageToken,
        includeItemsFromAllDrives: true, ...common,
      });
      files = r.data.files || [];
      nextPageToken = r.data.nextPageToken || null;
      for (const f of files) parentsCache.set(f.id, [folderId]);
    }
    return json({
      root,
      folder: { id: folder.id, name: folder.id === root ? "Program photos" : folder.name },
      path,
      search: q || null,
      folders: files.filter((f) => f.mimeType === FOLDER_MIME).map((f) => ({ id: f.id, name: f.name })),
      images: files.filter((f) => f.mimeType !== FOLDER_MIME).map(imageOut),
      nextPageToken,
    });
  }

  async function authedFetch(drive, link) {
    let token = null;
    try { const t = await drive._pdAuth?.getAccessToken(); token = typeof t === "string" ? t : t?.token; } catch { /* unauthenticated fetch */ }
    return fetchFn(link, token ? { headers: { Authorization: `Bearer ${token}` } } : {});
  }

  /** Drive's own JPEG rendition, `px` on the long edge. Works for HEIC too. */
  async function rendition(drive, f, px) {
    if (!f.thumbnailLink) return null;
    const link = f.thumbnailLink.replace(/=s\d+$/, `=s${px}`);
    const res = await authedFetch(drive, link);
    if (!res.ok) return null;
    return res.arrayBuffer();
  }

  async function thumb(url) {
    const drive = await getDrive();
    const id = url.searchParams.get("id") || "";
    if (!ID_RE.test(id)) return json({ error: "Bad id" }, 400);
    if (!(await insideRoot(drive, id))) return json({ error: "Not found" }, 404);
    const f = await meta(drive, id);
    const buf = await rendition(drive, f, 400);
    if (!buf) return json({ error: "No preview" }, 404);
    return new Response(buf, {
      headers: { "Content-Type": "image/jpeg", "Cache-Control": "private, max-age=3600", "X-Content-Type-Options": "nosniff" },
    });
  }

  async function importFile(body, user, req) {
    const drive = await getDrive();
    const id = String(body?.id || "");
    if (!ID_RE.test(id)) return json({ error: "Bad id" }, 400);
    if (!(await insideRoot(drive, id))) return json({ error: "Not found" }, 404);
    const f = await meta(drive, id);
    if (!/^image\//.test(f.mimeType || "")) return json({ error: "That file isn't an image." }, 415);

    let buf = null;
    if (DIRECT_TYPES.has(f.mimeType) && Number(f.size || 0) <= MAX_DIRECT) {
      const r = await drive.files.get({ fileId: id, alt: "media", ...common }, { responseType: "arraybuffer" });
      buf = r.data;
    } else {
      buf = await rendition(drive, f, 2400);
    }
    if (!buf) return json({ error: "Couldn't download that photo from Drive." }, 502);
    try {
      const stored = await save(buf, { name: f.name, actor: user.actor, source: `drive:${id}`, origin: new URL(req.url).origin });
      return json({ ...stored, name: f.name, description: (f.description || "").slice(0, 300) }, 201);
    } catch (e) {
      return json({ error: `${e.message}. Try a smaller photo or a JPG.` }, 415);
    }
  }

  return async (req) => {
    try {
      if (!rootId()) return json({ error: "Google Drive isn't set up yet (PROGRAM_PAGES_DRIVE_FOLDER_ID)." }, 503);
      const user = await editor(req, "program-drive");
      if (user instanceof Response) return user;
      const url = new URL(req.url);
      if (req.method === "GET") {
        const action = url.searchParams.get("action") || "list";
        if (action === "list") return await list(url);
        if (action === "thumb") return await thumb(url);
        return json({ error: "Unknown action" }, 400);
      }
      if (req.method === "POST") {
        let body;
        try { body = await req.json(); } catch { return json({ error: "Body must be JSON" }, 400); }
        if (body?.action === "import") return await importFile(body, user, req);
        return json({ error: "Unknown action" }, 400);
      }
      return json({ error: "Method not allowed" }, 405);
    } catch (err) {
      console.error("program-drive:", err);
      const msg = /not configured|invalid_grant|unauthorized_client/i.test(err.message || "")
        ? "The dashboard can't sign in to Google Drive. Tell Jake." : "Google Drive request failed. Try again.";
      return json({ error: msg }, 502);
    }
  };
}

export default makeHandler();

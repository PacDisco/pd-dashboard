// npm run test:program-drive
// The Drive photo picker against a fake Drive: folder sandboxing, browsing,
// search, thumbnails and imports (direct + HEIC/oversize via rendition).
import test from "node:test";
import assert from "node:assert/strict";
import { makeHandler } from "../netlify/functions/program-drive.mjs";

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6, 7, 8]).buffer;
const ROOT = "ROOT_folder_0001";
const FILES = {
  ROOT_folder_0001: { id: ROOT, name: "Program Photos", mimeType: "application/vnd.google-apps.folder", parents: ["drive_top_000"] },
  SA_folder_00001: { id: "SA_folder_00001", name: "South America", mimeType: "application/vnd.google-apps.folder", parents: [ROOT] },
  machu_jpg_00001: { id: "machu_jpg_00001", name: "machu-picchu.jpg", mimeType: "image/jpeg", size: "900000", parents: ["SA_folder_00001"], description: "Sunrise over Machu Picchu", thumbnailLink: "https://lh3.test/t/machu=s220" },
  iphone_heic_001: { id: "iphone_heic_001", name: "IMG_0042.HEIC", mimeType: "image/heic", size: "3000000", parents: ["SA_folder_00001"], thumbnailLink: "https://lh3.test/t/heic=s220" },
  huge_png_000001: { id: "huge_png_000001", name: "huge.png", mimeType: "image/png", size: String(9 * 1024 * 1024), parents: ["SA_folder_00001"], thumbnailLink: "https://lh3.test/t/huge=s220" },
  notes_doc_00001: { id: "notes_doc_00001", name: "notes.pdf", mimeType: "application/pdf", size: "10", parents: ["SA_folder_00001"] },
  finance_folder1: { id: "finance_folder1", name: "Finance", mimeType: "application/vnd.google-apps.folder", parents: ["drive_top_000"] },
  secret_jpg_0001: { id: "secret_jpg_0001", name: "machu-secret.jpg", mimeType: "image/jpeg", size: "100", parents: ["finance_folder1"], thumbnailLink: "https://lh3.test/t/secret=s220" },
};

function fakeDrive() {
  const calls = { media: [] };
  return {
    calls,
    _pdAuth: { getAccessToken: async () => ({ token: "tok" }) },
    files: {
      async get({ fileId, alt }) {
        const f = FILES[fileId];
        if (!f) { const e = new Error("File not found"); e.code = 404; throw e; }
        if (alt === "media") { calls.media.push(fileId); return { data: JPEG }; }
        return { data: { ...f } };
      },
      async list({ q }) {
        let m = /^'([^']+)' in parents/.exec(q);
        if (m) return { data: { files: Object.values(FILES).filter((f) => f.parents.includes(m[1]) && (f.mimeType.includes("folder") || f.mimeType.startsWith("image/"))) } };
        m = /name contains '([^']+)'/.exec(q);
        return { data: { files: Object.values(FILES).filter((f) => f.mimeType.startsWith("image/") && f.name.includes(m[1])) } };
      },
    },
  };
}

function setup({ user = { email: "a@pd.org", actor: "Megan" } } = {}) {
  process.env.PROGRAM_PAGES_DRIVE_FOLDER_ID = ROOT;
  const drive = fakeDrive();
  const stored = [];
  const fetched = [];
  const h = makeHandler({
    drive: async () => drive,
    requireEditor: async () => user,
    storeImage: async (buf, meta) => { stored.push({ bytes: buf.byteLength, ...meta }); return { key: "k1.jpg", url: "https://dash.test/api/program-media?key=k1.jpg" }; },
    fetch: async (url, opts) => { fetched.push({ url, auth: opts?.headers?.Authorization }); return new Response(JPEG); },
  });
  const get = async (qs) => { const r = await h(new Request(`https://dash.test/api/program-drive?${qs}`)); return { status: r.status, body: r.headers.get("content-type")?.includes("json") ? await r.json() : await r.arrayBuffer() }; };
  const post = async (body) => { const r = await h(new Request("https://dash.test/api/program-drive", { method: "POST", body: JSON.stringify(body) })); return { status: r.status, body: await r.json() }; };
  return { h, drive, stored, fetched, get, post };
}

test("not configured → 503 with a clear message", async () => {
  const { get } = setup();
  delete process.env.PROGRAM_PAGES_DRIVE_FOLDER_ID;
  const r = await get("action=list");
  assert.equal(r.status, 503);
  assert.match(r.body.error, /PROGRAM_PAGES_DRIVE_FOLDER_ID/);
});

test("needs an editor session", async () => {
  process.env.PROGRAM_PAGES_DRIVE_FOLDER_ID = ROOT;
  const h = makeHandler({ drive: async () => fakeDrive(), requireEditor: async () => new Response("{}", { status: 401 }) });
  assert.equal((await h(new Request("https://dash.test/api/program-drive?action=list"))).status, 401);
});

test("browse: root → subfolder, only images and folders, breadcrumbs", async () => {
  const { get } = setup();
  let r = await get("action=list");
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.folders.map((f) => f.name), ["South America"]);
  assert.equal(r.body.path[0].name, "Program photos");
  r = await get("action=list&folder=SA_folder_00001");
  assert.deepEqual(r.body.images.map((i) => i.name).sort(), ["IMG_0042.HEIC", "huge.png", "machu-picchu.jpg"]);
  assert.deepEqual(r.body.path.map((p) => p.name), ["Program photos", "South America"]);
  assert.match(r.body.images[0].thumb, /^\/api\/program-drive\?action=thumb&id=/);
});

test("sandbox: folders and files outside the photo folder are 404, even if shared", async () => {
  const { get, post } = setup();
  assert.equal((await get("action=list&folder=finance_folder1")).status, 404);
  assert.equal((await get("action=thumb&id=secret_jpg_0001")).status, 404);
  assert.equal((await post({ action: "import", id: "secret_jpg_0001" })).status, 404);
  assert.equal((await get("action=list&folder=../../etc")).status, 400);
});

test("search only returns photos under the root", async () => {
  const { get } = setup();
  const r = await get("action=list&q=machu");
  assert.deepEqual(r.body.images.map((i) => i.name), ["machu-picchu.jpg"]);
});

test("thumbnails come from Drive's rendition with the service account token", async () => {
  const { get, fetched } = setup();
  const r = await get("action=thumb&id=machu_jpg_00001");
  assert.equal(r.status, 200);
  assert.equal(fetched[0].url, "https://lh3.test/t/machu=s400");
  assert.equal(fetched[0].auth, "Bearer tok");
});

test("import: a normal JPG is downloaded as-is and keeps its Drive description", async () => {
  const { post, drive, stored } = setup();
  const r = await post({ action: "import", id: "machu_jpg_00001" });
  assert.equal(r.status, 201);
  assert.equal(r.body.url, "https://dash.test/api/program-media?key=k1.jpg");
  assert.equal(r.body.description, "Sunrise over Machu Picchu");
  assert.deepEqual(drive.calls.media, ["machu_jpg_00001"]);
  assert.equal(stored[0].source, "drive:machu_jpg_00001");
  assert.equal(stored[0].actor, "Megan");
});

test("import: HEIC and oversize files come in as Drive's 2400px JPEG", async () => {
  const { post, drive, fetched } = setup();
  assert.equal((await post({ action: "import", id: "iphone_heic_001" })).status, 201);
  assert.equal((await post({ action: "import", id: "huge_png_000001" })).status, 201);
  assert.deepEqual(drive.calls.media, []);
  assert.deepEqual(fetched.map((f) => f.url), ["https://lh3.test/t/heic=s2400", "https://lh3.test/t/huge=s2400"]);
});

test("import: non-images are refused", async () => {
  const { post } = setup();
  assert.equal((await post({ action: "import", id: "notes_doc_00001" })).status, 415);
});

// netlify/functions/weekly-checkin-notes.mjs
//
// Per-program "notes for next week's check-in" for the Weekly Check-Ins
// dashboard (/weekly-check-ins/). Stored in Netlify Blobs, one key per
// program, so two people editing different programs never overwrite each
// other.
//
//   GET  /api/weekly-checkin-notes
//        → { notes: { "<program>": { text, updated_at, updated_by, history: [...] } } }
//
//   POST /api/weekly-checkin-notes
//        { action: "save",  program, text, base_updated_at }
//          Saves the note. If someone else saved since base_updated_at the
//          request is refused with 409 and the current note, so the page can
//          warn instead of silently overwriting their edit.
//        { action: "clear", program }
//          "Discussed" — moves the current note into the program's history
//          (newest first, last 30 kept) and empties the box for next week.
//
// Auth: /api/* is not behind auth-gate, so the Identity token is VERIFIED
// (not decoded) — see _shared/identity.mjs.

import { getStore } from "@netlify/blobs";
import { verifiedUser, actorName } from "./_shared/identity.mjs";

const STORE = "weekly-checkins";
const PREFIX = "note:";
const MAX_TEXT = 20000;
const MAX_HISTORY = 30;

const json = (status, body) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json", "cache-control": "no-store" },
});

function store() {
  try {
    return getStore({ name: STORE, consistency: "strong" });
  } catch (err) {
    const siteID = process.env.NETLIFY_SITE_ID || process.env.SITE_ID;
    const token = process.env.NETLIFY_BLOBS_TOKEN || process.env.NETLIFY_API_TOKEN;
    if (siteID && token) return getStore({ name: STORE, consistency: "strong", siteID, token });
    throw err;
  }
}

const keyFor = (program) => PREFIX + encodeURIComponent(program);

function cleanProgram(p) {
  const s = String(p || "").replace(/\s+/g, " ").trim();
  return s && s.length <= 200 ? s : null;
}

function emptyNote() {
  return { text: "", updated_at: null, updated_by: null, history: [] };
}

async function readNote(s, program) {
  const v = await s.get(keyFor(program), { type: "json" });
  return v ? { ...emptyNote(), ...v } : emptyNote();
}

export default async (req) => {
  const user = await verifiedUser(req, "weekly-checkin-notes");
  if (!user) return json(401, { error: "Sign in required, or your session expired — reload the dashboard." });
  if (!user.roles.length) return json(403, { error: "Your account has no dashboard role." });

  let s;
  try { s = store(); }
  catch (e) { return json(500, { error: `Notes store unavailable: ${e.message}` }); }

  if (req.method === "GET") {
    const notes = {};
    const { blobs } = await s.list({ prefix: PREFIX });
    await Promise.all(blobs.map(async (b) => {
      const v = await s.get(b.key, { type: "json" });
      if (!v) return;
      let program;
      try { program = decodeURIComponent(b.key.slice(PREFIX.length)); } catch { return; }
      notes[program] = { ...emptyNote(), ...v };
    }));
    return json(200, { notes });
  }

  if (req.method !== "POST") return json(405, { error: "Method not allowed" });

  let body;
  try { body = await req.json(); } catch { return json(400, { error: "Invalid JSON" }); }
  const program = cleanProgram(body && body.program);
  if (!program) return json(400, { error: "program required" });

  const current = await readNote(s, program);
  const who = actorName(user);
  const now = new Date().toISOString();

  if (body.action === "save") {
    const text = String(body.text == null ? "" : body.text);
    if (text.length > MAX_TEXT) return json(400, { error: `Note is too long (max ${MAX_TEXT} characters).` });
    const base = body.base_updated_at || null;
    if (current.updated_at && current.updated_at !== base && current.text !== text) {
      return json(409, { error: "Someone else edited this note since you opened it.", note: current });
    }
    const next = { ...current, text, updated_at: now, updated_by: who };
    await s.setJSON(keyFor(program), next);
    return json(200, { note: next });
  }

  if (body.action === "clear") {
    if (!current.text.trim()) return json(200, { note: current });
    const history = [
      { text: current.text, written_by: current.updated_by, written_at: current.updated_at, cleared_by: who, cleared_at: now },
      ...(current.history || []),
    ].slice(0, MAX_HISTORY);
    const next = { text: "", updated_at: now, updated_by: who, history };
    await s.setJSON(keyFor(program), next);
    return json(200, { note: next });
  }

  return json(400, { error: "action must be save or clear" });
};

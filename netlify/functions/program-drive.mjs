// netlify/functions/program-drive.mjs
//
// GET /api/program-drive?action=config
//   → { clientId, apiKey, appId }   for the Google Picker in the Program Pages editor
//
// The editor uses Google's own file picker, signed in as the EDITOR (not a
// service account), so people can choose photos from everything they can open
// in Drive: My Drive, shared drives, and files shared with them.
//
//   - OAuth scope: drive.file. The dashboard can read only the files a person
//     picks, never browse the rest of their Drive. Google doesn't require app
//     verification for it.
//   - The token stays in the editor's browser tab memory. Nothing Google-side
//     is stored on the server. The picked photo is downloaded in the browser and
//     uploaded through /api/program-media like any other photo.
//
// These three values are not secrets (Google designs them to sit in a web
// page), but they're only handed to signed-in editors, and the API key should
// be restricted to the Picker API and to https://dashboard.pacificdiscovery.org/*.
//
// Env (pd-dashboard):
//   GOOGLE_PICKER_CLIENT_ID   OAuth 2.0 Client ID (type: Web application)
//   GOOGLE_PICKER_API_KEY     API key restricted to the Google Picker API
//   GOOGLE_PICKER_APP_ID      the Google Cloud project NUMBER

import { requireEditor, json } from "./_shared/program-pages-access.mjs";

export function pickerConfig(env = process.env) {
  const clientId = (env.GOOGLE_PICKER_CLIENT_ID || "").trim();
  const apiKey = (env.GOOGLE_PICKER_API_KEY || "").trim();
  const appId = (env.GOOGLE_PICKER_APP_ID || "").trim();
  const missing = [
    !/\.apps\.googleusercontent\.com$/.test(clientId) && "GOOGLE_PICKER_CLIENT_ID",
    !/^[A-Za-z0-9_-]{20,}$/.test(apiKey) && "GOOGLE_PICKER_API_KEY",
    !/^\d{6,20}$/.test(appId) && "GOOGLE_PICKER_APP_ID",
  ].filter(Boolean);
  return missing.length ? { missing } : { clientId, apiKey, appId };
}

export function makeHandler(deps = {}) {
  const editor = deps.requireEditor || requireEditor;
  return async (req) => {
    try {
      const user = await editor(req, "program-drive");
      if (user instanceof Response) return user;
      const url = new URL(req.url);
      if (req.method !== "GET" || (url.searchParams.get("action") || "config") !== "config") {
        return json({ error: "Unknown action" }, 400);
      }
      const cfg = pickerConfig(deps.env || process.env);
      if (cfg.missing) {
        return json({ error: `Google Drive isn't set up yet. Missing on pd-dashboard: ${cfg.missing.join(", ")}.` }, 503);
      }
      return json(cfg);
    } catch (err) {
      console.error("program-drive:", err);
      return json({ error: "Google Drive setup check failed." }, 500);
    }
  };
}

export default makeHandler();

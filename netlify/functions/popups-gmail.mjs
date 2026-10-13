// netlify/functions/popups-gmail.mjs
//
// Connects the Google Workspace mailbox that sends popup notifications.
// Everything needs a signed-in Website Popups editor.
//
//   GET  ?action=status     → { connected, email, configured, redirectUri }
//   GET  ?action=connect    → redirects to Google (gmail.send permission only)
//   GET  ?action=callback   ← Google sends the user back here; stores the token
//   POST { action:"test", to:[…] }   sends a sample notification
//   POST { action:"disconnect" }
//
// Setup (once): in Google Cloud → APIs & Services → Credentials, open the
// OAuth client used by the dashboard (GOOGLE_OAUTH_CLIENT_ID), add the
// redirect URI shown in the designer, and make sure the Gmail API is enabled.

import crypto from "node:crypto";
import { requirePopupEditor, json } from "./_shared/popups-access.mjs";
import { popupStore } from "./_shared/popups-store.mjs";
import { authUrl, exchangeCode, oauthClient, sendMail, notificationEmail } from "./_shared/popups-gmail.mjs";
import { blankPopup, isEmail } from "./_shared/popups-core.mjs";

const back = (origin, hash) => new Response(null, { status: 302, headers: { Location: `${origin}/popups/#${hash}`, "Cache-Control": "no-store" } });

export default async (req) => {
  const user = await requirePopupEditor(req);
  if (user instanceof Response) return user;
  const url = new URL(req.url);
  const action = url.searchParams.get("action");
  const store = popupStore();
  const redirectUri = `${url.origin}/api/popups-gmail?action=callback`;
  const client = oauthClient();

  if (req.method === "GET" && action === "status") {
    const conn = await store.get("gmail", { type: "json" }).catch(() => null);
    return json({ connected: !!conn?.refreshToken, email: conn?.email || "", by: conn?.by || "", at: conn?.at || "", configured: !!client, redirectUri, lastError: conn?.lastError || "" });
  }

  if (req.method === "GET" && action === "connect") {
    if (!client) return json({ error: "GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET aren't set on this site." }, 500);
    const state = crypto.randomBytes(18).toString("base64url");
    await store.setJSON(`oauth-state/${state}`, { by: user.email, exp: Date.now() + 10 * 60 * 1000 });
    return new Response(null, { status: 302, headers: { Location: authUrl({ clientId: client.id, redirectUri, state, loginHint: url.searchParams.get("hint") || "" }), "Cache-Control": "no-store" } });
  }

  if (req.method === "GET" && action === "callback") {
    const state = url.searchParams.get("state") || "";
    if (!/^[A-Za-z0-9_-]{20,40}$/.test(state)) return back(url.origin, "gmail=error");
    const saved = await store.get(`oauth-state/${state}`, { type: "json" }).catch(() => null);
    await store.delete(`oauth-state/${state}`).catch(() => {});
    if (!saved || saved.exp < Date.now() || saved.by !== user.email) return back(url.origin, "gmail=expired");
    if (url.searchParams.get("error")) return back(url.origin, "gmail=cancelled");
    try {
      const { refreshToken, email } = await exchangeCode({ code: url.searchParams.get("code") || "", redirectUri });
      await store.setJSON("gmail", { refreshToken, email, by: user.actor, at: new Date().toISOString() });
      return back(url.origin, "gmail=connected");
    } catch (e) {
      console.error("[popups-gmail] connect failed:", e.message);
      return back(url.origin, `gmail=error&msg=${encodeURIComponent(e.message.slice(0, 160))}`);
    }
  }

  if (req.method === "POST") {
    let body;
    try { body = await req.json(); } catch { return json({ error: "Bad JSON." }, 400); }
    if (body?.action === "disconnect") {
      await store.delete("gmail").catch(() => {});
      return json({ ok: true });
    }
    if (body?.action === "test") {
      const to = (Array.isArray(body.to) ? body.to : [user.email]).filter(isEmail).slice(0, 10);
      if (!to.length) return json({ error: "Add at least one valid email address." }, 400);
      const conn = await store.get("gmail", { type: "json" }).catch(() => null);
      if (!conn?.refreshToken) return json({ error: "Connect a Gmail mailbox first." }, 400);
      const sample = { ...blankPopup(body.name || "Test popup"), name: body.name || "Test popup" };
      sample.fields = sample.fields.map((f) => ({ ...f, on: ["firstname", "email", "program"].includes(f.key), options: f.key === "program" ? [{ label: "South America Semester", value: "SAS" }] : f.options }));
      const msg = notificationEmail(sample, { firstname: "Test", email: user.email, program: "SAS" }, { uri: "https://www.pacificdiscovery.org/programs/south-america-gap-semester" }, null);
      try {
        await sendMail(conn, { to, replyTo: user.email, subject: `[Test] ${msg.subject}`, text: msg.text, html: msg.html });
        return json({ ok: true, to });
      } catch (e) {
        return json({ error: e.message }, 502);
      }
    }
  }
  return json({ error: "Unknown action." }, 400);
};

// Connect a staff member's Google Calendar (any domain).
//   POST /api/checkins/oauth/start     (Identity, manager)  { email } → { url }
//   GET  /api/checkins/oauth/callback  ?code&state           → stores refresh token
import { getSettings, saveSettings, googleCreds, signState, verifyState, json } from "./_shared/checkins.mjs";
import { requireManager } from "./_shared/checkins-access.mjs";

const SCOPES = [
  "https://www.googleapis.com/auth/calendar.freebusy",             // read busy times
  "https://www.googleapis.com/auth/calendar.events",               // host creates + lists check-ins
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly", // host's calendar dropdown
  "openid", "email",
].join(" ");

const siteUrl = () => (process.env.URL || "http://localhost:8888").replace(/\/+$/, "");
const redirectUri = () => `${siteUrl()}/api/checkins/oauth/callback`;

function page(title, msg, ok) {
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  return new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f3f4f6;margin:0">
<div style="max-width:480px;margin:64px auto;background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:28px">
<h1 style="font-size:20px;margin:0 0 8px;color:${ok ? "#166534" : "#b91c1c"}">${esc(title)}</h1>
<p style="color:#4b5563;font-size:14px;line-height:1.5">${esc(msg)}</p>
<p style="margin-top:20px"><a href="/instructor-checkins/" style="color:#2563eb;font-size:14px">← Back to Instructor Check-ins</a></p>
</div></body>`,
    { status: ok ? 200 : 400, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } }
  );
}

export default async (req) => {
  const url = new URL(req.url);
  const { clientId, clientSecret } = googleCreds();

  if (url.pathname.endsWith("/start")) {
    if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
    const user = await requireManager(req, "checkins-oauth");
    if (user instanceof Response) return user;
    const { email } = await req.json().catch(() => ({}));
    const auth = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    auth.search = new URLSearchParams({
      client_id: clientId, redirect_uri: redirectUri(), response_type: "code", scope: SCOPES,
      access_type: "offline", prompt: "consent", include_granted_scopes: "true",
      login_hint: email || "", state: signState({ email: email || "", by: user.actor }),
    });
    return json({ url: auth.toString() });
  }

  // ── callback ──
  const state = verifyState(url.searchParams.get("state"));
  if (!state) return page("Link expired", "Start again from the Instructor Check-ins page.", false);
  const code = url.searchParams.get("code");
  if (!code) return page("Not connected", url.searchParams.get("error") === "access_denied" ? "Permission wasn't granted." : "Google didn't return an authorisation code.", false);

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri(), grant_type: "authorization_code" }),
  });
  const tok = await res.json().catch(() => ({}));
  if (!res.ok || !tok.refresh_token) {
    return page("Not connected", tok.error_description || "Google didn't return a refresh token. Remove the app at myaccount.google.com → Security → Third-party connections, then try again.", false);
  }
  const granted = String(tok.scope || "");
  if (!granted.includes("calendar.freebusy") || !granted.includes("calendar.events")) {
    return page("Not connected", "Both calendar permissions are needed. Try again and tick both boxes on Google's permission screen.", false);
  }

  // Trust the email Google signed (id_token came straight from Google over TLS), not the one requested.
  let email = "";
  try { email = String(JSON.parse(Buffer.from(tok.id_token.split(".")[1], "base64url").toString()).email || "").toLowerCase(); } catch {}
  if (!email) return page("Not connected", "Google didn't share the account's email address.", false);

  const settings = await getSettings();
  let person = settings.people.find((p) => p.email === email);
  if (!person) settings.people.push((person = { email, name: "", host: false, checkAvailability: true }));
  person.refresh_token = tok.refresh_token;
  person.checkAvailability = true;
  person.connectedAt = new Date().toISOString();
  person.connectedBy = state.by || "";
  if (!settings.people.some((p) => p.host && p.refresh_token)) person.host = true; // first connection hosts
  await saveSettings(settings);
  console.log(`[checkins-oauth] connected ${email} (started by ${state.by})`);

  const note = state.email && state.email.toLowerCase() !== email ? ` You signed in as ${email}, not ${state.email}.` : "";
  return page("Calendar connected ✓", `${email} is connected. Their busy times now block check-in slots.${note}`, true);
};

export const config = { path: ["/api/checkins/oauth/start", "/api/checkins/oauth/callback"] };

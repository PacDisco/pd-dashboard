// netlify/functions/_shared/popups-gmail.mjs
//
// Team notifications for popup sign-ups, sent through a Google Workspace
// mailbox (Gmail API, gmail.send scope only — it can send, it can't read mail).
//
// The mailbox is connected once from the popup designer ("Connect Gmail"),
// which stores a refresh token in Netlify Blobs (store "popups", key "gmail").
// Uses the dashboard's existing Google OAuth client:
//   GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET
// Optional: HUBSPOT_PORTAL_ID (default 3855728) for the "open in HubSpot" link.

export const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.send";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SEND_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";

export function oauthClient() {
  const id = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const secret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  return id && secret ? { id, secret } : null;
}

export function authUrl({ clientId, redirectUri, state, loginHint }) {
  const q = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: `openid email ${GMAIL_SCOPE}`,
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state,
  });
  if (loginHint) q.set("login_hint", loginHint);
  return `https://accounts.google.com/o/oauth2/v2/auth?${q}`;
}

export async function exchangeCode({ code, redirectUri }, fetchImpl = fetch) {
  const c = oauthClient();
  const res = await fetchImpl(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ code, client_id: c.id, client_secret: c.secret, redirect_uri: redirectUri, grant_type: "authorization_code" }),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.refresh_token) throw new Error(j.error_description || j.error || "Google didn't return a refresh token.");
  if (!String(j.scope || "").includes(GMAIL_SCOPE)) throw new Error("Permission to send email wasn't granted. Tick the Gmail box on Google's screen and try again.");
  // The id_token is from Google over TLS; we only read the address out of it.
  let email = "";
  try { email = JSON.parse(Buffer.from(String(j.id_token).split(".")[1], "base64url").toString()).email || ""; } catch { /* optional */ }
  return { refreshToken: j.refresh_token, email };
}

let _cache = null;
async function accessToken(refreshToken, fetchImpl = fetch) {
  if (_cache && _cache.rt === refreshToken && Date.now() < _cache.exp - 60_000) return _cache.token;
  const c = oauthClient();
  if (!c) throw new Error("GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET aren't set.");
  const res = await fetchImpl(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: c.id, client_secret: c.secret, refresh_token: refreshToken, grant_type: "refresh_token" }),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.access_token) {
    const err = new Error(`Google sign-in for notifications failed: ${j.error_description || j.error || res.status}`);
    err.revoked = j.error === "invalid_grant";
    throw err;
  }
  _cache = { rt: refreshToken, token: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
  return j.access_token;
}

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
// Header values: no line breaks (header injection), and encode non-ASCII.
const hdr = (s) => String(s ?? "").replace(/[\r\n]+/g, " ").trim();
const enc = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, "utf8").toString("base64")}?=`);
const addr = (email, name) => (name ? `${enc(hdr(name).replace(/"/g, ""))} <${hdr(email)}>` : hdr(email));

/**
 * A complete RFC 2822 message (text + HTML), base64url-encoded for the Gmail API.
 *
 * `attachments` is optional — [{ filename, mime, content: Buffer|string }]. With
 * none the message is exactly what it always was (multipart/alternative); with
 * some, that alternative part is wrapped in multipart/mixed alongside the files.
 * Used by the Time Tracker's scheduled report emails.
 */
export function buildMessage({ from, fromName, to, replyTo, subject, text, html, attachments }) {
  const rand = () => Math.random().toString(36).slice(2);
  const boundary = `pd_${rand()}`;
  const b64 = (buf) => Buffer.from(buf).toString("base64").replace(/.{76}/g, "$&\r\n");
  const files = Array.isArray(attachments) ? attachments.filter((a) => a && a.filename && a.content != null) : [];
  const mixed = files.length ? `pdm_${rand()}` : null;
  const alternative = [
    `--${boundary}`,
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    b64(Buffer.from(text, "utf8")),
    `--${boundary}`,
    "Content-Type: text/html; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    b64(Buffer.from(html, "utf8")),
    `--${boundary}--`,
  ];
  const lines = [
    `From: ${addr(from, fromName)}`,
    `To: ${to.map((t) => hdr(t)).join(", ")}`,
    ...(replyTo ? [`Reply-To: ${hdr(replyTo)}`] : []),
    `Subject: ${enc(hdr(subject))}`,
    "MIME-Version: 1.0",
  ];
  if (!mixed) {
    lines.push(`Content-Type: multipart/alternative; boundary="${boundary}"`, "", ...alternative, "");
  } else {
    // Filenames are ours (report-<name>-<dates>.csv), but quote-strip anyway.
    const fname = (n) => enc(hdr(n).replace(/["\\]/g, ""));
    lines.push(`Content-Type: multipart/mixed; boundary="${mixed}"`, "",
      `--${mixed}`, `Content-Type: multipart/alternative; boundary="${boundary}"`, "", ...alternative);
    for (const f of files) {
      lines.push(`--${mixed}`,
        `Content-Type: ${hdr(f.mime || "application/octet-stream")}; name="${fname(f.filename)}"`,
        `Content-Disposition: attachment; filename="${fname(f.filename)}"`,
        "Content-Transfer-Encoding: base64", "",
        b64(typeof f.content === "string" ? Buffer.from(f.content, "utf8") : f.content));
    }
    lines.push(`--${mixed}--`, "");
  }
  return Buffer.from(lines.join("\r\n"), "utf8").toString("base64url");
}

/** The team notification for one sign-up. */
export function notificationEmail(popup, values, page, contact) {
  const portal = process.env.HUBSPOT_PORTAL_ID || "3855728";
  const name = [values.firstname, values.lastname].filter(Boolean).join(" ") || values.email;
  const rows = [];
  for (const f of popup.fields) {
    if (!f.on || values[f.key] == null) continue;
    const opt = f.options?.find((o) => o.value === values[f.key]);
    rows.push([f.label, opt ? opt.label : values[f.key], f.key]);
  }
  const program = rows.find((r) => r[2] === "program")?.[1];
  const subject = `New website lead: ${name}${program ? ` · ${program}` : ""}`;
  const hsUrl = contact?.id ? `https://app.hubspot.com/contacts/${portal}/record/0-1/${encodeURIComponent(contact.id)}` : "";
  const status = contact ? (contact.created ? "New contact in HubSpot" : "Existing contact, updated in HubSpot") : "Not saved to HubSpot";
  const text = [
    `${name} signed up through the website popup “${popup.name}”.`,
    "",
    ...rows.map(([l, v]) => `${l}: ${v}`),
    "",
    `Page: ${page?.uri || "—"}`,
    `${status}. Lead status: New.`,
    hsUrl ? `Open in HubSpot: ${hsUrl}` : "",
    "",
    "Reply to this email to answer them directly.",
  ].join("\n");
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#2f2f2f;max-width:560px">
<p style="margin:0 0 4px;font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#F15B39;font-weight:bold">New website lead</p>
<h2 style="margin:0 0 6px;font-size:22px;color:#2f2f2f">${esc(name)}</h2>
<p style="margin:0 0 16px;color:#5f666b">Signed up through “${esc(popup.name)}”</p>
<table cellpadding="8" cellspacing="0" style="border-collapse:collapse;width:100%;border:1px solid #e1e6e8">
${rows.map(([l, v, k]) => `<tr><td style="background:#f4f6f7;width:38%;font-weight:bold;border-bottom:1px solid #e1e6e8">${esc(l)}</td><td style="border-bottom:1px solid #e1e6e8">${k === "email" ? `<a href="mailto:${esc(v)}">${esc(v)}</a>` : esc(v)}</td></tr>`).join("\n")}
</table>
<p style="margin:16px 0 4px;font-size:13px;color:#5f666b">Page: ${page?.uri ? `<a href="${esc(page.uri)}">${esc(page.uri)}</a>` : "—"}<br>${esc(status)} · Lead status: New</p>
${hsUrl ? `<p style="margin:18px 0"><a href="${esc(hsUrl)}" style="display:inline-block;background:#288195;color:#fff;text-decoration:none;padding:10px 18px;border-radius:999px;font-weight:bold">Open in HubSpot</a></p>` : ""}
<p style="font-size:12px;color:#8a9196">Reply to this email to answer ${esc(values.firstname || "them")} directly.</p></div>`;
  return { subject, text, html };
}

/** Send through the connected mailbox. */
export async function sendMail(conn, msg, fetchImpl = fetch) {
  const token = await accessToken(conn.refreshToken, fetchImpl);
  const res = await fetchImpl(SEND_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ raw: buildMessage({ from: conn.email, fromName: "Pacific Discovery website", ...msg }) }),
  });
  if (!res.ok) throw new Error(`Gmail ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return true;
}

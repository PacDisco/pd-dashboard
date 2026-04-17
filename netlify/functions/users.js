// netlify/functions/users.js
//
// Admin-only wrapper around the Netlify Identity GoTrue admin API.
// Caller must have `admin` in their app_metadata.roles.
//
// GET    /api/users           → list users with roles
// POST   /api/users           → invite a new user by email          body: { email }
// PATCH  /api/users/:userId   → update a user's roles                body: { roles: [...] }
// DELETE /api/users/:userId   → remove a user
// GET    /api/users?debug=1   → diagnostic (authed but no role required)
//
// We forward the caller's own JWT (which has admin role) to the GoTrue admin
// endpoints. GoTrue accepts any Bearer token where the user has admin in
// app_metadata.roles, so no separate admin secret or PAT is needed.

export const handler = async (event, context) => {
  const { user } = context.clientContext || {};
  const method = event.httpMethod;

  // Debug endpoint
  if (method === "GET" && event.queryStringParameters?.debug === "1") {
    return send(200, {
      authed: !!user,
      roles: user?.app_metadata?.roles || [],
      hasIdentity: !!context.clientContext?.identity,
      identityUrl: context.clientContext?.identity?.url || null,
      identityTokenPreview: context.clientContext?.identity?.token
        ? context.clientContext.identity.token.slice(0, 12) + "…"
        : null,
      hasAuthHeader: !!(event.headers?.authorization || event.headers?.Authorization),
      siteUrl: process.env.URL,
      deployUrl: process.env.DEPLOY_URL,
    });
  }

  if (!user) return send(401, { error: "Not authenticated" });
  if (!isAdmin(user)) return send(403, { error: "Admin role required" });

  // Extract the caller's JWT from the Authorization header to forward to GoTrue.
  const rawAuth = event.headers?.authorization || event.headers?.Authorization || "";
  const userJwt = rawAuth.replace(/^Bearer\s+/i, "");
  if (!userJwt) {
    return send(500, {
      error: "Missing Authorization header — the landing page must send a Bearer JWT to /api/users",
    });
  }

  // Build the identity admin base URL. Prefer context.clientContext.identity.url
  // (set when Identity is configured), fall back to process.env.URL.
  const identityUrl =
    context.clientContext?.identity?.url ||
    (process.env.URL ? `${process.env.URL}/.netlify/identity` : null);
  if (!identityUrl) {
    return send(500, {
      error: "Identity URL unavailable — enable Netlify Identity on the site",
    });
  }

  const adminBase = `${identityUrl}/admin/users`;
  const userId = extractUserId(event.path);
  const authHeaders = { Authorization: `Bearer ${userJwt}` };
  const jsonHeaders = { ...authHeaders, "Content-Type": "application/json" };

  // GET /api/users → list
  if (method === "GET" && !userId) {
    const res = await fetch(adminBase, { headers: authHeaders });
    if (!res.ok) return forward(res, "list users");
    const data = await res.json().catch(() => ({}));
    return send(200, {
      users: (data.users || []).map(summarize),
      total: data.users?.length || 0,
    });
  }

  // POST /api/users → invite  { email, roles?: [] }
  if (method === "POST" && !userId) {
    const body = parseBody(event.body);
    if (!body?.email) return send(400, { error: "`email` required" });

    const res = await fetch(`${identityUrl}/invite`, {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ email: body.email, aud: "" }),
    });
    if (!res.ok) return forward(res, "invite user");

    // Set initial roles if provided
    if (Array.isArray(body.roles) && body.roles.length) {
      const invited = await res.json().catch(() => ({}));
      if (invited?.id) {
        await fetch(`${adminBase}/${invited.id}`, {
          method: "PUT",
          headers: jsonHeaders,
          body: JSON.stringify({
            app_metadata: { ...(invited.app_metadata || {}), roles: body.roles },
          }),
        }).catch(() => {});
      }
    }
    return send(200, { ok: true });
  }

  // PATCH /api/users/:id  { roles: [] }
  if (method === "PATCH" && userId) {
    const body = parseBody(event.body);
    if (!Array.isArray(body?.roles)) return send(400, { error: "`roles` array required" });
    const roles = body.roles.filter(r => typeof r === "string");

    const getRes = await fetch(`${adminBase}/${userId}`, { headers: authHeaders });
    if (!getRes.ok) return forward(getRes, "fetch user before update");
    const existing = await getRes.json().catch(() => ({}));

    const putRes = await fetch(`${adminBase}/${userId}`, {
      method: "PUT",
      headers: jsonHeaders,
      body: JSON.stringify({
        app_metadata: { ...(existing.app_metadata || {}), roles },
      }),
    });
    if (!putRes.ok) return forward(putRes, "update roles");
    const updated = await putRes.json().catch(() => ({}));
    return send(200, { ok: true, user: summarize(updated) });
  }

  // DELETE /api/users/:id
  if (method === "DELETE" && userId) {
    const res = await fetch(`${adminBase}/${userId}`, {
      method: "DELETE",
      headers: authHeaders,
    });
    if (!res.ok && res.status !== 404) return forward(res, "delete user");
    return send(200, { ok: true });
  }

  return send(405, { error: `Method ${method} not allowed on ${event.path}` });
};

function isAdmin(user) {
  return (user?.app_metadata?.roles || []).includes("admin");
}
function parseBody(raw) {
  try { return JSON.parse(raw || "{}"); } catch { return null; }
}
function extractUserId(p) {
  const m = p.match(/\/users\/([^/?]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}
function summarize(u) {
  return {
    id: u.id,
    email: u.email,
    full_name: u.user_metadata?.full_name || "",
    roles: u.app_metadata?.roles || [],
    created_at: u.created_at,
    last_sign_in_at: u.last_sign_in_at || null,
    invited: !u.confirmed_at && !!u.invited_at,
  };
}
async function forward(res, operation) {
  let body, bodyText;
  try {
    bodyText = await res.text();
    body = JSON.parse(bodyText);
  } catch {
    body = { raw: bodyText };
  }
  const msg =
    body?.error_description ||
    body?.msg ||
    body?.error ||
    body?.message ||
    res.statusText ||
    `GoTrue returned ${res.status}`;
  console.error(`users.js ${operation} failed:`, res.status, bodyText?.slice(0, 300));
  return send(res.status || 500, { error: `${operation}: ${msg}`, gotrueStatus: res.status });
}
function send(status, body) {
  return {
    statusCode: status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    body: JSON.stringify(body),
  };
}

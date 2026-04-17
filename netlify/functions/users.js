// netlify/functions/users.js
//
// Admin-only wrapper around the Netlify Identity GoTrue admin API.
// Caller must have `admin` in their app_metadata.roles.
//
// GET    /api/users           → list users with roles
// POST   /api/users           → invite a new user by email          body: { email }
// PATCH  /api/users/:userId   → update a user's roles                body: { roles: [...] }
// DELETE /api/users/:userId   → remove a user
//
// Uses context.clientContext.identity (url + token) which Netlify provides
// automatically when Identity is enabled on the site — no env vars needed.

export const handler = async (event, context) => {
  const { identity, user } = context.clientContext || {};
  if (!user) return send(401, { error: "Not authenticated" });
  if (!isAdmin(user)) return send(403, { error: "Admin role required" });
  if (!identity?.url || !identity?.token) {
    return send(500, { error: "Identity admin context unavailable — is Identity enabled?" });
  }

  const method = event.httpMethod;
  const userId = extractUserId(event.path);
  const adminBase = `${identity.url}/admin/users`;

  // GET /api/users
  if (method === "GET" && !userId) {
    const res = await fetch(adminBase, { headers: auth(identity.token) });
    if (!res.ok) return forward(res);
    const data = await res.json();
    return send(200, {
      users: (data.users || []).map(summarize),
      total: data.users?.length || 0,
    });
  }

  // POST /api/users  { email, roles?: [] }
  if (method === "POST" && !userId) {
    const body = parseBody(event.body);
    if (!body?.email) return send(400, { error: "`email` required" });

    const res = await fetch(`${identity.url}/invite`, {
      method: "POST",
      headers: { ...auth(identity.token), "Content-Type": "application/json" },
      body: JSON.stringify({ email: body.email, aud: "" }),
    });
    if (!res.ok) return forward(res);

    // Optionally set initial roles
    if (Array.isArray(body.roles) && body.roles.length) {
      const invited = await res.json();
      if (invited?.id) {
        await fetch(`${adminBase}/${invited.id}`, {
          method: "PUT",
          headers: { ...auth(identity.token), "Content-Type": "application/json" },
          body: JSON.stringify({ app_metadata: { ...(invited.app_metadata || {}), roles: body.roles } }),
        });
      }
    }
    return send(200, { ok: true });
  }

  // PATCH /api/users/:id  { roles: [] }
  if (method === "PATCH" && userId) {
    const body = parseBody(event.body);
    if (!Array.isArray(body?.roles)) return send(400, { error: "`roles` array required" });
    const roles = body.roles.filter(r => typeof r === "string");

    // Fetch current user so we preserve other app_metadata fields
    const getRes = await fetch(`${adminBase}/${userId}`, { headers: auth(identity.token) });
    if (!getRes.ok) return forward(getRes);
    const existing = await getRes.json();

    const putRes = await fetch(`${adminBase}/${userId}`, {
      method: "PUT",
      headers: { ...auth(identity.token), "Content-Type": "application/json" },
      body: JSON.stringify({
        app_metadata: { ...(existing.app_metadata || {}), roles },
      }),
    });
    if (!putRes.ok) return forward(putRes);
    return send(200, { ok: true, user: summarize(await putRes.json()) });
  }

  // DELETE /api/users/:id
  if (method === "DELETE" && userId) {
    const res = await fetch(`${adminBase}/${userId}`, {
      method: "DELETE",
      headers: auth(identity.token),
    });
    if (!res.ok && res.status !== 404) return forward(res);
    return send(200, { ok: true });
  }

  return send(405, { error: `Method ${method} not allowed on ${event.path}` });
};

function isAdmin(user) {
  return (user?.app_metadata?.roles || []).includes("admin");
}
function auth(token) {
  return { Authorization: `Bearer ${token}` };
}
function parseBody(raw) {
  try { return JSON.parse(raw || "{}"); } catch { return null; }
}
function extractUserId(p) {
  // Accept "/api/users/abc-123" or "/.netlify/functions/users/abc-123"
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
async function forward(res) {
  let body;
  try { body = await res.json(); } catch { body = { error: await res.text() }; }
  return send(res.status, body);
}
function send(status, body) {
  return {
    statusCode: status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    body: JSON.stringify(body),
  };
}

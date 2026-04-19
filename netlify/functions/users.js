// netlify/functions/users.js
//
// Admin-only user management. Caller must have `admin` in app_metadata.roles.
//
// Uses Netlify's REST API (https://api.netlify.com/api/v1) with a Personal
// Access Token. This is the documented path — GoTrue's direct admin endpoints
// at /.netlify/identity/admin/* are NOT publicly exposed and return 404, and
// /.netlify/identity/invite requires a site-level admin secret (not a user
// JWT), which is why the prior implementation got "User not allowed".
//
// Required env vars:
//   NETLIFY_SITE_ID     (or SITE_ID)        → your site's API ID
//   NETLIFY_BLOBS_TOKEN (or NETLIFY_API_TOKEN) → a Netlify Personal Access Token
//
// Endpoints:
//   GET    /users            → list users
//   POST   /users            → invite user                      body: { email, roles?: [] }
//   PATCH  /users/:id        → update roles                     body: { roles: [...] }
//   DELETE /users/:id        → delete user
//   GET    /users?debug=1    → diagnostic (no auth required)

export const handler = async (event, context) => {
  const { user } = context.clientContext || {};
  const method = event.httpMethod;

  if (method === "GET" && event.queryStringParameters?.debug === "1") {
    return send(200, {
      authed: !!user,
      roles: user?.app_metadata?.roles || [],
      hasAuthHeader: !!(event.headers?.authorization || event.headers?.Authorization),
      envVarsPresent: {
        NETLIFY_SITE_ID: !!process.env.NETLIFY_SITE_ID,
        SITE_ID: !!process.env.SITE_ID,
        NETLIFY_BLOBS_TOKEN: !!process.env.NETLIFY_BLOBS_TOKEN,
        NETLIFY_API_TOKEN: !!process.env.NETLIFY_API_TOKEN,
      },
      siteUrl: process.env.URL,
    });
  }

  if (!user) return send(401, { error: "Not authenticated" });
  if (!isAdmin(user)) return send(403, { error: "Admin role required" });

  const siteID = process.env.NETLIFY_SITE_ID || process.env.SITE_ID;
  const token = process.env.NETLIFY_BLOBS_TOKEN || process.env.NETLIFY_API_TOKEN;
  if (!siteID || !token) {
    return send(500, {
      error:
        "Missing credentials — set NETLIFY_SITE_ID and NETLIFY_BLOBS_TOKEN (or NETLIFY_API_TOKEN) as env vars on the Netlify site.",
    });
  }

  const usersUrl = `https://api.netlify.com/api/v1/sites/${siteID}/users`;
  const auth = { Authorization: `Bearer ${token}` };
  const jsonAuth = { ...auth, "Content-Type": "application/json" };
  const userId = extractUserId(event.path);

  // Netlify also auto-provides an admin-level Identity token to the function.
  // Use it to hit GoTrue's admin endpoints directly, which return the FULL
  // Identity user list (REST `/sites/{id}/users` sometimes only returns
  // site members, not all invited Identity users).
  const identityToken = context.clientContext?.identity?.token;
  const identityUrl = context.clientContext?.identity?.url;
  const identityAuth = identityToken ? { Authorization: `Bearer ${identityToken}` } : null;
  const identityJsonAuth = identityAuth ? { ...identityAuth, "Content-Type": "application/json" } : null;

  // GET /users → list
  if (method === "GET" && !userId) {
    // Try GoTrue admin/users first (returns all Identity users)
    if (identityAuth && identityUrl) {
      const gotrueRes = await fetch(`${identityUrl}/admin/users?per_page=100`, { headers: identityAuth });
      if (gotrueRes.ok) {
        const data = await gotrueRes.json().catch(() => ({}));
        const arr = Array.isArray(data) ? data : (data.users || []);
        return send(200, { users: arr.map(summarize), total: arr.length, source: "gotrue" });
      }
    }
    // Fallback: REST API
    const res = await fetch(`${usersUrl}?per_page=100`, { headers: auth });
    if (!res.ok) return forward(res, "list users");
    const data = await res.json().catch(() => []);
    const arr = Array.isArray(data) ? data : (data.users || []);
    return send(200, { users: arr.map(summarize), total: arr.length, source: "rest" });
  }

  // POST /users → invite  { email, roles?: [] }
  //
  // Netlify's invite API isn't consistently documented — different endpoints
  // and payload shapes work depending on site config. We try in priority order
  // and report which one succeeded (or all errors if none do).
  if (method === "POST" && !userId) {
    const body = parseBody(event.body);
    if (!body?.email) return send(400, { error: "`email` required" });

    const attempts = [
      {
        name: "REST /users/invite {emails:[]}",
        url: `${usersUrl}/invite`,
        headers: jsonAuth,
        body: { emails: [body.email] },
      },
      {
        name: "REST /users {emails:[]}",
        url: usersUrl,
        headers: jsonAuth,
        body: { emails: [body.email] },
      },
      {
        name: "REST /users {email}",
        url: usersUrl,
        headers: jsonAuth,
        body: { email: body.email },
      },
    ];

    // Add GoTrue /invite as a last-resort if the identity admin token exists.
    const identityToken = context.clientContext?.identity?.token;
    const identityUrl = context.clientContext?.identity?.url;
    if (identityToken && identityUrl) {
      attempts.push({
        name: "GoTrue /invite (identity.token)",
        url: `${identityUrl}/invite`,
        headers: { Authorization: `Bearer ${identityToken}`, "Content-Type": "application/json" },
        body: { email: body.email, aud: "" },
      });
    }

    const errors = [];
    let invitedUser = null, usedMethod = null;
    for (const a of attempts) {
      try {
        const res = await fetch(a.url, {
          method: "POST",
          headers: a.headers,
          body: JSON.stringify(a.body),
        });
        const text = await res.text().catch(() => "");
        if (res.ok) {
          usedMethod = a.name;
          try {
            const parsed = JSON.parse(text);
            invitedUser = Array.isArray(parsed) ? parsed[0] : parsed;
          } catch {}
          break;
        }
        errors.push(`${a.name}: ${res.status} ${text.slice(0, 200) || res.statusText}`);
      } catch (err) {
        errors.push(`${a.name}: ${err.message}`);
      }
    }

    if (!usedMethod) {
      return send(500, {
        error: "All invite methods failed",
        tried: errors,
      });
    }

    // If roles provided and we have the new user's ID, set them.
    if (invitedUser?.id && Array.isArray(body.roles) && body.roles.length) {
      await fetch(`${usersUrl}/${invitedUser.id}`, {
        method: "PUT",
        headers: jsonAuth,
        body: JSON.stringify({
          app_metadata: { roles: body.roles.filter(r => typeof r === "string") },
        }),
      }).catch(() => {});
    }

    return send(200, { ok: true, method: usedMethod });
  }

  // PATCH /users/:id → update roles  { roles: [...] }
  if (method === "PATCH" && userId) {
    const body = parseBody(event.body);
    if (!Array.isArray(body?.roles)) return send(400, { error: "`roles` array required" });
    const roles = body.roles.filter(r => typeof r === "string");

    // Try GoTrue admin endpoint first (it's where the list came from)
    if (identityJsonAuth && identityUrl) {
      const gotrueRes = await fetch(`${identityUrl}/admin/users/${userId}`, {
        method: "PUT",
        headers: identityJsonAuth,
        body: JSON.stringify({ app_metadata: { roles } }),
      });
      if (gotrueRes.ok) {
        const updated = await gotrueRes.json().catch(() => ({}));
        return send(200, { ok: true, user: summarize(updated), source: "gotrue" });
      }
    }
    // Fallback: REST API
    const putRes = await fetch(`${usersUrl}/${userId}`, {
      method: "PUT",
      headers: jsonAuth,
      body: JSON.stringify({ app_metadata: { roles } }),
    });
    if (!putRes.ok) return forward(putRes, "update user roles");
    const updated = await putRes.json().catch(() => ({}));
    return send(200, { ok: true, user: summarize(updated), source: "rest" });
  }

  // DELETE /users/:id
  if (method === "DELETE" && userId) {
    if (identityAuth && identityUrl) {
      const gotrueRes = await fetch(`${identityUrl}/admin/users/${userId}`, {
        method: "DELETE",
        headers: identityAuth,
      });
      if (gotrueRes.ok || gotrueRes.status === 404) {
        return send(200, { ok: true, source: "gotrue" });
      }
    }
    const res = await fetch(`${usersUrl}/${userId}`, {
      method: "DELETE",
      headers: auth,
    });
    if (!res.ok && res.status !== 404) return forward(res, "delete user");
    return send(200, { ok: true, source: "rest" });
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
    full_name: u.user_metadata?.full_name || u.full_name || "",
    roles: u.app_metadata?.roles || [],
    created_at: u.created_at,
    last_sign_in_at: u.last_sign_in_at || null,
    invited: !u.confirmed_at && !!u.invited_at,
  };
}
async function forward(res, operation) {
  let bodyText = "";
  try { bodyText = await res.text(); } catch {}
  let body = {};
  try { body = JSON.parse(bodyText); } catch { body = { raw: bodyText }; }
  const msg =
    body?.error_description ||
    body?.message ||
    body?.msg ||
    body?.error ||
    res.statusText ||
    `Netlify API returned ${res.status}`;
  console.error(`users.js ${operation}:`, res.status, bodyText?.slice(0, 300));
  return send(res.status || 500, {
    error: `${operation}: ${msg}`,
    netlifyStatus: res.status,
  });
}
function send(status, body) {
  return {
    statusCode: status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    body: JSON.stringify(body),
  };
}

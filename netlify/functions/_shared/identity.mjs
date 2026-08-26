/**
 * Netlify Identity verification for `/api/*` functions.
 *
 * WHY VERIFY RATHER THAN DECODE
 * -----------------------------
 * `/api/*` is excluded from `auth-gate.js` and is not covered by the site's
 * `Role=` redirects, so nothing signature-checks `nf_jwt` before a request
 * reaches a function under that path. Decoding the token here would let anyone
 * forge `Cookie: nf_jwt=<header>.<base64 {"app_metadata":{"roles":["admin"]}}>.<junk>`
 * and write to whatever the function writes to. So we hand the token back to
 * GoTrue and let it say who the caller is.
 *
 * This is the same check shirt-orders.mjs performs inline; it lives here so new
 * write endpoints don't have to re-derive it. shirt-orders.mjs deliberately
 * keeps its own copy — it is a money-spending endpoint and is covered by its
 * own auth test, and moving it is a change worth making on its own.
 *
 * NOTE: `context.clientContext` is NOT available to v2 (default-export)
 * functions. Don't reintroduce it; it is silently undefined.
 */

const AUTH_CACHE_MS = 5 * 60 * 1000;
const _authCache = new Map(); // token -> { ts, user }

function bearerFrom(req) {
  const auth = req.headers.get('authorization') || '';
  const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
  if (m) return m[1].trim();
  const cookie = req.headers.get('cookie') || '';
  const c = cookie.match(/(?:^|;\s*)nf_jwt=([^;]+)/);
  return c ? decodeURIComponent(c[1]) : null;
}

/**
 * Verify the caller's Identity token with GoTrue.
 *
 * @param {Request} req
 * @param {string} label  prefix for log lines, e.g. 'enrollment-status'
 * @returns {Promise<null | { roles: string[], email: string, name: string }>}
 *          null when there is no usable session.
 */
export async function verifiedUser(req, label = 'api') {
  const token = bearerFrom(req);
  if (!token) return null;

  const hit = _authCache.get(token);
  if (hit && Date.now() - hit.ts < AUTH_CACHE_MS) return hit.user;

  const siteUrl = (process.env.URL || process.env.DEPLOY_PRIME_URL || '').replace(/\/+$/, '');
  if (!siteUrl) {
    console.error(`[${label}] URL env var missing — cannot verify Identity token`);
    return null;
  }

  let res;
  try {
    res = await fetch(`${siteUrl}/.netlify/identity/user`, {
      headers: { Authorization: `Bearer ${token}` }
    });
  } catch (e) {
    console.error(`[${label}] Identity verification request failed: ${e.message}`);
    return null;
  }
  if (!res.ok) return null; // expired, revoked or forged

  let raw;
  try { raw = await res.json(); } catch { return null; }

  const user = {
    roles: (raw && raw.app_metadata && raw.app_metadata.roles) || [],
    email: (raw && raw.email) || '',
    name: (raw && raw.user_metadata && raw.user_metadata.full_name) || ''
  };

  if (_authCache.size > 500) {
    const now = Date.now();
    for (const [k, v] of _authCache) if (now - v.ts >= AUTH_CACHE_MS) _authCache.delete(k);
  }
  _authCache.set(token, { ts: Date.now(), user });
  return user;
}

/** A display name for audit trails: full name if Identity has one, else email. */
export function actorName(user) {
  if (!user) return 'unknown';
  return user.name || user.email || 'unknown';
}

export default { verifiedUser, actorName };

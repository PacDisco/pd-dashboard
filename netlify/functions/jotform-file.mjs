/**
 * netlify/functions/jotform-file.mjs
 *
 * Streams a Jotform-hosted file through this Netlify function so the team can
 * open it without being logged into Jotform. Uses JOTFORM_API_KEY to
 * authenticate the upstream request.
 *
 * Usage:
 *   /.netlify/functions/jotform-file?url=https://www.jotform.com/uploads/...
 *   /.netlify/functions/jotform-file?url=<generatePDF endpoint>&download=1&name=Signed%20Contract.pdf
 *
 * Query params:
 *   url       required; must be a jotform.com host (defence in depth — this
 *             must not become an open proxy)
 *   download  "1" to force Content-Disposition: attachment
 *   name      filename to use for the download; falls back to the URL's last
 *             path segment. Needed for API endpoints, whose path segment is
 *             "generatePDF" or "server.php" rather than anything meaningful.
 *
 * ---------------------------------------------------------------------------
 * ACCESS CONTROL — read this before changing it
 * ---------------------------------------------------------------------------
 * This endpoint streams instructor passports, driver's licences and police
 * checks. It lives under /.netlify/functions/* and /api/*, neither of which is
 * covered by the site's Role= redirects, and auth-gate.js explicitly excludes
 * /api/*. So the check here is the ONLY thing standing in front of those files.
 *
 * It therefore VERIFIES the Netlify Identity token rather than just decoding
 * it. Decoding alone — which is what auth-gate.js does — is safe at the edge
 * only because Netlify's CDN has already signature-checked nf_jwt against the
 * Role= rules before auth-gate runs. There is no such rule in front of this
 * function, so an unverified decode would let anyone forge
 * `Cookie: nf_jwt=<header>.<base64 {"app_metadata":{"roles":["admin"]}}>.<junk>`
 * and read every file in the Jotform account.
 *
 * Verification asks GoTrue itself (`/.netlify/identity/user`), so no JWT secret
 * has to be configured here. Results are cached briefly per token to keep the
 * cost to one round trip per session rather than one per file.
 *
 * NOTE: `context.clientContext` is NOT available to v2 (default-export)
 * functions — it only exists on the v1 `exports.handler` signature. Don't
 * reintroduce it here; it is silently undefined and would reopen the hole.
 */

const ALLOWED_HOST_SUFFIX = ".jotform.com";
const AUTH_CACHE_MS = 5 * 60 * 1000;

const errJSON = (status, msg) => new Response(JSON.stringify({ error: msg }), {
  status,
  headers: { "content-type": "application/json", "cache-control": "no-store" },
});

// token -> { ts, roles }  (warm-container scoped)
const _authCache = new Map();

function bearerFrom(req) {
  const auth = req.headers.get("authorization") || "";
  const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
  if (m) return m[1].trim();
  const cookie = req.headers.get("cookie") || "";
  const c = cookie.match(/(?:^|;\s*)nf_jwt=([^;]+)/);
  return c ? decodeURIComponent(c[1]) : null;
}

/**
 * Verify the caller's Identity token with GoTrue and return their roles.
 * Returns null when there is no usable session.
 */
async function verifiedRoles(req) {
  const token = bearerFrom(req);
  if (!token) return null;

  const hit = _authCache.get(token);
  if (hit && Date.now() - hit.ts < AUTH_CACHE_MS) return hit.roles;

  const siteUrl = (process.env.URL || process.env.DEPLOY_PRIME_URL || "").replace(/\/+$/, "");
  if (!siteUrl) {
    console.error("[jotform-file] URL env var missing — cannot verify Identity token");
    return null;
  }

  let res;
  try {
    res = await fetch(`${siteUrl}/.netlify/identity/user`, {
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch (e) {
    console.error("[jotform-file] Identity verification request failed:", e.message);
    return null;
  }
  if (!res.ok) return null;                 // expired, revoked or forged

  let user;
  try { user = await res.json(); } catch { return null; }
  const roles = user?.app_metadata?.roles || [];

  if (_authCache.size > 500) {
    const now = Date.now();
    for (const [k, v] of _authCache) if (now - v.ts >= AUTH_CACHE_MS) _authCache.delete(k);
  }
  _authCache.set(token, { ts: Date.now(), roles });
  return roles;
}

// Jotform's generatePDF 400s on Sign-enabled submissions (the Instructor
// Contract Form is one). The legacy getSubmissionPDF endpoint on the www host
// renders those correctly, so derive it and retry rather than making every
// caller know about the quirk.
function pdfFallbackFor(upstream) {
  if (!/\/generatePDF$/i.test(upstream.pathname)) return null;
  const formID = upstream.searchParams.get("formID");
  const sid = upstream.searchParams.get("submissionID");
  if (!formID || !sid) return null;
  const www = upstream.hostname
    .replace(/^api\./, "www.")
    .replace(/^eu-api\./, "eu.")
    .replace(/^hipaa-api\./, "hipaa.");
  return new URL(
    `https://${www}/server.php?action=getSubmissionPDF` +
    `&sid=${encodeURIComponent(sid)}&formID=${encodeURIComponent(formID)}`
  );
}

// A stored file under /uploads/ is immutable, so it caches well. A rendered
// submission is not — edit or re-sign the form and the PDF changes.
function isDynamic(u) {
  return /\/generatePDF$/i.test(u.pathname) || /server\.php$/i.test(u.pathname);
}

export default async (req) => {
  const apiKey = process.env.JOTFORM_API_KEY;
  if (!apiKey) return errJSON(500, "JOTFORM_API_KEY env var is not set");

  const roles = await verifiedRoles(req);
  if (roles === null) return errJSON(401, "Sign in required, or your session expired — reload the dashboard.");
  if (!roles.length) return errJSON(403, "Your account has no dashboard role.");

  const reqUrl = new URL(req.url);
  const target = reqUrl.searchParams.get("url");
  if (!target) return errJSON(400, "Missing ?url= parameter");

  let upstream;
  try { upstream = new URL(target); }
  catch { return errJSON(400, "Invalid url parameter"); }

  // Defence in depth: only proxy files that live on a jotform.com host.
  const host = upstream.hostname.toLowerCase();
  if (host !== "jotform.com" && !host.endsWith(ALLOWED_HOST_SUFFIX)) {
    return errJSON(400, `Only jotform.com URLs are proxied (got host: ${host})`);
  }

  const attempts = [upstream];
  const fb = pdfFallbackFor(upstream);
  if (fb) attempts.push(fb);

  let resp = null, lastErr = "";
  for (const attempt of attempts) {
    // Jotform honours the key as ?apiKey= on some routes and as a header on
    // others, so send both.
    attempt.searchParams.set("apiKey", apiKey);
    try {
      const r = await fetch(attempt.toString(), { headers: { APIKEY: apiKey } });
      if (r.ok) { resp = r; upstream = attempt; break; }
      lastErr = `Jotform ${r.status}: ${(await r.text()).slice(0, 300)}`;
    } catch (e) {
      lastErr = `Upstream fetch failed: ${e.message}`;
    }
  }
  if (!resp) return errJSON(502, lastErr || "Upstream fetch failed");

  const headers = {
    "content-type": resp.headers.get("content-type") || "application/octet-stream",
    // Private either way — these are personal documents and must never land in
    // a shared cache. Rendered submissions additionally must revalidate, or an
    // edited contract would serve stale for a day.
    "cache-control": isDynamic(upstream)
      ? "private, max-age=0, must-revalidate"
      : "private, max-age=86400",
  };
  // Deliberately NOT forwarding content-length: undici transparently
  // decompresses a gzip'd upstream body but leaves the COMPRESSED length on
  // the headers, so copying it truncates the response
  // (ERR_CONTENT_LENGTH_MISMATCH). Let the platform frame the body.

  const dl = reqUrl.searchParams.get("download");
  if (dl === "1" || dl === "true") {
    // Prefer the caller-supplied name. The URL's last path segment is useless
    // for API endpoints — it would save a signed contract as "generatePDF" or
    // "server.php", with no extension.
    const raw = reqUrl.searchParams.get("name")
      || decodeURIComponent(upstream.pathname.split("/").pop() || "download");
    const safe = raw.replace(/[/\\"\r\n]/g, "").trim() || "download";
    headers["content-disposition"] = `attachment; filename="${safe}"`;
  }

  return new Response(resp.body, { status: 200, headers });
};

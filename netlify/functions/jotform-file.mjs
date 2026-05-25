/**
 * netlify/functions/jotform-file.mjs
 *
 * Streams a Jotform-hosted upload through this Netlify function so the team
 * can open files without being logged into Jotform. Uses the JOTFORM_API_KEY
 * env var to authenticate the upstream request.
 *
 * Usage:
 *   /.netlify/functions/jotform-file?url=https://www.jotform.com/uploads/...
 *
 * Only allows URLs whose host ends in `jotform.com` (defence in depth — we
 * don't want this becoming an open proxy).
 *
 * The optional `?download=1` query param adds a Content-Disposition: attachment
 * header so the browser downloads instead of inlining (handy for files like
 * .docx that browsers don't render).
 */

const ALLOWED_HOST_SUFFIX = ".jotform.com";

const errJSON = (status, msg) => new Response(JSON.stringify({ error: msg }), {
  status,
  headers: { "content-type": "application/json" },
});

export default async (req) => {
  const apiKey = process.env.JOTFORM_API_KEY;
  if (!apiKey) return errJSON(500, "JOTFORM_API_KEY env var is not set");

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

  // Jotform supports the API key both as ?apiKey=… and as a header. Some
  // routes only honour one — we set both to be safe.
  upstream.searchParams.set("apiKey", apiKey);

  let resp;
  try {
    resp = await fetch(upstream.toString(), {
      headers: { "APIKEY": apiKey },
    });
  } catch (e) {
    return errJSON(502, `Upstream fetch failed: ${e.message}`);
  }

  if (!resp.ok) {
    const txt = await resp.text();
    return errJSON(resp.status, `Jotform ${resp.status}: ${txt.slice(0, 300)}`);
  }

  // Pass through the binary body + relevant headers.
  const ct = resp.headers.get("content-type") || "application/octet-stream";
  const cl = resp.headers.get("content-length");
  const headers = {
    "content-type": ct,
    // Cache aggressively at the browser level — file URLs are immutable
    // (each upload has a unique path); 1 day is a sensible default and
    // the team's permission gate is what really controls access.
    "cache-control": "private, max-age=86400",
  };
  if (cl) headers["content-length"] = cl;

  const dl = reqUrl.searchParams.get("download");
  if (dl === "1" || dl === "true") {
    const filename = decodeURIComponent(upstream.pathname.split("/").pop() || "download");
    // Sanitize for header use — strip CR/LF and quotes
    const safe = filename.replace(/["\r\n]/g, "");
    headers["content-disposition"] = `attachment; filename="${safe}"`;
  }

  return new Response(resp.body, { status: 200, headers });
};

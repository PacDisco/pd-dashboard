// Netlify Function: proxies Jotform API calls and injects the API key
// from the JOTFORM_API_KEY environment variable set in Netlify.
//
// Uses Node's built-in `https` module (no dependencies, no fetch polyfill
// needed, works on any Node version Netlify gives us).
//
// Browser calls:  /.netlify/functions/jotform?path=/form/{id}/submissions&limit=1000
// Proxied to:     https://api.jotform.com{path}?apiKey={env}&limit=1000

const https = require("https");

const ALLOWED_PATH_PREFIXES = ["/form/", "/submission/"];

exports.handler = async (event) => {
  const apiKey = process.env.JOTFORM_API_KEY;
  if (!apiKey) {
    return json(500, { error: "JOTFORM_API_KEY environment variable is not set in Netlify." });
  }

  const params = event.queryStringParameters || {};
  const path = params.path || "";

  if (!ALLOWED_PATH_PREFIXES.some((p) => path.startsWith(p))) {
    return json(400, { error: `Disallowed path: ${path}` });
  }
  if (event.httpMethod !== "GET") {
    return json(405, { error: "Method not allowed" });
  }

  const forward = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (k === "path") continue;
    forward.append(k, v);
  }
  forward.append("apiKey", apiKey);

  const upstreamPath = `${path}?${forward.toString()}`;

  try {
    const { statusCode, body } = await httpsGet("api.jotform.com", upstreamPath);
    return {
      statusCode,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=30"
      },
      body
    };
  } catch (err) {
    console.error("Jotform proxy error:", err);
    return json(502, {
      error: "Upstream fetch failed",
      detail: err.message || String(err),
      code: err.code || null
    });
  }
};

function httpsGet(host, path) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        host,
        path,
        method: "GET",
        headers: { "Accept": "application/json", "User-Agent": "netlify-jotform-proxy/1.0" },
        timeout: 20000
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          resolve({ statusCode: res.statusCode || 500, body: Buffer.concat(chunks).toString("utf8") });
        });
      }
    );
    req.on("timeout", () => { req.destroy(new Error("Upstream request timed out")); });
    req.on("error", reject);
    req.end();
  });
}

function json(statusCode, payload) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  };
}

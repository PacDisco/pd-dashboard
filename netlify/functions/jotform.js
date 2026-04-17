// Netlify Function: proxies Jotform API calls and injects the API key
// from the JOTFORM_API_KEY environment variable set in Netlify.
//
// The key NEVER reaches the browser. The browser calls:
//   /.netlify/functions/jotform?path=/form/{id}/submissions&limit=1000&offset=0
// and this function forwards the request to:
//   https://api.jotform.com{path}?apiKey={env}&limit=1000&offset=0

const ALLOWED_PATH_PREFIXES = [
  "/form/",      // form metadata, questions, submissions
  "/submission/" // individual submissions (if needed later)
];

exports.handler = async (event) => {
  const apiKey = process.env.JOTFORM_API_KEY;
  if (!apiKey) {
    return json(500, { error: "JOTFORM_API_KEY environment variable is not set in Netlify." });
  }

  const params = event.queryStringParameters || {};
  const path = params.path || "";

  // Basic path whitelist to stop the proxy being used for arbitrary Jotform API calls
  if (!ALLOWED_PATH_PREFIXES.some((p) => path.startsWith(p))) {
    return json(400, { error: `Disallowed path: ${path}` });
  }

  // Only allow GET through this proxy (read-only)
  if (event.httpMethod !== "GET") {
    return json(405, { error: "Method not allowed" });
  }

  // Forward all query params except `path`, add apiKey server-side
  const forward = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (k === "path") continue;
    forward.append(k, v);
  }
  forward.append("apiKey", apiKey);

  const upstream = `https://api.jotform.com${path}?${forward.toString()}`;

  try {
    const res = await fetch(upstream);
    const body = await res.text();
    return {
      statusCode: res.status,
      headers: {
        "Content-Type": "application/json",
        // Short cache so repeated loads feel snappy but data stays fresh
        "Cache-Control": "public, max-age=30"
      },
      body
    };
  } catch (err) {
    return json(502, { error: "Upstream fetch failed: " + (err.message || String(err)) });
  }
};

function json(statusCode, payload) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  };
}

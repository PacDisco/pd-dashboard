// Netlify Function: proxies Jotform API calls and injects the API key
// from the JOTFORM_API_KEY environment variable set in Netlify.
//
// Uses Node's built-in `https` module (no dependencies).
//
// For the /submissions endpoint we strip blank answers and a few heavy/
// unused fields so the payload stays under Netlify's 6MB function limit
// and the dashboard loads faster.
//
// Browser calls:  /.netlify/functions/jotform?path=/form/{id}/submissions&limit=200
// Proxied to:     https://api.jotform.com{path}?apiKey={env}&limit=200

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

    // For submissions list, slim each submission down so the payload stays
    // well under Netlify's 6MB function response cap.
    let outBody = body;
    if (statusCode === 200 && /\/form\/[^/]+\/submissions$/.test(path)) {
      try {
        const parsed = JSON.parse(body);
        if (Array.isArray(parsed.content)) {
          parsed.content = parsed.content.map(slimSubmission);
          outBody = JSON.stringify(parsed);
        }
      } catch (_) { /* if parse fails, pass-through raw body */ }
    }

    return {
      statusCode,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=30"
      },
      body: outBody
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

// Remove empty answers and redundant heavy fields from each submission.
// Keeps every answered question plus the structure the dashboard needs.
function slimSubmission(sub) {
  const keep = {
    id: sub.id,
    form_id: sub.form_id,
    created_at: sub.created_at,
    updated_at: sub.updated_at,
    status: sub.status,
    new: sub.new,
    flag: sub.flag,
    answers: {}
  };
  const answers = sub.answers || {};
  for (const qid of Object.keys(answers)) {
    const q = answers[qid];
    if (!q) continue;
    if (!isAnswered(q.answer)) continue;
    // drop pretty/html/sublabels/subfields etc — dashboard only uses name/type/text/answer/order
    keep.answers[qid] = {
      name: q.name,
      type: q.type,
      text: q.text,
      order: q.order,
      answer: q.answer
    };
  }
  return keep;
}

function isAnswered(v) {
  if (v == null) return false;
  if (typeof v === "string") return v.length > 0;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "object") {
    // filter out objects that are effectively empty (e.g. {day:"",month:"",year:""})
    const vals = Object.values(v).filter((x) => x !== "" && x != null);
    return vals.length > 0;
  }
  return true;
}

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

/**
 * netlify/functions/contact-lookup.mjs
 *
 * Batch email → HubSpot contact lookup.
 *
 * Request (POST, JSON):
 *   { "emails": ["a@example.com", "b@example.com", ...] }
 *
 * Response:
 *   {
 *     "contacts": {
 *        "a@example.com": { firstname, lastname, full_name, id, lifecyclestage, hs_lead_status },
 *        "b@example.com": null   // not found
 *     }
 *   }
 *
 * Uses HubSpot's contacts search endpoint with an IN filter, batching at
 * 100 emails per request (HubSpot's max). Token is HUBSPOT_TOKEN env var.
 */

const HUBSPOT_API   = "https://api.hubapi.com";
const BATCH_SIZE    = 100;
const PROPERTIES    = ["email", "firstname", "lastname", "lifecyclestage", "hs_lead_status"];

const json = (status, body) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json", "cache-control": "no-store" },
});

export default async (req) => {
  if (req.method !== "POST") return json(405, { error: "POST only" });

  const token = process.env.HUBSPOT_TOKEN;
  if (!token) return json(500, { error: "HUBSPOT_TOKEN env var is not set" });

  let payload;
  try { payload = await req.json(); }
  catch { return json(400, { error: "Invalid JSON body" }); }

  // Dedupe + normalize (HubSpot stores emails lowercase, search is also CI but
  // normalizing makes the response key deterministic for the caller).
  const seen = new Set();
  const emails = [];
  for (const raw of (payload.emails || [])) {
    if (typeof raw !== "string") continue;
    const e = raw.trim().toLowerCase();
    if (!e || !e.includes("@")) continue;
    if (seen.has(e)) continue;
    seen.add(e);
    emails.push(e);
  }
  if (!emails.length) return json(200, { contacts: {} });

  // Pre-populate every requested email with null so callers always get a key.
  const contacts = Object.fromEntries(emails.map(e => [e, null]));

  try {
    for (let i = 0; i < emails.length; i += BATCH_SIZE) {
      const batch = emails.slice(i, i + BATCH_SIZE);
      const body = {
        filterGroups: [{
          filters: [{ propertyName: "email", operator: "IN", values: batch }],
        }],
        properties: PROPERTIES,
        limit: BATCH_SIZE,
      };
      const r = await fetch(`${HUBSPOT_API}/crm/v3/objects/contacts/search`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${token}`,
          "Content-Type":  "application/json",
        },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        const txt = await r.text();
        return json(502, { error: `HubSpot ${r.status}: ${txt.slice(0, 300)}` });
      }
      const data = await r.json();
      for (const c of (data.results || [])) {
        const p = c.properties || {};
        const email = (p.email || "").trim().toLowerCase();
        if (!email || !contacts.hasOwnProperty(email)) continue;
        const firstname = p.firstname || "";
        const lastname  = p.lastname  || "";
        contacts[email] = {
          id:              c.id,
          firstname,
          lastname,
          full_name:       [firstname, lastname].filter(Boolean).join(" ").trim(),
          lifecyclestage:  p.lifecyclestage || null,
          hs_lead_status:  p.hs_lead_status || null,
        };
      }
    }
    return json(200, { contacts });
  } catch (e) {
    return json(500, { error: e.message || String(e) });
  }
};

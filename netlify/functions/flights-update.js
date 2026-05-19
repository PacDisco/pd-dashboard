// Netlify serverless function — Flights Dashboard cell editor
// Endpoint: POST /api/flights-update
// Body: { dealId: string, field: string, value: string | null }
// Only the 7 whitelisted flight properties are writable. Datetime fields
// accept either ISO 8601 strings (from datetime-local inputs) or epoch ms;
// everything else is sent through as a plain string.

const HUBSPOT_API = 'https://api.hubapi.com';

// Whitelist: only these HubSpot deal properties can be patched by this endpoint.
// `type` tells the handler how to coerce / validate the incoming value.
const ALLOWED_FIELDS = {
  insurance_policy:               { type: 'text' },
  arrival_flight_number:          { type: 'text' },
  arrival_flight_time:            { type: 'datetime' },
  internal_flight_number:         { type: 'text' },
  internal_flight_departure_time: { type: 'datetime' },
  departure_flight_number:        { type: 'text' },
  departure_time:                 { type: 'datetime' },
};

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
  });
}

// Coerce an incoming value to what HubSpot expects.
// HubSpot datetime properties accept ISO 8601 strings or epoch ms; we send ISO.
// Empty / null / undefined means "clear the field" → HubSpot wants an empty string.
function coerceValue(field, raw) {
  if (raw === null || raw === undefined || raw === '') return '';
  const cfg = ALLOWED_FIELDS[field];

  if (cfg.type === 'datetime') {
    // Accept epoch ms (number or numeric string) or anything Date() can parse
    // (datetime-local: "2026-05-20T15:30"; ISO: "2026-05-20T15:30:00Z").
    let d;
    if (typeof raw === 'number' || /^\d+$/.test(String(raw))) {
      d = new Date(Number(raw));
    } else {
      d = new Date(String(raw));
    }
    if (isNaN(d.getTime())) {
      throw new Error(`Invalid datetime for ${field}: ${raw}`);
    }
    return d.toISOString();
  }

  return String(raw);
}

export default async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization'
      }
    });
  }
  if (req.method !== 'POST') return json(405, { error: 'POST only' });

  const token = process.env.HUBSPOT_TOKEN;
  if (!token) return json(500, { error: 'HUBSPOT_TOKEN not set' });

  let body;
  try { body = await req.json(); }
  catch { return json(400, { error: 'Invalid JSON body' }); }

  const { dealId, field } = body;
  if (!dealId || typeof dealId !== 'string') return json(400, { error: 'dealId required' });
  if (!field || !ALLOWED_FIELDS[field]) {
    return json(400, { error: `Field "${field}" is not editable from the Flights dashboard` });
  }

  let value;
  try { value = coerceValue(field, body.value); }
  catch (err) { return json(400, { error: err.message }); }

  try {
    const resp = await fetch(
      `${HUBSPOT_API}/crm/v3/objects/deals/${encodeURIComponent(dealId)}`,
      {
        method: 'PATCH',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ properties: { [field]: value } })
      }
    );

    if (!resp.ok) {
      const errBody = await resp.text();
      console.error(`HubSpot PATCH ${dealId}/${field} failed: ${resp.status} ${errBody}`);
      return json(resp.status, { error: `HubSpot error (${resp.status})`, detail: errBody });
    }

    const updated = await resp.json();
    return json(200, {
      ok: true,
      dealId,
      field,
      value,
      updatedAt: (updated.properties && updated.properties.hs_lastmodifieddate) || new Date().toISOString()
    });
  } catch (err) {
    console.error(`flights-update error: ${err.message}`);
    return json(500, { error: err.message });
  }
};

export const config = { path: '/api/flights-update' };

// Netlify serverless function — adds a contact to a fixed Google account
// (info@pacificdiscovery.org by default) via Google's People API.
//
// The dashboard at /add-contact/ POSTs JSON here:
//   { firstName, lastName, email, phone, company, title, notes }
//
// We mint a fresh access token from a long-lived refresh token (set up once
// via scripts/get-google-contacts-token.mjs as info@pacificdiscovery.org)
// and call people.createContact. Nothing is stored server-side.
//
// Required env vars (set in Netlify → Site settings → Environment):
//   GOOGLE_OAUTH_CLIENT_ID         (Web Client ID from Google Cloud)
//   GOOGLE_OAUTH_CLIENT_SECRET     (Web Client Secret)
//   GOOGLE_CONTACTS_REFRESH_TOKEN  (output of the CLI script)
// Optional:
//   GOOGLE_CONTACTS_DESTINATION    (display-only; defaults to "info@pacificdiscovery.org")

const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const PEOPLE_CREATE = 'https://people.googleapis.com/v1/people:createContact';

const JSON_HEADERS = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
};

function badRequest(message) {
  return new Response(JSON.stringify({ ok: false, error: message }), {
    status: 400,
    headers: JSON_HEADERS,
  });
}
function serverError(message, status = 500) {
  return new Response(JSON.stringify({ ok: false, error: message }), {
    status,
    headers: JSON_HEADERS,
  });
}

// ---------------------------------------------------------------------------
// Access-token cache (lives for the duration of a warm function instance).
// Refresh tokens never expire unless revoked, but access tokens are ~1h.
// ---------------------------------------------------------------------------
let _cachedAccessToken = null;
let _cachedExpiresAt = 0;

async function getAccessToken() {
  const now = Date.now();
  if (_cachedAccessToken && now < _cachedExpiresAt - 60_000) {
    return _cachedAccessToken;
  }

  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_CONTACTS_REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error(
      'Missing one of GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, GOOGLE_CONTACTS_REFRESH_TOKEN. See add-contact/oauth-setup.md.'
    );
  }

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });

  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Token refresh failed (HTTP ${res.status}): ${text.slice(0, 300)}`);
  }
  let json;
  try { json = JSON.parse(text); }
  catch { throw new Error('Token refresh returned non-JSON: ' + text.slice(0, 200)); }

  if (!json.access_token) {
    throw new Error('Token refresh returned no access_token: ' + text.slice(0, 200));
  }

  _cachedAccessToken = json.access_token;
  _cachedExpiresAt = now + (json.expires_in || 3600) * 1000;
  return _cachedAccessToken;
}

// ---------------------------------------------------------------------------
// Build the People API payload from the form fields.
// ---------------------------------------------------------------------------
function buildPersonPayload(input) {
  const person = {};
  const firstName = (input.firstName || '').trim();
  const lastName = (input.lastName || '').trim();
  const email = (input.email || '').trim();
  const phone = (input.phone || '').trim();
  const company = (input.company || '').trim();
  const title = (input.title || '').trim();
  const notes = (input.notes || '').trim();

  if (firstName || lastName) {
    person.names = [{ givenName: firstName, familyName: lastName }];
  }
  if (email) person.emailAddresses = [{ value: email }];
  if (phone) person.phoneNumbers = [{ value: phone }];
  if (company || title) {
    person.organizations = [{ name: company || undefined, title: title || undefined, current: true }];
  }
  if (notes) person.biographies = [{ value: notes, contentType: 'TEXT_PLAIN' }];

  return { person, hasAny: !!(firstName || lastName || email || phone || company || title || notes) };
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------
export default async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: JSON_HEADERS });
  }
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ ok: false, error: 'POST only' }), {
      status: 405, headers: JSON_HEADERS,
    });
  }

  let input;
  try { input = await req.json(); }
  catch { return badRequest('Body must be JSON'); }

  const { person, hasAny } = buildPersonPayload(input);
  if (!hasAny) return badRequest('Provide at least a name, email, phone, company, title, or note.');

  let accessToken;
  try { accessToken = await getAccessToken(); }
  catch (err) {
    return serverError('Auth setup error: ' + err.message);
  }

  const apiRes = await fetch(PEOPLE_CREATE, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + accessToken,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(person),
  });

  const apiText = await apiRes.text();
  if (!apiRes.ok) {
    let msg = `People API HTTP ${apiRes.status}`;
    try {
      const j = JSON.parse(apiText);
      if (j.error?.message) msg = j.error.message;
    } catch {}
    if (apiRes.status === 401) {
      // Bust cache so the next attempt refreshes
      _cachedAccessToken = null;
      _cachedExpiresAt = 0;
    }
    return serverError(msg, apiRes.status >= 500 ? 502 : 400);
  }

  let created;
  try { created = JSON.parse(apiText); } catch { created = {}; }

  const resourceName = created.resourceName || '';
  const contactId = resourceName.replace(/^people\//, '');
  const displayName =
    (created.names && created.names[0] && created.names[0].displayName) ||
    [input.firstName, input.lastName].filter(Boolean).join(' ').trim() ||
    input.email || input.phone || 'Contact';

  return new Response(
    JSON.stringify({
      ok: true,
      displayName,
      resourceName,
      contactId,
      url: contactId ? `https://contacts.google.com/person/${encodeURIComponent(contactId)}` : null,
      destination: process.env.GOOGLE_CONTACTS_DESTINATION || 'info@pacificdiscovery.org',
    }),
    { headers: JSON_HEADERS }
  );
};

export const config = { path: '/api/add-contact' };

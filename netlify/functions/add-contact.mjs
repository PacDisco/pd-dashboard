// Netlify serverless function — adds a contact to a fixed Google account
// via Google's People API. Supports multiple destinations selected by a
// `dest` query parameter, e.g.:
//   POST /api/add-contact            → legacy single-destination mode
//   POST /api/add-contact?dest=pd    → uses GOOGLE_CONTACTS_REFRESH_TOKEN_PD
//   POST /api/add-contact?dest=unearthed → uses GOOGLE_CONTACTS_REFRESH_TOKEN_UNEARTHED
//
// The dashboard POSTs JSON:
//   { firstName, lastName, email, phone, company, title, notes }
//
// Required env vars (shared across all destinations):
//   GOOGLE_OAUTH_CLIENT_ID         (Web Client ID from Google Cloud)
//   GOOGLE_OAUTH_CLIENT_SECRET     (Web Client Secret)
//
// Per-destination env vars (one set per ?dest= key):
//   GOOGLE_CONTACTS_REFRESH_TOKEN_<KEY>   (refresh token for that account)
//   GOOGLE_CONTACTS_DESTINATION_<KEY>     (display label, e.g. "info@unearthededucation.org")
//
// Legacy fallback (no ?dest=):
//   GOOGLE_CONTACTS_REFRESH_TOKEN  (refresh token)
//   GOOGLE_CONTACTS_DESTINATION    (display label)

const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const PEOPLE_CREATE = 'https://people.googleapis.com/v1/people:createContact';

const JSON_HEADERS = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
};

function badRequest(message) {
  return new Response(JSON.stringify({ ok: false, error: message }), {
    status: 400, headers: JSON_HEADERS,
  });
}
function serverError(message, status = 500) {
  return new Response(JSON.stringify({ ok: false, error: message }), {
    status, headers: JSON_HEADERS,
  });
}

// ---------------------------------------------------------------------------
// Resolve which destination this request is for, and look up its env vars.
// ---------------------------------------------------------------------------
function resolveDestination(req) {
  const url = new URL(req.url);
  const raw = (url.searchParams.get('dest') || '').trim();
  // Allowlist: alphanumeric + underscore + hyphen, max 32 chars. Prevents
  // env-var injection via malicious dest values.
  if (raw && !/^[A-Za-z0-9_-]{1,32}$/.test(raw)) {
    return { error: `Invalid dest: ${raw}` };
  }

  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return { error: 'Missing GOOGLE_OAUTH_CLIENT_ID or GOOGLE_OAUTH_CLIENT_SECRET. See add-contact/oauth-setup.md.' };
  }

  if (!raw) {
    // Legacy mode — un-suffixed env vars
    const refreshToken = process.env.GOOGLE_CONTACTS_REFRESH_TOKEN;
    if (!refreshToken) {
      return { error: 'Missing GOOGLE_CONTACTS_REFRESH_TOKEN (or pass ?dest=<key> and set GOOGLE_CONTACTS_REFRESH_TOKEN_<KEY>).' };
    }
    return {
      key: '',
      clientId,
      clientSecret,
      refreshToken,
      label: process.env.GOOGLE_CONTACTS_DESTINATION || 'unknown destination',
    };
  }

  // Parameterized mode — env vars suffixed with _<KEY>
  const upper = raw.toUpperCase().replace(/-/g, '_');
  const refreshToken = process.env[`GOOGLE_CONTACTS_REFRESH_TOKEN_${upper}`];
  if (!refreshToken) {
    return { error: `No refresh token configured for dest=${raw}. Set GOOGLE_CONTACTS_REFRESH_TOKEN_${upper} in Netlify env vars.` };
  }
  return {
    key: upper,
    clientId,
    clientSecret,
    refreshToken,
    label: process.env[`GOOGLE_CONTACTS_DESTINATION_${upper}`] || `${raw.toLowerCase()}@?`,
  };
}

// ---------------------------------------------------------------------------
// Per-destination access-token cache (lives for the duration of a warm
// function instance). Each destination's tokens cached separately so they
// can't bleed across destinations.
// ---------------------------------------------------------------------------
const _tokenCache = new Map(); // key -> { token, expiresAt }

async function getAccessToken({ key, clientId, clientSecret, refreshToken }) {
  const cacheKey = key || '__legacy__';
  const now = Date.now();
  const cached = _tokenCache.get(cacheKey);
  if (cached && now < cached.expiresAt - 60_000) {
    return cached.token;
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

  _tokenCache.set(cacheKey, {
    token: json.access_token,
    expiresAt: now + (json.expires_in || 3600) * 1000,
  });
  return json.access_token;
}

function bustTokenCache(key) {
  _tokenCache.delete(key || '__legacy__');
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

  // Resolve which destination + auth set we're using
  const dest = resolveDestination(req);
  if (dest.error) {
    console.error('[add-contact] Destination resolve error:', dest.error);
    return serverError('Auth setup error: ' + dest.error);
  }

  // Get access token for this destination
  let accessToken;
  try { accessToken = await getAccessToken(dest); }
  catch (err) {
    console.error('[add-contact] Token refresh failed for dest=' + (dest.key || 'legacy') + ':', err.message);
    console.error('[add-contact] env present:',
      'CLIENT_ID=' + (dest.clientId ? 'yes(' + dest.clientId.length + ')' : 'NO'),
      'CLIENT_SECRET=' + (dest.clientSecret ? 'yes(' + dest.clientSecret.length + ')' : 'NO'),
      'REFRESH_TOKEN=' + (dest.refreshToken ? 'yes(' + dest.refreshToken.length + ')' : 'NO'),
    );
    return serverError('Auth setup error: ' + err.message);
  }

  // Call People API
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
    console.error('[add-contact] People API failed for dest=' + (dest.key || 'legacy') + ':', apiRes.status, apiText.slice(0, 500));
    let msg = `People API HTTP ${apiRes.status}`;
    try {
      const j = JSON.parse(apiText);
      if (j.error?.message) msg = j.error.message;
    } catch {}
    if (apiRes.status === 401) bustTokenCache(dest.key);
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
      destination: dest.label,
    }),
    { headers: JSON_HEADERS }
  );
};

export const config = { path: '/api/add-contact' };

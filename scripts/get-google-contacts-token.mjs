#!/usr/bin/env node
/**
 * One-time CLI to get a long-lived refresh token for the Add Contact dashboard.
 *
 * Usage:
 *   GOOGLE_OAUTH_CLIENT_ID=...     \
 *   GOOGLE_OAUTH_CLIENT_SECRET=... \
 *   node scripts/get-google-contacts-token.mjs
 *
 * What it does:
 *   1. Spins up a local HTTP server on http://localhost:53682
 *   2. Opens your browser to Google's OAuth consent screen
 *   3. You sign in as info@pacificdiscovery.org and grant the contacts scope
 *   4. Google redirects back to the loopback server with an auth code
 *   5. Script exchanges the code for a refresh token and prints it
 *
 * After it prints the token, paste it into Netlify → Site settings →
 * Environment → GOOGLE_CONTACTS_REFRESH_TOKEN.
 *
 * Prerequisites (see add-contact/oauth-setup.md for full walkthrough):
 *   - Google Cloud project with People API enabled
 *   - OAuth Client ID of type "Web application"
 *   - http://localhost:53682 added to Authorized redirect URIs (note: the
 *     redirect URI list, NOT the JavaScript origins list — they're different)
 */

import http from 'node:http';
import { URL } from 'node:url';
import { exec } from 'node:child_process';

const PORT = 53682;
const REDIRECT_URI = `http://localhost:${PORT}/`;
const SCOPE = 'https://www.googleapis.com/auth/contacts';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

const CLIENT_ID = process.env.GOOGLE_OAUTH_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_OAUTH_CLIENT_SECRET;

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('\nError: set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET first.\n');
  console.error('Example:');
  console.error('  GOOGLE_OAUTH_CLIENT_ID=xxx.apps.googleusercontent.com \\');
  console.error('  GOOGLE_OAUTH_CLIENT_SECRET=GOCSPX-xxx \\');
  console.error('  node scripts/get-google-contacts-token.mjs\n');
  process.exit(1);
}

const STATE = Math.random().toString(36).slice(2);

function buildAuthUrl() {
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: SCOPE,
    access_type: 'offline',          // <-- required for refresh_token
    prompt: 'consent',               // <-- force re-consent so refresh_token is reissued
    include_granted_scopes: 'true',
    state: STATE,
  });
  return `${AUTH_URL}?${params.toString()}`;
}

async function exchangeCodeForTokens(code) {
  const body = new URLSearchParams({
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    code,
    grant_type: 'authorization_code',
    redirect_uri: REDIRECT_URI,
  });
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Token exchange failed (HTTP ${res.status}): ${text}`);
  }
  return JSON.parse(text);
}

function openBrowser(url) {
  const cmd = process.platform === 'darwin'
    ? `open "${url}"`
    : process.platform === 'win32'
      ? `start "" "${url}"`
      : `xdg-open "${url}"`;
  exec(cmd, (err) => {
    if (err) {
      console.log('\n(Could not auto-open browser. Open this URL manually:)');
      console.log(url);
    }
  });
}

function htmlResponse(title, body, color = '#0f766e') {
  return `<!doctype html><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:-apple-system,sans-serif;max-width:520px;margin:80px auto;padding:24px;color:#0f172a}
h1{color:${color};margin:0 0 12px;font-size:22px}p{font-size:15px;line-height:1.5;color:#475569}
code{background:#f1f5f9;padding:2px 6px;border-radius:4px;font-size:13px}</style>
<h1>${title}</h1>${body}`;
}

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, REDIRECT_URI);
    if (u.pathname !== '/') {
      res.writeHead(404).end();
      return;
    }
    const code = u.searchParams.get('code');
    const state = u.searchParams.get('state');
    const error = u.searchParams.get('error');

    if (error) {
      res.writeHead(400, { 'Content-Type': 'text/html' })
        .end(htmlResponse('Sign-in cancelled', `<p>Google returned: <code>${error}</code></p>`, '#b91c1c'));
      console.error('\nOAuth error:', error);
      server.close();
      process.exit(1);
    }
    if (!code) {
      res.writeHead(400, { 'Content-Type': 'text/html' })
        .end(htmlResponse('No code received', '<p>Try running the script again.</p>', '#b91c1c'));
      return;
    }
    if (state !== STATE) {
      res.writeHead(400, { 'Content-Type': 'text/html' })
        .end(htmlResponse('State mismatch', '<p>This response did not come from the request we initiated. Try again.</p>', '#b91c1c'));
      console.error('\nState mismatch — possible CSRF; aborting.');
      server.close();
      process.exit(1);
    }

    res.writeHead(200, { 'Content-Type': 'text/html' })
      .end(htmlResponse(
        'You can close this tab',
        '<p>Refresh token captured. Switch back to your terminal to copy it.</p>'
      ));

    const tokens = await exchangeCodeForTokens(code);
    server.close();

    if (!tokens.refresh_token) {
      console.error('\nNo refresh_token returned. This usually means you have already');
      console.error('granted this app consent. Revoke it at https://myaccount.google.com/permissions');
      console.error('then run this script again.\n');
      process.exit(1);
    }

    console.log('\n========================================================');
    console.log('SUCCESS');
    console.log('========================================================');
    console.log('\nGOOGLE_CONTACTS_REFRESH_TOKEN:');
    console.log(tokens.refresh_token);
    console.log('\n========================================================');
    console.log('\nNext steps:');
    console.log('  1. Copy the token above.');
    console.log('  2. Netlify → Site settings → Environment variables → Add');
    console.log('       GOOGLE_OAUTH_CLIENT_ID         = (your client ID)');
    console.log('       GOOGLE_OAUTH_CLIENT_SECRET     = (your client secret)');
    console.log('       GOOGLE_CONTACTS_REFRESH_TOKEN  = (the token above)');
    console.log('  3. Trigger a redeploy.');
    console.log('  4. Test at /add-contact/ — no sign-in needed; contacts go');
    console.log('     to whichever account you signed in with above.\n');

    process.exit(0);
  } catch (err) {
    console.error('\nError handling callback:', err.message);
    res.writeHead(500, { 'Content-Type': 'text/html' })
      .end(htmlResponse('Error', `<p>${err.message}</p>`, '#b91c1c'));
    server.close();
    process.exit(1);
  }
});

server.listen(PORT, () => {
  const authUrl = buildAuthUrl();
  console.log('\nGoogle Contacts refresh-token bootstrap');
  console.log('========================================');
  console.log('Opening browser for you to sign in...');
  console.log('IMPORTANT: sign in as the destination account (e.g. info@pacificdiscovery.org)');
  console.log('           — NOT your personal Google account.');
  console.log(`\nIf the browser does not open automatically, visit:\n  ${authUrl}\n`);
  openBrowser(authUrl);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\nPort ${PORT} is already in use. Close whatever is using it and retry.`);
  } else {
    console.error('\nServer error:', err.message);
  }
  process.exit(1);
});

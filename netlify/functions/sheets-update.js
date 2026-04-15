// Netlify serverless function — proxies write requests to Google Apps Script
// This avoids CORS issues since the request happens server-side.
//
// The dashboard calls: POST /api/sheets-update
// Body: { programKey, season, field, value }
// This function forwards it as a GET to the Apps Script Web App with query params.

const GSHEET_API_URL = process.env.GSHEET_API_URL || 'https://script.google.com/macros/s/AKfycbznheXhdgXD1Hhjsbjzix7dHgPBcjfGycTfqX8WyhVQuSfeZFihtd7aU3TW9CE8xmMU0Q/exec';

export default async (req) => {
  const corsHeaders = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ status: 'error', message: 'POST only' }), {
      status: 405, headers: corsHeaders,
    });
  }

  try {
    const { programKey, season, field, value } = await req.json();

    if (!programKey || !season || !field || value === undefined) {
      return new Response(JSON.stringify({ status: 'error', message: 'Missing fields' }), {
        status: 400, headers: corsHeaders,
      });
    }

    // Forward to Apps Script as GET with query params (avoids Apps Script POST/CORS issues)
    const params = new URLSearchParams({
      action: 'update',
      programKey,
      season,
      field,
      value: String(value),
    });
    const url = `${GSHEET_API_URL}?${params.toString()}`;
    const resp = await fetch(url, { redirect: 'follow' });
    const text = await resp.text();

    let result;
    try { result = JSON.parse(text); } catch { result = { status: 'ok' }; }

    return new Response(JSON.stringify(result), { headers: corsHeaders });

  } catch (err) {
    return new Response(JSON.stringify({ status: 'error', message: err.message }), {
      status: 500, headers: corsHeaders,
    });
  }
};

export const config = { path: '/api/sheets-update' };

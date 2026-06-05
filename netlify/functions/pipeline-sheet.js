/**
 * Pipeline sheet — live read/write proxy for the "Advisor Pipeline and
 * Commission Reports" Google Sheet, scoped to a single tab (by gid).
 *
 * This backs the /pipeline dashboard, which renders an editable, filterable
 * replica of one tab of that sheet.
 *
 * Routes (query ?action=... ):
 *   - read    GET   -> { title, gid, sheets:[{gid,title}], values:[[...]] }
 *   - update  POST  -> { row, col, value }  (1-based row/col within the tab)
 *                      writes a single cell, returns { ok:true, range }
 *
 * Optional ?gid=NNN overrides the default tab. ?title= can be passed on
 * update to avoid a metadata round-trip.
 *
 * Required env vars:
 *   GOOGLE_SERVICE_ACCOUNT_JSON   full service-account JSON (single string).
 *                                 The Google Sheet must be shared with that
 *                                 service account's client_email (Editor for
 *                                 writes, Viewer is enough for reads).
 *   PIPELINE_SHEET_ID             (optional) overrides the spreadsheet id.
 *   PIPELINE_SHEET_GID            (optional) overrides the default tab gid.
 */

const { google } = require('googleapis');

// The "Advisor Pipeline and Commission Reports" spreadsheet.
const SHEET_ID = process.env.PIPELINE_SHEET_ID
  || '1lzBFRQE_yJOWQZTLj4iQn_yqgfrjavxJD01cjIqqwkY';

// The tab linked by the user (…/edit?gid=491903886). Resolved to a title at
// runtime so we never depend on the tab's name.
const DEFAULT_GID = Number(process.env.PIPELINE_SHEET_GID || 491903886);

// --------------------------------------------------------------------------
// Auth / client (lazy, mirrors invoices.js)
// --------------------------------------------------------------------------
let _sheets;
async function sheetsClient() {
  if (_sheets) return _sheets;

  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON env var is not set');

  let creds;
  try { creds = JSON.parse(raw); }
  catch (e) { throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON: ' + e.message); }

  // private_key sometimes arrives with literal "\n" instead of real newlines.
  if (creds.private_key && creds.private_key.includes('\\n')) {
    creds.private_key = creds.private_key.replace(/\\n/g, '\n');
  }

  const auth = new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const client = await auth.getClient();
  _sheets = google.sheets({ version: 'v4', auth: client });
  return _sheets;
}

// --------------------------------------------------------------------------
// HTTP helpers
// --------------------------------------------------------------------------
const JSON_HEADERS = { 'Content-Type': 'application/json' };
function ok(body, extraHeaders = {}) {
  return { statusCode: 200, headers: { ...JSON_HEADERS, ...extraHeaders }, body: JSON.stringify(body) };
}
function bad(msg, code = 400) {
  return { statusCode: code, headers: JSON_HEADERS, body: JSON.stringify({ error: msg }) };
}

// --------------------------------------------------------------------------
// Sheet helpers
// --------------------------------------------------------------------------

// Build an A1 range that quotes a sheet title safely (single quotes doubled).
function quoteTitle(title) {
  return `'${String(title).replace(/'/g, "''")}'`;
}

// 1-based column index -> A1 column letters (1 -> A, 27 -> AA).
function colLetter(n) {
  let s = '';
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

// Resolve a gid to { title, gridProperties } and return the full tab list.
async function resolveSheet(gid) {
  const s = await sheetsClient();
  const meta = await s.spreadsheets.get({
    spreadsheetId: SHEET_ID,
    fields: 'sheets.properties(sheetId,title,index,gridProperties(rowCount,columnCount))',
  });
  const all = (meta.data.sheets || []).map(sh => sh.properties);
  const tabs = all
    .sort((a, b) => (a.index || 0) - (b.index || 0))
    .map(p => ({ gid: p.sheetId, title: p.title }));
  const match = all.find(p => p.sheetId === gid) || all[0];
  if (!match) throw new Error('Spreadsheet has no tabs');
  return { props: match, tabs };
}

// --------------------------------------------------------------------------
// Actions
// --------------------------------------------------------------------------
async function handleRead(qs) {
  const gid = qs.gid !== undefined ? Number(qs.gid) : DEFAULT_GID;
  const { props, tabs } = await resolveSheet(gid);

  const s = await sheetsClient();
  const res = await s.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: quoteTitle(props.title),
    valueRenderOption: 'FORMATTED_VALUE',
    majorDimension: 'ROWS',
  });

  const values = res.data.values || [];
  return ok({
    spreadsheetId: SHEET_ID,
    gid: props.sheetId,
    title: props.title,
    tabs,
    rowCount: props.gridProperties ? props.gridProperties.rowCount : values.length,
    values,
  }, { 'Cache-Control': 'no-store' });
}

async function handleUpdate(body) {
  const gid = body.gid !== undefined ? Number(body.gid) : DEFAULT_GID;
  const row = Number(body.row); // 1-based row within the tab
  const col = Number(body.col); // 1-based column within the tab
  if (!Number.isInteger(row) || row < 1) return bad('row must be a positive integer (1-based)');
  if (!Number.isInteger(col) || col < 1) return bad('col must be a positive integer (1-based)');
  const value = body.value === undefined || body.value === null ? '' : String(body.value);

  let title = body.title;
  if (!title) {
    const { props } = await resolveSheet(gid);
    title = props.title;
  }

  const a1 = `${quoteTitle(title)}!${colLetter(col)}${row}`;
  const s = await sheetsClient();
  await s.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: a1,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [[value]] },
  });

  return ok({ ok: true, range: a1, value });
}

// --------------------------------------------------------------------------
// Entry point
// --------------------------------------------------------------------------
exports.handler = async (event) => {
  try {
    const method = event.httpMethod;
    const qs = event.queryStringParameters || {};
    const body = event.body
      ? (event.isBase64Encoded
          ? JSON.parse(Buffer.from(event.body, 'base64').toString('utf8'))
          : JSON.parse(event.body))
      : {};
    const action = qs.action || body.action || (method === 'GET' ? 'read' : '');

    if (method === 'GET' && action === 'read') return await handleRead(qs);
    if (method === 'POST' && action === 'update') return await handleUpdate(body);

    return bad(`unknown action '${action}' for method ${method}`);
  } catch (err) {
    console.error('[pipeline-sheet]', err);
    const msg = err && err.message ? err.message : 'server error';
    // Surface permission problems clearly so the UI can explain them.
    const code = /permission|forbidden|403|not have access/i.test(msg) ? 403 : 500;
    return bad(msg, code);
  }
};

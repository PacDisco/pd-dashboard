/**
 * Invoice tool — single Netlify Function with action routing.
 *
 * Routes (query ?action=... or JSON body { action }):
 *   - list              GET   -> list payments (optional: status, program_id, from, to)
 *   - programs          GET   -> list active programs (add ?include_inactive=1 for admin view)
 *   - create            POST  -> manual entry (vendor, amount, due_date, program_id, notes)
 *   - upload            POST  -> multipart or base64 PDF -> Drive + Claude + DB
 *   - update            POST  -> { id, patch: { approved_to_pay, paid, due_date, ... } }
 *   - inbound           POST  -> Gmail Apps Script webhook (see apps-script/Code.gs)
 *   - programs-create   POST  -> { name, sort_order? }
 *   - programs-update   POST  -> { id, patch: { name, sort_order, is_active } }
 *   - programs-delete   POST  -> { id }  (fails if any payment references it)
 *
 * Required env vars:
 *   NETLIFY_DATABASE_URL          (auto-injected when Netlify DB is provisioned)
 *   ANTHROPIC_API_KEY             (for invoice parsing)
 *   GOOGLE_SERVICE_ACCOUNT_JSON   (full service-account JSON as a single string)
 *   GOOGLE_DRIVE_FOLDER_ID        (the shared folder the service account writes to)
 *   INVOICES_INBOUND_SECRET       (shared secret; Apps Script sends it in a header)
 */

const { neon } = require('@neondatabase/serverless');
const { google } = require('googleapis');
const Anthropic = require('@anthropic-ai/sdk').default || require('@anthropic-ai/sdk');

// --------------------------------------------------------------------------
// Lazy-initialised clients
// --------------------------------------------------------------------------
let _sql;
function sql() {
  if (!_sql) _sql = neon(process.env.NETLIFY_DATABASE_URL);
  return _sql;
}

let _drive;
function drive() {
  if (!_drive) {
    const creds = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
    const auth = new google.auth.JWT(
      creds.client_email,
      null,
      creds.private_key,
      ['https://www.googleapis.com/auth/drive.file']
    );
    _drive = google.drive({ version: 'v3', auth });
  }
  return _drive;
}

let _anthropic;
function anthropic() {
  if (!_anthropic) _anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _anthropic;
}

// --------------------------------------------------------------------------
// HTTP helpers
// --------------------------------------------------------------------------
const JSON_HEADERS = { 'Content-Type': 'application/json' };

function ok(body) {
  return { statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify(body) };
}
function bad(msg, code = 400) {
  return { statusCode: code, headers: JSON_HEADERS, body: JSON.stringify({ error: msg }) };
}

// --------------------------------------------------------------------------
// Drive upload
// --------------------------------------------------------------------------
async function uploadToDrive({ filename, mimeType, buffer }) {
  const res = await drive().files.create({
    requestBody: {
      name: filename,
      parents: [process.env.GOOGLE_DRIVE_FOLDER_ID],
    },
    media: {
      mimeType,
      body: require('stream').Readable.from(buffer),
    },
    fields: 'id, webViewLink',
    supportsAllDrives: true,
  });
  return { id: res.data.id, url: res.data.webViewLink };
}

// --------------------------------------------------------------------------
// Claude invoice parsing
// --------------------------------------------------------------------------
async function parseInvoiceWithClaude(buffer, mimeType) {
  const prompt = `You are reading an invoice. Extract the following fields and return ONLY valid JSON, no markdown fences, no commentary:

{
  "vendor": string,            // The company/person being paid
  "invoice_number": string|null,
  "amount": number,            // Total due as a number, no currency symbol
  "currency": string,          // 3-letter code, default "USD"
  "due_date": string           // ISO date YYYY-MM-DD. If only an issue date, add 30 days.
}

If any field is unreadable, use null (except amount/due_date/vendor which are required).`;

  const content = mimeType === 'application/pdf'
    ? [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: buffer.toString('base64') } }]
    : [{ type: 'image',    source: { type: 'base64', media_type: mimeType,          data: buffer.toString('base64') } }];

  const msg = await anthropic().messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 500,
    messages: [{ role: 'user', content: [...content, { type: 'text', text: prompt }] }],
  });

  const text = msg.content.find(c => c.type === 'text')?.text?.trim() || '{}';
  // Strip any stray code fences just in case
  const clean = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  return JSON.parse(clean);
}

// --------------------------------------------------------------------------
// Action handlers
// --------------------------------------------------------------------------
async function handleList(params) {
  const where = [];
  const args = [];
  if (params.status === 'unpaid')   where.push(`paid = FALSE`);
  if (params.status === 'paid')     where.push(`paid = TRUE`);
  if (params.status === 'pending')  where.push(`paid = FALSE AND approved_to_pay = FALSE`);
  if (params.status === 'approved') where.push(`paid = FALSE AND approved_to_pay = TRUE`);
  if (params.program_id) {
    args.push(Number(params.program_id));
    where.push(`program_id = $${args.length}`);
  }
  if (params.from) { args.push(params.from); where.push(`due_date >= $${args.length}`); }
  if (params.to)   { args.push(params.to);   where.push(`due_date <= $${args.length}`); }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const rows = await sql().query(
    `SELECT p.*, pr.name AS program_name
     FROM payments p
     LEFT JOIN programs pr ON pr.id = p.program_id
     ${whereSql}
     ORDER BY p.paid ASC, p.due_date ASC, p.id ASC`,
    args
  );
  return ok({ payments: rows });
}

async function handlePrograms(params) {
  const includeInactive = params.include_inactive === '1' || params.include_inactive === 'true';
  const rows = includeInactive
    ? await sql()`
        SELECT p.id, p.name, p.sort_order, p.is_active, p.created_at,
               (SELECT COUNT(*) FROM payments WHERE program_id = p.id)::int AS payment_count
        FROM programs p
        ORDER BY p.sort_order, p.name
      `
    : await sql()`
        SELECT id, name FROM programs WHERE is_active = TRUE ORDER BY sort_order, name
      `;
  return ok({ programs: rows });
}

async function handleProgramCreate(body) {
  const name = (body.name || '').trim();
  const sortOrder = Number.isFinite(Number(body.sort_order)) ? Number(body.sort_order) : 100;
  if (!name) return bad('name required');
  try {
    const rows = await sql()`
      INSERT INTO programs (name, sort_order)
      VALUES (${name}, ${sortOrder})
      RETURNING *
    `;
    return ok({ program: rows[0] });
  } catch (e) {
    if (/duplicate key/i.test(e.message)) return bad(`Program "${name}" already exists`, 409);
    throw e;
  }
}

async function handleProgramUpdate(body) {
  const { id, patch } = body;
  if (!id || !patch) return bad('id and patch required');

  const sets = [];
  const args = [];
  const allow = ['name', 'sort_order', 'is_active'];
  for (const k of Object.keys(patch)) {
    if (!allow.includes(k)) continue;
    args.push(k === 'name' ? String(patch[k]).trim() : patch[k]);
    sets.push(`${k} = $${args.length}`);
  }
  if (!sets.length) return bad('no updatable fields in patch');

  args.push(Number(id));
  try {
    const rows = await sql().query(
      `UPDATE programs SET ${sets.join(', ')} WHERE id = $${args.length} RETURNING *`,
      args
    );
    if (!rows.length) return bad('not found', 404);
    return ok({ program: rows[0] });
  } catch (e) {
    if (/duplicate key/i.test(e.message)) return bad(`That program name already exists`, 409);
    throw e;
  }
}

async function handleProgramDelete(body) {
  const id = Number(body.id);
  if (!id) return bad('id required');
  const ref = await sql()`SELECT COUNT(*)::int AS n FROM payments WHERE program_id = ${id}`;
  if (ref[0].n > 0) {
    return bad(`Can't delete — ${ref[0].n} payment(s) use this program. Deactivate it instead.`, 409);
  }
  const rows = await sql()`DELETE FROM programs WHERE id = ${id} RETURNING id`;
  if (!rows.length) return bad('not found', 404);
  return ok({ deleted: id });
}

async function handleCreate(body) {
  const { vendor, amount, due_date, program_id, invoice_number, notes } = body;
  if (!vendor || !amount || !due_date) return bad('vendor, amount, due_date required');
  const rows = await sql()`
    INSERT INTO payments (vendor, amount, due_date, program_id, invoice_number, notes, source)
    VALUES (${vendor}, ${amount}, ${due_date}, ${program_id || null}, ${invoice_number || null}, ${notes || null}, 'manual')
    RETURNING *
  `;
  return ok({ payment: rows[0] });
}

async function handleUpload(body) {
  // body: { filename, mimeType, data (base64), program_id?, notes? }
  if (!body.data || !body.filename) return bad('filename and base64 data required');
  const buffer = Buffer.from(body.data, 'base64');
  const mimeType = body.mimeType || 'application/pdf';

  // 1. Parse with Claude
  let parsed;
  try {
    parsed = await parseInvoiceWithClaude(buffer, mimeType);
  } catch (e) {
    return bad(`Claude parse failed: ${e.message}`, 502);
  }

  // 2. Upload to Drive
  const safeName = `${parsed.due_date || 'unknown'}_${(parsed.vendor || 'vendor').replace(/[^a-z0-9]+/gi, '-')}_${parsed.amount || ''}.${(mimeType.split('/')[1] || 'pdf')}`;
  const driveFile = await uploadToDrive({ filename: safeName, mimeType, buffer });

  // 3. Insert DB row
  const rows = await sql()`
    INSERT INTO payments
      (vendor, amount, currency, invoice_number, due_date, program_id,
       invoice_file_url, invoice_file_id, source, notes)
    VALUES
      (${parsed.vendor || 'Unknown'}, ${parsed.amount || 0}, ${parsed.currency || 'USD'},
       ${parsed.invoice_number || null}, ${parsed.due_date || new Date().toISOString().slice(0,10)},
       ${body.program_id || null},
       ${driveFile.url}, ${driveFile.id}, 'upload', ${body.notes || null})
    RETURNING *
  `;
  return ok({ payment: rows[0], parsed });
}

async function handleUpdate(body) {
  const { id, patch } = body;
  if (!id || !patch) return bad('id and patch required');

  const sets = [];
  const args = [];
  const allow = [
    'vendor', 'amount', 'due_date', 'program_id', 'invoice_number', 'notes',
    'approved_to_pay', 'approved_by', 'paid', 'paid_date', 'paid_by',
    'rescheduled_from', 'reschedule_reason',
  ];
  for (const k of Object.keys(patch)) {
    if (!allow.includes(k)) continue;
    args.push(patch[k]);
    sets.push(`${k} = $${args.length}`);
  }
  if (patch.approved_to_pay === true && !patch.approved_at) {
    sets.push(`approved_at = NOW()`);
  }
  if (!sets.length) return bad('no updatable fields in patch');

  args.push(Number(id));
  const rows = await sql().query(
    `UPDATE payments SET ${sets.join(', ')} WHERE id = $${args.length} RETURNING *`,
    args
  );
  if (!rows.length) return bad('not found', 404);
  return ok({ payment: rows[0] });
}

async function handleInbound(body, headers) {
  // Apps Script POSTs:
  //   X-Shared-Secret: <INVOICES_INBOUND_SECRET>
  //   Body: { from, subject, attachments: [{ filename, mimeType, data (base64) }] }
  const secret = headers['x-shared-secret'] || headers['X-Shared-Secret'];
  if (secret !== process.env.INVOICES_INBOUND_SECRET) return bad('unauthorized', 401);
  if (!body.attachments || !body.attachments.length) return bad('no attachments');

  const created = [];
  for (const att of body.attachments) {
    const mimeType = att.mimeType || 'application/pdf';
    const buffer = Buffer.from(att.data, 'base64');
    let parsed;
    try { parsed = await parseInvoiceWithClaude(buffer, mimeType); }
    catch (e) { parsed = { vendor: body.from || 'Unknown (email)', amount: 0, due_date: new Date().toISOString().slice(0,10) }; }

    const safeName = `${parsed.due_date || 'unknown'}_${(parsed.vendor || 'vendor').replace(/[^a-z0-9]+/gi, '-')}_${parsed.amount || ''}.${(mimeType.split('/')[1] || 'pdf')}`;
    const driveFile = await uploadToDrive({ filename: safeName, mimeType, buffer });

    const rows = await sql()`
      INSERT INTO payments
        (vendor, amount, currency, invoice_number, due_date,
         invoice_file_url, invoice_file_id, source, notes)
      VALUES
        (${parsed.vendor || 'Unknown'}, ${parsed.amount || 0}, ${parsed.currency || 'USD'},
         ${parsed.invoice_number || null}, ${parsed.due_date || new Date().toISOString().slice(0,10)},
         ${driveFile.url}, ${driveFile.id}, 'email',
         ${`From: ${body.from || ''}\nSubject: ${body.subject || ''}`})
      RETURNING *
    `;
    created.push(rows[0]);
  }
  return ok({ created });
}

// --------------------------------------------------------------------------
// Entry point
// --------------------------------------------------------------------------
exports.handler = async (event) => {
  try {
    const method = event.httpMethod;
    const qs = event.queryStringParameters || {};
    const body = event.body ? (event.isBase64Encoded ? JSON.parse(Buffer.from(event.body, 'base64').toString('utf8')) : JSON.parse(event.body)) : {};
    const action = qs.action || body.action;

    if (method === 'GET'  && action === 'list')             return await handleList(qs);
    if (method === 'GET'  && action === 'programs')         return await handlePrograms(qs);
    if (method === 'POST' && action === 'create')           return await handleCreate(body);
    if (method === 'POST' && action === 'upload')           return await handleUpload(body);
    if (method === 'POST' && action === 'update')           return await handleUpdate(body);
    if (method === 'POST' && action === 'inbound')          return await handleInbound(body, event.headers || {});
    if (method === 'POST' && action === 'programs-create')  return await handleProgramCreate(body);
    if (method === 'POST' && action === 'programs-update')  return await handleProgramUpdate(body);
    if (method === 'POST' && action === 'programs-delete')  return await handleProgramDelete(body);

    return bad(`unknown action '${action}' for method ${method}`);
  } catch (err) {
    console.error(err);
    return bad(err.message || 'server error', 500);
  }
};

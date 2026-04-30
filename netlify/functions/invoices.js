/**
 * Invoice tool — single Netlify Function with action routing.
 *
 * Routes (query ?action=... or JSON body { action }):
 *   - list              GET   -> list payments (optional: status, program_id, from, to)
 *   - programs          GET   -> list active programs (add ?include_inactive=1 for admin view)
 *   - create            POST  -> manual entry (vendor, amount, due_date, program_id, notes)
 *   - upload            POST  -> multipart or base64 PDF -> Drive + Claude + DB
 *   - update            POST  -> { id, patch: { approved_to_pay, paid, due_date, ... } }
 *   - delete            POST  -> { id }  (removes payment row; Drive file stays)
 *   - delete-bulk       POST  -> { ids: [1,2,3] }  (bulk remove)
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
async function drive() {
  if (!_drive) {
    const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
    if (!raw) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON env var is not set');

    let creds;
    try { creds = JSON.parse(raw); }
    catch (e) { throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON: ' + e.message); }

    // Common env-var gotcha: private_key sometimes arrives with literal "\n"
    // (two characters) instead of real newlines. Normalize.
    if (creds.private_key && creds.private_key.includes('\\n')) {
      creds.private_key = creds.private_key.replace(/\\n/g, '\n');
    }

    const auth = new google.auth.GoogleAuth({
      credentials: creds,
      // Use full drive scope — the service account still only sees folders
      // explicitly shared with it, but can write into them.
      scopes: ['https://www.googleapis.com/auth/drive'],
    });
    const client = await auth.getClient();    // throws LOUDLY on bad creds
    _drive = google.drive({ version: 'v3', auth: client });
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
  const d = await drive();
  const res = await d.files.create({
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

// Extract a JSON value from a response that might have prose around it.
// Tries strict JSON first, then code-fence stripping, then bracket-bounded extraction.
function extractJSON(text) {
  if (!text) return null;
  const tries = [
    text.trim(),
    text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim(),
  ];
  // First [ ... last ]
  const firstBracket = text.indexOf('[');
  const lastBracket  = text.lastIndexOf(']');
  if (firstBracket !== -1 && lastBracket > firstBracket) {
    tries.push(text.slice(firstBracket, lastBracket + 1));
  }
  // First { ... last }
  const firstBrace = text.indexOf('{');
  const lastBrace  = text.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    tries.push(text.slice(firstBrace, lastBrace + 1));
  }
  for (const candidate of tries) {
    try { return JSON.parse(candidate); } catch (_) { /* keep trying */ }
  }
  return null;
}

async function parseInvoiceWithClaude(buffer, mimeType) {
  const prompt = `You are reading an invoice. Return ONLY a JSON array, no markdown fences, no commentary, no leading or trailing text.

Each array element represents one currency on the invoice:

[
  {
    "vendor": string,            // The party being paid (NOT the customer being billed)
    "invoice_number": string|null,
    "amount": number,            // Total due FOR THIS CURRENCY, after subtracting credits/refunds. NEVER negative.
    "currency": string,          // 3-letter ISO code (USD, NZD, EUR, AUD, etc.). If ambiguous, default to "NZD".
    "due_date": string           // ISO YYYY-MM-DD. If only an issue date is shown, add 30 days.
  }
]

Rules for "amount":
  - If the invoice has a clearly labelled "Total Amount Due", "Balance Due", "Amount Due", "Total Owed" or similar — USE THAT NUMBER for the predominant currency. Ignore the line-by-line subtotal calculation.
  - If line items have DIFFERENT currencies (some USD, some EUR), produce one array element per currency. The "amount" for each currency is the sum of its lines (subtracting any negative/credit lines for that currency). If a single overall total is given without splitting by currency, put the bulk in the predominant currency and the smaller-currency lines as their own element.
  - Negative line items are credits (already paid, refunds). Subtract them, don't include them as separate items.
  - Skip header rows, footers, "Total" row labels, and bank-detail sections — these aren't payable items.

Rules for "vendor":
  - The party who should RECEIVE money (the contractor/instructor/supplier name on the invoice). NOT the customer being invoiced.

Rules for "currency":
  - Use codes shown next to amounts. If the invoice mixes "$" without country qualifier, prefer "NZD" unless the rest of the invoice strongly implies otherwise.

If the document is genuinely not an invoice or you can't extract anything meaningful, return [] (empty array). Otherwise return at least one element.`;

  const content = mimeType === 'application/pdf'
    ? [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: buffer.toString('base64') } }]
    : [{ type: 'image',    source: { type: 'base64', media_type: mimeType,          data: buffer.toString('base64') } }];

  const msg = await anthropic().messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1500,
    messages: [{ role: 'user', content: [...content, { type: 'text', text: prompt }] }],
  });

  const text = msg.content.find(c => c.type === 'text')?.text || '';
  const parsed = extractJSON(text);
  if (parsed === null) {
    // Surface the raw response so we can iterate on the prompt later
    const err = new Error(`Claude returned unparseable response: ${text.slice(0, 400)}`);
    err.rawResponse = text;
    throw err;
  }
  return Array.isArray(parsed) ? parsed : (parsed && typeof parsed === 'object' ? [parsed] : []);
}

// Text-only variant for emails that arrive without an attachment.
// Returns an ARRAY of invoice/payment line items. An empty array means
// "this email isn't actually about payments to make" — Apps Script then
// flags the thread as Failed.
async function parseInvoiceTextWithClaude({ from, subject, body }) {
  const todayIso = new Date().toISOString().slice(0, 10);
  const prompt = `You are reading an email that may contain ONE OR MORE bills / invoices / scheduled payments.

From: ${from || '(unknown)'}
Subject: ${subject || '(no subject)'}
Today's date: ${todayIso}

Body:
${(body || '').slice(0, 12000)}

---

Extract every distinct payment that needs to be made. Return ONLY a JSON ARRAY (no markdown, no commentary). Each element:

{
  "vendor": string,            // Who is being paid
  "invoice_number": string|null,
  "amount": number,            // No currency symbol, just the number
  "currency": string,          // 3-letter ISO code. Default "NZD" if ambiguous.
  "due_date": string,          // ISO YYYY-MM-DD — see rules below
  "notes": string|null         // One-line context: section header, "Each month", "Accommodation bond", etc.
}

Due date rules (apply in order):
  1. If a specific full date is shown, use it.
  2. If only a day-of-month is shown WITH "each month" / "monthly" / "every month", use the NEXT upcoming occurrence of that day after today.
  3. If only a day-of-month is shown without recurrence context, use the next upcoming occurrence after today.
  4. If no date hint at all, use today + 30 days.

Other rules:
  - Lines that aren't payments (greetings, signatures, totals, section headers themselves) → skip them. Only return actual payable items.
  - Sub-totals or running totals at the bottom of a section → skip.
  - If a section header describes the items (e.g. "Accommodation Bonds", "Pacific Payments", "Pure Payments"), include it in each item's notes for that section.
  - If the email is clearly NOT about payments at all (marketing, FYI/conversation, receipt of payment already made) → return [] (empty array).
  - Do NOT invent payments not in the email. If unsure, skip.

Return the array, nothing else.`;

  const msg = await anthropic().messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4000,
    messages: [{ role: 'user', content: prompt }],
  });

  const text = msg.content.find(c => c.type === 'text')?.text || '';
  const parsed = extractJSON(text);
  if (parsed === null) {
    console.error('Body-text Claude parse failed. Raw response:', text.slice(0, 800));
    return [];
  }
  return Array.isArray(parsed) ? parsed : (parsed && typeof parsed === 'object' ? [parsed] : []);
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

  // Sort options. Allow-listed for safety since this is interpolated into SQL.
  const sortMap = {
    'due_asc':       'p.due_date ASC, p.id ASC',
    'due_desc':      'p.due_date DESC, p.id DESC',
    'created_asc':   'p.created_at ASC, p.id ASC',
    'created_desc':  'p.created_at DESC, p.id DESC',
    'amount_asc':    'p.amount ASC, p.id ASC',
    'amount_desc':   'p.amount DESC, p.id DESC',
    'vendor_asc':    'lower(p.vendor) ASC, p.id ASC',
  };
  const sortKey = sortMap[params.sort] ? params.sort : 'due_asc';
  const orderClause = `p.paid ASC, ${sortMap[sortKey]}`;

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const rows = await sql().query(
    `SELECT p.*, pr.name AS program_name
     FROM payments p
     LEFT JOIN programs pr ON pr.id = p.program_id
     ${whereSql}
     ORDER BY ${orderClause}`,
    args
  );
  return ok({ payments: rows, sort: sortKey });
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
  const { vendor, amount, due_date, program_id, invoice_number, notes, currency } = body;
  if (!vendor || !amount || !due_date) return bad('vendor, amount, due_date required');
  const cur = (currency || 'NZD').toUpperCase().slice(0, 3);
  const rows = await sql()`
    INSERT INTO payments (vendor, amount, currency, due_date, program_id, invoice_number, notes, source)
    VALUES (${vendor}, ${amount}, ${cur}, ${due_date}, ${program_id || null}, ${invoice_number || null}, ${notes || null}, 'manual')
    RETURNING *
  `;
  return ok({ payment: rows[0] });
}

async function handleUpload(body) {
  // body: { filename, mimeType, data (base64), program_id?, notes? }
  if (!body.data || !body.filename) return bad('filename and base64 data required');
  const buffer = Buffer.from(body.data, 'base64');
  const mimeType = body.mimeType || 'application/pdf';

  // 1. Parse with Claude — always returns an array (one entry per currency)
  let lineGroups;
  try {
    lineGroups = await parseInvoiceWithClaude(buffer, mimeType);
  } catch (e) {
    return bad(`Claude parse failed: ${e.message}`, 502);
  }
  if (!lineGroups.length) return bad('Claude did not return any line items', 502);

  // 2. Upload to Drive ONCE — all rows share the same file
  const first = lineGroups[0];
  const safeName = `${first.due_date || 'unknown'}_${(first.vendor || 'vendor').replace(/[^a-z0-9]+/gi, '-')}.${(mimeType.split('/')[1] || 'pdf')}`;
  const driveFile = await uploadToDrive({ filename: safeName, mimeType, buffer });

  // 3. Insert one row per line group
  const multi = lineGroups.length > 1;
  const created = [];
  for (let i = 0; i < lineGroups.length; i++) {
    const lg = lineGroups[i];
    const noteExtra = multi ? `(Line ${i + 1} of ${lineGroups.length} — multi-currency invoice)` : '';
    const note = [body.notes, noteExtra].filter(Boolean).join('\n') || null;
    const rows = await sql()`
      INSERT INTO payments
        (vendor, amount, currency, invoice_number, due_date, program_id,
         invoice_file_url, invoice_file_id, source, notes)
      VALUES
        (${lg.vendor || 'Unknown'}, ${lg.amount || 0}, ${lg.currency || 'NZD'},
         ${lg.invoice_number || null}, ${lg.due_date || new Date().toISOString().slice(0,10)},
         ${body.program_id || null},
         ${driveFile.url}, ${driveFile.id}, 'upload', ${note})
      RETURNING *
    `;
    created.push(rows[0]);
  }
  return ok({ payments: created, parsed: lineGroups });
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

async function handleDelete(body) {
  const id = Number(body.id);
  if (!id) return bad('id required');
  const rows = await sql()`DELETE FROM payments WHERE id = ${id} RETURNING id, vendor, amount`;
  if (!rows.length) return bad('not found', 404);
  return ok({ deleted: rows[0] });
}

async function handleDeleteBulk(body) {
  const ids = Array.isArray(body.ids) ? body.ids.map(Number).filter(n => Number.isFinite(n) && n > 0) : [];
  if (!ids.length) return bad('ids array required');
  const rows = await sql()`DELETE FROM payments WHERE id = ANY(${ids}::int[]) RETURNING id, vendor, amount`;
  return ok({ deleted: rows, count: rows.length });
}

async function handleDebug() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  const report = {
    env: {
      GOOGLE_SERVICE_ACCOUNT_JSON: raw ? `present (${raw.length} chars)` : 'MISSING',
      GOOGLE_DRIVE_FOLDER_ID:      process.env.GOOGLE_DRIVE_FOLDER_ID ? 'present' : 'MISSING',
      ANTHROPIC_API_KEY:           process.env.ANTHROPIC_API_KEY ? `present (starts ${String(process.env.ANTHROPIC_API_KEY).slice(0, 7)}…)` : 'MISSING',
      NETLIFY_DATABASE_URL:        process.env.NETLIFY_DATABASE_URL ? 'present' : 'MISSING',
      INVOICES_INBOUND_SECRET:     process.env.INVOICES_INBOUND_SECRET ? 'present' : 'MISSING',
    },
  };

  if (raw) {
    try {
      const creds = JSON.parse(raw);
      report.service_account = {
        client_email:      creds.client_email || 'missing field',
        project_id:        creds.project_id || 'missing field',
        private_key_looks_ok:
          typeof creds.private_key === 'string' &&
          creds.private_key.includes('BEGIN PRIVATE KEY') &&
          creds.private_key.includes('END PRIVATE KEY'),
        private_key_has_real_newlines: creds.private_key && creds.private_key.includes('\n'),
        private_key_has_escaped_newlines: creds.private_key && creds.private_key.includes('\\n'),
      };
    } catch (e) {
      report.service_account = { error: 'Failed to JSON.parse: ' + e.message };
    }
  }

  try {
    const d = await drive();

    // 1. List test — confirms read access
    const list = await d.files.list({
      q: `'${process.env.GOOGLE_DRIVE_FOLDER_ID}' in parents`,
      pageSize: 1, fields: 'files(id,name)',
      supportsAllDrives: true, includeItemsFromAllDrives: true,
    });
    report.drive_list = { ok: true, sample_file: list.data.files?.[0]?.name || '(folder empty)' };

    // 2. Metadata test — fetches info about the folder itself
    try {
      const meta = await d.files.get({
        fileId: process.env.GOOGLE_DRIVE_FOLDER_ID,
        fields: 'id,name,mimeType,driveId,parents,capabilities',
        supportsAllDrives: true,
      });
      report.drive_folder = {
        name: meta.data.name,
        mimeType: meta.data.mimeType,
        driveId: meta.data.driveId || '(not in a shared drive)',
        parents: meta.data.parents,
        can_add_children: meta.data.capabilities?.canAddChildren ?? 'unknown',
        can_edit:         meta.data.capabilities?.canEdit ?? 'unknown',
      };
    } catch (e) {
      report.drive_folder = { error: e.message };
    }

    // 3. Upload test — tries to create a tiny file
    try {
      const testRes = await d.files.create({
        requestBody: {
          name: `netlify-debug-${Date.now()}.txt`,
          parents: [process.env.GOOGLE_DRIVE_FOLDER_ID],
        },
        media: { mimeType: 'text/plain', body: 'ok' },
        fields: 'id,webViewLink',
        supportsAllDrives: true,
      });
      report.drive_upload = { ok: true, created_id: testRes.data.id, view_link: testRes.data.webViewLink };
    } catch (e) {
      report.drive_upload = { ok: false, error: e.message };
    }

    report.drive_test = { ok: true };
  } catch (e) {
    report.drive_test = { ok: false, error: e.message };
  }

  return ok(report);
}

async function handleInbound(body, headers) {
  // Apps Script POSTs:
  //   X-Shared-Secret: <INVOICES_INBOUND_SECRET>
  //   Body: {
  //     from, subject,
  //     attachments: [{ filename, mimeType, data (base64) }]   // preferred
  //     body: "..."                                             // fallback when no attachments
  //   }
  const secret = headers['x-shared-secret'] || headers['X-Shared-Secret'];
  if (secret !== process.env.INVOICES_INBOUND_SECRET) return bad('unauthorized', 401);

  const hasAttachments = Array.isArray(body.attachments) && body.attachments.length > 0;
  const hasBody        = typeof body.body === 'string' && body.body.trim().length > 20;

  if (!hasAttachments && !hasBody) return bad('no attachments and no body text to parse');

  const created = [];

  // --- Attachment path --------------------------------------------------
  if (hasAttachments) {
    for (const att of body.attachments) {
      const mimeType = att.mimeType || 'application/pdf';
      const buffer = Buffer.from(att.data, 'base64');

      let lineGroups;
      let parseError = null;
      try {
        lineGroups = await parseInvoiceWithClaude(buffer, mimeType);
      } catch (e) {
        parseError = e.message || String(e);
        console.error(`Claude parse failed for attachment "${att.filename}":`, parseError);
        if (e.rawResponse) console.error('Raw Claude output:', e.rawResponse.slice(0, 800));
        lineGroups = [{
          vendor: `⚠ Parse failed — ${body.from || 'Unknown'}`,
          amount: 0,
          currency: 'NZD',
          due_date: new Date().toISOString().slice(0, 10),
        }];
      }
      if (!lineGroups.length) {
        parseError = parseError || 'Claude returned an empty array';
        lineGroups = [{
          vendor: `⚠ Parse failed — ${body.from || 'Unknown'}`,
          amount: 0,
          currency: 'NZD',
          due_date: new Date().toISOString().slice(0, 10),
        }];
      }

      // Upload once per attachment
      const first = lineGroups[0];
      const safeName = `${first.due_date || 'unknown'}_${(first.vendor || 'vendor').replace(/[^a-z0-9]+/gi, '-')}.${(mimeType.split('/')[1] || 'pdf')}`;
      const driveFile = await uploadToDrive({ filename: safeName, mimeType, buffer });

      const multi = lineGroups.length > 1;
      for (let i = 0; i < lineGroups.length; i++) {
        const lg = lineGroups[i];
        const base = `From: ${body.from || ''}\nSubject: ${body.subject || ''}`;
        const extra = parseError
          ? `\n\n⚠ Auto-parse failed. Please open the Drive file and edit this row.\nReason: ${parseError.slice(0, 300)}`
          : (multi ? `\n(Line ${i + 1} of ${lineGroups.length} — multi-currency invoice)` : '');
        const rows = await sql()`
          INSERT INTO payments
            (vendor, amount, currency, invoice_number, due_date,
             invoice_file_url, invoice_file_id, source, notes)
          VALUES
            (${lg.vendor || 'Unknown'}, ${lg.amount || 0}, ${lg.currency || 'NZD'},
             ${lg.invoice_number || null}, ${lg.due_date || new Date().toISOString().slice(0,10)},
             ${driveFile.url}, ${driveFile.id}, 'email',
             ${base + extra})
          RETURNING *
        `;
        created.push(rows[0]);
      }
    }
    return ok({ created });
  }

  // --- Body-only path ---------------------------------------------------
  // parseInvoiceTextWithClaude now returns an array — could be 0, 1, or many items.
  let items;
  try {
    items = await parseInvoiceTextWithClaude({ from: body.from, subject: body.subject, body: body.body });
  } catch (e) {
    return bad(`Failed to parse email body: ${e.message}`, 502);
  }

  // Filter out items missing required fields
  const valid = (items || []).filter(it => it && it.vendor && Number(it.amount) > 0 && it.due_date);
  const skipped = (items || []).length - valid.length;

  if (!valid.length) {
    return bad('Email does not appear to contain any payable invoices', 422);
  }

  const total = valid.length;
  const baseNote = `From: ${body.from || ''}\nSubject: ${body.subject || ''}`;
  for (let i = 0; i < valid.length; i++) {
    const it = valid[i];
    const positionTag = total > 1 ? `\n(Line ${i + 1} of ${total} — parsed from email body)` : `\n(Parsed from email body — no attachment)`;
    const itemNote = it.notes ? `\nNotes: ${it.notes}` : '';
    const rows = await sql()`
      INSERT INTO payments
        (vendor, amount, currency, invoice_number, due_date,
         source, notes)
      VALUES
        (${it.vendor}, ${it.amount}, ${(it.currency || 'NZD').toUpperCase()},
         ${it.invoice_number || null}, ${it.due_date},
         'email',
         ${baseNote + itemNote + positionTag})
      RETURNING *
    `;
    created.push(rows[0]);
  }
  return ok({ created, parsed_from: 'body', skipped_incomplete: skipped });
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

    if (method === 'GET'  && action === 'debug')           return await handleDebug();
    if (method === 'GET'  && action === 'list')             return await handleList(qs);
    if (method === 'GET'  && action === 'programs')         return await handlePrograms(qs);
    if (method === 'POST' && action === 'create')           return await handleCreate(body);
    if (method === 'POST' && action === 'upload')           return await handleUpload(body);
    if (method === 'POST' && action === 'update')           return await handleUpdate(body);
    if (method === 'POST' && action === 'delete')           return await handleDelete(body);
    if (method === 'POST' && action === 'delete-bulk')      return await handleDeleteBulk(body);
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

// Netlify serverless function — Send Sign Request (JotForm Workflow trigger)
// Endpoint: /api/send-sign-request  (POST, JSON)
//
// WHAT THIS DOES
//   Your team enters the second signer's (the instructor's) name + email on the
//   Sign Request dashboard. This function creates a submission on the JotForm
//   *Workflow starting form* via the JotForm API. That submission triggers the
//   workflow, which sends your existing Sign Document to the signers in order
//   (Pacific Discovery first, then the instructor) — "as normal", straight from
//   JotForm. Your team never logs into JotForm.
//
// WHY A WORKFLOW (not the Sign API)
//   JotForm Sign has no API and Sign documents can't be sent programmatically.
//   But JotForm Workflows CAN: a Sign Document element pulls the signer's email
//   from a form field (the "Link icon" in Manage Signers), and submitting the
//   starting form sends the document. We trigger that submission from here.
//   See SETUP-sign-request.md.
//
// Required env vars (set in Netlify → Site settings → Environment variables):
//   JOTFORM_API_KEY     Already used by jotform.js in this repo.
//   SIGN_WF_FORM_ID     The ID of the Workflow's STARTING form (the numeric ID
//                       in its URL, e.g. 261607666577066).
//   SIGN_WF_EMAIL_QID   The question ID (QID) of the instructor-email field on
//                       that starting form (e.g. "4"). Find it in the form's
//                       API/"Properties" — it's the number JotForm uses, not the
//                       label.
//   SIGN_WF_NAME_QID    (optional) QID of a single-line instructor-name field.
//
// Request body (JSON):
//   { "instructorName": "Jane Doe", "instructorEmail": "jane@example.com",
//     "extra": { "<QID>": "value", ... }   // optional: any other starting-form fields
//   }

const JOTFORM_API = 'https://api.jotform.com';

const JSON_HEADERS = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };

function reply(status, body) {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: JSON_HEADERS });
  if (req.method !== 'POST') return reply(405, { ok: false, error: 'POST only' });

  const apiKey = process.env.JOTFORM_API_KEY;
  const formId = process.env.SIGN_WF_FORM_ID;
  const emailQid = process.env.SIGN_WF_EMAIL_QID;
  const nameQid = process.env.SIGN_WF_NAME_QID; // optional

  const missing = [];
  if (!apiKey) missing.push('JOTFORM_API_KEY');
  if (!formId) missing.push('SIGN_WF_FORM_ID');
  if (!emailQid) missing.push('SIGN_WF_EMAIL_QID');
  if (missing.length) {
    return reply(500, { ok: false, error: `Missing env var(s): ${missing.join(', ')}. See SETUP-sign-request.md.` });
  }

  let input;
  try { input = await req.json(); }
  catch { return reply(400, { ok: false, error: 'Body must be JSON' }); }

  const instructorName = (input.instructorName || '').trim();
  const instructorEmail = (input.instructorEmail || '').trim();
  if (!instructorEmail || !instructorEmail.includes('@')) {
    return reply(400, { ok: false, error: 'A valid instructorEmail is required.' });
  }

  // Build the JotForm submission body. JotForm expects fields keyed by question
  // ID, e.g. submission[4]=jane@example.com.
  const params = new URLSearchParams();
  params.append(`submission[${emailQid}]`, instructorEmail);
  if (nameQid && instructorName) {
    // SIGN_WF_NAME_QID points to a JotForm "Full Name" field, which the
    // submission API expects as separate first/last sub-fields:
    //   submission[6_first]=Jane  submission[6_last]=Doe
    // We split the typed name on the first space (first word = first name,
    // the rest = last name). If your form uses a single-line text field for
    // the name instead, see SETUP-sign-request.md for the one-line change.
    const parts = instructorName.trim().split(/\s+/);
    const first = parts.shift() || '';
    const last = parts.join(' ');
    params.append(`submission[${nameQid}_first]`, first);
    if (last) params.append(`submission[${nameQid}_last]`, last);
  }
  // Any additional starting-form fields the dashboard wants to pass through.
  const extra = (input.extra && typeof input.extra === 'object') ? input.extra : {};
  for (const [qid, value] of Object.entries(extra)) {
    if (value == null || value === '') continue;
    params.append(`submission[${qid}]`, String(value));
  }

  let resp, text;
  try {
    resp = await fetch(`${JOTFORM_API}/form/${encodeURIComponent(formId)}/submissions?apiKey=${encodeURIComponent(apiKey)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
    text = await resp.text();
  } catch (err) {
    return reply(502, { ok: false, error: `JotForm submission failed: ${err.message}` });
  }

  if (!resp.ok) {
    let detail = text;
    try { detail = JSON.parse(text).message || text; } catch {}
    return reply(resp.status >= 500 ? 502 : 400, {
      ok: false,
      error: `JotForm error (HTTP ${resp.status}): ${String(detail).slice(0, 300)}`,
    });
  }

  let data = {};
  try { data = JSON.parse(text); } catch {}
  const submissionId = data.content && data.content.submissionID ? data.content.submissionID : null;

  return reply(200, {
    ok: true,
    submissionId,
    instructorEmail,
    message: 'Submitted to JotForm. The workflow will send the agreement to the signers in order.',
  });
};

export const config = { path: '/api/send-sign-request' };

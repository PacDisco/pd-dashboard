/**
 * Netlify serverless function — dropped-student status for the Enrollment
 * dashboard.
 *
 *   GET  /api/enrollment-status  → every drop record, keyed by HubSpot deal id.
 *   POST /api/enrollment-status  → mark a student dropped (with a reason) or
 *                                  put them back.
 *
 * The records live in Netlify Blobs (see _shared/drops.mjs) so the whole thing
 * is managed from the dashboard — no HubSpot property to create first. Each
 * change also writes a note on the student's HubSpot deal so there is a trail
 * outside the dashboard; that note is best-effort and never fails the request.
 *
 * ------------------------------------------------------------------------
 * AUTHORISATION
 * ------------------------------------------------------------------------
 * GET is open, matching /api/enrollment, which serves the same data to the same
 * page. POST changes what the dashboard reports, so it requires a VERIFIED
 * Netlify Identity session and one of the roles in ENROLLMENT_DROP_ROLES. See
 * _shared/identity.mjs for why the token is verified rather than decoded.
 *
 * ------------------------------------------------------------------------
 * ENVIRONMENT
 * ------------------------------------------------------------------------
 *   HUBSPOT_TOKEN          optional — without it the deal note is skipped and
 *                          the drop is still recorded.
 *   ENROLLMENT_DROP_ROLES  optional — comma-separated roles allowed to mark a
 *                          student dropped.
 *                          Default: admin,operations,programs,admissions
 *   URL                    set by Netlify; needed to verify Identity tokens.
 */

import drops from './_shared/drops.mjs';
import { verifiedUser, actorName } from './_shared/identity.mjs';

const HUBSPOT_BASE = 'https://api.hubapi.com';
const DEFAULT_DROP_ROLES = ['admin', 'operations', 'programs', 'admissions'];

const JSON_HEADERS = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
  'Access-Control-Allow-Origin': '*'
};

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });

function dropRoles() {
  const raw = process.env.ENROLLMENT_DROP_ROLES;
  if (!raw) return DEFAULT_DROP_ROLES;
  const list = raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  return list.length ? list : DEFAULT_DROP_ROLES;
}

function escapeHtml(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * Log the change on the deal. Best-effort by design: the drop is already
 * recorded by the time this runs, so a HubSpot outage must not be reported to
 * the user as a failed save.
 */
async function logDealNote({ dealId, action, studentName, reason, actor }) {
  const token = process.env.HUBSPOT_TOKEN;
  if (!token) {
    console.warn('[enrollment-status] HUBSPOT_TOKEN not set — skipping the deal note');
    return null;
  }

  const lines = action === 'drop'
    ? [
      '<strong>[DROPPED]</strong> Marked as dropped on the Student Enrollment dashboard',
      `Student: ${escapeHtml(studentName || '—')}`,
      `Reason: ${escapeHtml(reason)}`,
      `Marked by: ${escapeHtml(actor)}`,
      '<em>Removed from the student headcount. The deal amount and payments still count toward the totals.</em>'
    ]
    : [
      '<strong>[DROP REMOVED]</strong> Put back into the student list on the Student Enrollment dashboard',
      `Student: ${escapeHtml(studentName || '—')}`,
      `By: ${escapeHtml(actor)}`
    ];

  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  const res = await fetch(`${HUBSPOT_BASE}/crm/v3/objects/notes`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      properties: { hs_timestamp: String(Date.now()), hs_note_body: lines.join('<br>') }
    })
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`HubSpot ${res.status} creating the note: ${body.slice(0, 200)}`);
  }
  const note = await res.json();

  // Default association type for note→deal (214). Letting HubSpot pick it beats
  // hard-coding the numeric id.
  const assoc = await fetch(
    `${HUBSPOT_BASE}/crm/v4/objects/notes/${note.id}/associations/default/deals/${encodeURIComponent(dealId)}`,
    { method: 'PUT', headers }
  );
  if (!assoc.ok) {
    const body = await assoc.text().catch(() => '');
    throw new Error(`HubSpot ${assoc.status} associating the note: ${body.slice(0, 200)}`);
  }
  return note.id;
}

// ═══════════════════════════════════════════
// HANDLER
// ═══════════════════════════════════════════
export default async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization'
      }
    });
  }

  if (req.method === 'GET') {
    const { ok, drops: map, error } = await drops.readDrops();
    return json(200, {
      ok,
      drops: map,
      droppedCount: Object.keys(map).length,
      // A storage outage must be visible. Otherwise "nobody is dropped" and
      // "we cannot read who is dropped" look identical, and the headcount is
      // quietly wrong.
      error: ok ? '' : error
    });
  }

  if (req.method !== 'POST') return json(405, { error: 'GET or POST only' });

  const user = await verifiedUser(req, 'enrollment-status');
  if (user === null) return json(401, { error: 'Sign in required, or your session expired — reload the dashboard.' });
  const allowed = dropRoles();
  const has = (user.roles || []).some((r) => allowed.includes(String(r).toLowerCase()));
  if (!has) {
    return json(403, {
      error: `Marking a student dropped needs one of these roles: ${allowed.join(', ')}.`
    });
  }

  let payload;
  try {
    payload = await req.json();
  } catch {
    return json(400, { error: 'Invalid JSON body' });
  }

  const dealId = String((payload && payload.dealId) || '').trim();
  const action = String((payload && payload.action) || 'drop').toLowerCase();
  const studentName = String((payload && payload.studentName) || '').trim().slice(0, 200);
  const reason = String((payload && payload.reason) || '').trim().slice(0, drops.MAX_REASON);

  if (!/^\d+$/.test(dealId)) return json(400, { error: 'A numeric dealId is required.' });
  if (action !== 'drop' && action !== 'undrop') {
    return json(400, { error: "action must be 'drop' or 'undrop'." });
  }
  // The reason is the point of the feature — a drop with no reason is a mystery
  // for whoever reads the dashboard in six months.
  if (action === 'drop' && !reason) return json(400, { error: 'A reason is required.' });

  // Read → modify → write. Two people dropping two different students within the
  // same second could in principle clobber each other; with strong consistency
  // and a handful of users a season, that is a theoretical risk not worth a
  // locking scheme.
  const current = await drops.readDrops();
  if (!current.ok) {
    return json(503, {
      error: `Cannot reach the dashboard's storage: ${current.error}. Nothing was saved.`
    });
  }
  const map = current.drops;

  let record = null;
  if (action === 'drop') {
    record = {
      reason,
      droppedBy: actorName(user),
      droppedByEmail: user.email || '',
      droppedAt: new Date().toISOString(),
      studentName
    };
    map[dealId] = record;
  } else {
    delete map[dealId];
  }

  try {
    await drops.writeDrops(map);
  } catch (err) {
    console.error(`[enrollment-status] write failed: ${err.message}`);
    return json(500, { error: `Could not save: ${err.message}` });
  }

  let noteWarning = null;
  try {
    await logDealNote({ dealId, action, studentName, reason, actor: actorName(user) });
  } catch (err) {
    console.error(`[enrollment-status] deal note failed: ${err.message}`);
    noteWarning = 'Saved, but the note could not be written to HubSpot.';
  }

  return json(200, {
    ok: true,
    dealId,
    action,
    dropped: action === 'drop',
    record,
    droppedCount: Object.keys(map).length,
    warning: noteWarning
  });
};

export const config = { path: '/api/enrollment-status' };

/**
 * Dropped-student records for the Student Enrollment dashboard.
 *
 * A "drop" is a student who enrolled and then left the programme. HubSpot has
 * no property for this today — the deal stays Closed Won because the money was
 * real — so the record lives in Netlify Blobs, written and read entirely from
 * the dashboard. Marking someone dropped also logs a note on their HubSpot deal
 * (see enrollment-status.mjs), which is the audit trail; the Blobs copy is what
 * the dashboard reads.
 *
 * THE COUNTING RULE, which is the whole reason this exists:
 *   a dropped student does NOT count toward the student headcount,
 *   but their deal amount and everything they paid DO still count toward the
 *   money totals. They were a sale; they are no longer a traveller.
 *
 * Storage shape — one object keyed by HubSpot deal id:
 *   { "12345": { reason, droppedBy, droppedByEmail, droppedAt, studentName } }
 */

export const STORE_NAME = 'enrollment-status';
export const DROPS_KEY = 'drops.json';

/** Reasons are free text, but not unbounded free text. */
export const MAX_REASON = 1000;

/**
 * Open the Blobs store. Isolated in its own function, and imported lazily, so
 * that a caller outside the Netlify runtime (a unit test, a local script) fails
 * here — where it is caught — rather than at module load.
 */
async function openStore() {
  const { getStore } = await import('@netlify/blobs');
  return getStore({ name: STORE_NAME, consistency: 'strong' });
}

/** Coerce whatever is in the blob into the shape the rest of the code expects. */
export function normalizeDrops(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const key of Object.keys(raw)) {
    const rec = raw[key];
    if (!rec || typeof rec !== 'object') continue;
    out[String(key)] = {
      reason: String(rec.reason || ''),
      droppedBy: String(rec.droppedBy || ''),
      droppedByEmail: String(rec.droppedByEmail || ''),
      droppedAt: String(rec.droppedAt || ''),
      studentName: String(rec.studentName || '')
    };
  }
  return out;
}

/**
 * Every drop record, keyed by deal id.
 *
 * Never throws. The enrollment dashboard must render even if Blobs is
 * unreachable or has not been provisioned on this site yet — losing the drop
 * markers degrades the headcount, while throwing would lose the whole table.
 * The failure is logged and surfaced to the UI via `dropsAvailable: false`.
 */
export async function readDrops() {
  try {
    const store = await openStore();
    const data = await store.get(DROPS_KEY, { type: 'json' });
    return { ok: true, drops: normalizeDrops(data), error: '' };
  } catch (err) {
    console.warn(`[drops] could not read ${DROPS_KEY}: ${err.message}`);
    return { ok: false, drops: {}, error: err.message };
  }
}

/** Persist the whole map. Throws — a failed write must not report success. */
export async function writeDrops(map) {
  const store = await openStore();
  await store.setJSON(DROPS_KEY, normalizeDrops(map));
}

export default { STORE_NAME, DROPS_KEY, MAX_REASON, normalizeDrops, readDrops, writeDrops };

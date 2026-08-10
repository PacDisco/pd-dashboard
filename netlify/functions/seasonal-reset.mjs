/**
 * SEASONAL RESET — scheduled Netlify function.
 *
 * On each season boundary it clears the Signed Contract and Visa items for
 * EVERY instructor, so both the admin dashboard and the instructor portal show
 * them as owed again and prompt a fresh submission for the new season. The
 * per-item cutoff (reset_at) means last season's contract / visa in Jotform
 * won't silently re-tick the box — only a submission made after the reset does.
 *
 * SEASON BOUNDARIES (interpreted in the org's timezone, Pacific/Auckland):
 *   Dec 1, May 1, Jul 15.
 *
 * WHY IT RUNS DAILY AND CHECKS THE DATE
 *   A Netlify function may carry only one `schedule`, and our three dates don't
 *   fit one clean cron rule (two different days-of-month across three months).
 *   So it wakes once a day, asks "is today a season boundary in NZ?", and does
 *   nothing on every other day. The daily run is cheap, and this keeps the
 *   three dates in one obvious list instead of spread across cron fields.
 *
 * IDEMPOTENCY
 *   It claims the day by inserting a unique run_key ('season-YYYY-MM-DD', the NZ
 *   date) into checklist_reset_log first. If the row already exists — a retry, a
 *   double fire, a second daily tick that lands on the same NZ date — the claim
 *   fails and the run is a no-op. Only the run that wins the claim resets.
 *
 * Runs at 13:00 UTC, which is early morning of the same date in Pacific/Auckland
 * year-round (UTC+12 in winter, +13 in summer), so the NZ-date check lands on
 * the intended calendar day.
 *
 * Env: NETLIFY_DATABASE_URL (auto-injected by Netlify DB).
 * To change the dates or which items reset, edit SEASON_DATES / RESET_ITEMS.
 */

import { neon } from '@neondatabase/serverless';
import resetModule from './_shared/onboarding-reset.js';

const { resetOnboardingItems, logReset } = resetModule;

// Season boundaries, in the org's timezone. Edit here to change the schedule.
const SEASON_TZ = 'Pacific/Auckland';
const SEASON_DATES = [
  { month: 12, day: 1 },   // Dec 1
  { month: 5,  day: 1 },   // May 1
  { month: 7,  day: 15 },  // Jul 15
];

// Items cleared on every season boundary. The other documents (passport,
// driver's licence, WFR, background check) are reset on demand per instructor
// from the dashboard, not on this schedule.
const RESET_ITEMS = ['contract', 'doc_visa'];

// Today's date in the org timezone, as { iso: 'YYYY-MM-DD', month, day }.
function localDate(now, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const get = (t) => parts.find((p) => p.type === t).value;
  const y = get('year'), m = get('month'), d = get('day');
  return { iso: `${y}-${m}-${d}`, month: Number(m), day: Number(d) };
}

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export default async () => {
  const today = localDate(new Date(), SEASON_TZ);
  const isBoundary = SEASON_DATES.some((s) => s.month === today.month && s.day === today.day);
  if (!isBoundary) {
    return json(200, { skipped: 'not a season boundary', date: today.iso });
  }

  const dbUrl = process.env.NETLIFY_DATABASE_URL;
  if (!dbUrl) {
    console.error('[seasonal-reset] NETLIFY_DATABASE_URL not set');
    return json(500, { error: 'database not configured' });
  }
  const sql = neon(dbUrl);
  const runKey = `season-${today.iso}`;

  // Claim the day FIRST. logReset inserts ON CONFLICT DO NOTHING and returns
  // true only if this run created the row — so exactly one run performs the
  // reset even if the schedule fires more than once.
  let claimed;
  try {
    claimed = await logReset(sql, {
      runKey, items: RESET_ITEMS, scope: 'all', instructorId: null,
      affected: 0, actor: 'schedule',
    });
  } catch (e) {
    console.error('[seasonal-reset] claim failed:', e.message || e);
    return json(500, { error: 'claim failed', detail: e.message || String(e) });
  }
  if (!claimed) {
    return json(200, { skipped: 'already ran for this date', runKey });
  }

  try {
    const { affected, items } = await resetOnboardingItems(sql, { items: RESET_ITEMS, instructorId: null });
    // Record how many rows the reset touched, now that we know.
    await sql`UPDATE checklist_reset_log SET affected_rows = ${affected} WHERE run_key = ${runKey}`;
    console.log(`[seasonal-reset] ${runKey}: reset ${items.join(', ')} across ${affected} row(s)`);
    return json(200, { reset: items, affected, runKey, date: today.iso });
  } catch (e) {
    console.error('[seasonal-reset] reset failed:', e.message || e);
    return json(500, { error: 'reset failed', detail: e.message || String(e), runKey });
  }
};

// Daily at 13:00 UTC — see header for why daily + date-check rather than three crons.
export const config = {
  schedule: '0 13 * * *',
};

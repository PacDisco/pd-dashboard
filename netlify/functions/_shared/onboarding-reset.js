/**
 * Onboarding SEASONAL RESET — the shared write path.
 *
 * One function performs a reset, imported by both consumers so they can't
 * drift:
 *   - instructors.js     the admin "reset this item" actions (one instructor,
 *                        or all of them)
 *   - seasonal-reset.js  the scheduled Dec 1 / May 1 / Jul 15 job
 *
 * WHAT A RESET DOES to each targeted (instructor, item):
 *   completed    -> FALSE        the box goes red in the dashboard AND the
 *                                instructor portal (both read this one table)
 *   completed_at -> NULL
 *   source       -> 'jotform'    releases any manual pin, so a fresh upload
 *                                this season re-ticks it automatically
 *   reset_at     -> NOW()        the cutoff: from now on only Jotform evidence
 *                                submitted AFTER this instant credits the item,
 *                                so last season's upload can't silently re-tick
 *
 * WHY IT UPSERTS A ROW FOR EVERY INSTRUCTOR (not just those with a row):
 *   Completion is derived from Jotform on every portal load. An instructor who
 *   has no row for `doc_visa` yet would, on their next portal visit, get visa
 *   re-derived from last season's still-present upload and ticked. Stamping a
 *   cutoff row for everyone is what makes the reset actually hold across the
 *   whole roster — not just for people who happened to have a row already.
 */

'use strict';

const CHECKLIST = require('./instructor-checklist.js');

/**
 * Reset a set of checklist items.
 * @param sql            a neon tagged-template instance (e.g. the value of sql())
 * @param items          array of checklist keys (invalid keys are ignored)
 * @param instructorId   null -> all instructors; a number -> just that one
 * @returns { affected, items }  items = the valid keys actually applied
 */
async function resetOnboardingItems(sql, { items, instructorId = null }) {
  const valid = Array.from(new Set(
    (items || []).map((i) => String(i || '').trim()).filter((i) => CHECKLIST.BY_ITEM.has(i))
  ));
  if (!valid.length) return { affected: 0, items: [] };

  const labels = valid.map((i) => CHECKLIST.BY_ITEM.get(i).label);
  const idNum = instructorId == null ? null : Number(instructorId);

  // UNNEST pairs each item with its canonical label; the CROSS JOIN fans it
  // across every instructor (or the one requested). ON CONFLICT makes it a
  // reset for rows that already exist and an insert for those that don't.
  const rows = await sql`
    INSERT INTO instructor_onboarding
      (instructor_id, item, label, completed, completed_at, source, reset_at)
    SELECT i.id, t.item, t.label, FALSE, NULL, 'jotform', NOW()
      FROM instructors i
      CROSS JOIN UNNEST(${valid}::text[], ${labels}::text[]) AS t(item, label)
     WHERE (${idNum}::int IS NULL OR i.id = ${idNum}::int)
    ON CONFLICT (instructor_id, item) DO UPDATE
      SET completed    = FALSE,
          completed_at = NULL,
          source       = 'jotform',
          reset_at     = NOW(),
          label        = COALESCE(EXCLUDED.label, instructor_onboarding.label)
    RETURNING instructor_id`;

  return { affected: rows.length, items: valid };
}

/**
 * Record a reset in checklist_reset_log. Best-effort and idempotent: the
 * scheduled job passes a season run_key (e.g. 'season-2026-12-01') so a retried
 * or double-fired cron logs once; ON CONFLICT DO NOTHING absorbs the repeat.
 * @returns true if a new log row was written, false if it already existed.
 */
async function logReset(sql, { runKey, items, scope, instructorId = null, affected, actor }) {
  const rows = await sql`
    INSERT INTO checklist_reset_log
      (run_key, items, scope, instructor_id, affected_rows, actor)
    VALUES (${runKey}, ${items}, ${scope}, ${instructorId == null ? null : Number(instructorId)},
            ${affected || 0}, ${actor || null})
    ON CONFLICT (run_key) DO NOTHING
    RETURNING id`;
  return rows.length > 0;
}

/**
 * Has a reset with this run_key already happened? The scheduled job calls this
 * to decide whether today is a fresh season boundary or one it already handled.
 */
async function resetAlreadyRan(sql, runKey) {
  const rows = await sql`SELECT 1 FROM checklist_reset_log WHERE run_key = ${runKey} LIMIT 1`;
  return rows.length > 0;
}

module.exports = { resetOnboardingItems, logReset, resetAlreadyRan };

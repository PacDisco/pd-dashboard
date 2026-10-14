/**
 * Time Tracker — scheduled report emails (weekly / every other week).
 *
 * Runs once a day (schedule in netlify.toml). Every schedule is due on a Monday;
 * the report that goes out covers the week — or two — that ended the Sunday
 * before. People set these up from the Time Tracker's "Export report" dialog.
 *
 * Exactly-once, as far as one mailbox allows:
 *   1. CLAIM  — move next_send_on forward in a conditional UPDATE. If two runs
 *               overlap, only one of them gets the row back.
 *   2. SEND   — build the report and mail it.
 *   3. On failure, put next_send_on BACK and record the error, so tomorrow's run
 *               tries again and the owner sees why in the dialog. A schedule
 *               that fails for a fortnight is paused rather than retried forever.
 *
 * Sending goes through the Gmail mailbox connected in the Popups dashboard —
 * see _shared/time-report-mail.js.
 */

'use strict';

const { neon } = require('@neondatabase/serverless');
const R = require('./_shared/time-report.js');
const MAIL = require('./_shared/time-report-mail.js');

const BUDGET_MS = 22000;          // scheduled functions get ~30s; leave headroom
const GIVE_UP_AFTER_DAYS = 14;

/**
 * One pass over every due schedule. Exported with its dependencies injectable
 * so the database test drives it with a fake mailbox.
 */
async function runDue(sql, { mailer = MAIL.gmailMailer, now = new Date(), siteUrl = process.env.URL, log = console } = {}) {
  const started = Date.now();
  // "Due" is judged in each schedule's own timezone, so a NZ schedule sends on
  // the NZ Monday even though the cron runs on UTC.
  const candidates = await sql.query(
    `SELECT * FROM time_report_schedules WHERE is_active = TRUE AND next_send_on <= $1::date + 1 ORDER BY next_send_on, id`,
    [now.toISOString().slice(0, 10)]);

  const results = [];
  for (const sched of candidates) {
    if (Date.now() - started > BUDGET_MS) { log.warn(`time-report-emails: out of time, ${candidates.length - results.length} left for tomorrow`); break; }
    const today = R.todayIn(sched.timezone, now);
    const sendOn = R.isYmd(String(sched.next_send_on)) ? String(sched.next_send_on) : ymd(sched.next_send_on);
    if (sendOn > today) continue;

    const next = R.advanceSendOn(sendOn, sched.frequency, today);
    const claimed = await sql.query(
      `UPDATE time_report_schedules SET next_send_on = $3, updated_at = NOW()
        WHERE id = $1 AND next_send_on = $2 AND is_active = TRUE RETURNING id`,
      [sched.id, sendOn, next]);
    if (!claimed.length) continue;              // another run has it

    // The report covers the period of the LATEST Monday that has passed, so a
    // run that was down for a day still sends last week rather than an old one.
    const latest = latestDue(sendOn, sched.frequency, today);
    try {
      const out = await MAIL.runSchedule(sql, sched, { sendOn: latest, mailer, siteUrl, now });
      await sql.query(
        `UPDATE time_report_schedules
            SET last_sent_at = NOW(), last_period_start = $2, last_period_end = $3, last_error = NULL, last_error_at = NULL
          WHERE id = $1`, [sched.id, out.period.from, out.period.to]);
      results.push({ id: sched.id, ok: true, ...out });
      log.log(`time-report-emails: #${sched.id} sent ${out.period.from}..${out.period.to} to ${out.recipients.length}`);
    } catch (e) {
      const ageDays = (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${sendOn}T00:00:00Z`)) / 86400000;
      const giveUp = ageDays >= GIVE_UP_AFTER_DAYS;
      await sql.query(
        `UPDATE time_report_schedules
            SET next_send_on = CASE WHEN $4 THEN $5::date ELSE $2::date END,
                is_active = CASE WHEN $4 THEN FALSE ELSE is_active END,
                last_error = $3, last_error_at = NOW()
          WHERE id = $1`,
        [sched.id, sendOn, String(e.message || e).slice(0, 500) + (giveUp ? ' — paused after two weeks of failed sends' : ''), giveUp, next]);
      results.push({ id: sched.id, ok: false, error: e.message });
      log.error(`time-report-emails: #${sched.id} failed:`, e.message);
    }
  }
  return results;
}

/** The most recent send date on this schedule's cadence that is on or before today. */
function latestDue(sendOn, frequency, today) {
  const step = R.FREQUENCIES[frequency] || 7;
  let d = sendOn;
  while (R.addDaysYmd(d, step) <= today) d = R.addDaysYmd(d, step);
  return d;
}

function ymd(raw) {
  if (raw instanceof Date) {
    const utc = raw.getUTCHours() === 0 && raw.getUTCMinutes() === 0;
    const y = utc ? raw.getUTCFullYear() : raw.getFullYear();
    const m = (utc ? raw.getUTCMonth() : raw.getMonth()) + 1;
    const d = utc ? raw.getUTCDate() : raw.getDate();
    return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }
  return String(raw).slice(0, 10);
}

exports.handler = async (event) => {
  try {
    await MAIL.connectBlobs(event);
    const results = await runDue(neon(process.env.NETLIFY_DATABASE_URL));
    return { statusCode: 200, body: JSON.stringify({ processed: results.length, results }) };
  } catch (e) {
    if (/relation "time_report_schedules/i.test(e.message || '')) {
      console.log('time-report-emails: table missing — run MIGRATION-time-report-schedules.sql');
      return { statusCode: 200, body: '{"processed":0}' };
    }
    console.error('time-report-emails failed:', e);
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};

exports.runDue = runDue;
exports.latestDue = latestDue;

/**
 * Sending a scheduled Time Tracker report.
 *
 * Mail goes out through the Google Workspace mailbox already connected for the
 * popup lead notifications (Popups dashboard → "Connect Gmail"; Netlify Blobs
 * store "popups", key "gmail"). No second mailbox, no new provider, no new env
 * vars — if popups can email the team, so can this.
 *
 * Used by two callers:
 *   time-tracking.js        "Send now" on a schedule (the person is signed in)
 *   time-report-emails.js   the daily scheduled run
 *
 * runSchedule() takes its mailer as an argument so the tests run the whole path
 * against a real database with a fake inbox.
 */

'use strict';

const R = require('./time-report.js');

const FROM_NAME = 'Time Tracker';

/** The connected Gmail mailbox, or null. Lazy-imported: these are ES modules. */
async function gmailConnection() {
  const { popupStore } = await import('./popups-store.mjs');
  const store = popupStore();
  const conn = await store.get('gmail', { type: 'json' }).catch(() => null);
  return conn && conn.refreshToken && conn.email ? { conn, store } : null;
}

/** The default mailer: the shared Gmail mailbox. */
const gmailMailer = {
  async status() {
    try {
      const hit = await gmailConnection();
      return hit ? { connected: true, from: hit.conn.email } : { connected: false };
    } catch (e) {
      return { connected: false, error: e.message };
    }
  },
  async send(msg) {
    const hit = await gmailConnection();
    if (!hit) {
      throw Object.assign(new Error('No mailbox is connected for sending. Open the Popups dashboard and click "Connect Gmail" — the Time Tracker sends through the same mailbox.'), { status: 409 });
    }
    const { sendMail } = await import('./popups-gmail.mjs');
    await sendMail(hit.conn, { fromName: FROM_NAME, replyTo: msg.replyTo, ...msg });
    return { from: hit.conn.email };
  },
};

/**
 * Build and send one schedule's report.
 *
 * @param {Function} sql      neon()-style tagged template with .query()
 * @param {object}   sched    a time_report_schedules row
 * @param {object}   opts
 * @param {string}   opts.sendOn   the Monday this send belongs to (decides the period)
 * @param {object}   [opts.mailer] { send(msg) } — defaults to the Gmail mailbox
 * @param {string}   [opts.siteUrl]
 * @param {Date}     [opts.now]
 * @returns {{ period, recipients, entries, minutes, files }}
 */
async function runSchedule(sql, sched, { sendOn, mailer = gmailMailer, siteUrl, now = new Date() }) {
  const scope = sched.scope === 'team' ? 'team' : 'self';
  const period = R.periodForSend(sendOn, sched.frequency);

  // The person's access is re-checked on every send, not just when the schedule
  // was saved: a team report keeps going only while its owner can still see the
  // team (owner_can_review is refreshed every time they open the tracker), and
  // nobody's report keeps going after they've been deactivated.
  const owner = (await sql.query(
    'SELECT id, email, full_name, is_active FROM time_contractors WHERE email = $1', [sched.owner_email]))[0];
  if (!owner) throw new Error('the person who set this report up no longer has a Time Tracker account');
  if (owner.is_active === false) throw new Error(`${owner.full_name || owner.email} has been deactivated in the Time Tracker`);
  if (scope === 'team' && !sched.owner_can_review) {
    throw new Error(`${owner.full_name || owner.email} no longer has the admin or timesheet-reviewer role, so team reports they set up are paused`);
  }

  const options = R.normalizeOptions({
    ...(sched.options || {}), title: (sched.options && sched.options.title) || sched.name || '',
    from: period.from, to: period.to,
  }, { scope });
  const contractorIds = scope === 'self' ? [owner.id] : options.contractor_ids;
  if (scope === 'self') options.contractor_ids = [];   // already pinned in the query

  const entries = await R.loadReportEntries(sql, { from: period.from, to: period.to, contractorIds });
  const report = R.buildReport({
    entries: scope === 'self' ? entries.filter((e) => e.contractor_id === owner.id) : entries,
    options, scope, subject: owner.full_name || owner.email, tz: sched.timezone, now,
  });

  const formats = (sched.formats || []).filter((f) => R.FORMATS.includes(f));
  const files = R.renderFiles(report, formats.length ? formats : ['csv']);

  // A personal report only ever goes to its owner. A team report goes to the
  // list it was saved with.
  const recipients = scope === 'self'
    ? [owner.email]
    : R.normalizeRecipients(sched.recipients || []);
  if (!recipients.length) throw new Error('this report has no one to send to');

  const msg = R.toEmail(report, { frequency: sched.frequency, siteUrl, attachments: files.map((f) => f.filename) });
  await mailer.send({ to: recipients, replyTo: owner.email, subject: msg.subject, text: msg.text, html: msg.html, attachments: files });

  return {
    period, recipients,
    entries: report.totals.count,
    minutes: report.totals.minutes,
    files: files.map((f) => f.filename),
  };
}

/**
 * v1 (Lambda-style) functions have to hand their invocation to @netlify/blobs
 * before getStore() can find the site's Blobs. popupStore() also falls back to
 * NETLIFY_SITE_ID + NETLIFY_BLOBS_TOKEN, so this is belt and braces.
 */
async function connectBlobs(event) {
  if (!event || !event.blobs) return;
  try { (await import('@netlify/blobs')).connectLambda(event); } catch { /* fallback covers it */ }
}

module.exports = { runSchedule, gmailMailer, connectBlobs, FROM_NAME };

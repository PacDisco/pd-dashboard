/**
 * Gmail → Invoices tool forwarder
 *
 * Setup:
 *   1. In Gmail, create a label: "Invoices/To Process"
 *   2. Create a filter that applies that label to invoice emails.
 *   3. Open https://script.google.com → New project → paste this file in.
 *   4. Edit the CONFIG block below (NETLIFY_URL + SHARED_SECRET + NOTIFY_EMAIL).
 *   5. Run forwardInvoices once manually — approve the OAuth prompts.
 *   6. Triggers (clock icon) → Add Trigger → forwardInvoices,
 *      Time-driven, Minutes timer, every 10 minutes.
 */

// ============================ CONFIG ============================
const CONFIG = {
  NETLIFY_URL:        'https://dashboard.pacificdiscovery.org/api/invoices?action=inbound',
  SHARED_SECRET:      'w66BXJXVdpHH9MnULsTH2gD76h27Fb8M',
  LABEL_TO_PROCESS:   'Invoices/To Process',
  LABEL_PROCESSED:    'Invoices/Processed',
  LABEL_FAILED:       'Invoices/Failed',
  MAX_THREADS_PER_RUN: 20,

  // Failure notifications: one email per run summarising any failures.
  // Comma-separate multiple addresses; set NOTIFY_EMAIL to '' to disable.
  NOTIFY_EMAIL:           'director@pacificdiscovery.org, operations@edagroup.org, accounts@pacificdiscovery.org',
  NOTIFY_DASHBOARD_URL:   'https://dashboard.pacificdiscovery.org/invoices/',
  // If true, "not an invoice" failures (Claude said it wasn't a real bill)
  // also trigger notifications. Set false to suppress those — useful if
  // your filter catches a lot of marketing/notification emails.
  NOTIFY_ON_NOT_INVOICE:  true,
};
// ================================================================

function forwardInvoices() {
  const toProcess = GmailApp.getUserLabelByName(CONFIG.LABEL_TO_PROCESS);
  const processed = getOrCreateLabel_(CONFIG.LABEL_PROCESSED);
  const failed    = getOrCreateLabel_(CONFIG.LABEL_FAILED);

  if (!toProcess) {
    console.log(`Label not found: ${CONFIG.LABEL_TO_PROCESS}. Create it in Gmail first.`);
    return;
  }

  const threads = toProcess.getThreads(0, CONFIG.MAX_THREADS_PER_RUN);
  console.log(`Found ${threads.length} threads to forward.`);

  // Collect failures across this run for a single summary email at the end.
  const failures = [];

  for (const thread of threads) {
    const messages = thread.getMessages();
    const newest = messages[messages.length - 1];

    try {
      const seen = new Set();
      const attachments = [];
      for (const m of messages) {
        const atts = m.getAttachments({ includeInlineImages: false, includeAttachments: true });
        for (const a of atts) {
          const type = a.getContentType() || '';
          const name = a.getName() || '';
          const looksLikePdf   = /^application\/pdf$/i.test(type) || /\.pdf$/i.test(name);
          const looksLikeImage = /^image\/(png|jpe?g|gif|webp|heic)$/i.test(type) || /\.(png|jpe?g|gif|webp|heic)$/i.test(name);
          if (!looksLikePdf && !looksLikeImage) continue;
          const key = `${name}|${a.getSize()}`;
          if (seen.has(key)) continue;
          seen.add(key);
          attachments.push(a);
        }
      }

      const payload = {
        from:    newest.getFrom(),
        subject: newest.getSubject(),
      };

      if (attachments.length) {
        payload.attachments = attachments.map(a => ({
          filename: a.getName(),
          mimeType: a.getContentType(),
          data:     Utilities.base64Encode(a.getBytes()),
        }));
      } else {
        const body = (newest.getPlainBody() || '').slice(0, 10000);
        payload.body = body;
      }

      const response = UrlFetchApp.fetch(CONFIG.NETLIFY_URL, {
        method: 'post',
        contentType: 'application/json',
        headers: { 'X-Shared-Secret': CONFIG.SHARED_SECRET },
        payload: JSON.stringify(payload),
        muteHttpExceptions: true,
      });

      const code = response.getResponseCode();
      const responseBody = response.getContentText();
      const tagAtts = attachments.length ? `${attachments.length} attachment${attachments.length !== 1 ? 's' : ''}` : 'body-only';

      if (code >= 200 && code < 300) {
        console.log(`OK (${tagAtts}): ${newest.getSubject()}`);
        thread.removeLabel(toProcess);
        thread.addLabel(processed);
      } else {
        const reason = parseErrorMessage_(responseBody) || `HTTP ${code}`;
        const isNotInvoice = code === 422;
        console.warn(`FAIL ${code} (${tagAtts}): ${newest.getSubject()} → ${responseBody.slice(0, 200)}`);
        thread.removeLabel(toProcess);
        thread.addLabel(failed);

        if (!isNotInvoice || CONFIG.NOTIFY_ON_NOT_INVOICE) {
          failures.push({
            subject: newest.getSubject(),
            from:    newest.getFrom(),
            reason:  reason,
            kind:    isNotInvoice ? 'not_invoice' : 'error',
            link:    thread.getPermalink(),
          });
        }
      }
    } catch (err) {
      console.error(`ERROR on thread "${newest.getSubject()}":`, err);
      thread.removeLabel(toProcess);
      thread.addLabel(failed);
      failures.push({
        subject: newest.getSubject(),
        from:    newest.getFrom(),
        reason:  `Script error: ${String(err && err.message || err)}`,
        kind:    'script_error',
        link:    thread.getPermalink(),
      });
    }
  }

  if (failures.length && CONFIG.NOTIFY_EMAIL) {
    sendFailureEmail_(failures);
  }
}

// ------------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------------

// Best-effort extraction of the "error" field from the Netlify response.
function parseErrorMessage_(body) {
  if (!body) return '';
  try {
    const j = JSON.parse(body);
    return j.error || '';
  } catch (e) {
    return body.slice(0, 200);
  }
}

function sendFailureEmail_(failures) {
  const n = failures.length;
  const subject = n === 1
    ? `[Invoice tool] Failed: ${failures[0].subject}`
    : `[Invoice tool] ${n} invoice email${n !== 1 ? 's' : ''} failed`;

  const lines = [];
  lines.push(`The following email${n !== 1 ? 's' : ''} couldn't be processed by the invoice tool and ${n !== 1 ? 'have' : 'has'} been moved to the "${CONFIG.LABEL_FAILED}" label.`);
  lines.push('');

  for (const f of failures) {
    lines.push('─────────────────────');
    lines.push(`Subject:  ${f.subject}`);
    lines.push(`From:     ${f.from}`);
    lines.push(`Reason:   ${f.reason}`);
    lines.push(`Open:     ${f.link}`);
    lines.push('');
  }

  lines.push('─────────────────────');
  lines.push('');
  lines.push('Common reasons:');
  lines.push('  • "Email does not appear to be an invoice" — Gmail filter caught a marketing/confirmation email');
  lines.push('  • "no attachments and no body text" — message was effectively empty');
  lines.push('  • "Drive upload failed" / 401 / 500 — backend issue (check Netlify function logs)');
  lines.push('  • "Failed to parse email body" — Claude could not extract structured invoice data');
  lines.push('');
  lines.push(`Dashboard: ${CONFIG.NOTIFY_DASHBOARD_URL}`);
  lines.push('');
  lines.push('To stop these notifications, set CONFIG.NOTIFY_EMAIL = "" in the Apps Script project.');

  MailApp.sendEmail({
    to:      CONFIG.NOTIFY_EMAIL,
    subject: subject,
    body:    lines.join('\n'),
  });
  console.log(`Sent failure notification email to ${CONFIG.NOTIFY_EMAIL} (${n} item${n !== 1 ? 's' : ''}).`);
}

function getOrCreateLabel_(name) {
  return GmailApp.getUserLabelByName(name) || GmailApp.createLabel(name);
}

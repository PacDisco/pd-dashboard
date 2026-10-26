// terms-kit.mjs — the Program Terms & Conditions document format.
//
// Pure functions, no DOM. Used by:
//   - pd-apply functions     /api/terms, the applicant emails
//   - pd-apply/public        /terms page and terms-embed.js (website)
//   - pd-dashboard/apply-form  pinned copy for the Terms tab preview
//                              (keep in step with pd-apply/public/terms-kit.mjs)
//
// The document is plain text with a small Markdown subset, so admissions can
// edit it without HTML and it renders the same everywhere:
//   # Heading            ## Sub-heading        ### Minor heading
//   1. numbered item     - bullet item
//   **bold**  *italic*   [link text](https://…)
//   blank line = new paragraph
// Everything else is escaped. Only http(s) and mailto links are kept.

export const TERMS_DOC_ID = 'program-terms';

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function inline(text) {
  let s = esc(text);
  // links first, so * inside URLs is left alone
  s = s.replace(/\[([^\]]+)\]\(((?:https?:\/\/|mailto:)[^\s)]+)\)/g, (_, t, u) => `<a href="${u}" target="_blank" rel="noopener">${t}</a>`);
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');
  return s;
}

/** Markdown subset → { blocks } (the parsed structure). */
export function parseTerms(md) {
  const lines = String(md ?? '').replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let para = [];
  let list = null;
  const flushPara = () => { if (para.length) { blocks.push({ type: 'p', text: para.join(' ') }); para = []; } };
  const flushList = () => { if (list) { blocks.push(list); list = null; } };
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) { flushPara(); flushList(); continue; }
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    if (h) { flushPara(); flushList(); blocks.push({ type: `h${h[1].length}`, text: h[2] }); continue; }
    const ol = /^(\d+)[.)]\s+(.*)$/.exec(line);
    const ul = /^[-*•]\s+(.*)$/.exec(line);
    if (ol || ul) {
      flushPara();
      const type = ol ? 'ol' : 'ul';
      if (!list || list.type !== type) { flushList(); list = { type, items: [], start: ol ? Number(ol[1]) : undefined }; }
      list.items.push(ol ? ol[2] : ul[1]);
      continue;
    }
    if (list) {
      // a continuation line belongs to the last list item
      list.items[list.items.length - 1] += ` ${line}`;
      continue;
    }
    para.push(line);
  }
  flushPara(); flushList();
  return blocks;
}

/** Safe HTML for web pages (no styles — the page styles it). */
export function termsToHtml(md) {
  return parseTerms(md).map((b) => {
    if (b.type === 'p') return `<p>${inline(b.text)}</p>`;
    if (b.type === 'ol' || b.type === 'ul') {
      const start = b.type === 'ol' && b.start && b.start !== 1 ? ` start="${b.start}"` : '';
      return `<${b.type}${start}>${b.items.map((i) => `<li>${inline(i)}</li>`).join('')}</${b.type}>`;
    }
    return `<${b.type}>${inline(b.text)}</${b.type}>`;
  }).join('\n');
}

/**
 * HTML for emails: inline styles only (mail clients drop <style>).
 * `size` is the body font size — 13 for the terms, 15 for a message.
 */
/** A bulletproof email button (table-based, so Outlook draws it). */
export function emailButton(text, href, { secondary = false } = {}) {
  const bg = secondary ? '#ffffff' : '#288195';
  const fg = secondary ? '#288195' : '#ffffff';
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:6px 0 18px"><tr><td style="border-radius:8px;background:${bg};border:2px solid #288195">`
    + `<a href="${esc(href)}" target="_blank" rel="noopener" style="display:inline-block;padding:12px 24px;font-family:Arial,Helvetica,sans-serif;font-size:15px;font-weight:bold;color:${fg};text-decoration:none;border-radius:8px">${esc(text)}</a>`
    + '</td></tr></table>';
}

const LONE_LINK = /^\[([^\]]+)\]\(((?:https?:\/\/|mailto:)[^\s)]+)\)$/;

export function termsToEmailHtml(md, { size = 13, buttons = false } = {}) {
  const st = {
    h1: `font-size:${size + 4}px;margin:20px 0 8px;color:#2f2f2f`,
    h2: `font-size:${size + 2}px;margin:18px 0 6px;color:#2f2f2f`,
    h3: `font-size:${size + 1}px;margin:14px 0 4px;color:#2f2f2f`,
    p: `font-size:${size}px;line-height:1.55;margin:0 0 12px;color:#3a3a3a`,
    list: `font-size:${size}px;line-height:1.55;margin:0 0 12px;padding-left:20px;color:#3a3a3a`,
  };
  return parseTerms(md).map((b) => {
    // A link on its own line becomes a button (in messages, not the terms).
    const lone = buttons && b.type === 'p' ? LONE_LINK.exec(b.text.trim()) : null;
    if (lone) return emailButton(lone[1], lone[2]);
    if (b.type === 'p') return `<p style="${st.p}">${inline(b.text)}</p>`;
    if (b.type === 'ol' || b.type === 'ul') return `<${b.type} style="${st.list}">${b.items.map((i) => `<li style="margin:0 0 4px">${inline(i)}</li>`).join('')}</${b.type}>`;
    return `<${b.type} style="${st[b.type]}">${inline(b.text)}</${b.type}>`;
  }).join('\n');
}

/** Plain text (email text part). */
export function termsToText(md) {
  return parseTerms(md).map((b) => {
    const strip = (t) => String(t).replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)').replace(/\*\*?([^*]+)\*\*?/g, '$1');
    if (b.type === 'ol') return b.items.map((i, n) => `${(b.start || 1) + n}. ${strip(i)}`).join('\n');
    if (b.type === 'ul') return b.items.map((i) => `- ${strip(i)}`).join('\n');
    if (b.type === 'h1' || b.type === 'h2') return strip(b.text).toUpperCase();
    return strip(b.text);
  }).join('\n\n');
}

/**
 * Fill {placeholders} in an editable message. Unknown placeholders are left as
 * they are so a typo is visible in the test email rather than silently blank.
 */
export function fillTemplate(tpl, vars) {
  return String(tpl ?? '').replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined && vars[k] !== null ? String(vars[k]) : m));
}

/**
 * Website HTML → this format. Used once, to import the existing terms page.
 * Deliberately simple: headings, paragraphs, list items, bold, links.
 */
export function htmlToTerms(html) {
  let s = String(html ?? '');
  s = s.replace(/<(script|style|noscript|svg|header|footer|nav)[\s\S]*?<\/\1>/gi, '');
  s = s.replace(/<a\s[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_, u, t) => (/^(https?:|mailto:)/i.test(u) ? `[${t.replace(/<[^>]+>/g, '').trim()}](${u})` : t));
  s = s.replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_, __, t) => { const x = t.replace(/<[^>]+>/g, '').trim(); return x ? `**${x}**` : ''; });
  s = s.replace(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi, '\n\n# $1\n\n');
  s = s.replace(/<h2\b[^>]*>([\s\S]*?)<\/h2>/gi, '\n\n## $1\n\n');
  s = s.replace(/<h[3-6]\b[^>]*>([\s\S]*?)<\/h[3-6]>/gi, '\n\n### $1\n\n');
  s = s.replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, '\n- $1');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<\/(p|div|ul|ol|section|article|table|tr)>/gi, '\n\n');
  s = s.replace(/<[^>]+>/g, '');
  s = s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&rsquo;|&lsquo;/g, "'").replace(/&ldquo;|&rdquo;/g, '"')
    .replace(/&ndash;/g, '–').replace(/&mdash;/g, '—').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
  s = s.split('\n').map((l) => l.replace(/[ \t]+/g, ' ').trim()).join('\n');
  s = s.replace(/^(#{1,3}) \*\*(.*)\*\*$/gm, '$1 $2').replace(/^- \s*$/gm, '');
  return s.replace(/\n{3,}/g, '\n\n').trim();
}

// ── editable messages: defaults ────────────────────────────────────────────
// Stored in the published form schema under settings.texts / settings.emails
// (Apply Form → Fee, interview & text). Empty = use these.

export const DEFAULT_FEE_POLICY =
  'Your {fee} application fee is refunded in full if your application isn\'t accepted. Otherwise it is non-refundable. It counts toward your total tuition.';

export const DEFAULT_EMAILS = {
  feeConfirmation: {
    subject: 'Application received — {program}',
    body: [
      'Hi {firstName},',
      '',
      'Thank you for applying to **{program}** ({term}). We\'ve received your application fee of {fee}.',
      '',
      '{interviewButton}',
      '',
      '**What happens next**',
      '',
      '- {interview}',
      '- Our admissions team will review your application.',
      '- If you\'re accepted, we\'ll email you a link to confirm your place and choose how you\'d like to pay.',
      '',
      'Your application fee counts toward your total tuition. It is refunded in full if your application isn\'t accepted; otherwise it is non-refundable.',
      '',
      'Payment: {total} on {date} (reference {reference})',
      '',
      'Pacific Discovery Admissions',
    ].join('\n'),
  },
};

// Application fee not paid: sent 1, 4, 10 and 21 days after the full
// application is in (see netlify/functions/_lib/reminders.mjs). {link} is a
// personal "continue your application" link; {nextStep} says what's left.
const SIGN_OFF = ['', 'Pacific Discovery Admissions'];
DEFAULT_EMAILS.feeReminder1 = {
  subject: 'Your Pacific Discovery application is almost done',
  body: [
    'Hi {firstName},',
    '',
    'Thanks for completing your application for **{program}** ({term}). There\'s one step left: {nextStep}',
    '',
    '[Finish my application]({link})',
    '',
    'Your {fee} application fee counts toward your tuition, and it\'s refunded in full if your application isn\'t accepted.',
    ...SIGN_OFF,
  ].join('\n'),
};
DEFAULT_EMAILS.feeReminder2 = {
  subject: 'Still thinking about {program}?',
  body: [
    'Hi {firstName},',
    '',
    'Your application for **{program}** ({term}) is waiting for you. To finish it: {nextStep}',
    '',
    '[Finish my application]({link})',
    '',
    'Places on each program are limited, and we review applications in the order we receive them.',
    '',
    'If anything is holding you back — dates, cost, or questions about the program — book a call with an admissions advisor below, or reply to this email.',
    '',
    'Pacific Discovery Admissions',
  ].join('\n'),
};
DEFAULT_EMAILS.feeReminder3 = {
  subject: 'Checking in about your application',
  body: [
    'Hi {firstName},',
    '',
    'I wanted to check in personally about your application for **{program}** ({term}). We\'d love to see it through, and it only takes a few minutes to finish: {nextStep}',
    '',
    '[Finish my application]({link})',
    '',
    'If you\'d like to talk anything through first, book a time with one of our admissions advisors using the button below.',
    '',
    'Pacific Discovery Admissions',
  ].join('\n'),
};
DEFAULT_EMAILS.feeReminder4 = {
  subject: 'Should we keep your application open?',
  body: [
    'Hi {firstName},',
    '',
    'We haven\'t received the application fee for your **{program}** ({term}) application yet, so we\'ll close your application on {closeDate} unless we hear from you.',
    '',
    'If you\'d still like to join us, you can finish here:',
    '',
    '[Finish my application]({link})',
    '',
    'If your plans have changed, no problem at all — reply and let us know, and we\'ll stop these reminders.',
    '',
    'Pacific Discovery Admissions',
  ].join('\n'),
};

// Admissions decided not to offer a place (dashboard → Applications → Decline).
DEFAULT_EMAILS.declined = {
  subject: 'Your Pacific Discovery application',
  body: [
    'Hi {firstName},',
    '',
    'Thank you for applying to **{program}** ({term}), and for the time you spent on your application and interview.',
    '',
    'After careful consideration, we\'re not able to offer you a place on this program.',
    '',
    '{message}',
    '',
    '{refund}',
    '',
    'We really appreciate your interest in Pacific Discovery and wish you all the best with your plans.',
    '',
    'Pacific Discovery Admissions',
  ].join('\n'),
};

// Accepted (dashboard → Accept): the personal link to confirm their place.
DEFAULT_EMAILS.accepted = {
  subject: 'Congratulations — you\'re accepted to {program}!',
  body: [
    'Hi {firstName},',
    '',
    'Congratulations! We\'re delighted to offer you a place on **{program}** ({term}), starting {startDate}.',
    '',
    '{message}',
    '',
    'To confirm your place, please complete your payment by **{holdUntil}**. {howToPay}',
    '',
    '[Confirm my place]({link})',
    '',
    'Your application fee and deposit both count toward your total tuition of {tuition}.',
    '',
    'Pacific Discovery Admissions',
  ].join('\n'),
};

// Deposit paid: place confirmed, the payment plan, and the student portal.
DEFAULT_EMAILS.enrolled = {
  subject: 'Your place is confirmed — {program}',
  body: [
    'Hi {firstName},',
    '',
    'Your place on **{program}** ({term}) is confirmed — we\'ve received your payment of {paidToday}. We can\'t wait to have you with us!',
    '',
    '**Your payment plan: {planName}**',
    '',
    '{schedule}',
    '',
    '{scheduleNote}',
    '',
    '**Your student portal**',
    '',
    'Pre-departure information, forms and your payments all live in the student portal. Sign in with {email} — the first time, choose "Forgot password" to set one.',
    '',
    '[Open the student portal]({portalUrl})',
    '',
    'Pacific Discovery Admissions',
  ].join('\n'),
};

/** The placeholders each message understands, for the dashboard help text. */
const REMINDER_PLACEHOLDERS = ['firstName', 'program', 'term', 'fee', 'nextStep', 'link', 'closeDate'];
export const EMAIL_PLACEHOLDERS = {
  feeConfirmation: ['firstName', 'studentName', 'program', 'term', 'fee', 'total', 'date', 'reference', 'interview', 'interviewButton', 'termsUrl'],
  feeReminder1: REMINDER_PLACEHOLDERS,
  feeReminder2: REMINDER_PLACEHOLDERS,
  feeReminder3: REMINDER_PLACEHOLDERS,
  feeReminder4: REMINDER_PLACEHOLDERS,
  declined: ['firstName', 'program', 'term', 'message', 'refund'],
  accepted: ['firstName', 'program', 'term', 'startDate', 'holdUntil', 'howToPay', 'deposit', 'tuition', 'message', 'link'],
  enrolled: ['firstName', 'program', 'term', 'paidToday', 'planName', 'schedule', 'scheduleNote', 'email', 'portalUrl'],
};

/** How long an accepted applicant's place is held for the deposit (days). */
export function holdDays(schema) {
  const n = Number(schema?.settings?.acceptance?.holdDays);
  return Number.isFinite(n) && n >= 1 && n <= 60 ? Math.round(n) : 7;
}

/** Days after the full application is in. Index n → template feeReminder{n+1}. */
export const FEE_REMINDER_DAYS = [1, 4, 10, 21];
/** Days after the full application when an unpaid application is marked closed. */
export const FEE_CLOSE_DAYS = 28;

export function emailTemplate(schema, key) {
  const d = DEFAULT_EMAILS[key] || { subject: '', body: '' };
  const e = schema?.settings?.emails?.[key] || {};
  return {
    enabled: e.enabled !== false,
    subject: String(e.subject || '').trim() || d.subject,
    body: String(e.body || '').trim() || d.body,
  };
}

export function feePolicyText(schema, feeLabel) {
  const t = String(schema?.settings?.texts?.feePolicy || '').trim() || DEFAULT_FEE_POLICY;
  return fillTemplate(t, { fee: feeLabel });
}

// ── "talk to an advisor" block, at the foot of every family email ──────────
export const DEFAULT_ADVISOR_URL = 'https://meetings.hubspot.com/megan-mckelvey';
export const DEFAULT_ADVISOR_TEXT = 'Have questions? Book a time to talk with one of our admissions advisors — or just reply to this email.';

/** { url, text, label } or null when switched off (empty URL in the dashboard). */
export function advisorBlock(schema) {
  const a = schema?.settings?.advisor || {};
  if (a.enabled === false) return null;
  const url = String(a.url || '').trim() || DEFAULT_ADVISOR_URL;
  if (!/^https:\/\//i.test(url)) return null;
  return {
    url,
    text: String(a.text || '').trim() || DEFAULT_ADVISOR_TEXT,
    label: String(a.label || '').trim() || 'Book a call with an advisor',
  };
}

// The interview scheduler (the same HubSpot page as step 3 of the application).
export const DEFAULT_INTERVIEW_URL = 'https://meetings.hubspot.com/eda-admissions/pacific-discovery-interviews';

/** The booking link, prefilled with the student's name and email. */
export function interviewBookingUrl(schema, app) {
  const raw = String(schema?.settings?.meetingUrl || '').trim() || DEFAULT_INTERVIEW_URL;
  let u;
  try { u = new URL(raw); } catch { return DEFAULT_INTERVIEW_URL; }
  if (app?.first_name) u.searchParams.set('firstName', app.first_name);
  if (app?.last_name) u.searchParams.set('lastName', app.last_name);
  if (app?.email) u.searchParams.set('email', app.email);
  return u.toString();
}

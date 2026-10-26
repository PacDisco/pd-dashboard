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
export function termsToEmailHtml(md, { size = 13 } = {}) {
  const st = {
    h1: `font-size:${size + 4}px;margin:20px 0 8px;color:#2f2f2f`,
    h2: `font-size:${size + 2}px;margin:18px 0 6px;color:#2f2f2f`,
    h3: `font-size:${size + 1}px;margin:14px 0 4px;color:#2f2f2f`,
    p: `font-size:${size}px;line-height:1.55;margin:0 0 12px;color:#3a3a3a`,
    list: `font-size:${size}px;line-height:1.55;margin:0 0 12px;padding-left:20px;color:#3a3a3a`,
  };
  return parseTerms(md).map((b) => {
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
      '**What happens next**',
      '',
      '- Our admissions team will review your application.',
      '- {interview}',
      '- If you\'re accepted, we\'ll email you a link to confirm your place and choose how you\'d like to pay.',
      '',
      'Your application fee counts toward your total tuition. It is refunded in full if your application isn\'t accepted; otherwise it is non-refundable.',
      '',
      'Payment: {total} on {date} (reference {reference})',
      '',
      'Questions? Just reply to this email.',
      '',
      'Pacific Discovery Admissions',
    ].join('\n'),
  },
};

/** The placeholders each message understands, for the dashboard help text. */
export const EMAIL_PLACEHOLDERS = {
  feeConfirmation: ['firstName', 'studentName', 'program', 'term', 'fee', 'total', 'date', 'reference', 'interview', 'termsUrl'],
};

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

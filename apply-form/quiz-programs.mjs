// apply-form/quiz-programs.mjs — the programs picked for each quiz result.
//
// Each result (archetype) can carry
//   programs: [{ slug, name, url }]     in display order
// and the editor writes them into the end of the result's html as
//   <div class="quiz-programs"><p><strong>Programs to look at:</strong></p>
//     <ul><li><a href="https://www.pacificdiscovery.org/programs/<slug>">Name</a></li>…</ul></div>
// so pd-apply shows them as links without any change on its side. The
// `programs` array is kept too, so a richer card layout can use it later.
//
// Lives outside quiz-kit.mjs on purpose: quiz-kit is a pinned copy synced from
// pd-apply (scripts/sync-form-kit.mjs) and would be overwritten.

export const PROGRAMS_BASE = 'https://www.pacificdiscovery.org/programs/';
export const DEFAULT_PROGRAMS_HEADING = 'Programs to look at:';
export const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

const escHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const BLOCK_RE = /\s*<div class="quiz-programs">[\s\S]*?<\/ul>\s*<\/div>\s*/gi;
const LEGACY_RE = /\s*<p>\s*<strong>\s*Programs to look at:?\s*<\/strong>([\s\S]*?)<\/p>\s*/i;

export const programUrl = (slug) => PROGRAMS_BASE + slug;

/** The result text the editor shows — html without the generated programs block. */
export function stripProgramsBlock(html) {
  return String(html || '').replace(BLOCK_RE, '').trim();
}

export function programsBlockHtml(programs, heading = DEFAULT_PROGRAMS_HEADING) {
  const list = (programs || []).filter((p) => p && SLUG_RE.test(p.slug || ''));
  if (!list.length) return '';
  const h = String(heading ?? '').trim();
  return `<div class="quiz-programs">${h ? `<p><strong>${escHtml(h)}</strong></p>` : ''}<ul>${list
    .map((p) => `<li><a href="${escHtml(programUrl(p.slug))}" target="_blank" rel="noopener">${escHtml(p.name || p.slug)}</a></li>`)
    .join('')}</ul></div>`;
}

/** body (no block) + the block for `programs`. */
export function composeResultHtml(body, programs, heading) {
  const b = stripProgramsBlock(body);
  const block = programsBlockHtml(programs, heading);
  return [b, block].filter(Boolean).join('');
}

const normName = (s) => String(s || '')
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/&/g, ' and ')
  .replace(/\b(gap|semester|abroad|program|programme)\b/g, ' ')
  .replace(/[^a-z0-9]+/g, ' ').trim();

/** Best catalog entry for a program name typed in old result text, or null. */
export function matchProgram(name, catalog) {
  const n = normName(name);
  if (!n) return null;
  const hits = (catalog || []).filter((p) => normName(p.name) === n || normName(p.slug.replace(/-/g, ' ')) === n);
  return hits.length === 1 ? hits[0] : hits.find((p) => p.status === 'live') || hits[0] || null;
}

/**
 * Old results name programs in a "<p><strong>Programs to look at:</strong> A, B, C.</p>"
 * paragraph. Returns { found: bool, html (paragraph removed), matched: [catalog entries], unmatched: [names] }.
 */
export function convertLegacyPrograms(html, catalog) {
  const src = String(html || '');
  const m = src.match(LEGACY_RE);
  if (!m) return { found: false, html: src, matched: [], unmatched: [] };
  const names = m[1].replace(/<[^>]+>/g, '').split(/,|;|\n/).map((s) => s.replace(/&amp;/g, '&').trim().replace(/\.$/, '').trim()).filter(Boolean);
  const matched = []; const unmatched = [];
  for (const nm of names) {
    const p = matchProgram(nm, catalog);
    if (p) { if (!matched.some((x) => x.slug === p.slug)) matched.push(p); } else unmatched.push(nm);
  }
  return { found: true, html: src.replace(LEGACY_RE, ' ').trim(), matched, unmatched };
}

export const hasLegacyPrograms = (html) => LEGACY_RE.test(String(html || ''));

/** Editor warnings about picked programs (never blocks publishing). */
export function lintResultPrograms(archetypes, catalog) {
  const out = [];
  if (!catalog) return out;
  const bySlug = new Map(catalog.map((p) => [p.slug, p]));
  for (const a of archetypes || []) {
    for (const p of a.programs || []) {
      const c = bySlug.get(p.slug);
      if (!c) out.push({ level: 'warn', message: `"${a.name}": the program "${p.name}" no longer has a program page — remove it or pick another.` });
      else if (c.status !== 'live' && c.status !== 'changes') out.push({ level: 'warn', message: `"${a.name}": "${c.name}" isn't published in Program Pages yet, so its link may not work.` });
    }
  }
  return out;
}

/** Server-side shape check for archetype.programs. Returns an error string or null. */
export function checkResultPrograms(archetypes) {
  for (const a of archetypes || []) {
    if (a.programs == null) continue;
    if (!Array.isArray(a.programs) || a.programs.length > 30) return `"${a.name}": the programs list is malformed.`;
    for (const p of a.programs) {
      if (!p || typeof p !== 'object' || !SLUG_RE.test(p.slug || '') || typeof p.name !== 'string' || p.name.length > 200) return `"${a.name}": a picked program is malformed.`;
      if (p.url != null && p.url !== programUrl(p.slug)) return `"${a.name}": program links must go to ${PROGRAMS_BASE}…`;
    }
  }
  return null;
}

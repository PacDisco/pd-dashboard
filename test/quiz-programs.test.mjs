// node test/quiz-programs.test.mjs — program picks on quiz results (pure).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { composeResultHtml, stripProgramsBlock, convertLegacyPrograms, matchProgram, checkResultPrograms, lintResultPrograms, programUrl } from '../apply-form/quiz-programs.mjs';
import { checkQuiz } from '../netlify/functions/apply-forms.mjs';
import { lintQuiz } from '../apply-form/quiz-kit.mjs';

const catalog = JSON.parse(readFileSync(new URL('../program-pages/starters/index.json', import.meta.url))).map((p) => ({ ...p, status: 'live', url: programUrl(p.slug) }));
const seed = JSON.parse(readFileSync(new URL('../apply-form/quiz-seed.json', import.meta.url)));
let n = 0; const t = (name, fn) => { fn(); n++; console.log('  ✓', name); };

t('compose / strip round-trips and escapes', () => {
  const progs = [{ slug: 'japan-mini-semester', name: 'Japan <Mini>' }, { slug: 'hawaii-mini-semester', name: 'Hawaii' }];
  const html = composeResultHtml('<p>Hi</p>', progs, 'Look:');
  assert.match(html, /^<p>Hi<\/p><div class="quiz-programs"><p><strong>Look:<\/strong><\/p><ul><li><a href="https:\/\/www\.pacificdiscovery\.org\/programs\/japan-mini-semester"/);
  assert.match(html, /Japan &lt;Mini&gt;/);
  assert.equal(stripProgramsBlock(html), '<p>Hi</p>');
  assert.equal(composeResultHtml(html, [progs[1]]).match(/quiz-programs/g).length, 1, 'block replaced, not duplicated');
  assert.equal(composeResultHtml(html, []), '<p>Hi</p>');
  assert.doesNotMatch(composeResultHtml('x', progs, ''), /<strong>/);
});
t('matches the names used in the seed', () => {
  for (const [name, slug] of [['South America Gap Semester', 'south-america-gap-semester'], ['Australia and Bali Gap Semester', 'australia-bali-gap-semester'],
    ['Marine Conservation and Reef Monitoring Field Program', 'marine-conservation-summer-program'], ['Japan Mini Semester', 'japan-mini-semester'],
    ['Costa Rica Mini Semester', 'costa-rica-mini-semester'], ['New Zealand and Australia Gap Semester', 'new-zealand-australia-gap-semester']]) assert.equal(matchProgram(name, catalog)?.slug, slug, name);
  assert.equal(matchProgram('Nepal and Tibet Gap Semester', catalog), null);
});
t('converts every seed result; reports unmatched names', () => {
  const missed = [];
  for (const a of seed.archetypes) {
    const r = convertLegacyPrograms(a.html, catalog);
    assert.ok(r.found, a.name); assert.doesNotMatch(r.html, /Programs to look at/);
    assert.ok(r.matched.length >= 2, a.name); missed.push(...r.unmatched);
  }
  assert.deepEqual([...new Set(missed)], ['Nepal and Tibet Gap Semester']);
});
t('server rejects bad program picks; quiz still lints clean', () => {
  const q = structuredClone(seed);
  q.archetypes[0].programs = [{ slug: 'japan-mini-semester', name: 'Japan', url: programUrl('japan-mini-semester') }];
  q.archetypes[0].html = composeResultHtml(q.archetypes[0].html, q.archetypes[0].programs);
  assert.equal(checkQuiz(q), null);
  assert.equal(lintQuiz(q).filter((l) => l.level === 'error').length, 0);
  q.archetypes[0].programs[0].url = 'https://evil.example/';
  assert.match(checkQuiz(q), /program links/);
  q.archetypes[0].programs[0] = { slug: 'Bad Slug', name: 'x' };
  assert.match(checkResultPrograms(q.archetypes), /malformed/);
});
t('editor warnings for unpublished / removed pages', () => {
  const arch = [{ name: 'A', programs: [{ slug: 'japan-mini-semester', name: 'J' }, { slug: 'gone-page', name: 'G' }] }];
  const cat = [{ slug: 'japan-mini-semester', name: 'Japan', status: 'draft' }];
  const w = lintResultPrograms(arch, cat).map((x) => x.message).join('\n');
  assert.match(w, /isn't published/); assert.match(w, /no longer has a program page/);
  assert.deepEqual(lintResultPrograms(arch, null), []);
});
console.log(`${n} passed`);

// quiz-kit.mjs — the gap-year quiz: scoring, results, HubSpot mapping, lint.
// Shared by the quiz page, the quiz API and the dashboard editor (pinned copy
// in pd-dashboard/apply-form/). Pure functions only.
//
// A quiz is a form-kit schema with two steps — "quiz" (one question per
// section, shown one at a time) and "contact" — plus:
//
//   archetypes: [{ key, name, headline, html, ctaLabel, ctaUrl, hubspotValue }]
//                 list order = tie-break order
//   field.scores: { "<option text>": ["adventurer", "seeker"] }
//                 picking that option gives each listed archetype one point.
//                 For a checkbox question an archetype scores at most once,
//                 however many of its options are ticked (as on Jotform).
//   settings: introTitle, introBody, startLabel, submitLabel, hubspotFormGuid,
//             leadStatus, archetypeProperty, answersProperty, secondaryCta…

import { allFields, stepFields, valueText, isEmptyValue, lintSchema as lintForm } from './form-kit.mjs';

export const QUIZ_FORM_ID = 'pd-quiz';

const norm = (s) => String(s ?? '').trim().toLowerCase();

/** { scores: { key: n }, archetype: key, ranked: [{ key, score }] } */
export function scoreQuiz(schema, values) {
  const arch = schema?.archetypes || [];
  const scores = Object.fromEntries(arch.map((a) => [a.key, 0]));
  for (const field of stepFields(schema, 'quiz')) {
    const map = field.scores;
    if (!map) continue;
    const lookup = new Map(Object.entries(map).map(([k, v]) => [norm(k), v]));
    const v = values?.[field.key];
    const picked = Array.isArray(v) ? v : v == null || v === '' ? [] : [v];
    const got = new Set();
    for (const p of picked) for (const k of lookup.get(norm(p)) || []) got.add(k);
    for (const k of got) if (k in scores) scores[k] += 1;
  }
  const ranked = arch.map((a, i) => ({ key: a.key, score: scores[a.key], i })).sort((a, b) => b.score - a.score || a.i - b.i);
  return { scores, archetype: ranked[0]?.key || null, ranked: ranked.map(({ key, score }) => ({ key, score })) };
}

export function archetypeByKey(schema, key) {
  return (schema?.archetypes || []).find((a) => a.key === key) || null;
}

/** "Question: answer" lines, for the HubSpot answers property and emails. */
export function answersText(schema, values) {
  const lines = [];
  for (const field of stepFields(schema, 'quiz')) {
    const v = values?.[field.key];
    if (isEmptyValue(field, v)) continue;
    lines.push(`${field.label}: ${valueText(field, v)}`);
  }
  return lines.join('\n');
}

/** Contact properties from the quiz (answers mapped in the editor + result). */
export function quizContactProps(schema, values, archetypeKey, { date } = {}) {
  const props = {};
  for (const { field } of allFields(schema)) {
    const map = field.hubspot?.contact;
    const v = values?.[field.key];
    if (!map || v == null || v === '') continue;
    if (typeof map === 'object' && field.type === 'fullname') {
      if (map.first) props[map.first] = v.first || '';
      if (map.last) props[map.last] = v.last || '';
    } else if (typeof map === 'string') {
      props[map] = field.type === 'checkbox' && Array.isArray(v) ? v.join(';') : valueText(field, v);
    }
  }
  const st = schema?.settings || {};
  const a = archetypeByKey(schema, archetypeKey);
  if (a && st.archetypeProperty !== '') props[st.archetypeProperty || 'pd_quiz_archetype'] = a.hubspotValue || a.name;
  if (st.answersProperty !== '') props[st.answersProperty || 'pd_quiz_answers'] = answersText(schema, values).slice(0, 65000);
  props.pd_quiz_date = date || new Date().toISOString().slice(0, 10);
  if (st.leadStatus) props.hs_lead_status = st.leadStatus;
  return props;
}

/** What the browser needs (no integration details). */
export function publicQuiz(schema) {
  const steps = (schema.steps || []).map((st) => ({
    ...st,
    sections: (st.sections || []).map((sec) => ({ ...sec, fields: (sec.fields || []).map(({ hubspot, jfQid, ...f }) => f) })),
  }));
  const { hubspotFormGuid, leadStatus, archetypeProperty, answersProperty, jotformFormId, ...settings } = schema.settings || {};
  return { kind: 'quiz', title: schema.title, settings, archetypes: schema.archetypes || [], steps, programs: [], terms: [], lists: schema.lists || {} };
}

const SAFE_URL = /^(\/|https:\/\/)/i;

export function lintQuiz(schema) {
  const out = [];
  const err = (message) => out.push({ level: 'error', message });
  const warn = (message) => out.push({ level: 'warn', message });
  if (!schema || schema.kind !== 'quiz') { err('This is not a quiz.'); return out; }
  const arch = schema.archetypes || [];
  if (arch.length < 2) err('Add at least two results.');
  const keys = new Set();
  for (const a of arch) {
    if (!a.key || !/^[a-z0-9_-]+$/i.test(a.key)) err(`Result "${a.name || '?'}" needs a short key (letters, numbers, - or _).`);
    if (keys.has(a.key)) err(`Two results share the key "${a.key}".`);
    keys.add(a.key);
    if (!a.name) err('Every result needs a name.');
    if (!String(a.html || '').trim()) warn(`"${a.name || a.key}" has no result text.`);
    if (a.ctaUrl && !SAFE_URL.test(a.ctaUrl)) err(`"${a.name}": the button link must start with / or https://`);
    if (/<\s*script|javascript:/i.test(String(a.html || ''))) err(`"${a.name}" contains a script — remove it.`);
  }
  const quiz = stepFields(schema, 'quiz');
  if (!quiz.length) err('Add at least one question.');
  const reach = Object.fromEntries([...keys].map((k) => [k, 0]));
  for (const f of quiz) {
    if (!['radio', 'select', 'checkbox'].includes(f.type) && f.scores) warn(`"${f.label}" is scored but isn't a choice question.`);
    for (const [opt, ks] of Object.entries(f.scores || {})) {
      if (!(f.options || []).map(norm).includes(norm(opt))) warn(`"${f.label}": scoring refers to "${opt}", which is no longer an option.`);
      for (const k of ks) { if (!keys.has(k)) err(`"${f.label}": scoring refers to a result that doesn't exist ("${k}").`); else reach[k] += 1; }
    }
  }
  for (const [k, n] of Object.entries(reach)) if (!n) warn(`No answer scores for "${archetypeByKey(schema, k)?.name || k}" — nobody can get that result.`);
  const contact = stepFields(schema, 'contact');
  if (!contact.find((f) => f.key === 'email' && f.type === 'email')) err('The details page needs an email field with the key "email".');
  for (const l of lintForm({ ...schema, programs: [], terms: [] })) {
    if (/program|travel date|term/i.test(l.message)) continue; // application-only checks
    out.push(l);
  }
  return out;
}

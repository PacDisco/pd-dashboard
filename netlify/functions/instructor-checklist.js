/**
 * Instructor onboarding checklist — read API for the INSTRUCTOR PORTAL.
 *
 * The portal (a separate Netlify site) used to answer "what documents does this
 * instructor still owe?" from a HubSpot contact property that nothing ever
 * wrote. It now asks this endpoint, and Postgres — the same tables the admin
 * Instructors dashboard manages — is the source of truth.
 *
 *   GET /api/instructor-checklist?email=someone@example.com
 *   Header: X-PD-Service-Key: <INSTRUCTOR_PORTAL_KEY>
 *
 * Response:
 *   {
 *     found:    true|false,        // is there an instructor profile?
 *     email:    "<resolved primary email>",
 *     instructor: { id, full_name, status } | null,
 *     items: [ { item, label, kind, completed, completed_at, source } ],
 *     complete: <int>, total: <int>,
 *     refreshed: true|false,       // did we top up from Jotform on this call?
 *     warning: "<string>"          // only when a source degraded
 *   }
 *
 * `found: false` still returns the full item list, all incomplete — an
 * instructor who has done nothing yet should see what they owe, not an error.
 *
 * ------------------------------------------------------------------------
 * WHY IT TOPS UP FROM JOTFORM
 * ------------------------------------------------------------------------
 * The admin dashboard only refreshes when someone clicks "Sync from Jotform".
 * If the portal read the DB alone, an instructor who had just submitted a form
 * would keep seeing a red box until an admin happened to sync — worse than the
 * behaviour this replaces. So this endpoint re-derives from Jotform for the ONE
 * requested email, writes anything new into instructor_onboarding, and returns
 * the merged state. The dashboard therefore also stays current as a side effect
 * of instructors using their portal.
 *
 * Cost is bounded: 9 Jotform reads for a single email, cached per-email for
 * CHECKLIST_CACHE_MS. Pass ?fresh=0 to skip the top-up and read the DB only.
 *
 * ------------------------------------------------------------------------
 * AUTH
 * ------------------------------------------------------------------------
 * Service-to-service shared secret in X-PD-Service-Key, compared in constant
 * time. This endpoint is NOT behind the dashboard's Netlify Identity gate
 * (the portal has no Identity session), so the key is the only thing guarding
 * it — keep it long and random, and set it on BOTH sites.
 *
 * Env vars:
 *   NETLIFY_DATABASE_URL    (Neon; auto-injected by Netlify DB)
 *   JOTFORM_API_KEY
 *   INSTRUCTOR_PORTAL_KEY   shared secret; must match the portal's
 *   CHECKLIST_CACHE_MS      optional, default 60000; 0 disables caching
 */

'use strict';

const crypto = require('crypto');
const https = require('https');
const { neon } = require('@neondatabase/serverless');
const CHECKLIST = require('./_shared/instructor-checklist.js');

let _sql;
function sql() {
  if (!_sql) _sql = neon(process.env.NETLIFY_DATABASE_URL);
  return _sql;
}

const JSON_HEADERS = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
function ok(body)             { return { statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify(body) }; }
function bad(msg, code = 400) { return { statusCode: code, headers: JSON_HEADERS, body: JSON.stringify({ error: msg }) }; }

const CACHE_MS = (() => {
  const raw = process.env.CHECKLIST_CACHE_MS;
  if (raw == null || String(raw).trim() === '') return 60000;
  const n = Number(raw);
  // Number("60s") is NaN and `elapsed < NaN` is always false, which would
  // disable the cache silently rather than loudly.
  if (!Number.isFinite(n) || n < 0) {
    console.warn(`[instructor-checklist] bad CHECKLIST_CACHE_MS "${raw}", using 60000`);
    return 60000;
  }
  return n;
})();

// email -> { ts, items:string[] } derived from Jotform. Warm-container scoped.
const _deriveCache = new Map();

function timingSafeEqual(a, b) {
  const ba = Buffer.from(String(a || ''), 'utf8');
  const bb = Buffer.from(String(b || ''), 'utf8');
  if (ba.length !== bb.length || ba.length === 0) return false;
  return crypto.timingSafeEqual(ba, bb);
}

// --------------------------------------------------------------------------
// Jotform
// --------------------------------------------------------------------------
function jotformGet(path) {
  const apiKey = process.env.JOTFORM_API_KEY;
  if (!apiKey) return Promise.reject(new Error('JOTFORM_API_KEY not set'));
  const sep = path.includes('?') ? '&' : '?';
  const full = `${path}${sep}apiKey=${encodeURIComponent(apiKey)}`;
  return new Promise((resolve, reject) => {
    const req = https.get(
      { host: 'api.jotform.com', path: full, headers: { 'User-Agent': 'pd-dashboard', Accept: 'application/json' } },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            return reject(new Error(`Jotform HTTP ${res.statusCode}`));
          }
          try { resolve(JSON.parse(data)); }
          catch (e) { reject(new Error('Jotform parse error: ' + e.message)); }
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(8000, () => req.destroy(new Error('Jotform timeout')));
  });
}

async function activeSubmissions(formId) {
  const res = await jotformGet(`/form/${formId}/submissions?limit=1000`);
  const list = (res && Array.isArray(res.content)) ? res.content : [];
  // Jotform keeps deleted submissions addressable with status DELETED.
  return list.filter((s) => String((s && s.status) || 'ACTIVE').toUpperCase() === 'ACTIVE');
}

/**
 * Which checklist items do this person's Jotform submissions satisfy?
 * Fault-tolerant: one form failing is recorded and the rest still count, so a
 * partial Jotform outage can only ever under-report.
 */
async function deriveFromJotform(emails) {
  const want = new Set(emails.map((e) => String(e || '').toLowerCase().trim()).filter(Boolean));
  const items = new Set();
  const errors = [];
  if (!want.size) return { items: [], errors: ['no email'] };

  const mine = (sub) => {
    const e = CHECKLIST.submitterEmail(sub);
    return !!e && want.has(e);
  };

  const formTasks = Array.from(CHECKLIST.FORM_ITEM.entries()).map(async ([formId, item]) => {
    try {
      const subs = await activeSubmissions(formId);
      if (subs.some(mine)) items.add(item);
    } catch (e) { errors.push(`form ${formId}: ${e.message || e}`); }
  });

  const uploadTasks = CHECKLIST.UPLOAD_FORM_IDS.map(async (formId) => {
    try {
      const subs = await activeSubmissions(formId);
      for (const sub of subs) {
        if (!mine(sub)) continue;
        CHECKLIST.classifyUploadSubmission(sub).items.forEach((i) => items.add(i));
      }
    } catch (e) { errors.push(`upload form ${formId}: ${e.message || e}`); }
  });

  await Promise.all([...formTasks, ...uploadTasks]);
  return { items: Array.from(items), errors };
}

async function cachedDerive(emails) {
  const key = emails.slice().sort().join('|');
  if (CACHE_MS > 0) {
    const hit = _deriveCache.get(key);
    if (hit && Date.now() - hit.ts < CACHE_MS) return hit.value;
  }
  const value = await deriveFromJotform(emails);
  // Never cache a partial failure — retry it on the next load.
  if (CACHE_MS > 0 && !value.errors.length) {
    const now = Date.now();
    for (const [k, v] of _deriveCache) if (now - v.ts >= CACHE_MS) _deriveCache.delete(k);
    _deriveCache.set(key, { value, ts: now });
  }
  return value;
}

// --------------------------------------------------------------------------
// Handler
// --------------------------------------------------------------------------
exports.handler = async (event) => {
  try {
    if (event.httpMethod !== 'GET') return bad('GET only', 405);

    // Fail closed on a missing OR trivially weak key. "   " is truthy, and a
    // short key is brute-forceable — this endpoint returns personal data and
    // the key is the only thing in front of it.
    const expected = String(process.env.INSTRUCTOR_PORTAL_KEY || '').trim();
    if (expected.length < 24) {
      console.error('[instructor-checklist] INSTRUCTOR_PORTAL_KEY missing or too short ' +
                    '(need >= 24 chars; generate with `openssl rand -hex 32`)');
      return bad('service key not configured', 500);
    }
    const headers = event.headers || {};
    const supplied = String(headers['x-pd-service-key'] || headers['X-PD-Service-Key'] || '').trim();
    if (!timingSafeEqual(supplied, expected)) return bad('unauthorized', 401);

    const qs = event.queryStringParameters || {};
    const email = String(qs.email || '').trim().toLowerCase();
    if (!email || !/.+@.+\..+/.test(email)) return bad('a valid ?email= is required');
    const wantFresh = String(qs.fresh || '1') !== '0';

    // 1. Resolve the profile. alt_emails means an instructor who files Jotform
    //    from a second address still resolves to one profile.
    const rows = await sql()`
      SELECT id, email, full_name, status, alt_emails
      FROM instructors
      WHERE email = ${email} OR ${email} = ANY (alt_emails)
      LIMIT 1`;
    const instructor = rows[0] || null;
    const emails = instructor
      ? Array.from(new Set([instructor.email, ...(instructor.alt_emails || []), email].filter(Boolean)))
      : [email];

    // 2. Read stored state FIRST, so step 3 can write only what actually
    //    changed. Reversing these two would rewrite all 14 rows on every page
    //    refresh — a fully-onboarded instructor idly reloading the tab would
    //    be a pure write generator against Neon.
    let stored = [];
    if (instructor) {
      stored = await sql()`
        SELECT item, label, completed, completed_at, source
        FROM instructor_onboarding WHERE instructor_id = ${instructor.id}`;
    }
    const storedByItem = new Map(stored.map((r) => [r.item, r]));

    // 3. Top up from Jotform so a form submitted a minute ago already shows.
    let derived = { items: [], errors: [] };
    let refreshed = false;
    if (wantFresh) {
      try {
        derived = await cachedDerive(emails);
        refreshed = true;
      } catch (e) {
        derived = { items: [], errors: [e.message || String(e)] };
      }
      if (derived.errors.length) {
        console.warn('[instructor-checklist] derive degraded:', derived.errors.join('; '));
      }
      // Persist only genuinely NEW evidence, so the admin dashboard reflects
      // what the portal just learned. A manual pin is never overridden, and an
      // item already stored as complete is skipped entirely.
      if (instructor) {
        const toWrite = derived.items.filter((item) => {
          if (!CHECKLIST.BY_ITEM.has(item)) return false;
          const row = storedByItem.get(item);
          if (!row) return true;                        // never recorded
          if (row.source === 'manual') return false;    // pinned
          return !row.completed;                        // already done -> skip
        });
        for (const item of toWrite) {
          const meta = CHECKLIST.BY_ITEM.get(item);
          try {
            // The WHERE mirrors instructors.js markOnboarding: pins hold, and
            // an unchanged row is not rewritten even under a race.
            await sql()`
              INSERT INTO instructor_onboarding (instructor_id, item, label, completed, completed_at, source)
              VALUES (${instructor.id}, ${item}, ${meta.label}, TRUE, NOW(), 'jotform')
              ON CONFLICT (instructor_id, item) DO UPDATE
                SET completed    = TRUE,
                    completed_at = COALESCE(instructor_onboarding.completed_at, NOW()),
                    label        = EXCLUDED.label
                WHERE instructor_onboarding.source <> 'manual'
                  AND (instructor_onboarding.completed IS DISTINCT FROM TRUE
                       OR instructor_onboarding.label  IS DISTINCT FROM EXCLUDED.label)`;
          } catch (e) {
            console.warn(`[instructor-checklist] upsert ${item} failed:`, e.message || e);
          }
        }
      }
    }

    // 4. Merge stored state with this call's fresh evidence.
    const derivedSet = new Set(derived.items);

    const items = CHECKLIST.CHECKLIST_ITEMS.map((c) => {
      const row = storedByItem.get(c.item);
      // A manual pin wins outright — that's the point of pinning. Otherwise the
      // stored value and this call's fresh evidence are OR-ed, so a Jotform
      // hiccup can never un-tick something already earned.
      const completed = row && row.source === 'manual'
        ? !!row.completed
        : (!!(row && row.completed) || derivedSet.has(c.item));
      return {
        item: c.item,
        label: c.label,
        kind: c.kind,
        completed,
        completed_at: row ? row.completed_at : null,
        source: row ? row.source : (derivedSet.has(c.item) ? 'jotform' : null),
      };
    });

    const body = {
      found: !!instructor,
      email: instructor ? instructor.email : email,
      instructor: instructor
        ? { id: instructor.id, full_name: instructor.full_name, status: instructor.status }
        : null,
      items,
      complete: items.filter((i) => i.completed).length,
      total: items.length,
      refreshed,
    };
    if (derived.errors.length) body.warning = derived.errors.join('; ');
    return ok(body);

  } catch (err) {
    console.error('[instructor-checklist] error:', err);
    return bad(err.message || 'server error', 500);
  }
};

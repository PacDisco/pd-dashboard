// netlify/functions/_shared/tile-badges.mjs
//
// "New since you last opened it" counts for the landing-page tiles.
// See TILE-BADGES.md.
//
// HOW IT COUNTS
// -------------
// Every badged dashboard has a source (tile-badge-sources.mjs) that returns a
// SNAPSHOT of what's there right now, in one of two shapes:
//
//   { kind: "times",   keys: [newest … oldest] }  one sortable key per recent
//                                                 submission (epoch ms, or a
//                                                 Jotform "YYYY-MM-DD HH:MM:SS")
//   { kind: "counter", value: 42 }                 a running total that only
//                                                 goes up (popup sign-ups, …)
//
// When someone opens a dashboard we store a CURSOR for them: the newest key
// (or the counter value) at that moment. "New" is then simply everything past
// their cursor. The cursor is taken from the source itself, never from the
// wall clock, so Jotform's account-timezone timestamps compare correctly
// without us knowing what that timezone is.
//
// Someone who has never opened a dashboard gets a cursor at the current
// position the first time the badges load (count 0) — otherwise the day this
// ships every tile would show "99+".
//
// STORAGE (Netlify Blobs, store "tile-badges")
//   seen/<email>      { [slug]: { c: cursor, at: ISO } }   per person
//   counter/<slug>    { value, at }                        for counter sources
//                                                          bumped by bumpBadgeCounter

import { getStore } from "@netlify/blobs";

export const STORE = "tile-badges";
export const MAX_KEYS = 100;          // a times snapshot holds at most this many
export const LOOKBACK_DAYS = 45;      // …from at most this far back

// ── pure ────────────────────────────────────────────────────────────────────

/** The cursor that means "seen everything in this snapshot". */
export function latestCursor(snap) {
  if (!snap) return undefined;
  if (snap.kind === "counter") return Number(snap.value) || 0;
  if (snap.kind === "times") {
    const keys = snap.keys || [];
    if (!keys.length) return null;    // nothing recent: anything that arrives is new
    return keys.reduce((a, b) => (b > a ? b : a));
  }
  return undefined;
}

/**
 * How many items in `snap` are newer than `cursor`.
 * `cursor` undefined = no record for this person (caller baselines instead).
 * Returns { count, capped } — capped means "at least count" (show "99+").
 */
export function countNew(snap, cursor) {
  if (!snap || cursor === undefined) return { count: 0, capped: false };

  if (snap.kind === "counter") {
    const v = Number(snap.value) || 0;
    const c = Number(cursor);
    if (!Number.isFinite(c)) return { count: 0, capped: false };
    return { count: Math.max(0, v - c), capped: false };
  }

  if (snap.kind === "times") {
    const keys = snap.keys || [];
    // A cursor of a different type than the keys means the source changed
    // shape (e.g. moved from Jotform to Neon) — treat as nothing new rather
    // than comparing a string to a number.
    if (cursor !== null && keys.length && typeof cursor !== typeof keys[0]) {
      return { count: 0, capped: false };
    }
    const n = cursor === null ? keys.length : keys.filter((k) => k > cursor).length;
    return { count: n, capped: n >= (snap.limit || MAX_KEYS) };
  }

  return { count: 0, capped: false };
}

/** Bubble text: "1" … "99", then "99+". */
export function badgeLabel({ count, capped } = {}) {
  if (!count) return "";
  return capped || count > 99 ? "99+" : String(count);
}

/** Jotform-style timestamp for a filter: "YYYY-MM-DD HH:MM:SS" (UTC). */
export function jotformStamp(ms) {
  return new Date(ms).toISOString().slice(0, 19).replace("T", " ");
}

export function emailKey(email) {
  return String(email || "").trim().toLowerCase();
}

// ── storage ─────────────────────────────────────────────────────────────────

let _storeOverride = null;
export function _setStoreForTests(s) { _storeOverride = s; }

export function badgeStore() {
  if (_storeOverride) return _storeOverride;
  try {
    return getStore({ name: STORE, consistency: "strong" });
  } catch (err) {
    const siteID = process.env.NETLIFY_SITE_ID || process.env.SITE_ID;
    const token = process.env.NETLIFY_BLOBS_TOKEN || process.env.NETLIFY_API_TOKEN;
    if (siteID && token) return getStore({ name: STORE, consistency: "strong", siteID, token });
    throw err;
  }
}

export async function readSeen(email, store = badgeStore()) {
  const key = emailKey(email);
  if (!key) return {};
  return (await store.get(`seen/${key}`, { type: "json" }).catch(() => null)) || {};
}

export async function writeSeen(email, seen, store = badgeStore()) {
  const key = emailKey(email);
  if (!key) return;
  await store.setJSON(`seen/${key}`, seen);
}

export async function readCounter(slug, store = badgeStore()) {
  const doc = await store.get(`counter/${slug}`, { type: "json" }).catch(() => null);
  return Number(doc?.value) || 0;
}

/**
 * +1 on a counter source. Call this from wherever a submission lands that has
 * no queryable timestamp of its own (e.g. a calendar booking). Never throws —
 * a badge is a convenience and must not break the thing being counted.
 */
export async function bumpBadgeCounter(slug, by = 1, store) {
  try {
    const s = store || badgeStore();
    const value = (await readCounter(slug, s)) + by;
    await s.setJSON(`counter/${slug}`, { value, at: new Date().toISOString() });
    return value;
  } catch (e) {
    console.warn(`[tile-badges] counter bump for ${slug} failed: ${e.message}`);
    return null;
  }
}

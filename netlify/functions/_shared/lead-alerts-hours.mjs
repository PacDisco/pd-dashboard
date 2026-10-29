// netlify/functions/_shared/lead-alerts-hours.mjs
//
// "When am I available?" for Lead Alerts. Pure — no I/O — so it's easy to test.
//
// A schedule is either null (= always available, 24/7 — the default) or
//
//   { days: [ [ {s:"08:00", e:"18:00"} ], …7 entries, Sunday first… ] }
//
// in the person's own time zone (an IANA name like "America/Denver"). An empty
// day means "not available that day". A block whose end is earlier than its
// start runs past midnight into the next day (e.g. 20:00 → 02:00), and "24:00"
// means end of day, so 00:00–24:00 is a whole day.

const HM = /^([01]\d|2[0-4]):([0-5]\d)$/;
export const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const toMin = (hm) => { const m = HM.exec(hm); return m ? Math.min(24 * 60, Number(m[1]) * 60 + Number(m[2])) : null; };

export function validTz(tz) {
  if (typeof tz !== "string" || !tz || tz.length > 64) return false;
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch { return false; }
}

/**
 * Clean whatever came off the wire. Returns null for "24/7", a schedule
 * object, or throws with a message fit to show the user.
 */
export function normalizeSchedule(raw) {
  if (raw == null || raw === "24/7" || raw.always === true) return null;
  const days = Array.isArray(raw.days) ? raw.days : null;
  if (!days || days.length !== 7) throw new Error("A schedule needs all seven days.");
  const out = days.map((blocks, d) => {
    const list = Array.isArray(blocks) ? blocks : [];
    if (list.length > 4) throw new Error(`${DAY_NAMES[d]}: at most 4 blocks.`);
    return list.map((b) => {
      const s = toMin(b?.s), e = toMin(b?.e);
      if (s == null || e == null) throw new Error(`${DAY_NAMES[d]}: times must be HH:MM.`);
      if (s === e) throw new Error(`${DAY_NAMES[d]}: start and end are the same.`);
      if (s >= 24 * 60) throw new Error(`${DAY_NAMES[d]}: a block can't start at 24:00.`);
      return { s: b.s, e: b.e };
    });
  });
  // Every day open all day is just 24/7.
  if (out.every((bl) => bl.some((b) => toMin(b.s) === 0 && toMin(b.e) === 24 * 60))) return null;
  return { days: out };
}

const _fmt = new Map();
function partsIn(tz, ms) {
  if (!_fmt.has(tz)) {
    _fmt.set(tz, new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hourCycle: "h23", weekday: "short", hour: "2-digit", minute: "2-digit",
    }));
  }
  const p = {};
  for (const x of _fmt.get(tz).formatToParts(new Date(ms))) p[x.type] = x.value;
  return { dow: DAY_NAMES.indexOf(p.weekday), min: (Number(p.hour) % 24) * 60 + Number(p.minute) };
}

/** Is someone with this schedule available at `ms`? */
export function isAvailable(schedule, tz, ms = Date.now()) {
  if (!schedule) return true;
  const zone = validTz(tz) ? tz : "UTC";
  const { dow, min } = partsIn(zone, ms);
  const today = schedule.days[dow] || [];
  const yesterday = schedule.days[(dow + 6) % 7] || [];
  for (const b of today) {
    const s = toMin(b.s), e = toMin(b.e);
    if (e > s ? (min >= s && min < e) : min >= s) return true;          // same-day, or the first half of an overnight block
  }
  for (const b of yesterday) {
    const s = toMin(b.s), e = toMin(b.e);
    if (e < s && min < e) return true;                                    // the after-midnight half of yesterday's block
  }
  return false;
}

/**
 * The first moment at or after `fromMs` that the person is available.
 * Returns fromMs when available now, null when the schedule has no hours at all.
 * Steps 15 minutes at a time then backs up to the exact minute.
 */
export function nextAvailableAt(schedule, tz, fromMs = Date.now()) {
  if (!schedule) return fromMs;
  if (!schedule.days.some((d) => d.length)) return null;
  if (isAvailable(schedule, tz, fromMs)) return fromMs;
  const STEP = 15 * 60_000;
  let t = Math.floor(fromMs / 60_000) * 60_000;
  for (let i = 0; i < 8 * 24 * 4; i++) {
    t += STEP;
    if (isAvailable(schedule, tz, t)) {
      let lo = t - STEP;
      while (lo + 60_000 < t && !isAvailable(schedule, tz, lo + 60_000)) lo += 60_000;
      return Math.max(fromMs, lo + 60_000);
    }
  }
  return null;
}

/** The next moment availability flips (for "alerts pause at 6:00 PM"). */
export function nextChangeAt(schedule, tz, fromMs = Date.now()) {
  if (!schedule) return null;
  const now = isAvailable(schedule, tz, fromMs);
  if (!now) return nextAvailableAt(schedule, tz, fromMs);
  const STEP = 15 * 60_000;
  let t = Math.floor(fromMs / 60_000) * 60_000;
  for (let i = 0; i < 8 * 24 * 4; i++) {
    t += STEP;
    if (!isAvailable(schedule, tz, t)) {
      let lo = t - STEP;
      while (lo + 60_000 < t && isAvailable(schedule, tz, lo + 60_000)) lo += 60_000;
      return lo + 60_000;
    }
  }
  return null;   // available for the whole next week
}

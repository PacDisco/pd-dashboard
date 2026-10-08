// POST /api/checkins/book  (portal → dashboard, X-PD-Service-Key)
// { start: ISO, name, email, notes?, repeatWeeks?: 1..maxRepeat }
import crypto from "node:crypto";
import {
  getSettings, hostOf, busyIntervals, isFree, weeklyOccurrences, candidateSlots,
  utcToZoned, localIso, createEvent, json, portalKeyOk,
} from "./_shared/checkins.mjs";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Pure: validate the request body against config. Returns { booking } or { error, status }. */
export function checkBooking(body, cfg, now = Date.now()) {
  const name = String(body?.name || "").trim().slice(0, 100);
  const email = String(body?.email || "").trim().toLowerCase();
  const notes = String(body?.notes || "").trim().slice(0, 1000);
  const repeat = Math.max(1, Math.min(cfg.maxRepeat, parseInt(body?.repeatWeeks, 10) || 1));
  const start = Date.parse(body?.start);
  if (!name || !EMAIL.test(email) || !start) return { error: "Please fill in your name, email and a time.", status: 400 };
  if (!candidateSlots(cfg, now).includes(start)) return { error: "That time isn't available. Please pick another.", status: 409 };
  return { booking: { name, email, notes, repeat, start } };
}

/** Pure: the Google Calendar event body. */
export function buildEvent(b, cfg, staff) {
  const dur = cfg.duration * 60_000;
  return {
    summary: `${cfg.title} — ${b.name}`,
    description: [
      `Booked by ${b.name} (${b.email}) via the instructor portal.`,
      b.notes && `\nNotes from instructor:\n${b.notes}`,
      `\nStaff: add, remove or swap people with Edit event → Guests. Everyone is notified.`,
    ].filter(Boolean).join("\n"),
    start: { dateTime: localIso(utcToZoned(b.start, cfg.tz)), timeZone: cfg.tz },
    end: { dateTime: localIso(utcToZoned(b.start + dur, cfg.tz)), timeZone: cfg.tz },
    attendees: [{ email: b.email, displayName: b.name }, ...staff],
    // Anyone on the invite, on any domain, can change the guest list from their own calendar.
    guestsCanModify: true,
    guestsCanInviteOthers: true,
    conferenceData: { createRequest: { requestId: crypto.randomUUID(), conferenceSolutionKey: { type: "hangoutsMeet" } } },
    extendedProperties: { private: { source: "instructor-portal", instructorEmail: b.email } },
    reminders: { useDefault: true },
    ...(b.repeat > 1 && { recurrence: [`RRULE:FREQ=WEEKLY;COUNT=${b.repeat}`] }),
  };
}

export default async (req) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (!portalKeyOk(req)) return json({ error: "Forbidden" }, 403);

  const body = await req.json().catch(() => null);
  try {
    const settings = await getSettings();
    const cfg = settings.config;
    const host = hostOf(settings);
    if (!host) return json({ error: "Check-ins aren't set up yet." }, 503);

    const checked = checkBooking(body, cfg);
    if (checked.error) return json({ error: checked.error }, checked.status);
    const b = checked.booking;

    // Re-check every occurrence right before booking.
    const dur = cfg.duration * 60_000;
    const occ = weeklyOccurrences(b.start, b.repeat, cfg.tz);
    const busy = await busyIntervals(settings, occ[0] - 3600_000, occ.at(-1) + dur + 3600_000);
    const clashes = occ.filter((ts) => !isFree(busy, ts, ts + dur, cfg.buffer));
    if (clashes.length) {
      return json({
        error: b.repeat > 1
          ? `That time is already taken in ${clashes.length} of the ${b.repeat} weeks. Try fewer weeks or another time.`
          : "Sorry, that time was just taken. Please pick another.",
        clashes: clashes.map((ts) => new Date(ts).toISOString()),
      }, 409);
    }

    const staff = settings.people.filter((p) => !p.host).map((p) => ({ email: p.email, displayName: p.name || undefined }));
    const created = await createEvent(host, cfg.calendarId, buildEvent(b, cfg, staff));
    console.log(`[checkins-book] ${b.email} booked ${new Date(b.start).toISOString()} x${b.repeat} → ${created.id}`);
    return json({ ok: true, start: new Date(b.start).toISOString(), weeks: b.repeat, meetLink: created.hangoutLink || null });
  } catch (e) {
    console.error("[checkins-book]", e.message);
    return json({ error: "Booking failed. Please try again or contact the office." }, 500);
  }
};

export const config = { path: "/api/checkins/book" };

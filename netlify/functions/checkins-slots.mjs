// GET /api/checkins/slots  (portal → dashboard, X-PD-Service-Key)
// Bookable check-in start times as UTC ISO strings.
import { getSettings, hostOf, busyIntervals, candidateSlots, isFree, json, portalKeyOk } from "./_shared/checkins.mjs";

export default async (req) => {
  if (!portalKeyOk(req)) return json({ error: "Forbidden" }, 403);
  try {
    const settings = await getSettings();
    const cfg = settings.config;
    if (!hostOf(settings)) return json({ error: "Check-ins aren't set up yet." }, 503);

    const meta = { duration: cfg.duration, maxRepeat: cfg.maxRepeat, tz: cfg.tz };
    const candidates = candidateSlots(cfg);
    if (!candidates.length) return json({ slots: [], ...meta });

    const dur = cfg.duration * 60_000;
    const busy = await busyIntervals(settings, candidates[0] - 3600_000, candidates.at(-1) + dur + 3600_000);
    const slots = candidates.filter((ts) => isFree(busy, ts, ts + dur, cfg.buffer)).map((ts) => new Date(ts).toISOString());
    return json({ slots, ...meta });
  } catch (e) {
    console.error("[checkins-slots]", e.message);
    return json({ error: "Couldn't load times. Please try again shortly." }, 500);
  }
};

export const config = { path: "/api/checkins/slots" };

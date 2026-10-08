// GET /api/checkins/mine?email=  (portal → dashboard, X-PD-Service-Key)
// One instructor's upcoming check-ins (next 90 days), for the portal's booking view.
import { getSettings, upcomingCheckins, json, portalKeyOk } from "./_shared/checkins.mjs";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default async (req) => {
  if (!portalKeyOk(req)) return json({ error: "Forbidden" }, 403);
  const email = String(new URL(req.url).searchParams.get("email") || "").trim().toLowerCase();
  if (!EMAIL.test(email)) return json({ error: "Missing email" }, 400);
  try {
    const settings = await getSettings();
    const rows = await upcomingCheckins(settings, { days: 90, instructorEmail: email });
    return json({
      checkins: rows.map((e) => ({ start: e.start, end: e.end, recurring: e.recurring, meet: e.meet })),
      tz: settings.config.tz,
    });
  } catch (e) {
    console.error("[checkins-mine]", e.message);
    return json({ error: "Couldn't load your check-ins." }, 500);
  }
};

export const config = { path: "/api/checkins/mine" };

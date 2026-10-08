// /api/checkins/admin — backs the Instructor Check-ins dashboard (Identity-verified).
//
//   GET                       → { people, config, calendars, upcoming, warnings }
//   POST { action, ... }      → same shape after the change
//     add        { email, name }
//     update     { email, name?, checkAvailability? }
//     remove     { email }
//     setHost    { email }
//     disconnect { email }
//     config     { config: { calendarId?, hours?, duration?, buffer?, leadHours?, horizonDays?, maxRepeat?, title?, tz? } }
import {
  getSettings, saveSettings, publicPeople, hostOf, hostCalendars, upcomingCheckins, checkConfig, json,
} from "./_shared/checkins.mjs";
import { requireManager } from "./_shared/checkins-access.mjs";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Pure: apply an action to settings in place. Returns an error string or null. */
export function applyAction(settings, b, actor = "") {
  const email = String(b?.email || "").trim().toLowerCase();
  const person = settings.people.find((p) => p.email === email);
  switch (b?.action) {
    case "add":
      if (!EMAIL.test(email)) return "Enter a valid email.";
      if (person) return "They're already on the list.";
      settings.people.push({ email, name: String(b.name || "").trim().slice(0, 80), host: false, checkAvailability: false, addedBy: actor });
      return null;
    case "update":
      if (!person) return "Not found.";
      if (typeof b.name === "string") person.name = b.name.trim().slice(0, 80);
      if (typeof b.checkAvailability === "boolean") person.checkAvailability = b.checkAvailability;
      return null;
    case "remove":
      if (!person) return "Not found.";
      if (person.host) return "Make someone else the host first.";
      settings.people = settings.people.filter((p) => p !== person);
      return null;
    case "setHost":
      if (!person?.refresh_token) return "Connect this person's calendar first.";
      settings.people.forEach((p) => (p.host = p === person));
      settings.config.calendarId = "primary"; // the old host's calendar isn't theirs
      return null;
    case "disconnect":
      if (!person) return "Not found.";
      if (person.host) return "Make someone else the host first.";
      delete person.refresh_token;
      person.checkAvailability = false;
      return null;
    case "config": {
      const r = checkConfig(b.config || {}, settings.config);
      if (r.error) return r.error;
      settings.config = r.config;
      return null;
    }
    default:
      return "Unknown action.";
  }
}

async function view(settings) {
  const host = hostOf(settings);
  const warnings = [];
  let calendars = [], upcoming = [];
  if (host) {
    const [cals, up] = await Promise.allSettled([hostCalendars(host), upcomingCheckins(settings)]);
    if (cals.status === "fulfilled") calendars = cals.value;
    else warnings.push(cals.reason?.status === 403
      ? `Reconnect ${host.email} to list their calendars (it was connected before calendar picking was added).`
      : `Couldn't list ${host.email}'s calendars: ${cals.reason?.message}`);
    if (up.status === "fulfilled") upcoming = up.value;
    else warnings.push(up.reason?.code === "revoked"
      ? `${host.email}'s Google connection was revoked. Reconnect it.`
      : `Couldn't load upcoming check-ins: ${up.reason?.message}`);
  }
  return json({ people: publicPeople(settings), config: settings.config, calendars, upcoming, warnings });
}

export default async (req) => {
  const user = await requireManager(req, "checkins-admin");
  if (user instanceof Response) return user;

  const settings = await getSettings();
  if (req.method === "GET") return view(settings);
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const b = await req.json().catch(() => ({}));
  const err = applyAction(settings, b, user.actor);
  if (err) return json({ error: err }, 400);
  await saveSettings(settings);
  console.log(`[checkins-admin] ${user.actor}: ${b.action} ${b.email || ""}`);
  return view(settings);
};

export const config = { path: "/api/checkins/admin" };

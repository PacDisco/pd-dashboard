// netlify/functions/lead-alerts.mjs
//
// API for the Lead Alerts phone app (/lead-alerts/). See LEAD-ALERTS.md.
//
//   GET  /api/lead-alerts               feed (last 7 days), unseen count, stats
//   POST /api/lead-alerts/seen          "I've opened the app" — clears the bubble
//   POST /api/lead-alerts/handled       { id, undo? } mark followed up
//   POST /api/lead-alerts/subscribe     { subscription } register this phone
//   POST /api/lead-alerts/unsubscribe   { endpoint }
//   POST /api/lead-alerts/prefs         { tz, schedule } my available hours (schedule null = 24/7)
//   POST /api/lead-alerts/dial          { id, aircallEmail? } put the lead's number in my Aircall desktop app
//   POST /api/lead-alerts/aircall-setup connect the Aircall webhook (admin only)
//   POST /api/lead-alerts/test          send a test notification to my phones
//   POST /api/lead-alerts/scan          run a scan now (admin only)
//
// Every call needs a verified Identity session (Bearer from the PWA, or the
// nf_jwt cookie from the dashboard) AND access to the lead-alerts dashboard.

import { verifiedUser, actorName } from "./_shared/identity.mjs";
import {
  accessChecker, feedFor, markSeen, setHandled, saveSubscription, removeSubscription,
  subscriptionsFor, testPush, savePrefs, aircallStatus, connectAircall, dialForEvent, runScan, vapidPublicKey, FOLLOW_UP_MIN, REMIND_AFTER_MIN,
} from "./_shared/lead-alerts.mjs";

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

export default async (req) => {
  const user = await verifiedUser(req, "lead-alerts");
  if (!user || !user.email) return json({ error: "Not signed in" }, 401);

  const may = await accessChecker();
  if (!may(user.email, user.roles)) return json({ error: "You haven't been given access to Lead Alerts." }, 403);

  const action = new URL(req.url).pathname.replace(/\/+$/, "").split("/").pop();
  let body = {};
  if (req.method === "POST") { try { body = await req.json(); } catch {} }

  try {
    if (req.method === "GET" && (action === "lead-alerts" || action === "feed")) {
      const [feed, devices, aircall] = await Promise.all([feedFor(user.email), subscriptionsFor(user.email), aircallStatus()]);
      return json({
        ...feed,
        me: { email: user.email, name: user.name, isAdmin: user.roles.includes("admin") },
        devices: devices.length,
        aircall,
        vapidPublicKey: vapidPublicKey(),
        followUpMinutes: FOLLOW_UP_MIN,
        remindAfterMinutes: REMIND_AFTER_MIN,
        generatedAt: new Date().toISOString(),
      });
    }

    if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

    switch (action) {
      case "seen":
        await markSeen(user.email);
        return json({ ok: true });

      case "handled": {
        const id = String(body.id || "");
        if (!id) return json({ error: "id required" }, 400);
        const event = await setHandled(id, actorName(user), !!body.undo);
        if (!event) return json({ error: "Not found" }, 404);
        return json({ ok: true, event });
      }

      case "subscribe":
        await saveSubscription(user.email, user.roles, body.subscription, req.headers.get("user-agent"));
        return json({ ok: true });

      case "unsubscribe":
        await removeSubscription(user.email, body.endpoint);
        return json({ ok: true });

      case "prefs":
        return json({ ok: true, prefs: await savePrefs(user.email, { tz: body.tz, schedule: body.schedule }) });

      case "dial": {
        const id = String(body.id || "");
        if (!id) return json({ error: "id required" }, 400);
        try {
          return json({ ok: true, ...(await dialForEvent(user.email, id, body.aircallEmail)) });
        } catch (e) {
          if (e.needsAircallEmail) return json({ error: e.message, needsAircallEmail: true }, 404);
          throw e;
        }
      }

      case "aircall-setup":
        if (!user.roles.includes("admin")) return json({ error: "Admins only" }, 403);
        return json({ ok: true, ...(await connectAircall(process.env.URL || new URL(req.url).origin)) });

      case "test":
        return json({ ok: true, ...(await testPush(user.email)) });

      case "scan":
        if (!user.roles.includes("admin")) return json({ error: "Admins only" }, 403);
        return json({ ok: true, report: await runScan() });

      default:
        return json({ error: "Unknown action" }, 404);
    }
  } catch (e) {
    console.error("[lead-alerts]", action, e);
    return json({ error: e.status ? e.message : "Something went wrong" }, e.status || 500);
  }
};

export const config = { path: ["/api/lead-alerts", "/api/lead-alerts/*"] };

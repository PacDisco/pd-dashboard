// netlify/functions/aircall-webhook.mjs
//
// Aircall → POST /api/aircall-webhook (call.ended). When the advisor calls a
// lead from Aircall — phone or computer — or answers a lead calling in, the
// matching open Lead Alert closes itself. See LEAD-ALERTS.md → "Aircall".
//
// Aircall doesn't sign requests; each body carries the webhook's `token`,
// which we compare (timing-safe) with the one saved when the webhook was
// connected. Must answer within 5 seconds.

import { closeFromAircallCall, webhookTokenOk } from "./_shared/lead-alerts.mjs";

const ok = (body = { ok: true }) => new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });

export default async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  let body;
  try { body = await req.json(); } catch { return new Response("Bad JSON", { status: 400 }); }
  if (!(await webhookTokenOk(body?.token))) return new Response("Unauthorized", { status: 401 });

  if (body.resource !== "call" || body.event !== "call.ended") return ok({ ok: true, ignored: body.event });
  try {
    const closed = await closeFromAircallCall(body.data);
    if (closed.length) console.log(`[aircall-webhook] call ${body.data?.id} closed ${closed.join(", ")}`);
    return ok({ ok: true, closed: closed.length });
  } catch (e) {
    // 500 → Aircall retries, which is what we want for a database blip.
    console.error("[aircall-webhook]", e);
    return new Response("Error", { status: 500 });
  }
};

export const config = { path: "/api/aircall-webhook" };

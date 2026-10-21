// netlify/functions/student-payments-sync.mjs
//
// Scheduled every 10 minutes (netlify.toml). Pulls new Stripe + Wise payments,
// logs them against HubSpot student deals, and attaches application PDFs.
// All the work is in _shared/student-payments-run.mjs — the dashboard's
// "Sync now" calls the same pass.

import { runSync } from "./_shared/student-payments-run.mjs";

export default async () => {
  // Scheduled functions get 30 s; leave room for the lock release + logging.
  const result = await runSync({ trigger: "schedule", budgetMs: 22_000 });
  console.log("[student-payments-sync]", JSON.stringify(result));
  return new Response("ok");
};

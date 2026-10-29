// netlify/functions/lead-alerts-scan.mjs
//
// Scheduled (every 2 minutes — see netlify.toml): looks for new applications,
// quiz completions and HubSpot "New lead" contacts, stores them, and pushes a
// notification to every phone subscribed in the Lead Alerts app. Also sends
// one reminder for alerts still open after LEAD_ALERTS_REMIND_MIN (default 45)
// and closes alerts HubSpot shows were followed up. See LEAD-ALERTS.md.

import { runScan } from "./_shared/lead-alerts.mjs";

export default async () => {
  const report = await runScan();
  if (report.inserted || report.reminders || report.autoClosed || report.errors.length) {
    console.log("[lead-alerts-scan]", JSON.stringify(report));
  }
  return new Response(JSON.stringify(report), { headers: { "Content-Type": "application/json" } });
};

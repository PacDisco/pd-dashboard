// netlify/functions/form-attachments-sync.mjs
//
// Scheduled every 5 minutes (netlify.toml). Attaches a PDF of every quiz,
// referral, step-1-only application and Meta lead form to the HubSpot contact.
// All the work is in _shared/form-attachments-run.mjs. See FORM-ATTACHMENTS.md.

import { runFormAttachments } from "./_shared/form-attachments-run.mjs";

export default async () => {
  const result = await runFormAttachments({ trigger: "schedule", budgetMs: 22_000 });
  console.log("[form-attachments-sync]", JSON.stringify(result));
  return new Response("ok");
};

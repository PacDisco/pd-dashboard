// netlify/functions/ue-student-payments.mjs
//
// API behind /ue-student-payments/ — Unearthed Education's payments only:
// Stripe + Wise payments into Unearthed's own accounts, logged against deals
// in the "Unearthed Education" pipeline, the review queue, watch mode and deal
// stage moves. Can't see or touch Pacific Discovery payments. Routes and rules:
// _shared/student-payments-api.mjs. Env: STUDENT-PAYMENTS.md › Unearthed Education.

import { makeHandler } from "./_shared/student-payments-api.mjs";

export const DASHBOARD_SLUG = "ue-student-payments";
// Keep in step with ue-student-payments/dashboard.json → allowedRoles.
export const ALLOWED_ROLES = ["admin", "operations", "unearthed"];

export default makeHandler({ slug: DASHBOARD_SLUG, roles: ALLOWED_ROLES, brand: "ue" });

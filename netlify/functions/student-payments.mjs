// netlify/functions/student-payments.mjs
//
// API behind /student-payments/ — Pacific Discovery's payments only: the
// ledger of Stripe + Wise payments logged against HubSpot student deals, the
// review queue, and the application-PDF status. Unearthed Education has its
// own dashboard and API (ue-student-payments.mjs). Routes and rules:
// _shared/student-payments-api.mjs. Env: STUDENT-PAYMENTS.md.

import { makeHandler } from "./_shared/student-payments-api.mjs";

export const DASHBOARD_SLUG = "student-payments";
// Keep in step with student-payments/dashboard.json → allowedRoles.
export const ALLOWED_ROLES = ["admin", "operations", "admissions"];

export default makeHandler({ slug: DASHBOARD_SLUG, roles: ALLOWED_ROLES, brand: "pd" });

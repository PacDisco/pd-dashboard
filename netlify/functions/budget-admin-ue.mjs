// netlify/functions/budget-admin-ue.mjs
//
// Unearthed Education's Field Budget admin — the same API as budget-admin.mjs,
// bound to the Unearthed field app's database (UE_FIELD_BUDGET_DATABASE_URL)
// and to Unearthed's write roles. Served at /api/budget-admin-ue and used by
// the ue-field-budget dashboard. See FIELD-BUDGET.md, "Unearthed Education".

import { createBudgetAdmin, BRANDS } from "./budget-admin.mjs";

export default createBudgetAdmin(BRANDS.ue);

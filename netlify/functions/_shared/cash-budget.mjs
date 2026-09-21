// netlify/functions/_shared/cash-budget.mjs
//
// Monthly overheads from Xero's Budget Manager.
//
// WHY THE BUDGET AND NOT THE P&L
// ------------------------------
// The P&L says what HAS been spent. A cash forecast needs what WILL be — and
// for the eight months of the year that have not happened, the budget is the
// only real answer. Reading the P&L covers closed months; reading the budget
// covers the rest. Twelve numbers typed once a year from a workbook covers
// neither.
//
// WHICH LINES COUNT AS OVERHEADS
// ------------------------------
// A budget spans every account, including revenue and cost of sales. Program
// costs are already modelled from pax and phasing, so pulling DIRECTCOSTS in
// here would double-count them against the Program costs row.
//
// The rule: account Class is EXPENSE, and Type is not DIRECTCOSTS. That comes
// off the chart of accounts rather than from guessing at names, and every
// account that was dropped is reported with its reason — because "the overheads
// look low" is otherwise an unanswerable question.
//
// SCOPE
// -----
// `accounting.budgets.read` is the expected scope. Xero's scope documentation
// renders client-side and could not be read directly, so this is unconfirmed:
// if it is wrong the call returns 403 with a scope message, which the probe
// surfaces verbatim rather than swallowing.
//
// READ-ONLY. Every request here is a GET.

import { xeroGet } from "./cash-xero.mjs";
import { isNonCash } from "./cash-opex.mjs";

/** Budgets available in the organisation, newest first. */
export async function listBudgets(accessToken, tenantId) {
  const json = await xeroGet(accessToken, tenantId, "Budgets");
  return (json?.Budgets ?? [])
    .map((b) => ({
      budgetID: b.BudgetID,
      type: b.Type,                 // OVERALL or TRACKING
      description: b.Description || "(no description)",
      updatedAt: b.UpdatedDateUTC || null,
    }))
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

/** One budget with its lines and per-period balances. */
export async function fetchBudget(accessToken, tenantId, budgetID, { from, to } = {}) {
  const params = {};
  if (from) params.DateFrom = from;
  if (to) params.DateTo = to;
  const json = await xeroGet(accessToken, tenantId, `Budgets/${budgetID}`, params);
  return json?.Budgets?.[0] ?? null;
}

/** AccountID -> {code, name, type, class}, for classifying budget lines. */
export async function accountIndex(accessToken, tenantId) {
  const json = await xeroGet(accessToken, tenantId, "Accounts");
  const byId = new Map();
  for (const a of json?.Accounts ?? []) {
    if (!a?.AccountID) continue;
    byId.set(a.AccountID, {
      code: a.Code ?? null,
      name: a.Name ?? "",
      type: a.Type ?? "",
      klass: a.Class ?? "",
    });
  }
  return byId;
}

/**
 * Decide whether a budget line belongs in the overheads row, and say why not.
 *
 * Returned as {include, reason} rather than a bare boolean so the probe can
 * show what it dropped. A silently excluded account is how a forecast ends up
 * understating costs with nobody able to explain the gap.
 */
export function classifyLine(account) {
  if (!account) return { include: false, reason: "account not in the chart of accounts" };
  if (account.klass !== "EXPENSE") {
    return { include: false, reason: `class ${account.klass || "unknown"}, not an expense` };
  }
  if (account.type === "DIRECTCOSTS") {
    return { include: false, reason: "direct cost — already modelled as program costs" };
  }
  if (isNonCash(account.name)) {
    return { include: false, reason: "non-cash line" };
  }
  return { include: true, reason: null };
}

/** "2026-04-30" or "2026-04" -> fiscal slot 0-11 for an April-start year. */
export function periodToSlot(period, fyStartYear) {
  const m = /^(\d{4})-(\d{2})/.exec(String(period ?? ""));
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const slot = (year - fyStartYear) * 12 + (month - 1) - 3;
  return slot >= 0 && slot < 12 ? slot : null;
}

/**
 * Twelve monthly overhead figures, April first, from a budget.
 *
 * Pure — takes the budget and the account index, does no I/O, so it can be
 * tested against fixtures.
 *
 * @returns {{months: number[], included, excluded, periodsSeen, slotsCovered}}
 */
export function overheadsFromBudget(budget, accountsById, fyStartYear) {
  const months = Array(12).fill(0);
  const included = new Map();
  const excluded = new Map();
  const periodsSeen = new Set();
  const slotsCovered = new Set();

  for (const line of budget?.BudgetLines ?? []) {
    const account = accountsById.get(line?.AccountID) ?? null;
    const { include, reason } = classifyLine(account);
    const label = account ? `${account.code ?? "?"} ${account.name}` : (line?.AccountID ?? "unknown");

    if (!include) {
      if (!excluded.has(label)) excluded.set(label, { reason, amount: 0 });
      for (const bal of line?.BudgetBalances ?? []) {
        if (periodToSlot(bal?.Period, fyStartYear) !== null) {
          excluded.get(label).amount += Number(bal?.Amount) || 0;
        }
      }
      continue;
    }

    if (!included.has(label)) {
      included.set(label, {
        code: account?.code ?? null,
        // The bare account name, kept alongside the "code name" label, because
        // that is what the P&L prints and therefore the only thing a budget
        // line can be matched to a reported line by.
        name: account?.name ?? label,
        amount: 0,
        months: Array(12).fill(0),
      });
    }
    const entry = included.get(label);
    for (const bal of line?.BudgetBalances ?? []) {
      periodsSeen.add(bal?.Period);
      const slot = periodToSlot(bal?.Period, fyStartYear);
      if (slot === null) continue;
      const amount = Number(bal?.Amount) || 0;
      months[slot] += amount;
      entry.months[slot] += amount;
      entry.amount += amount;
      if (amount !== 0) slotsCovered.add(slot);
    }
  }

  return {
    months: months.map((n) => Math.round(n * 100) / 100),
    included: [...included.entries()]
      .map(([account, v]) => ({
        account,
        code: v.code,
        name: v.name,
        amount: Math.round(v.amount),
        months: v.months.map((n) => Math.round(n)),
      }))
      .sort((a, b) => b.amount - a.amount),
    excluded: [...excluded.entries()]
      .map(([account, v]) => ({ account, reason: v.reason, amount: Math.round(v.amount) }))
      .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount)),
    periodsSeen: [...periodsSeen].filter(Boolean).sort(),
    // A budget covering only part of the year would otherwise show as a set of
    // convincing-looking zeros in the months it does not reach.
    slotsCovered: [...slotsCovered].sort((a, b) => a - b),
  };
}

/**
 * Twelve monthly figures for whichever accounts a predicate accepts.
 *
 * `overheadsFromBudget` above answers the cash forecast's question and throws
 * the rest away with a reason. The surplus view needs two of the things it
 * throws away — budgeted revenue and budgeted cost of sales — so the same walk
 * is expressed once here and asked three different questions.
 */
function collectBudget(budget, accountsById, fyStartYear, accept) {
  const months = Array(12).fill(0);
  const included = new Map();
  const slotsCovered = new Set();

  for (const line of budget?.BudgetLines ?? []) {
    const account = accountsById.get(line?.AccountID) ?? null;
    if (!accept(account)) continue;
    const label = account ? `${account.code ?? "?"} ${account.name}` : (line?.AccountID ?? "unknown");

    if (!included.has(label)) {
      included.set(label, {
        code: account?.code ?? null,
        name: account?.name ?? label,
        amount: 0,
        months: Array(12).fill(0),
      });
    }
    const entry = included.get(label);
    for (const bal of line?.BudgetBalances ?? []) {
      const slot = periodToSlot(bal?.Period, fyStartYear);
      if (slot === null) continue;
      const amount = Number(bal?.Amount) || 0;
      months[slot] += amount;
      entry.months[slot] += amount;
      entry.amount += amount;
      if (amount !== 0) slotsCovered.add(slot);
    }
  }

  return {
    months: months.map((n) => Math.round(n * 100) / 100),
    total: Math.round(months.reduce((s, n) => s + n, 0)),
    included: [...included.entries()]
      .map(([account, v]) => ({
        account,
        code: v.code,
        name: v.name,
        amount: Math.round(v.amount),
        months: v.months.map((n) => Math.round(n)),
      }))
      .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount)),
    slotsCovered: [...slotsCovered].sort((a, b) => a - b),
  };
}

/**
 * The budget split into the three lines a surplus is made of.
 *
 * Revenue comes back POSITIVE, and so do both cost series. Nothing here nets
 * anything off: the subtraction happens once, in the surplus computation, where
 * it can be read. A budget module that returned costs as negatives would work
 * until the day someone added them instead of subtracting, and that mistake is
 * invisible in a total.
 *
 * `overheads` deliberately re-uses overheadsFromBudget's own rule, so the
 * surplus view and the cash forecast can never disagree about what an overhead
 * is — a second definition here is a second thing to keep in step.
 */
export function budgetSeries(budget, accountsById, fyStartYear) {
  const overheads = overheadsFromBudget(budget, accountsById, fyStartYear);
  const revenue = collectBudget(budget, accountsById, fyStartYear,
    (a) => a?.klass === "REVENUE");
  const directCosts = collectBudget(budget, accountsById, fyStartYear,
    (a) => a?.klass === "EXPENSE" && a?.type === "DIRECTCOSTS");

  return {
    overheads: {
      months: overheads.months,
      total: Math.round(overheads.months.reduce((s, n) => s + n, 0)),
      slotsCovered: overheads.slotsCovered,
    },
    revenue,
    directCosts,
    // Budgeted surplus, computed here once so the page and any other caller
    // cannot each do the subtraction slightly differently.
    surplus: Math.round(
      revenue.total - directCosts.total - overheads.months.reduce((s, n) => s + n, 0)),
    // Whether the budget actually covers the whole year. A budget that stops in
    // December makes a full-year surplus look far better than it is, and the
    // shortfall is invisible in the total.
    monthsCovered: [...new Set([
      ...overheads.slotsCovered, ...revenue.slotsCovered, ...directCosts.slotsCovered,
    ])].sort((a, b) => a - b),
  };
}

export default {
  listBudgets, fetchBudget, accountIndex, overheadsFromBudget,
  budgetSeries, classifyLine, periodToSlot,
};

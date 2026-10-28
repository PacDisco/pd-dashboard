// netlify/functions/payment-plans.mjs
//
// API behind /payment-plans/ — what's coming in from families on payment
// plans (pd-apply's acceptance page), and when. Reads applications.enrolment
// (MIGRATION-enrolment.sql) from the same Neon database pd-apply writes.
//
//   GET ?action=report  → buildReport(...)  (see below)
//
// Amounts are TUITION (what counts toward the program). Card / bank processing
// fees are charged on top and reported separately as an estimate.

import { requireDashboard, json } from "./_shared/apply-form-access.mjs";
import { db } from "./_shared/student-payments-run.mjs";

export const DASHBOARD_SLUG = "payment-plans";
// Keep in step with payment-plans/dashboard.json → allowedRoles.
export const ALLOWED_ROLES = ["admin", "operations", "admissions"];

const DEPOSIT_TOTAL = 2500;
const OPEN = ["scheduled", "charging", "processing", "failed", "needs_admissions", "due"];
const PLAN_NAMES = { monthly: "Monthly", two: "Two instalments", full: "Paid in full", later: "Balance later" };
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const iso = (d) => new Date(d).toISOString().slice(0, 10);
const addDays = (day, n) => iso(new Date(new Date(`${day}T12:00:00Z`).getTime() + n * 864e5));
const monthOf = (day) => String(day).slice(0, 7);

/**
 * Turn accepted applications into the report. Pure (tested).
 *   rows   applications with decision + enrolment (+ deal_amount, payment …)
 *   today  YYYY-MM-DD
 *   rates  { card, ach } current processing-fee rates (for the fee estimate)
 */
export function buildReport(rows, { today = iso(new Date()), rates = { card: 0.035, ach: 0 } } = {}) {
  const families = [];
  const events = []; // { date, amount, fee, kind, appId }
  for (const a of rows || []) {
    const e = a.enrolment || {};
    const d = a.decision || {};
    if (d.outcome !== "accepted") continue;
    const name = `${a.first_name || ""} ${a.last_name || ""}`.trim() || a.email;
    const base = { id: a.id, name, email: a.email, program: a.program || "", term: a.term || "", dealId: a.hubspot_deal_id || null };
    const tuition = r2((Number(e.offer?.tuition) || Number(a.deal_amount) || 0) - (Number(e.deposit?.discount) || 0) - (Number(e.payOff?.discount) || 0));
    const method = e.choice?.method === "ach" ? "ach" : "card";
    const rate = e.choice?.rate != null ? Number(e.choice.rate) : rates[method] ?? 0;
    const deposited = ["paid", "processing"].includes(e.deposit?.status);

    if (!deposited) {
      const fee = a.paid_at ? Number(a.payment?.base ?? 250) : 0;
      const paidSoFar = Math.max(fee, Number(e.prepaid?.total) || 0);
      const choosing = !!e.prepaid || paidSoFar >= DEPOSIT_TOTAL;
      const holdUntil = d.holdUntil || e.offer?.holdUntil || null;
      const depositDue = choosing ? 0 : r2(Math.max(0, DEPOSIT_TOTAL - paidSoFar));
      const holdPassed = !!(holdUntil && iso(holdUntil) < today);
      if (depositDue > 0 && a.status !== "withdrawn") events.push({ date: holdPassed ? today : iso(holdUntil || today), amount: depositDue, fee: 0, kind: "pendingDeposit", appId: a.id });
      families.push({
        ...base, state: a.status === "withdrawn" ? "withdrawn" : choosing ? "choosing" : "awaitingDeposit",
        plan: null, planName: choosing ? "Choosing a plan" : "Deposit not paid", method: null,
        tuition, paid: paidSoFar, remaining: r2(Math.max(0, tuition - paidSoFar)), unscheduled: r2(Math.max(0, tuition - paidSoFar - depositDue)),
        next: depositDue > 0 ? { date: iso(holdUntil || today), amount: depositDue, kind: "deposit" } : null,
        holdUntil, holdPassed, problems: holdPassed && depositDue > 0 ? ["Hold passed, deposit not paid"] : [],
        schedule: [],
      });
      continue;
    }

    const schedule = Array.isArray(e.schedule) ? e.schedule : [];
    let paid = Number(a.paid_at ? (a.payment?.base ?? 250) : 0);
    // pd-apply's app fee isn't in the schedule; a "paid before choosing" row already includes it.
    if (schedule[0]?.label === "Paid before choosing a plan") paid = 0;
    const problems = [];
    let next = null;
    for (const p of schedule) {
      const amt = Number(p.amount) || 0;
      if (p.status === "paid") {
        paid += amt;
        const date = p.paidAt ? iso(p.paidAt) : p.kind === "deposit" && e.deposit?.paidAt ? iso(e.deposit.paidAt) : p.due;
        const fee = p.kind === "deposit" ? Number(e.deposit?.fee) || 0 : r2((Number(p.total) || amt) - amt);
        events.push({ date, amount: amt, fee, kind: "received", appId: a.id });
        continue;
      }
      if (!OPEN.includes(p.status) || e.withdrawn) continue;
      let kind = p.manual ? "manual" : "automatic";
      let date = p.due;
      if (p.status === "failed") { kind = "atRisk"; date = p.nextAttemptAt ? iso(p.nextAttemptAt) : today; problems.push(`Payment of $${amt.toLocaleString("en-US")} due ${p.due} failed${p.attempts ? ` ×${p.attempts}` : ""} — retrying`); }
      if (p.status === "needs_admissions") { kind = "atRisk"; date = today; problems.push(`Payment of $${amt.toLocaleString("en-US")} due ${p.due} failed ${p.attempts || 3} times — contact the family`); }
      if (p.manual && p.due < today) { kind = "atRisk"; date = today; problems.push(`Balance of $${amt.toLocaleString("en-US")} was due ${p.due}`); }
      if (["processing", "charging"].includes(p.status)) date = today < p.due ? p.due : today;
      if (e.paused && kind === "automatic") { kind = "atRisk"; if (!problems.includes("Automatic payments paused")) problems.push("Automatic payments paused"); }
      const fee = p.manual ? 0 : r2(amt * rate);
      events.push({ date: date < today && kind !== "received" ? today : date, amount: amt, fee, kind, appId: a.id });
      if (!next || p.due < next.date) next = { date: p.due, amount: amt, kind, status: p.status };
    }
    const remaining = e.withdrawn ? 0 : r2(schedule.filter((p) => OPEN.includes(p.status)).reduce((s, p) => s + (Number(p.amount) || 0), 0));
    families.push({
      ...base, state: e.withdrawn ? "withdrawn" : remaining <= 0 ? "paidInFull" : problems.length ? "problem" : "onTrack",
      plan: e.choice?.plan || null, planName: PLAN_NAMES[e.choice?.plan] || "", method, paused: !!e.paused,
      tuition, paid: r2(paid), remaining, unscheduled: 0, next, problems,
      schedule: schedule.map((p) => ({ due: p.due, amount: Number(p.amount) || 0, kind: p.kind, manual: !!p.manual, status: p.status, paidAt: p.paidAt || null, attempts: p.attempts || 0 })),
    });
  }

  // ── months: 3 back, 12 ahead ────────────────────────────────────────────
  const start = new Date(`${today.slice(0, 7)}-01T12:00:00Z`);
  const months = [];
  for (let i = -3; i <= 12; i++) {
    const m = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + i, 1));
    months.push({ month: iso(m).slice(0, 7), received: 0, automatic: 0, manual: 0, atRisk: 0, pendingDeposit: 0, fees: 0 });
  }
  const byMonth = Object.fromEntries(months.map((m) => [m.month, m]));
  for (const ev of events) {
    const m = byMonth[monthOf(ev.date)];
    if (!m) continue;
    m[ev.kind] = r2(m[ev.kind] + ev.amount);
    m.fees = r2(m.fees + (ev.fee || 0));
  }

  const sum = (list, f = () => true) => r2(list.filter(f).reduce((s, x) => s + x.amount, 0));
  const ahead = (n) => (ev) => ev.kind !== "received" && ev.kind !== "pendingDeposit" && ev.date <= addDays(today, n);
  const expected = events.filter((ev) => ev.kind !== "received");
  const kpis = {
    received: sum(events, (ev) => ev.kind === "received"),
    receivedThisMonth: sum(events, (ev) => ev.kind === "received" && monthOf(ev.date) === monthOf(today)),
    next30: sum(expected, ahead(30)),
    next90: sum(expected, ahead(90)),
    scheduled: sum(expected, (ev) => ev.kind === "automatic" || ev.kind === "manual"),
    atRisk: sum(expected, (ev) => ev.kind === "atRisk"),
    pendingDeposits: sum(expected, (ev) => ev.kind === "pendingDeposit"),
    pendingDepositCount: families.filter((f) => f.state === "awaitingDeposit").length,
    unscheduled: r2(families.reduce((s, f) => s + (f.unscheduled || 0), 0)),
    feesExpected: r2(expected.filter((ev) => ev.kind === "automatic").reduce((s, ev) => s + (ev.fee || 0), 0)),
    families: families.filter((f) => f.state !== "withdrawn").length,
    onPlans: families.filter((f) => ["onTrack", "problem"].includes(f.state)).length,
    problems: families.filter((f) => f.problems.length).length,
  };
  const names = Object.fromEntries(families.map((f) => [f.id, f]));
  const upcoming = expected
    .filter((ev) => ev.date <= addDays(today, 60))
    .sort((x, y) => x.date.localeCompare(y.date))
    .map((ev) => ({ ...ev, name: names[ev.appId]?.name, program: names[ev.appId]?.program, term: names[ev.appId]?.term, method: names[ev.appId]?.method }));
  const terms = [...new Set(families.map((f) => f.term).filter(Boolean))].sort();
  return { today, kpis, months, upcoming, events, families: families.sort((x, y) => (y.problems.length - x.problems.length) || x.name.localeCompare(y.name)), terms };
}

export default async function handler(req, context, deps = {}) {
  const user = await requireDashboard(req, DASHBOARD_SLUG, ALLOWED_ROLES, deps);
  if (user instanceof Response) return user;
  const url = new URL(req.url);
  if (req.method !== "GET") return json({ error: "Method not allowed" }, 405);
  if ((url.searchParams.get("action") || "report") !== "report") return json({ error: "Unknown action" }, 400);
  try {
    const rows = await db().query(
      `SELECT id, email, first_name, last_name, program, term, status, paid_at, payment, deal_amount, hubspot_deal_id,
              to_jsonb(applications)->'decision' AS decision, to_jsonb(applications)->'enrolment' AS enrolment
         FROM applications
        WHERE to_jsonb(applications)->'decision'->>'outcome' = 'accepted'`);
    const form = await db().query(`SELECT published->'settings' AS s FROM apply_forms WHERE id = 'pd-application' LIMIT 1`).catch(() => []);
    const st = form[0]?.s || {};
    const rates = { card: st.cardFeeRate != null ? Number(st.cardFeeRate) : 0.035, ach: st.achFeeRate != null ? Number(st.achFeeRate) : 0 };
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: process.env.INTERVIEW_TZ || "America/Denver", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
    return json(buildReport(rows, { today, rates }));
  } catch (err) {
    console.error("[payment-plans]", err);
    if (/enrolment|decision/.test(err.message)) return json({ error: "Run MIGRATION-decisions.sql and MIGRATION-enrolment.sql in Neon first." }, 500);
    return json({ error: err.message || "Server error" }, 500);
  }
}

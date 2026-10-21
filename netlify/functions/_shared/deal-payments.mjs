// netlify/functions/_shared/deal-payments.mjs
//
// The pure part of student payment logging: turning a Stripe charge or a Wise
// statement line into one ledger row, deciding which deal it belongs to, and
// deciding which payment_N slot (if any) it goes into. No I/O here, so every
// rule below is unit-tested (test/student-payments.test.mjs).
//
// HOW THE DEAL STORES PAYMENTS (as it already does, by hand and from pd-apply)
// ---------------------------------------------------------------------------
//   payment_1 … payment_15   "2250, pi_3TP4koAY32Ud1Dlw0TmieGo8, 2026-04-23"
//                            amount (USD), reference, date. The Enrollment
//                            dashboard reads the amount before the first comma.
//   total_amount_paid        the running total.
//
// We write the same shape so nothing downstream changes. When the money came
// in another currency the converted USD figure goes first and the original is
// appended as a 4th part ("…, 2026-10-17, NZD 4000.00 @ 0.5625"), which the
// existing parsers ignore.

export const PAYMENT_SLOTS = 15;
export const SLOT_PROPS = Array.from({ length: PAYMENT_SLOTS }, (_, i) => `payment_${i + 1}`);

// Stripe amounts are in the smallest unit except for these.
const ZERO_DECIMAL = new Set(["BIF", "CLP", "DJF", "GNF", "JPY", "KMF", "KRW", "MGA", "PYG", "RWF", "UGX", "VND", "VUV", "XAF", "XOF", "XPF"]);

export const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

/** 2250 → "2250", 1228.75 → "1228.75", 1228.5 → "1228.50". */
export function formatAmount(n) {
  const v = round2(n);
  return Number.isInteger(v) ? String(v) : v.toFixed(2);
}

// ── reading the slots ───────────────────────────────────────────────────────

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };

/**
 * The dates people have typed into slots: "2026-10-17", "13 Oct 2026",
 * "4 Sept 2026", "19-10-2026", "19/10/2026". Returns "YYYY-MM-DD" or null.
 * Day-first for the numeric forms — the team is in NZ.
 */
export function parseLooseDate(s) {
  const t = String(s || "").trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(t);
  if (m) return iso(+m[1], +m[2], +m[3]);
  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(t);
  if (m) return iso(+m[3], +m[2], +m[1]);
  m = /^(\d{1,2})\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})$/.exec(t);
  if (m) { const mo = MONTHS[m[2].toLowerCase().slice(0, 3)]; return mo ? iso(+m[3], mo, +m[1]) : null; }
  m = /^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})$/.exec(t);
  if (m) { const mo = MONTHS[m[1].toLowerCase().slice(0, 3)]; return mo ? iso(+m[3], mo, +m[2]) : null; }
  return null;
}
function iso(y, mo, d) {
  if (!(mo >= 1 && mo <= 12 && d >= 1 && d <= 31)) return null;
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** One slot's text → { n, raw, amount, ref, date }. Empty slot → amount null. */
export function parseSlot(n, raw) {
  const text = String(raw ?? "").trim();
  if (!text) return { n, raw: "", amount: null, ref: "", date: null };
  const parts = text.split(",").map((s) => s.trim());
  const amount = parseFloat(parts[0].replace(/[$\s]/g, ""));
  let date = null;
  let ref = "";
  for (const p of parts.slice(1)) {
    if (!p) continue;
    const d = parseLooseDate(p);
    if (d && !date) date = d;
    else if (!ref) ref = p;
  }
  return { n, raw: text, amount: Number.isFinite(amount) ? amount : null, ref, date };
}

export function slotsOf(props = {}) {
  return SLOT_PROPS.map((p, i) => parseSlot(i + 1, props[p]));
}

const dayDiff = (a, b) => Math.abs((Date.parse(a) - Date.parse(b)) / 86_400_000);

/**
 * Has this payment already been written to the deal — by us, by pd-apply
 * (the app fee), or by hand?
 *   1. Any slot mentions the payment's reference (pi_…, ch_…, Wise ref).
 *   2. A slot has the same USD amount (to the cent) dated within 3 days.
 *      Catches hand entries made from the bank feed with a different reference.
 */
export function findExisting(slots, { refs = [], amountUsd, date }) {
  const wanted = refs.map((r) => String(r || "").trim().toLowerCase()).filter((r) => r.length >= 6);
  for (const s of slots) {
    if (!s.raw) continue;
    const low = s.raw.toLowerCase();
    if (wanted.some((r) => low.includes(r))) return { slot: s.n, why: "reference" };
  }
  if (amountUsd != null && date) {
    for (const s of slots) {
      if (s.amount == null || !s.date) continue;
      if (Math.abs(s.amount - amountUsd) < 0.005 && dayDiff(s.date, date) <= 3) return { slot: s.n, why: "amount_and_date" };
    }
  }
  return null;
}

/**
 * Decide what to write for one payment on one deal.
 * @returns {{ action: 'already', slot, why } | { action: 'full' } |
 *           { action: 'write', slot, prop, line, total }}
 */
export function planWrite(props, payment) {
  const slots = slotsOf(props);
  const date = String(payment.date || "").slice(0, 10);
  const existing = findExisting(slots, { refs: [payment.ref, ...(payment.altRefs || [])], amountUsd: payment.amountUsd, date });
  if (existing) return { action: "already", ...existing };
  const free = slots.find((s) => !s.raw);
  if (!free) return { action: "full" };
  const parts = [formatAmount(payment.amountUsd), String(payment.ref || "").replace(/,/g, " ").trim() || payment.source, date];
  if (payment.currency && payment.currency !== "USD" && payment.amount != null) {
    parts.push(`${payment.currency} ${Number(payment.amount).toFixed(2)}${payment.fxRate ? ` @ ${Number(payment.fxRate).toFixed(4)}` : ""}`);
  }
  const sum = slots.reduce((t, s) => t + (s.amount || 0), 0);
  const current = parseFloat(props.total_amount_paid);
  // Keep an existing hand-kept total (it may include things not in the slots);
  // otherwise start from the slots, the same fallback Enrollment uses.
  const base = Number.isFinite(current) && current > 0 ? current : sum;
  return { action: "write", slot: free.n, prop: `payment_${free.n}`, line: parts.join(", "), total: round2(base + payment.amountUsd) };
}

// ── turning source records into ledger rows ─────────────────────────────────

/**
 * Card payments carry a surcharge on top (the app fee is $250 + 3.5% =
 * $258.75, and pd-apply logs it as 250). If the charge divided by (1 + rate)
 * lands on a whole dollar, it was surcharged: credit the deal the base amount.
 * Anything else is credited as charged. rate 0 turns this off.
 */
export function removeSurcharge(amount, rate) {
  const r = Number(rate);
  if (!(r > 0)) return { credited: round2(amount), note: null };
  const base = amount / (1 + r);
  if (Math.abs(base - Math.round(base)) < 0.011) {
    const credited = Math.round(base);
    if (credited !== round2(amount)) return { credited, note: `card fee ${+(r * 100).toFixed(2)}% (${formatAmount(amount - credited)}) not credited` };
  }
  return { credited: round2(amount), note: null };
}

const META_DEAL_KEYS = ["hubspot_deal_id", "hs_deal_id", "deal_id", "dealId", "dealid", "hubspotDealId"];
export function metadataDealId(...metas) {
  for (const m of metas) {
    if (!m || typeof m !== "object") continue;
    for (const k of META_DEAL_KEYS) {
      const v = String(m[k] ?? "").trim();
      if (/^\d{6,15}$/.test(v)) return v;
    }
  }
  return null;
}

/**
 * Stripe charge (listed with expand[]=data.payment_intent&expand[]=data.customer)
 * → ledger row, or null when it isn't money in (failed, unpaid).
 */
export function fromStripeCharge(c, { account = "stripe", surchargeRate = 0 } = {}) {
  if (!c || c.status !== "succeeded" || !c.paid) return null;
  const currency = String(c.currency || "").toUpperCase();
  const div = ZERO_DECIMAL.has(currency) ? 1 : 100;
  const pi = typeof c.payment_intent === "object" && c.payment_intent ? c.payment_intent : null;
  const piId = pi ? pi.id : (typeof c.payment_intent === "string" ? c.payment_intent : null);
  const customer = typeof c.customer === "object" && c.customer ? c.customer : null;
  const meta = { ...(customer?.metadata || {}), ...(pi?.metadata || {}), ...(c.metadata || {}) };
  const gross = c.amount / div;
  const { credited, note } = removeSurcharge(gross, surchargeRate);
  return {
    source: "stripe",
    external_id: piId || c.id,
    account,
    received_at: new Date(c.created * 1000).toISOString(),
    amount: credited,
    gross,
    currency,
    fee_note: note,
    payer_name: c.billing_details?.name || customer?.name || null,
    payer_email: (c.billing_details?.email || c.receipt_email || customer?.email || "").toLowerCase() || null,
    reference: [c.description, pi?.description, c.statement_descriptor].filter(Boolean).join(" · ") || null,
    metadata: { ...meta, charge_id: c.id, refunded: !!c.refunded, amount_refunded: (c.amount_refunded || 0) / div },
    fully_refunded: !!c.refunded,
  };
}

/**
 * Wise balance-statement transaction → ledger row, or null when it isn't a
 * payment received from someone (conversions, card spend, outgoing transfers,
 * fee lines). Wise reports the amount net of its receiving fee; we add the fee
 * back so the deal is credited what the family sent.
 */
export function fromWiseTransaction(t, { account = "wise", addBackFees = true } = {}) {
  if (!t || t.type !== "CREDIT") return null;
  const kind = t.details?.type;
  if (kind !== "DEPOSIT") return null;
  const currency = String(t.amount?.currency || "").toUpperCase();
  const net = Number(t.amount?.value);
  if (!(net > 0)) return null;
  const fee = Number(t.totalFees?.value) || 0;
  const amount = addBackFees && fee > 0 ? round2(net + fee) : round2(net);
  return {
    source: "wise",
    external_id: String(t.referenceNumber || ""),
    account,
    received_at: new Date(t.date).toISOString(),
    amount,
    gross: amount,
    currency,
    fee_note: addBackFees && fee > 0 ? `Wise fee ${formatAmount(fee)} added back` : null,
    payer_name: t.details?.senderName || null,
    payer_email: null,
    reference: [t.details?.paymentReference, t.details?.description].filter(Boolean).join(" · ") || null,
    metadata: { senderAccount: t.details?.senderAccount || null },
  };
}

// ── matching ────────────────────────────────────────────────────────────────

export function normalize(s) {
  return String(s || "")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/** "Grace Gragg - Japan Mini Semester" / "Isaac John McCartney — Nepal 2028" → student name. */
export function studentNameOf(dealname) {
  const s = String(dealname || "");
  const m = /^(.*?)\s+[-–—]\s+/.exec(s) || /^(.*?)[-–—]\s/.exec(s);
  return (m ? m[1] : s).trim();
}

/** Deal IDs typed into a reference ("PD-65383262849", "deal 65383262849"). */
export function dealIdsIn(text) {
  return [...new Set(String(text || "").match(/(?<![A-Za-z0-9])\d{9,13}(?![A-Za-z0-9])/g) || [])];
}

/**
 * Deals whose student's first AND last name both appear as whole words in
 * `text`. One name word is never enough — "Smith" would match half the roster.
 */
export function dealsNamedIn(text, deals) {
  const words = new Set(normalize(text).split(" ").filter(Boolean));
  if (!words.size) return [];
  return deals.filter((d) => {
    const parts = normalize(studentNameOf(d.name)).split(" ").filter((w) => w.length >= 2);
    if (parts.length < 2) return false;
    return words.has(parts[0]) && words.has(parts[parts.length - 1]);
  });
}

const NAME_NOISE = new Set(["mr", "mrs", "ms", "miss", "dr", "jr", "sr", "ii", "iii", "iv"]);

/**
 * The (first, last) pairs a bank's account-holder name could mean.
 *   "ROBERT J SMITH"            → robert/smith
 *   "SMITH, ROBERT J"           → robert/smith
 *   "MARIA GARCIA LOPEZ"        → maria/lopez, maria/garcia lopez
 *   "ROBERT OR JANE SMITH"      → robert/smith, jane/smith
 *   "ROBERT & JANE SMITH"       → same
 * Initials, titles and suffixes are dropped. Single names give nothing.
 */
export function nameVariants(raw) {
  const s = String(raw || "").trim();
  if (!s) return [];
  const clean = (t) => normalize(t).split(" ").filter((w) => w.length >= 2 && !NAME_NOISE.has(w));
  const out = [];
  const add = (first, last) => {
    if (!first || !last || first === last) return;
    if (!out.some((v) => v.first === first && v.last === last)) out.push({ first, last });
  };
  const fromWords = (words) => {
    if (words.length < 2) return;
    add(words[0], words[words.length - 1]);
    if (words.length >= 3) add(words[0], words.slice(1).join(" "));
  };
  // "SMITH, ROBERT J" — surname first.
  const comma = /^([^,]+),\s*(.+)$/.exec(s);
  if (comma && !/\b(and|or)\b|&/i.test(s)) {
    const last = clean(comma[1]);
    const first = clean(comma[2]);
    if (last.length && first.length) add(first[0], last.join(" "));
    return out;
  }
  // Joint accounts: split on "and" / "or" / "&"; a shared surname comes last.
  const people = s.split(/\s+(?:and|or)\s+|\s*&\s*|\s*\/\s*/i).map(clean).filter((w) => w.length);
  if (people.length > 1) {
    const shared = people[people.length - 1].length >= 2 ? people[people.length - 1][people[people.length - 1].length - 1] : null;
    for (const words of people) {
      if (words.length >= 2) fromWords(words);
      else if (shared) add(words[0], shared);
    }
    return out;
  }
  fromWords(people[0] || []);
  return out;
}

/**
 * Does a HubSpot contact's name fit one of the variants? Compared on words, so
 * contact "Robert James" / "Smith" and "Maria" / "Garcia Lopez" both fit.
 */
export function contactFits(contact, variants) {
  const first = normalize(contact?.firstname).split(" ").filter(Boolean);
  const last = normalize(contact?.lastname).split(" ").filter(Boolean);
  if (!first.length || !last.length) return false;
  return variants.some((v) => {
    const vl = v.last.split(" ");
    return first[0] === v.first && vl.every((w) => last.includes(w));
  });
}

/** Deals still owed money first, so a family's older paid-off deal doesn't win. */
export function preferOwing(deals) {
  if (deals.length <= 1) return deals;
  const owing = deals.filter((d) => d.amount > 0 && d.paid < d.amount - 0.5);
  return owing.length ? owing : deals;
}

export const candidateSummary = (d) => ({ id: d.id, name: d.name, amount: d.amount, paid: d.paid, pipeline: d.pipeline || null });

/**
 * Decide the deal for one payment. Async lookups are injected so the order of
 * rules is testable without HubSpot:
 *   deps.dealById(id)            → deal | null   (any pipeline)
 *   deps.dealsForEmail(email)    → deals          (open student deals of contacts with that email)
 *   deps.dealsForPerson(name)    → deals          (open student deals of contacts with that full name)
 *   deps.openDeals()             → deals          (open student deals, for name-in-reference)
 *
 * @returns {{ dealId, method, deal } | { review: reason, candidates }}
 */
export async function matchPayment(p, deps) {
  // 0. Already written on a deal (pd-apply's app fee, or a hand entry that
  //    used the Stripe/Wise reference) — find that deal so it's marked done.
  const refs = [p.external_id, p.metadata?.charge_id].map((r) => String(r || "").toLowerCase()).filter((r) => r.length >= 6);
  if (refs.length) {
    const hit = (await deps.openDeals()).find((d) => SLOT_PROPS.some((k) => {
      const v = String(d.props?.[k] || "").toLowerCase();
      return v && refs.some((r) => v.includes(r));
    }));
    if (hit) return { dealId: hit.id, method: "already_on_deal", deal: hit };
  }
  // 1. Explicit deal id in Stripe metadata.
  const metaId = metadataDealId(p.metadata);
  if (metaId) {
    const d = await deps.dealById(metaId);
    if (d) return { dealId: d.id, method: "metadata", deal: d };
  }
  // 2. A deal id typed into the reference. If the reference also names a
  //    student, the name must agree with the deal — a parent paying for two
  //    children who swaps the ids goes to review rather than the wrong deal.
  //    A reference with no recognisable student name is trusted on the id.
  for (const id of dealIdsIn(`${p.reference || ""} ${p.payer_name || ""}`)) {
    const d = await deps.dealById(id);
    if (!d) continue;
    const ref = p.reference || "";
    if (dealsNamedIn(ref, [d]).length) return { dealId: d.id, method: "reference_id", deal: d };
    const others = dealsNamedIn(ref, await deps.openDeals()).filter((x) => x.id !== d.id);
    if (!others.length) return { dealId: d.id, method: "reference_id", deal: d };
    return {
      review: `Reference has deal ID ${d.id} (${studentNameOf(d.name)}) but names ${others.map((x) => studentNameOf(x.name)).join(" / ")}`,
      candidates: [d, ...others].slice(0, 8).map(candidateSummary),
    };
  }
  const seen = new Map();
  const note = (list) => { for (const d of list) seen.set(d.id, d); return list; };
  // 3. Payer email → contact → their open deal.
  if (p.payer_email) {
    const list = preferOwing(note(await deps.dealsForEmail(p.payer_email)));
    if (list.length === 1) return { dealId: list[0].id, method: "email", deal: list[0] };
  }
  // 4. The student's full name in the reference / description / payer name.
  const text = `${p.reference || ""} ${p.payer_name || ""}`;
  if (normalize(text)) {
    const list = preferOwing(note(dealsNamedIn(text, await deps.openDeals())));
    if (list.length === 1) return { dealId: list[0].id, method: "student_name", deal: list[0] };
  }
  // 5. Payer's full name is a contact on exactly one open deal (a parent).
  if (p.payer_name && nameVariants(p.payer_name).length) {
    const list = preferOwing(note(await deps.dealsForPerson(p.payer_name)));
    if (list.length === 1) return { dealId: list[0].id, method: "sender_name", deal: list[0] };
  }
  const candidates = [...seen.values()].slice(0, 8).map(candidateSummary);
  return {
    review: candidates.length > 1 ? "More than one student deal could fit" : "No student deal matched the payer or reference",
    candidates,
  };
}

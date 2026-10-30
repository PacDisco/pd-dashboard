// netlify/functions/_shared/submission-pdf.mjs
//
// One PDF layout for everything a lead or applicant submits, so every
// attachment on a HubSpot contact looks the same:
//
//   renderSubmissionPdf()   the layout (title, name, meta lines, sections of
//                           question → answer rows, footnote, page footer)
//   quizPdf()               gap-year quiz (pd-apply /quiz)
//   referralPdf()           referral form (pd-apply /refer)
//   step1Pdf()              application started but not submitted (step 1 only)
//   metaLeadPdf()           Meta (Facebook / Instagram) instant lead form
//   popupPdf()              website popup
//
// Full applications keep buildApplicationPdf() in application-pdf.mjs (same
// look); the question rows for every pd-apply form come from its
// applicationRows(), so conditional questions and private fields are handled
// the same way everywhere.

// Static import so Netlify's esbuild bundles jspdf into the function. A
// createRequire("jspdf") call is invisible to the bundler and fails on Netlify
// with "Cannot find module 'jspdf'".
import { jsPDF } from "jspdf";
import { pdfText, applicationRows } from "./application-pdf.mjs";

const TEAL = [40, 129, 149];
const INK = [47, 47, 47];
const MUTED = [95, 102, 107];

export const fmtDate = (d) => (d ? new Date(d).toLocaleDateString("en-NZ", { day: "numeric", month: "short", year: "numeric", timeZone: "Pacific/Auckland" }) : "");
export const fmtDateTime = (d) => (d ? new Date(d).toLocaleString("en-US", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit", timeZone: process.env.LEAD_ALERTS_TZ || "America/Los_Angeles", timeZoneName: "short" }) : "");

/**
 * @param {{ title: string, name: string, meta?: string[], sections: { step?: string, title: string, rows: { label: string, value: string }[] }[], footnote?: string }} doc
 * @returns {Uint8Array}
 */
export function renderSubmissionPdf({ title, name, meta = [], sections = [], footnote = "" }) {
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  const W = doc.internal.pageSize.getWidth();
  const H = doc.internal.pageSize.getHeight();
  const M = 48;
  const width = W - M * 2;
  let y = M;
  const ensure = (h) => { if (y + h > H - M) { doc.addPage(); y = M; } };

  doc.setFont("helvetica", "bold"); doc.setFontSize(18); doc.setTextColor(...TEAL);
  for (const line of doc.splitTextToSize(pdfText(title), width)) { doc.text(line, M, y); y += 22; }
  y += 4;
  doc.setFontSize(13); doc.setTextColor(...INK);
  doc.text(pdfText(name), M, y); y += 18;

  doc.setFont("helvetica", "normal"); doc.setFontSize(9.5); doc.setTextColor(...MUTED);
  for (const m of meta.filter(Boolean)) {
    for (const line of doc.splitTextToSize(pdfText(m), width)) { ensure(13); doc.text(line, M, y); y += 13; }
  }
  y += 6;
  doc.setDrawColor(225, 230, 232); doc.line(M, y, W - M, y); y += 18;

  let lastStep = null;
  for (const s of sections) {
    if (!s.rows?.length) continue;
    if (s.step && s.step !== lastStep) {
      ensure(40);
      doc.setFont("helvetica", "bold"); doc.setFontSize(9); doc.setTextColor(...MUTED);
      doc.text(pdfText(String(s.step).toUpperCase()), M, y); y += 14;
      lastStep = s.step;
    }
    if (s.title) {
      ensure(34);
      doc.setFont("helvetica", "bold"); doc.setFontSize(12); doc.setTextColor(...TEAL);
      doc.text(pdfText(s.title), M, y); y += 16;
    }
    for (const r of s.rows) {
      doc.setFont("helvetica", "bold"); doc.setFontSize(9.5);
      const label = doc.splitTextToSize(pdfText(r.label), width);
      doc.setFont("helvetica", "normal"); doc.setFontSize(10);
      const value = doc.splitTextToSize(pdfText(r.value === "" || r.value == null ? "-" : r.value), width - 10);
      ensure(label.length * 12 + Math.min(value.length, 4) * 13 + 8);
      doc.setFont("helvetica", "bold"); doc.setFontSize(9.5); doc.setTextColor(...INK);
      doc.text(label, M, y); y += label.length * 12;
      doc.setFont("helvetica", "normal"); doc.setFontSize(10); doc.setTextColor(...MUTED);
      for (const line of value) { ensure(13); doc.text(line, M + 10, y); y += 13; }
      y += 7;
    }
    y += 8;
  }

  if (footnote) {
    ensure(40);
    doc.setFont("helvetica", "italic"); doc.setFontSize(9.5); doc.setTextColor(...MUTED);
    const note = doc.splitTextToSize(pdfText(footnote), width);
    doc.text(note, M, y); y += note.length * 12;
  }

  const pages = doc.getNumberOfPages();
  for (let i = 1; i <= pages; i++) {
    doc.setPage(i);
    doc.setFont("helvetica", "normal"); doc.setFontSize(8); doc.setTextColor(...MUTED);
    doc.text(`Generated ${fmtDate(new Date())} - page ${i} of ${pages}`, M, H - 24);
  }
  return new Uint8Array(doc.output("arraybuffer"));
}

// ── helpers ─────────────────────────────────────────────────────────────────

export function safeFileName(kind, name, when) {
  const safe = String(name || "").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "Contact";
  const day = new Date(when || Date.now()).toISOString().slice(0, 10);
  return `${kind}-${safe}-${day}.pdf`;
}

const personName = (first, last, email) => [first, last].filter(Boolean).join(" ").trim() || email || "Unknown";

/** "facebook / paid_social / fall-quiz" from a pd-apply attribution blob. */
export function sourceLine(attribution) {
  const t = attribution?.first || attribution?.last || attribution || {};
  const parts = [t.utm_source, t.utm_medium, t.utm_campaign].filter(Boolean);
  if (parts.length) return `Came from: ${parts.join(" / ")}`;
  if (t.referrer) return `Came from: ${t.referrer}`;
  return null;
}

const privateNote = (n) => (n ? `${n} private answer(s) are not included in this copy. See the Apply Form dashboard for the full record.` : "");

// ── quiz ────────────────────────────────────────────────────────────────────

/**
 * The quiz shows one question per section, so its sections have no real
 * titles; print one block per step ("Quiz answers", "Contact details").
 */
export function flattenSteps(sections, titles = {}) {
  const out = [];
  for (const s of sections) {
    const last = out[out.length - 1];
    if (last && last.key === s.step) last.rows.push(...s.rows);
    else out.push({ key: s.step, title: titles[s.step] || s.step, rows: [...s.rows] });
  }
  return out.map(({ title, rows }) => ({ title, rows }));
}

export function quizPdf({ resp, schema, includePrivate = false }) {
  const arch = (schema?.archetypes || []).find((a) => a.key === resp.archetype);
  const rows = applicationRows(schema, resp.answers || {}, { includePrivate });
  const stepTitle = (key) => (schema?.steps || []).find((st) => st.key === key)?.title || key;
  const titles = { [stepTitle("quiz")]: "Quiz answers", [stepTitle("contact")]: "Contact details" };
  const sections = flattenSteps(rows.sections, titles);
  const { omittedPrivate } = rows;
  const scores = resp.scores && typeof resp.scores === "object"
    ? Object.entries(resp.scores).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${(schema?.archetypes || []).find((a) => a.key === k)?.name || k} ${v}`).join(", ")
    : "";
  const name = personName(resp.first_name, resp.last_name, resp.email);
  return {
    name,
    fileName: safeFileName("Quiz", name, resp.created_at),
    bytes: renderSubmissionPdf({
      title: "Pacific Discovery - Gap Year Quiz",
      name,
      meta: [
        `Result: ${arch?.name || resp.archetype || "-"}`,
        scores && `Scores: ${scores}`,
        resp.email && `Email: ${resp.email}`,
        resp.phone && `Phone: ${resp.phone}`,
        `Completed: ${fmtDateTime(resp.created_at)}`,
        sourceLine(resp.attribution),
        `Quiz response ID: ${resp.id}`,
      ],
      sections,
      footnote: privateNote(omittedPrivate),
    }),
    noteTitle: `Gap year quiz — ${name}`,
    noteLines: [`Result: ${arch?.name || resp.archetype || "—"}`, "Completed on apply.pacificdiscovery.org/quiz. PDF attached."],
  };
}

// ── referral ────────────────────────────────────────────────────────────────

export function referralPdf({ ref, schema, includePrivate = false }) {
  const { sections, omittedPrivate } = applicationRows(schema, ref.answers || {}, { includePrivate });
  const referrer = personName(ref.referrer_first_name, ref.referrer_last_name, ref.referrer_email);
  const referred = personName(ref.referred_first_name, ref.referred_last_name, ref.referred_email);
  return {
    name: referred,
    fileName: safeFileName("Referral", `${referred}-by-${referrer}`, ref.created_at),
    bytes: renderSubmissionPdf({
      title: "Pacific Discovery - Referral",
      name: `${referred}, referred by ${referrer}`,
      meta: [
        `Referrer: ${referrer} <${ref.referrer_email}>${ref.referrer_type ? ` (${ref.referrer_type})` : ""}`,
        `Referred: ${referred} <${ref.referred_email}>`,
        `Submitted: ${fmtDateTime(ref.created_at)}`,
        sourceLine(ref.attribution),
        `Referral ID: ${ref.id}`,
      ],
      sections,
      footnote: privateNote(omittedPrivate),
    }),
    noteTitle: `Referral — ${referred}, referred by ${referrer}`,
    noteLines: [`Referrer type: ${ref.referrer_type || "—"}`, "Submitted on apply.pacificdiscovery.org/refer. PDF attached."],
  };
}

// ── application step 1 only ─────────────────────────────────────────────────

export function step1Pdf({ app, schema, includePrivate = false }) {
  const { sections, omittedPrivate } = applicationRows(schema, app.answers || {}, { includePrivate, steps: ["step1"] });
  const name = personName(app.first_name, app.last_name, app.email);
  return {
    name,
    fileName: safeFileName("Application-Started", name, app.step1_at || app.created_at),
    bytes: renderSubmissionPdf({
      title: "Pacific Discovery - Application Started (step 1)",
      name,
      meta: [
        app.program && `Program: ${app.program}`,
        app.term && `Travel dates: ${app.term}`,
        app.email && `Email: ${app.email}`,
        `Started: ${fmtDateTime(app.step1_at || app.created_at)}`,
        "Full application: not submitted yet",
        sourceLine(app.attribution),
        `Application ID: ${app.id}`,
      ],
      sections,
      footnote: privateNote(omittedPrivate),
    }),
    noteTitle: `Application started — ${name}`,
    noteLines: [[app.program, app.term].filter(Boolean).join(" · "), "Step 1 completed on apply.pacificdiscovery.org; full application not submitted yet. PDF attached."].filter(Boolean),
  };
}

// ── Meta instant lead form ──────────────────────────────────────────────────

const STD_LABELS = {
  email: "Email", full_name: "Full name", first_name: "First name", last_name: "Last name",
  phone_number: "Phone number", city: "City", state: "State", province: "Province", country: "Country",
  zip_code: "ZIP code", post_code: "Post code", street_address: "Street address", date_of_birth: "Date of birth",
  gender: "Gender", job_title: "Job title", company_name: "Company",
};
const humanize = (k) => STD_LABELS[k] || String(k).replace(/_+/g, " ").replace(/^\w/, (c) => c.toUpperCase());

/** Rows for a lead's field_data, labelled from the form's questions. */
export function metaLeadRows(fieldData = [], questions = []) {
  const labels = new Map((questions || []).map((q) => [q.key, q.label]));
  return (fieldData || []).map((f) => ({
    label: labels.get(f.name) || humanize(f.name),
    value: (f.values || []).map((v) => String(v).replace(/_/g, " ")).join(", "),
  }));
}

export function metaLeadName(lead) {
  const fd = Object.fromEntries((lead.field_data || []).map((f) => [f.name, (f.values || [])[0] || ""]));
  return [fd.first_name, fd.last_name].filter(Boolean).join(" ").trim() || fd.full_name || lead.email || "Meta lead";
}

export function metaLeadPdf({ lead }) {
  const name = metaLeadName(lead);
  const platform = { fb: "Facebook", ig: "Instagram", an: "Audience Network", msg: "Messenger" }[lead.platform] || lead.platform;
  return {
    name,
    fileName: safeFileName("Meta-Lead-Form", name, lead.created_time),
    bytes: renderSubmissionPdf({
      title: "Pacific Discovery - Meta Lead Form",
      name,
      meta: [
        lead.form_name && `Form: ${lead.form_name}`,
        lead.campaign_name && `Campaign: ${lead.campaign_name}`,
        lead.adset_name && `Ad set: ${lead.adset_name}`,
        lead.ad_name && `Ad: ${lead.ad_name}`,
        platform && `Platform: ${platform}${lead.is_organic ? " (organic)" : ""}`,
        `Submitted: ${fmtDateTime(lead.created_time)}`,
        `Lead ID: ${lead.id}`,
      ],
      sections: [{ title: "Answers", rows: metaLeadRows(lead.field_data, lead.questions) }],
    }),
    noteTitle: `Meta lead form — ${name}`,
    noteLines: [[lead.form_name, lead.campaign_name].filter(Boolean).join(" · "), `Submitted on ${platform || "Meta"}. PDF attached.`].filter(Boolean),
  };
}

// ── website popup ───────────────────────────────────────────────────────────

export function popupPdf({ popup, values, page, when = new Date() }) {
  const rows = [];
  for (const f of popup.fields || []) {
    if (!f.on || values[f.key] == null) continue;
    const opt = f.options?.find((o) => o.value === values[f.key]);
    rows.push({ label: f.label || f.key, value: opt ? opt.label : String(values[f.key]) });
  }
  const name = personName(values.firstname, values.lastname, values.email);
  return {
    name,
    fileName: safeFileName("Popup", name, when),
    bytes: renderSubmissionPdf({
      title: "Pacific Discovery - Website Form",
      name,
      meta: [
        `Form: ${popup.name || popup.id}`,
        page?.title && `Page: ${page.title}`,
        page?.uri && `URL: ${page.uri}`,
        `Submitted: ${fmtDateTime(when)}`,
      ],
      sections: [{ title: "Answers", rows }],
    }),
  };
}

export function noteHtml(title, lines = []) {
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  return `<p><strong>${esc(title)}</strong>${lines.filter(Boolean).map((l) => `<br>${esc(l)}`).join("")}</p>`;
}

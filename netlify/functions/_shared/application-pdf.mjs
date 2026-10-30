// netlify/functions/_shared/application-pdf.mjs
//
// Turns one pd-apply application (the `applications` row + the form version it
// was filled in on) into a PDF, laid out the way the applicant saw it: steps,
// sections, every question that was shown to them, and their answer.
//
// PRIVATE FIELDS
// --------------
// Fields marked "Private (health / passport)" in the Apply Form editor are left
// out unless APPLICATION_PDF_INCLUDE_PRIVATE=true. The PDF is attached in
// HubSpot, which every HubSpot user across PD, Pure Exploration and Unearthed
// can open; the private answers stay in the Apply Form dashboard and the
// portals, which already gate them.

// Static import so Netlify's esbuild bundles jspdf into the function. A
// createRequire("jspdf") call is invisible to the bundler and fails on Netlify
// with "Cannot find module 'jspdf'".
import { jsPDF } from "jspdf";
import { allFields, isInput, isVisible, valueText, dateText } from "../../../apply-form/form-kit.mjs";

/** jsPDF's built-in Helvetica is WinAnsi: map what we can, drop the rest. */
export function pdfText(s) {
  return String(s ?? "")
    .normalize("NFC")
    .replace(/[‘’‚′]/g, "'")
    .replace(/[“”„″]/g, '"')
    .replace(/[–—−]/g, "-")
    .replace(/…/g, "...")
    .replace(/[   ]/g, " ")
    .replace(/\r\n?/g, "\n")
    .replace(/[^\n\x20-\x7E¡-ÿ]/g, "?");
}

export function answerText(field, v) {
  if (v == null || v === "") return "";
  if (field.type === "date") return dateText(v) || String(v);
  return valueText(field, v);
}

/**
 * The questions to print, grouped by step and section. `steps` limits it to
 * those step keys (e.g. ["step1"] for an application that stopped at step 1).
 * @returns {{ sections: [{ step, title, rows: [{ label, value }] }], omittedPrivate: number }}
 */
export function applicationRows(schema, answers = {}, { includePrivate = false, steps = null } = {}) {
  const sections = [];
  let omittedPrivate = 0;
  const byKey = new Map();
  for (const step of schema?.steps || []) {
    if (steps && !steps.includes(step.key)) continue;
    for (const section of step.sections || []) {
      const entry = { step: step.title || step.key, title: section.title || section.key, rows: [] };
      byKey.set(`${step.key}/${section.key}`, entry);
      sections.push(entry);
    }
  }
  for (const { field, step, section } of allFields(schema)) {
    if (steps && !steps.includes(step)) continue;
    if (!isInput(field) || field.type === "hidden" || field.hidden) continue;
    if (!isVisible(schema, field, answers)) continue;
    if (field.sensitive && !includePrivate) { omittedPrivate++; continue; }
    const value = answerText(field, answers[field.key]);
    byKey.get(`${step}/${section}`)?.rows.push({ label: field.label || field.key, value: value || "-" });
  }
  return { sections: sections.filter((s) => s.rows.length), omittedPrivate };
}

const fmtDate = (d) => (d ? new Date(d).toLocaleDateString("en-NZ", { day: "numeric", month: "short", year: "numeric", timeZone: "Pacific/Auckland" }) : "");

export function applicantName(app) {
  return [app.first_name, app.last_name].filter(Boolean).join(" ").trim() || app.email || "Applicant";
}

export function pdfFileName(app) {
  const safe = applicantName(app).replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "") || "Applicant";
  const day = new Date(app.step2_at || app.created_at || Date.now()).toISOString().slice(0, 10);
  return `Application-${safe}-${day}.pdf`;
}

/** @returns {Uint8Array} */
export function buildApplicationPdf({ app, schema, includePrivate = false }) {
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  const W = doc.internal.pageSize.getWidth();
  const H = doc.internal.pageSize.getHeight();
  const M = 48;
  const width = W - M * 2;
  let y = M;

  const ensure = (h) => { if (y + h > H - M) { doc.addPage(); y = M; } };
  const teal = [40, 129, 149];
  const ink = [47, 47, 47];
  const muted = [95, 102, 107];

  doc.setFont("helvetica", "bold"); doc.setFontSize(18); doc.setTextColor(...teal);
  doc.text("Pacific Discovery - Student Application", M, y); y += 26;
  doc.setFontSize(13); doc.setTextColor(...ink);
  doc.text(pdfText(applicantName(app)), M, y); y += 18;

  doc.setFont("helvetica", "normal"); doc.setFontSize(9.5); doc.setTextColor(...muted);
  const meta = [
    app.program && `Program: ${app.program}`,
    app.term && `Travel dates: ${app.term}`,
    app.email && `Email: ${app.email}`,
    app.step1_at && `Started: ${fmtDate(app.step1_at)}`,
    app.step2_at && `Application submitted: ${fmtDate(app.step2_at)}`,
    app.paid_at && `Application fee paid: ${fmtDate(app.paid_at)}`,
    `Application ID: ${app.id}`,
  ].filter(Boolean);
  for (const line of meta) { doc.text(pdfText(line), M, y); y += 13; }
  y += 6;
  doc.setDrawColor(225, 230, 232); doc.line(M, y, W - M, y); y += 18;

  const { sections, omittedPrivate } = applicationRows(schema, app.answers || {}, { includePrivate });
  let lastStep = null;
  for (const s of sections) {
    if (s.step !== lastStep) {
      ensure(40);
      doc.setFont("helvetica", "bold"); doc.setFontSize(9); doc.setTextColor(...muted);
      doc.text(pdfText(String(s.step).toUpperCase()), M, y); y += 14;
      lastStep = s.step;
    }
    ensure(34);
    doc.setFont("helvetica", "bold"); doc.setFontSize(12); doc.setTextColor(...teal);
    doc.text(pdfText(s.title), M, y); y += 16;
    for (const r of s.rows) {
      doc.setFont("helvetica", "bold"); doc.setFontSize(9.5); doc.setTextColor(...ink);
      const label = doc.splitTextToSize(pdfText(r.label), width);
      doc.setFont("helvetica", "normal"); doc.setFontSize(10);
      const value = doc.splitTextToSize(pdfText(r.value), width - 10);
      ensure(label.length * 12 + Math.min(value.length, 4) * 13 + 8);
      doc.setFont("helvetica", "bold"); doc.setFontSize(9.5); doc.setTextColor(...ink);
      doc.text(label, M, y); y += label.length * 12;
      doc.setFont("helvetica", "normal"); doc.setFontSize(10); doc.setTextColor(...muted);
      for (const line of value) { ensure(13); doc.text(line, M + 10, y); y += 13; }
      y += 7;
    }
    y += 8;
  }

  if (omittedPrivate) {
    ensure(40);
    doc.setFont("helvetica", "italic"); doc.setFontSize(9.5); doc.setTextColor(...muted);
    const note = doc.splitTextToSize(`${omittedPrivate} private answer(s) - health, passport and similar - are not included in this copy. See the Apply Form dashboard (Applications) for the full record.`, width);
    doc.text(note, M, y); y += note.length * 12;
  }

  const pages = doc.getNumberOfPages();
  for (let i = 1; i <= pages; i++) {
    doc.setPage(i);
    doc.setFont("helvetica", "normal"); doc.setFontSize(8); doc.setTextColor(...muted);
    doc.text(`Generated ${fmtDate(new Date())} · page ${i} of ${pages}`.replace("·", "-"), M, H - 24);
  }
  return new Uint8Array(doc.output("arraybuffer"));
}

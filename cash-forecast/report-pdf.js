/**
 * Fiscal-year cash flow report — drawn as a PDF in the browser.
 *
 * WHY IN THE BROWSER
 * ------------------
 * The page already holds the forecast it is showing — server-computed with the
 * Xero actuals, or the live preview while editing — and that is exactly what
 * the reader expects to get on paper. Building the PDF server-side would mean a
 * second request that re-derives the same forecast and could disagree with the
 * screen, plus a headless browser in a function. Here it is one click and the
 * file is the screen.
 *
 * WHY VENDORED, AND WHY LAZY
 * --------------------------
 * jsPDF and the AutoTable plugin are served from ./vendor/ rather than a CDN:
 * this page carries bank balances, so it should not grow a third-party script
 * dependency for a feature used a few times a quarter. They load on the first
 * export only — around 450 KB nobody pays for until they ask for a PDF.
 *
 * Standard PDF fonts only cover the Windows-1252 character set, so every
 * string goes through `pdfText`, which swaps the handful of characters the
 * dashboard uses outside it (the true minus, arrows) for ones that print.
 */

import { longDate } from "./report.mjs";

/* ------------------------------------------------------------------ */
/* loading                                                             */
/* ------------------------------------------------------------------ */

let libs = null;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error(`Could not load ${src}`));
    document.head.appendChild(s);
  });
}

async function loadLibs() {
  if (libs) return libs;
  libs = (async () => {
    if (!window.jspdf?.jsPDF) {
      await loadScript(new URL("./vendor/jspdf.umd.min.js", import.meta.url).href);
    }
    const { autoTable } = await import("./vendor/jspdf.plugin.autotable.mjs");
    return { jsPDF: window.jspdf.jsPDF, autoTable };
  })();
  try {
    return await libs;
  } catch (err) {
    libs = null; // let the next click retry rather than caching the failure
    throw err;
  }
}

/* ------------------------------------------------------------------ */
/* formatting                                                          */
/* ------------------------------------------------------------------ */

/** Characters the standard fonts cannot print, swapped for ones they can. */
export function pdfText(s) {
  return String(s ?? "")
    .replace(/−/g, "-")              // true minus
    .replace(/\s*→\s*/g, " > ")      // arrow, as in "Diagnostics → Refresh"
    .replace(/\s*←\s*/g, " < ")
    .replace(/≤/g, "<=")
    .replace(/≥/g, ">=")
    .replace(/ /g, " ")              // non-breaking space
    // Anything else outside Latin-1 and the Windows-1252 extras it can print.
    .replace(/[^\x00-\xff–—‘’“”•…€]/g, "");
}

/**
 * Accounting style: negatives in brackets, zero as a dash. Brackets rather than
 * a minus because a leading "-" is easy to lose at 7pt in a column of numbers,
 * and this is the convention an accountant reading the PDF will expect.
 */
export function acct(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return "n/a";
  const r = Math.round(n);
  if (r === 0) return "–";
  const s = Math.abs(r).toLocaleString("en-NZ");
  return r < 0 ? `(${s})` : s;
}

function shortMoney(v) {
  const a = Math.abs(v);
  if (a >= 1e6) return `${(v / 1e6).toFixed(1)}m`;
  if (a >= 1e3) return `${Math.round(v / 1e3)}k`;
  return `${Math.round(v)}`;
}

/* ------------------------------------------------------------------ */
/* palette — the dashboard's tokens, as RGB                            */
/* ------------------------------------------------------------------ */

const C = {
  topaz: [85, 187, 210],
  topazDark: [40, 129, 149],
  topazDarker: [30, 106, 122],
  topazSoft: [234, 247, 250],
  actualTint: [242, 248, 250],
  actualHead: [228, 241, 245],
  ink: [74, 74, 74],
  heading: [44, 44, 44],
  muted: [107, 114, 128],
  faint: [152, 162, 179],
  line: [228, 232, 239],
  rule: [207, 214, 224],
  sunk: [246, 248, 250],
  over: [176, 42, 55],
  overSoft: [253, 236, 238],
  warn: [138, 83, 16],
  warnSoft: [253, 243, 227],
  good: [47, 125, 50],
  grey: [176, 184, 196],
};

/* A4 landscape, millimetres. */
const PAGE_W = 297;
const PAGE_H = 210;
const M = 14;
const CONTENT_W = PAGE_W - 2 * M;

/* ------------------------------------------------------------------ */
/* the document                                                        */
/* ------------------------------------------------------------------ */

/**
 * Build the PDF. Returns the jsPDF document; `exportCashFlowPdf` saves it.
 *
 * @param report  fiscalYearReport() output
 * @param meta    { generatedAt: Date, generatedBy, planningRate, planningRateLabel,
 *                  draft: boolean, entity }
 */
export async function buildCashFlowPdf(report, meta) {
  const { jsPDF, autoTable } = await loadLibs();
  const doc = new jsPDF({ orientation: "landscape", unit: "mm", format: "a4", compress: true });
  const fy = report.fiscalYear;
  const entity = meta.entity || "Pacific Discovery";

  doc.setProperties({
    title: pdfText(`${entity} cash flow report ${fy.label}`),
    subject: pdfText(`Monthly cash flow, ${fy.range}`),
    author: pdfText(meta.generatedBy || entity),
    creator: "Pacific Discovery dashboards — Cash Forecast",
  });

  const T = (s) => pdfText(s);

  /* ---------------- page 1: summary and chart ---------------- */

  let y = header(doc, report, meta, entity);

  if (meta.draft) {
    y = banner(doc, y, C.warnSoft, C.warn,
      "DRAFT — this report includes unsaved changes. Save the model and export again for a copy that matches the stored forecast.");
  }
  if (fy.noPrograms) {
    y = banner(doc, y, C.warnSoft, C.warn,
      `No programs are entered for ${fy.label}. Figures are overheads only and do not forecast this year's cash.`);
  }

  const s = report.summary;
  y = tiles(doc, y, [
    { k: "NZD account 1 Apr", v: s.openingBase, sub: "Opening balance" },
    { k: "Cash in", v: s.cashIn, sub: "NZD equivalent" },
    { k: "Cash out", v: -s.cashOut, sub: "NZD" },
    { k: "NZD account 31 Mar", v: s.closingBase, sub: "Closing balance", alert: s.closingBase < 0 },
    { k: "Lowest NZD account", v: s.lowestBase, sub: s.lowestBaseMonth, alert: s.lowestBase < 0 },
  ], 13);
  y = tiles(doc, y + 2.5, [
    { k: "Net movement", v: s.net, sub: "Cash in less cash out" },
    { k: "USD converted", v: s.fxConverted, sub: s.fxConvertedPartial && s.actualMonths ? "Forecast months only" : `@ ${meta.planningRate?.toFixed(4) ?? "—"}` },
    { k: "USD held 31 Mar", v: s.usdHeld, sub: "Unconverted, USD" },
    { k: "Total position 31 Mar", v: s.totalPosition, sub: "Incl. unconverted USD", alert: s.totalPosition < 0 },
    { k: "Revenue recognised", v: s.recognisedRevenue, sub: "Moved to sales in year" },
  ], 10);

  y += 6;
  doc.setFont("helvetica", "bold"); doc.setFontSize(10); doc.setTextColor(...C.heading);
  doc.text(T("NZD account by month"), M, y);
  doc.setFont("helvetica", "normal"); doc.setFontSize(8); doc.setTextColor(...C.faint);
  doc.text(T("Closing balance, NZD. Shaded months are closed and use Xero actuals."), M + 42, y);
  chart(doc, report.chart, M, y + 3, CONTENT_W, PAGE_H - M - 10 - (y + 3));

  /* ---------------- page 2: the monthly table ---------------- */

  doc.addPage();
  y = pageTitle(doc, "Monthly cash flow", `${fy.label} · ${fy.range} · NZD unless stated`);

  const cols = report.columns;
  const head = [[
    { content: "", styles: { halign: "left" } },
    ...cols.map((c) => ({ content: c.isActual ? `${c.label}\nActual` : `${c.label}\nForecast`, isActual: c.isActual })),
    { content: "Year\nTotal / 31 Mar" },
  ]];

  const body = [];
  for (const r of report.rows) {
    if (r.section) {
      body.push([{ content: T(r.section.toUpperCase()), colSpan: cols.length + 2, styles: {
        fontSize: 6.5, textColor: C.faint, fontStyle: "bold", halign: "left",
        cellPadding: { top: 3, bottom: 1, left: 2, right: 2 }, fillColor: [255, 255, 255],
      } }]);
      continue;
    }
    const label = r.kind === "balance" && !r.variance ? `${r.label}` : r.label;
    body.push([
      { content: T(label), _row: r },
      ...r.values.map((v, i) => ({
        content: v === null ? (r.variance ? "–" : "n/a") : acct(v),
        _row: r, _v: v, _col: cols[i],
      })),
      { content: r.total === null ? "n/a" : `${acct(r.total)}${r.partialTotal ? "*" : ""}`,
        _row: r, _v: r.total, _total: true },
    ]);
  }

  const labelW = 40;
  const totalW = 21;
  const monthW = (CONTENT_W - labelW - totalW) / cols.length;

  autoTable(doc, {
    startY: y + 1,
    head,
    body,
    theme: "plain",
    margin: { left: M, right: M, bottom: 16 },
    styles: {
      font: "helvetica", fontSize: 7.2, cellPadding: { top: 1.6, bottom: 1.6, left: 1.5, right: 1.5 },
      textColor: C.ink, halign: "right", valign: "middle", lineColor: C.line, overflow: "visible",
    },
    headStyles: {
      fontSize: 6.3, fontStyle: "bold", textColor: C.muted, fillColor: C.sunk, halign: "right",
    },
    columnStyles: {
      0: { halign: "left", cellWidth: labelW },
      ...Object.fromEntries(cols.map((_, i) => [i + 1, { cellWidth: monthW }])),
      [cols.length + 1]: { cellWidth: totalW, fontStyle: "bold" },
    },
    didParseCell(data) {
      const raw = data.cell.raw ?? {};
      if (data.section === "head") {
        if (raw.isActual) { data.cell.styles.fillColor = C.actualHead; data.cell.styles.textColor = C.topazDarker; }
        if (data.column.index === cols.length + 1) { data.cell.styles.textColor = C.heading; }
        return;
      }
      const r = raw._row;
      if (!r) return;
      const st = data.cell.styles;
      const col = raw._col;

      if (col?.isActual) st.fillColor = C.actualTint;
      if (raw._total) st.fillColor = C.sunk;

      if (r.style === "strong") st.fontStyle = "bold";
      if (r.style === "rule") { st.fontStyle = "bold"; st.textColor = C.heading; }
      if (r.style === "muted") { st.textColor = C.faint; st.fontSize = 6.8; }
      if (data.column.index === 0 && (r.style === "strong" || r.style === "rule")) st.textColor = C.heading;
      if (data.column.index === 0 && !r.style) st.textColor = C.muted;

      // A forecast figure inside a closed month must not read as banked.
      if (col?.isActual && !r.realWhenClosed) { st.fontStyle = "italic"; st.textColor = [154, 166, 180]; }
      if (raw._v === null && data.column.index > 0) { st.textColor = [184, 192, 203]; st.fontStyle = "italic"; }

      if (typeof raw._v === "number" && Math.round(raw._v) < 0 && data.column.index > 0) {
        st.textColor = col?.isActual && !r.realWhenClosed ? [208, 154, 149] : C.over;
      }
      if (r.variance && typeof raw._v === "number" && Math.round(raw._v) > 0) st.textColor = C.good;
    },
    didDrawCell(data) {
      if (data.section !== "body") return;
      const r = data.cell.raw?._row;
      // The NZD account is the row that says whether a supplier can be paid —
      // ruled off above, as on the screen.
      if (r?.style === "rule") {
        doc.setDrawColor(...C.rule); doc.setLineWidth(0.5);
        doc.line(data.cell.x, data.cell.y, data.cell.x + data.cell.width, data.cell.y);
      } else if (r && !r.section) {
        doc.setDrawColor(...C.line); doc.setLineWidth(0.15);
        doc.line(data.cell.x, data.cell.y + data.cell.height, data.cell.x + data.cell.width, data.cell.y + data.cell.height);
      }
      // Divider before the year column.
      if (data.column.index === cols.length + 1) {
        doc.setDrawColor(148, 163, 184); doc.setLineWidth(0.4);
        doc.line(data.cell.x, data.cell.y, data.cell.x, data.cell.y + data.cell.height);
      }
    },
  });

  y = doc.lastAutoTable.finalY + 5;
  const foot = [
    "Year column: flow rows are the sum of the twelve months; balance rows (USD balance, NZD account, total position, deferred revenue) are the 31 March figure.",
    "Negative figures are shown in brackets. Headline rows are NZD; treasury rows marked USD are native USD.",
  ];
  if (report.rows.some((r) => r.partialTotal)) {
    foot.push("* Total of the months that can be derived. Closed months cannot separate a currency conversion from a customer payment, so they show n/a.");
  }
  if (report.summary.actualMonths) {
    foot.push(`Actual columns (through ${report.summary.actualsThrough}) use Xero for cash in, cash out and the balances. Figures in italics are still forecast: a bank summary gives a month's totals, not the split across categories.`);
  }
  y = footnotes(doc, y, foot);

  /* ---------------- page 3: programs, notes, basis ---------------- */

  doc.addPage();
  y = pageTitle(doc, "Programs departing in the year", `${report.programs.length} program${report.programs.length === 1 ? "" : "s"} · revenue and costs in NZD at the planning rate`);

  if (report.programs.length) {
    const pt = report.programTotals;
    autoTable(doc, {
      startY: y + 1,
      head: [["Program", "Season", "Departs", "Pax", "Revenue", "Total cost", "Gross profit", "GP %"]],
      body: [
        ...report.programs.map((p) => [
          T(p.name), T(p.season ?? ""), p.startDate ? fmtIsoDate(p.startDate) : "—",
          String(p.pax ?? 0), acct(p.revenue), acct(p.cost), acct(p.grossProfit),
          p.gpPct === null ? "—" : `${p.gpPct.toFixed(1)}%`,
        ]),
        [
          { content: `${fy.label} total`, colSpan: 3, styles: { halign: "left" } },
          String(pt.pax), acct(pt.revenue), acct(pt.cost), acct(pt.grossProfit),
          pt.revenue > 0 ? `${((pt.grossProfit / pt.revenue) * 100).toFixed(1)}%` : "—",
        ],
      ],
      theme: "plain",
      margin: { left: M, right: M, bottom: 16 },
      styles: { font: "helvetica", fontSize: 8, cellPadding: { top: 1.8, bottom: 1.8, left: 2, right: 2 },
        textColor: C.ink, halign: "right" },
      headStyles: { fontSize: 7, fontStyle: "bold", textColor: C.muted, fillColor: C.sunk },
      columnStyles: { 0: { halign: "left", cellWidth: 78 }, 1: { halign: "left" }, 2: { halign: "left" } },
      didParseCell(data) {
        if (data.section === "head" && data.column.index <= 2) data.cell.styles.halign = "left";
        if (data.section !== "body") return;
        const isTotal = data.row.index === report.programs.length;
        if (isTotal) { data.cell.styles.fontStyle = "bold"; data.cell.styles.fillColor = C.sunk; data.cell.styles.textColor = C.heading; }
        // GP % bands match the Programs tab: red under 20, amber under 35.
        if (data.column.index === 7) {
          const p = isTotal ? null : report.programs[data.row.index];
          const pct = isTotal ? (pt.revenue > 0 ? (pt.grossProfit / pt.revenue) * 100 : null) : p.gpPct;
          if (pct !== null) data.cell.styles.textColor = pct < 20 ? C.over : pct < 35 ? [154, 107, 31] : C.good;
        }
        if (data.column.index === 6 && String(data.cell.raw).startsWith("(")) data.cell.styles.textColor = C.over;
      },
      didDrawCell(data) {
        if (data.section !== "body") return;
        doc.setDrawColor(...C.line); doc.setLineWidth(0.15);
        doc.line(data.cell.x, data.cell.y + data.cell.height, data.cell.x + data.cell.width, data.cell.y + data.cell.height);
      },
    });
    y = doc.lastAutoTable.finalY + 3;
    y = footnotes(doc, y, [
      "Gross profit is revenue less the program's own costs, before overheads. GP % is against revenue, not a markup on cost.",
    ]);
  } else {
    doc.setFont("helvetica", "normal"); doc.setFontSize(9); doc.setTextColor(...C.muted);
    doc.text(T(`No programs depart in ${fy.label}.`), M, y + 4);
    y += 10;
  }

  /* Notes and basis of preparation, side by side.
   *
   * Stacked, the basis paragraphs routinely spilled a few lines onto a page of
   * their own. Side by side they share the space under the programs table and
   * move together, so neither is orphaned. */
  const basis = [
    `Fiscal year ${fy.range}. Figures are NZD unless marked USD.`,
    `Cash is modelled from each program's deposits and balances on the booking curve; revenue is recognised separately, in the months up to and including departure. The gap between the two is deferred revenue.`,
    `Funds are collected in USD and converted only when the NZD account would fall below its minimum buffer. Planning rate ${meta.planningRate?.toFixed(4) ?? "—"} USD to NZD (${meta.planningRateLabel || "pinned"}). Total position values unconverted USD at that rate and is not spendable cash.`,
    report.summary.actualMonths
      ? `Closed months (${report.summary.actualMonths}, through ${report.summary.actualsThrough}) are locked to Xero actuals, and every month after them re-bases onto the real closing balance.`
      : "No months in this year are closed; every figure is forecast.",
    `Generated from the Cash Forecast dashboard${meta.draft ? " with unsaved changes" : ""} on ${longDate(meta.generatedAt)}.`,
  ];
  const gutter = 8;
  const leftW = CONTENT_W * 0.6 - gutter / 2;
  const rightX = M + leftW + gutter;
  const rightW = CONTENT_W - leftW - gutter;
  const notes = report.notes.length ? report.notes : [{ level: "info", text: "No warnings for this year." }];
  const notesH = notes.reduce((h, n) => h + noteHeight(doc, n, leftW), 0);
  const basisH = basis.reduce((h, b) => h + paragraphHeight(doc, b, rightW, 7.8), 0);
  const blockH = 8 + Math.max(notesH, basisH);

  y += 6;
  if (y + blockH > PAGE_H - 16) y = ensureSpace(doc, PAGE_H, blockH);
  if (y + blockH <= PAGE_H - 16) {
    subheading(doc, y, "Notes");
    subheading(doc, y, "Basis of preparation", rightX);
    let yl = y + 8; let yr = y + 8;
    for (const n of notes) yl = noteLine(doc, yl, n, M, leftW);
    for (const b of basis) yr = paragraph(doc, yr, b, C.ink, 7.8, rightX, rightW);
    y = Math.max(yl, yr);
  } else {
    // More notes than a page holds: let them flow, basis after.
    y = subheading(doc, y, "Notes");
    for (const n of notes) { y = ensureSpace(doc, y, noteHeight(doc, n, CONTENT_W)); y = noteLine(doc, y, n); }
    y = ensureSpace(doc, y + 4, 30);
    y = subheading(doc, y, "Basis of preparation");
    for (const b of basis) { y = ensureSpace(doc, y, 8); y = paragraph(doc, y, b, C.ink, 7.8); }
  }

  /* ---------------- running footer on every page ---------------- */

  const pages = doc.getNumberOfPages();
  for (let p = 1; p <= pages; p++) {
    doc.setPage(p);
    doc.setDrawColor(...C.line); doc.setLineWidth(0.2);
    doc.line(M, PAGE_H - 10, PAGE_W - M, PAGE_H - 10);
    doc.setFont("helvetica", "normal"); doc.setFontSize(7); doc.setTextColor(...C.faint);
    doc.text(T(`${entity} · Cash flow report ${fy.label}${meta.draft ? " · DRAFT" : ""}`), M, PAGE_H - 6);
    doc.text("Confidential — contains bank balances", PAGE_W / 2, PAGE_H - 6, { align: "center" });
    doc.text(`Page ${p} of ${pages}`, PAGE_W - M, PAGE_H - 6, { align: "right" });
  }

  return doc;
}

/** Build and download. Returns the filename used. */
export async function exportCashFlowPdf(report, meta) {
  const doc = await buildCashFlowPdf(report, meta);
  const d = meta.generatedAt;
  const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const filename = `PD-cash-flow-${report.fiscalYear.short}-${stamp}${meta.draft ? "-DRAFT" : ""}.pdf`;
  doc.save(filename);
  return filename;
}

/* ------------------------------------------------------------------ */
/* drawing helpers                                                     */
/* ------------------------------------------------------------------ */

function header(doc, report, meta, entity) {
  const fy = report.fiscalYear;
  // Brand bar.
  doc.setFillColor(...C.topaz);
  doc.rect(0, 0, PAGE_W, 2.2, "F");

  doc.setFont("helvetica", "bold"); doc.setFontSize(8); doc.setTextColor(...C.topazDark);
  doc.setCharSpace(0.6);
  doc.text(pdfText(entity.toUpperCase()), M, M + 1);
  doc.setCharSpace(0);

  doc.setFont("times", "normal"); doc.setFontSize(24); doc.setTextColor(...C.heading);
  doc.text(pdfText(`Cash flow report · ${fy.label}`), M, M + 11);

  doc.setFont("helvetica", "normal"); doc.setFontSize(9.5); doc.setTextColor(...C.muted);
  doc.text(pdfText(`${fy.range} · NZD`), M, M + 17);

  // Meta block, right-aligned.
  const rows = [
    ["Generated", longDate(meta.generatedAt)],
    ["Prepared by", meta.generatedBy || "—"],
    ["Planning rate", `${meta.planningRate?.toFixed(4) ?? "—"} USD to NZD · ${meta.planningRateLabel || "pinned"}`],
    ["Actuals", report.summary.actualMonths
      ? `Xero, ${[...new Set([report.columns.find((c) => c.isActual).label, report.summary.actualsThrough])].join(" – ")}`
      : "None — forecast only"],
  ];
  const xr = PAGE_W - M;
  rows.forEach(([k, v], i) => {
    const yy = M + 1 + i * 4.6;
    doc.setFont("helvetica", "normal"); doc.setFontSize(7.5); doc.setTextColor(...C.faint);
    doc.text(pdfText(k), xr - 72, yy);
    doc.setTextColor(...C.ink);
    doc.text(pdfText(v), xr, yy, { align: "right" });
  });

  doc.setDrawColor(...C.line); doc.setLineWidth(0.3);
  doc.line(M, M + 21, PAGE_W - M, M + 21);
  return M + 26;
}

function pageTitle(doc, title, sub) {
  doc.setFillColor(...C.topaz);
  doc.rect(0, 0, PAGE_W, 2.2, "F");
  doc.setFont("times", "normal"); doc.setFontSize(17); doc.setTextColor(...C.heading);
  doc.text(pdfText(title), M, M + 4);
  doc.setFont("helvetica", "normal"); doc.setFontSize(8.5); doc.setTextColor(...C.muted);
  doc.text(pdfText(sub), M, M + 9.5);
  return M + 13;
}

function subheading(doc, y, text, x = M) {
  doc.setFont("times", "normal"); doc.setFontSize(13); doc.setTextColor(...C.heading);
  doc.text(pdfText(text), x, y + 4);
  return y + 8;
}

function banner(doc, y, fill, ink, text) {
  const lines = doc.setFont("helvetica", "bold").setFontSize(8.5).splitTextToSize(pdfText(text), CONTENT_W - 8);
  const h = 4 + lines.length * 3.8;
  doc.setFillColor(...fill);
  doc.rect(M, y, CONTENT_W, h, "F");
  doc.setFillColor(...ink);
  doc.rect(M, y, 1, h, "F");
  doc.setTextColor(...ink);
  doc.text(lines, M + 4, y + 4.6);
  return y + h + 3;
}

/** A row of figure tiles, the PDF counterpart of the page's header tiles. */
function tiles(doc, y, items, valueSize) {
  const gap = 2.5;
  const w = (CONTENT_W - gap * (items.length - 1)) / items.length;
  const h = valueSize > 11 ? 19 : 16;
  items.forEach((t, i) => {
    const x = M + i * (w + gap);
    doc.setFillColor(...(t.alert ? C.overSoft : [255, 255, 255]));
    doc.setDrawColor(...C.line); doc.setLineWidth(0.3);
    doc.roundedRect(x, y, w, h, 1.6, 1.6, "FD");
    doc.setFont("helvetica", "bold"); doc.setFontSize(6.5); doc.setTextColor(138, 148, 163);
    doc.setCharSpace(0.3);
    doc.text(pdfText(t.k.toUpperCase()), x + 3, y + 4.6);
    doc.setCharSpace(0);
    doc.setFont("helvetica", "bold"); doc.setFontSize(valueSize);
    doc.setTextColor(...(Math.round(t.v) < 0 ? C.over : C.heading));
    doc.text(acct(t.v), x + 3, y + 4.6 + valueSize * 0.42);
    doc.setFont("helvetica", "normal"); doc.setFontSize(6.8); doc.setTextColor(...C.faint);
    doc.text(pdfText(t.sub ?? ""), x + 3, y + h - 2.4);
  });
  return y + h;
}

/**
 * The NZD account as a vector line chart.
 *
 * Drawn with jsPDF primitives rather than a screenshot of the Chart.js canvas:
 * a canvas image is blurry when printed and its size depends on the window the
 * export was clicked from. Same two series as the page: the NZD account solid,
 * the total position including unconverted USD dashed behind it, zero in red.
 */
function chart(doc, data, x, y, w, h) {
  const padL = 16; const padB = 9; const padT = 7; const padR = 4;
  const px = x + padL; const pw = w - padL - padR;
  const py = y + padT; const ph = h - padT - padB;
  const n = data.labels.length;

  const all = [...data.base, ...data.total, 0];
  let lo = Math.min(...all); let hi = Math.max(...all);
  if (hi === lo) { hi += 1; lo -= 1; }
  const step = niceStep((hi - lo) / 5);
  lo = Math.floor(lo / step) * step;
  hi = Math.ceil(hi / step) * step;

  const X = (i) => px + (n === 1 ? pw / 2 : (pw * i) / (n - 1));
  const Y = (v) => py + ph - ((v - lo) / (hi - lo)) * ph;
  const colW = n > 1 ? pw / (n - 1) : pw;

  // Closed months, shaded.
  data.actual.forEach((a, i) => {
    if (!a) return;
    const x0 = Math.max(px, X(i) - colW / 2);
    const x1 = Math.min(px + pw, X(i) + colW / 2);
    doc.setFillColor(...C.actualTint);
    doc.rect(x0, py, x1 - x0, ph, "F");
  });

  // Grid and y labels.
  doc.setFont("helvetica", "normal"); doc.setFontSize(7); doc.setTextColor(...C.faint);
  for (let v = lo; v <= hi + step / 2; v += step) {
    const yy = Y(v);
    const zero = Math.abs(v) < step / 1000;
    doc.setDrawColor(...(zero ? C.over : [238, 241, 245]));
    doc.setLineWidth(zero ? 0.45 : 0.2);
    doc.line(px, yy, px + pw, yy);
    doc.text(shortMoney(v), px - 2, yy + 1, { align: "right" });
  }

  // X labels.
  data.labels.forEach((l, i) => doc.text(pdfText(l), X(i), py + ph + 5, { align: "center" }));

  // Area under the NZD line, very light — drawn as thin trapezoids to the zero
  // line so it reads as "above or below zero" the way the page fill does.
  const yZero = Y(Math.min(Math.max(0, lo), hi));
  doc.setFillColor(...C.topazSoft);
  for (let i = 0; i < n - 1; i++) {
    doc.lines([[X(i + 1) - X(i), Y(data.base[i + 1]) - Y(data.base[i])],
               [0, yZero - Y(data.base[i + 1])],
               [X(i) - X(i + 1), 0]], X(i), Y(data.base[i]), [1, 1], "F", true);
  }

  // Total position, dashed.
  doc.setDrawColor(...C.grey); doc.setLineWidth(0.4);
  doc.setLineDashPattern([1.6, 1.2], 0);
  for (let i = 0; i < n - 1; i++) doc.line(X(i), Y(data.total[i]), X(i + 1), Y(data.total[i + 1]));
  doc.setLineDashPattern([], 0);

  // NZD account.
  doc.setDrawColor(...C.topazDark); doc.setLineWidth(0.7);
  for (let i = 0; i < n - 1; i++) doc.line(X(i), Y(data.base[i]), X(i + 1), Y(data.base[i + 1]));
  data.base.forEach((v, i) => {
    doc.setFillColor(...(v < 0 ? C.over : C.topazDark));
    doc.circle(X(i), Y(v), v < 0 ? 0.9 : 0.7, "F");
  });

  // Legend, top right.
  const lx = x + w - 92; const ly = y + 2;
  doc.setDrawColor(...C.topazDark); doc.setLineWidth(0.7); doc.line(lx, ly, lx + 6, ly);
  doc.setFontSize(7.5); doc.setTextColor(...C.muted);
  doc.text("NZD account", lx + 8, ly + 1);
  doc.setDrawColor(...C.grey); doc.setLineWidth(0.4); doc.setLineDashPattern([1.6, 1.2], 0);
  doc.line(lx + 30, ly, lx + 36, ly); doc.setLineDashPattern([], 0);
  doc.text("Incl. unconverted USD", lx + 38, ly + 1);
  doc.setFillColor(...C.actualTint); doc.setDrawColor(...C.line); doc.setLineWidth(0.2);
  doc.rect(lx + 69, ly - 1.6, 4, 3, "FD");
  doc.text("Actual", lx + 75, ly + 1);
}

function niceStep(raw) {
  if (!(raw > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(raw));
  const f = raw / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
}

function footnotes(doc, y, lines) {
  doc.setFont("helvetica", "normal"); doc.setFontSize(7); doc.setTextColor(...C.faint);
  for (const l of lines) {
    const wrapped = doc.splitTextToSize(pdfText(l), CONTENT_W);
    y = ensureSpace(doc, y, wrapped.length * 3.2 + 1);
    doc.setFont("helvetica", "normal"); doc.setFontSize(7); doc.setTextColor(...C.faint);
    doc.text(wrapped, M, y);
    y += wrapped.length * 3.2 + 0.8;
  }
  return y;
}

function paragraph(doc, y, text, color, size, x = M, w = CONTENT_W) {
  doc.setFont("helvetica", "normal"); doc.setFontSize(size); doc.setTextColor(...color);
  const wrapped = doc.splitTextToSize(pdfText(text), w);
  doc.text(wrapped, x, y + 3);
  return y + wrapped.length * (size * 0.42) + 2;
}

function paragraphHeight(doc, text, w, size) {
  doc.setFont("helvetica", "normal"); doc.setFontSize(size);
  return doc.splitTextToSize(pdfText(text), w).length * (size * 0.42) + 2;
}

function noteLine(doc, y, note, x = M, w = CONTENT_W) {
  const ink = note.level === "warn" ? C.warn : C.topazDark;
  doc.setFont("helvetica", "normal"); doc.setFontSize(8);
  const wrapped = doc.splitTextToSize(pdfText(note.text), w - 6);
  const h = wrapped.length * 3.4 + 2.4;
  doc.setFillColor(...(note.level === "warn" ? C.warnSoft : C.topazSoft));
  doc.rect(x, y, w, h, "F");
  doc.setFillColor(...ink);
  doc.rect(x, y, 0.9, h, "F");
  doc.setTextColor(...C.ink);
  doc.text(wrapped, x + 4, y + 3.8);
  return y + h + 1.6;
}

function noteHeight(doc, note, w) {
  doc.setFont("helvetica", "normal"); doc.setFontSize(8);
  return doc.splitTextToSize(pdfText(note.text), w - 6).length * 3.4 + 2.4 + 1.6;
}

function ensureSpace(doc, y, need) {
  if (y + need <= PAGE_H - 16) return y;
  doc.addPage();
  doc.setFillColor(...C.topaz);
  doc.rect(0, 0, PAGE_W, 2.2, "F");
  return M + 2;
}

function fmtIsoDate(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  const mon = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][m - 1];
  return `${d} ${mon} ${y}`;
}

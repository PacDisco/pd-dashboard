/**
 * Cash Forecast dashboard — client.
 *
 * Imports the SAME engine module the functions use, so editing a pax number
 * redraws the whole year instantly without a round trip, and the browser and
 * the server can never disagree about the arithmetic. The server recomputes
 * from the same module on save, so the browser is a fast preview, never the
 * authority.
 *
 * API calls go through /api/cash-* with `credentials: 'include'`, matching the
 * rest of the site. Those endpoints verify the Identity token and role
 * themselves — /api/* sits outside auth-gate.js.
 */

import { buildForecast } from "./engine.mjs";

const state = {
  assumptions: null,
  actuals: null,
  canEdit: false,
  email: "",
  fx: null,
  effectiveRate: null,
  actualMonthsAvailable: [],
  partialMonth: null,
  openings: null,
  overheads: null,
  diag: null,
  diagBusy: null,
  costCurve: null,
  curveBusy: false,
  // The P&L tab. `pnlOpen` is which sections and accounts are expanded, keyed
  // "<section>" and "<section>::<account name>", kept here rather than in the
  // DOM so a re-render does not collapse everything the reader had opened.
  pnl: null,
  pnlBusy: false,
  pnlBasis: "total",
  pnlByMonth: false,
  pnlOpen: {},
  dirty: false,
  tab: "forecast",
  saving: false,
  error: null,
};

const money = (n, dp = 0) => {
  // Round before testing the sign, or values like -0.0001 render as "−0".
  const factor = 10 ** dp;
  const r = Math.round((n + Number.EPSILON) * factor) / factor;
  const v = Object.is(r, -0) ? 0 : r;
  return (v < 0 ? "−" : "") +
    Math.abs(v).toLocaleString("en-NZ", { minimumFractionDigits: dp, maximumFractionDigits: dp });
};

const el = (id) => document.getElementById(id);

/* ------------------------------------------------------------------ */

const API = "/api";

async function api(path, opts) {
  const res = await fetch(`${API}${path}`, { credentials: "include", ...opts });
  if (!res.ok) {
    const j = await res.json().catch(() => ({}));
    throw new Error(j.error || `Request failed (${res.status})`);
  }
  return res.json();
}

async function boot() {
  try {
    const data = await api("/cash-forecast");
    state.assumptions = data.assumptions;
    state.actuals = data.actuals;
    state.fx = data.fx ?? null;
    state.actualMonthsAvailable = data.actualMonthsAvailable ?? [];
    state.partialMonth = data.partialMonth ?? null;
    state.openings = data.openings ?? null;
    state.overheads = data.overheads ?? null;
    state.effectiveRate = data.effectiveRate ?? null;
    state.canEdit = data.canEdit;
    state.serverForecast = data.forecast ?? null;
    // What the server fed the engine for closed months, so the browser can run
    // the identical chain instead of splicing two incompatible ones together.
    state.actualsByMonth = data.actualsByMonth ?? {};
    state.forecastOnly = data.forecastOnly ?? null;
    state.email = data.email;
  } catch (err) {
    return showGate(err.message);
  }
  render();
}

function showGate(message) {
  el("app").innerHTML = `<div class="gate"><p>${escapeHtml(message)}</p></div>`;
}

/* ------------------------------------------------------------------ */

/** The rate the forecast should plan at, from the live series or pinned. */
function resolvedRate() {
  const a = state.assumptions;
  const cur = a.settlementCurrency || "USD";
  const src = a.planningRateSource || "manual";
  if (src === "manual" || !state.fx) return a.fxRates[cur] ?? 1;
  return { avg30: state.fx.avg30, avg60: state.fx.avg60,
           avg90: state.fx.avg90, current: state.fx.current }[src] ?? a.fxRates[cur];
}

/**
 * Overlay the server's closed months onto a locally recomputed forecast.
 *
 * The engine re-bases the forecast onto each actual closing balance, which the
 * browser cannot do without the Xero figures. So while editing, months after the
 * lock are marked provisional rather than pretending to be re-based — better a
 * visible "recalculating" state than a confidently wrong tail.
 */
function withServerActuals(local) {
  const server = state.serverForecast;
  if (!server || !state.assumptions.actualsThroughMonth) return local;

  const byKey = Object.fromEntries(server.months.map((m) => [m.key, m]));
  let sawActual = false;
  local.months = local.months.map((m) => {
    const s = byKey[m.key];
    if (s?.isActual) { sawActual = true; return s; }
    return { ...m, provisional: sawActual && state.dirty };
  });
  local.totals = { ...local.totals, actualMonths: server.totals.actualMonths };

  // The local build ran with NO stored actuals — the browser does not hold them
  // — so it warns that every closed month is missing its Xero figures. For the
  // months the server DID supply that warning is simply false, and a false
  // warning on a page whose whole job is trust is worse than no warning. The
  // server ran the same engine with the real data, so its verdict is the one
  // that counts: take the actuals warnings from there.
  const ACTUALS_WARNING = /Locked as actual|has not finished/;
  local.warnings = [
    ...local.warnings.filter((w) => !ACTUALS_WARNING.test(w)),
    ...server.warnings.filter((w) => ACTUALS_WARNING.test(w)),
  ];

  if (state.dirty && sawActual) {
    local.warnings = [...local.warnings,
      "Months after the last closed month will re-base onto the real balance when you save."];
  }
  return local;
}

/** Assumptions with the planning rate applied — never mutates state. */
function effectiveAssumptions() {
  const a = state.assumptions;
  const cur = a.settlementCurrency || "USD";
  // The server resolves the 1 April balances against Xero; the browser has to
  // use the same ones or the local preview quietly disagrees with the saved
  // forecast by the size of the opening — which is every month, not just one.
  const openings = (a.openingBalanceSource ?? "xero") === "xero" && state.openings?.source === "xero"
    ? state.openings.inUse
    : a.openingBalances;
  // Same reasoning as the openings: the server resolves overheads against the
  // P&L and the budget, and the browser has neither. Use what it resolved.
  const overheads = (a.overheadSource ?? "auto") === "auto" && state.overheads?.months
    ? state.overheads.months
    : a.monthlyOverheads;
  // Likewise for the runway months: they repeat the budget, not the resolved
  // array, and only the server knows what the budget says.
  const forward = (a.overheadSource ?? "auto") === "auto" && state.overheads?.forward
    ? state.overheads.forward
    : a.monthlyOverheads;
  return {
    ...a,
    openingBalances: openings,
    monthlyOverheads: overheads,
    monthlyOverheadsForward: forward,
    monthlyOverheadsForwardSources: state.overheads?.forwardSources ?? null,
    // Same metadata the server passes, so a locally recomputed preview explains
    // an opening-balance mismatch the same way the saved forecast does.
    openingsMeta: state.openings ? {
      source: state.openings.source,
      fromXero: state.openings.fromXero,
      typed: state.openings.typed,
      openingRateSource: state.openings.openingRateSource,
    } : null,
    fxRates: { ...a.fxRates, [cur]: resolvedRate() },
  };
}

/**
 * The forecast to display.
 *
 * THE BUG THIS FIXES, because it was subtle and expensive.
 *
 * The browser recomputes locally for instant feedback while editing, and
 * `withServerActuals` then splices the server's closed months over the top. But
 * a spliced table is TWO RUNS JOINED AT A SEAM, and balances do not carry across
 * a seam. April to August came from the server's chain, which had the real Xero
 * figures; September onward came from a local chain that never saw them and had
 * therefore already spent its USD somewhere else entirely.
 *
 * The visible symptom: August closed with 229,675 USD and September opened with
 * none of it — converting only its own receipts, month after month, with the
 * USD balance pinned at zero. About 394,000 NZD of cover simply absent from the
 * forecast, and the NZD account roughly that much worse than it should be from
 * September on.
 *
 * `withServerActuals` half-knew this: it marks the tail `provisional` — but only
 * when `state.dirty`. Sitting and reading the page, dirty is false, so the tail
 * was presented as re-based when it was nothing of the kind.
 *
 * So: when not editing, show the SERVER's forecast. It ran this same engine with
 * the real actuals in one unbroken chain, which is the only way the balances can
 * be right. The local splice stays for live editing, where an instantly wrong
 * tail clearly labelled provisional beats a correct one that arrives a second
 * after each keystroke.
 */
function displayForecast() {
  if (!state.dirty && state.serverForecast) return state.serverForecast;
  // While editing, run the SAME chain the server runs — same engine, same
  // actuals — so the live preview differs from the saved forecast only by the
  // edit in progress, never by a seam. Falls back to the splice for an older
  // server that does not send the monthly actuals.
  const actuals = state.actualsByMonth;
  if (actuals && Object.keys(actuals).length) {
    return buildForecast(effectiveAssumptions(), actuals);
  }
  return withServerActuals(buildForecast(effectiveAssumptions()));
}

function render() {
  const f = displayForecast();
  el("app").innerHTML = `
    ${topBar(f)}
    ${emptyState()}
    ${warnings(f)}
    ${tabs()}
    <div class="panel">${
      state.tab === "forecast" ? forecastView(f)
      : state.tab === "programs" ? programsView(f)
      : state.tab === "payments" ? paymentsView()
      : state.tab === "surplus" ? surplusPanel()
      : state.tab === "pnl" ? pnlPanel()
      : overheadsView()
    }</div>
  `;
  wire();
  if (state.tab === "forecast") drawChart(f);
}

function topBar(f) {
  const t = f.totals;
  const low = t.lowestClosing;
  const fy = state.assumptions.fiscalYearStartYear;
  return `
    <header class="top">
      <div class="title">
        <h1>Pacific Discovery cash flow</h1>
        <span class="fy">FY ${fy}/${String(fy + 1).slice(2)} · Apr–Mar${
          f.horizon?.beyondFiscalYear
            ? ` + ${f.horizon.beyondFiscalYear} mo to ${escapeHtml(f.months[f.months.length - 1].label)}`
            : ""}</span>
      </div>
      <div class="tiles">
        <div class="tile"><span class="k">Cash in</span><span class="v">${money(t.cashIn)}</span><span class="sub">NZD equiv.</span></div>
        <div class="tile"><span class="k">Cash out</span><span class="v">${money(t.cashOut)}</span><span class="sub">NZD</span></div>
        <div class="tile ${t.lowestBaseClosing < 0 ? "alert" : ""}">
          <span class="k">Lowest NZD</span>
          <span class="v ${t.lowestBaseClosing < 0 ? "neg" : ""}">${money(t.lowestBaseClosing)}</span>
          <span class="sub">${t.lowestBaseMonth} · after converting</span>
        </div>
        <div class="tile">
          <span class="k">USD converted</span><span class="v">${money(t.fxConverted)}</span>
          <span class="sub">@ ${t.planningRate.toFixed(4)}</span>
        </div>
        <div class="tile ${low < 0 ? "alert" : ""}">
          <span class="k">Total position</span>
          <span class="v ${low < 0 ? "neg" : ""}">${money(t.closingBalance)}</span>
          <span class="sub">incl. unconverted USD</span>
        </div>
      </div>
      <div class="who">
        ${state.canEdit
          ? `<button id="save" class="btn-primary" ${state.dirty && !state.saving ? "" : "disabled"}>${
              state.saving ? "Saving…" : state.dirty ? "Save changes" : "Saved"
            }</button>`
          : `<span class="badge">View only</span>`}
        <span class="email">${escapeHtml(state.email)}</span>
      </div>
    </header>`;
}

/**
 * An empty model renders a page full of zeros, which reads as broken rather
 * than as "nothing entered yet". Say so plainly, and offer the starting values
 * so nobody hand-types ten programs into a web form.
 */
function emptyState() {
  if (state.assumptions.programs?.length) return "";
  return `<div class="empty">
    <h2>No programs yet</h2>
    <p>The forecast is showing zeros because nothing has been entered. ${
      state.canEdit
        ? `Load the starting values from the 26/27 workbook and edit from there, or add programs one at a time on the <b>Programs &amp; pax</b> tab.`
        : `An administrator needs to set up the model.`
    }</p>
    ${state.canEdit ? `<button id="seed" class="btn-primary">Load 26/27 starting values</button>` : ""}
    <p class="foot">Costs and season pax totals come from the workbook. Per-program pax, departure dates and supplier cost phasing are placeholders you will need to replace — the numbers mean nothing until you do.</p>
  </div>`;
}

function warnings(f) {
  const all = [...f.warnings];
  if (!state.actuals) all.push("No Xero actuals yet — showing forecast only.");
  else if (state.actuals.tokenHealth?.needsAttention)
    all.push(`Xero connection expires in ${state.actuals.tokenHealth.daysRemaining} days — re-authorise before then.`);
  if (state.error) all.push(state.error);
  if (!all.length) return "";
  return `<ul class="warnings">${all.map((w) => `<li>${escapeHtml(w)}</li>`).join("")}</ul>`;
}

function tabs() {
  const items = [
    ["forecast", "Cash flow"],
    ["programs", "Programs & pax"],
    ["payments", "Payment rules"],
    ["overheads", "Overheads"],
    ["surplus", "Surplus vs budget"],
    ["pnl", "P&L"],
  ];
  return `<nav class="tabs">${items
    .map(([id, label]) => `<button data-tab="${id}" class="${state.tab === id ? "on" : ""}">${label}</button>`)
    .join("")}</nav>`;
}

/* ---------------- forecast ---------------- */

function forecastView(f) {
  // [label, getter, class, realWhenClosed]
  // Xero's Bank Summary gives totals received and spent, not a split across
  // program costs / overheads / capital. So in a closed month the totals are
  // real and the components are still forecast — and they must LOOK different,
  // or the column silently fails to add up.
  // One Revenue row when the single receipts curve is driving cash in; the old
  // two-row split only appears for a model that still uses deposits/balances.
  const usingCurve = f.months.some((m) => Math.abs(m.revenueIn) > 0.5);
  const rows = [
    ...(usingCurve
      ? [["Revenue in", (m) => m.revenueIn, "", false]]
      : [["Deposits in", (m) => m.depositsIn, "", false],
         ["Balances in", (m) => m.balancesIn, "", false]]),
    ["Cash in", (m) => m.cashIn, "strong", true],
    ["Program costs", (m) => -m.programCostsOut, "", false],
    ["Overheads", (m) => -m.overheads, "", false],
    ["Capital", (m) => -m.capital, "", false],
    ["Tax", (m) => -m.tax, "", false],
    ["Cash out", (m) => -m.cashOut, "strong", true],
    ["Net movement", (m) => m.net, "strong", true],
  ];

  const treasuryRows = [
    ["USD received", (m) => m.fxIn, "", true],
    ["USD converted", (m) => m.fxConverted === null ? null : -m.fxConverted, "", true],
    ["USD balance", (m) => m.fxClosing, "strong", true],
    ["NZD from conversion", (m) => m.baseFromConversion, "", true],
    ["NZD account", (m) => m.baseClosing, "rule", true],
    ["Total position (NZD)", (m) => m.closing, "muted", true],
    ["Revenue recognised", (m) => m.recognisedRevenue, "muted", false],
    ["Deferred revenue", (m) => m.deferredRevenueBalance, "muted", false],
  ];

  return `
    <figure class="chartwrap">
      <div style="position:relative;height:250px"><canvas id="chart"></canvas></div>
      <figcaption>NZD account by month, with the total position including unconverted USD behind it. The dashed red line is zero.${
        f.horizon?.emptyFromLabel
          ? ` The line goes grey and dashed past 31 March; from ${escapeHtml(f.horizon.emptyFromLabel)} it has overheads but no programs entered, so that decline is missing inputs rather than a forecast.`
          : f.horizon?.beyondFiscalYear
            ? " The line goes grey and dashed past 31 March — still a forecast, just beyond the reported year."
            : ""}</figcaption>
    </figure>
    <div class="scroll">
      <table class="cftable">
        <thead><tr><th class="lab"></th>${f.months.map((m, i) =>
          `<th class="${m.isActual ? "actualcol" : ""}${m.provisional ? " provisional" : ""}${span(f, i)}">${m.label}${
            m.isActual ? '<span class="amark">actual</span>' : ""}</th>`).join("")}</tr></thead>
        <tbody>
          ${rows.map(([label, get, cls, real]) => `
            <tr class="${cls || ""}">
              <th class="lab">${label}</th>
              ${f.months.map((m, i) => cell(get(m), m, real, span(f, i))).join("")}
            </tr>`).join("")}
          <tr class="sep"><th class="lab">Treasury</th>${f.months.map((m, i) => `<td class="${span(f, i).trim()}"></td>`).join("")}</tr>
          ${treasuryRows.map(([label, get, cls, real]) => `
            <tr class="${cls || ""}">
              <th class="lab">${label}</th>
              ${f.months.map((m, i) => cell(get(m), m, real, span(f, i))).join("")}
            </tr>`).join("")}
          ${varianceRow(f)}
        </tbody>
      </table>
    </div>
    ${beyondNote(f)}
    ${f.totals.actualMonths ? `<p class="foot"><b>Closed months</b> (tinted) show Xero figures for the totals — cash in, cash out, and the balances. The category split below them is <span class="stillfc-key">still forecast</span>, because a bank summary gives a month's totals and not how the spend divided. Rows marked <i>n/a</i> cannot be derived at all: a conversion and a customer payment both look like money arriving.</p>` : ""}
    <p class="foot">Funds are collected in USD and converted only when the NZD account would fall below the buffer. <b>NZD account</b> is the row that says whether you can pay a supplier; <b>Total position</b> values unconverted USD at the planning rate and is a mark-to-market figure, not spendable cash.</p>
    ${actualsPanel()}`;
}

/**
 * One table cell. Three states worth distinguishing, and they are not the same
 * thing: a real zero, a figure that cannot be derived from a bank summary
 * (null — conversions, for instance), and a normal number.
 */
/**
 * Column classes marking the fiscal-year boundary.
 *
 * The table now runs past 31 March, so a reader scanning any row crosses from
 * "the year the totals describe" into "runway with no programs entered". That
 * transition has to be visible in the table itself — a footnote under it would
 * be read after the number rather than with it.
 */
function span(f, i) {
  const per = f.horizon?.fiscalYearMonths ?? 12;
  const beyond = i >= per ? " beyond" : "";
  // A divider at EVERY 31 March, not just the first. With two-plus years on
  // screen a single line marks the edge of the reported year but leaves the
  // rest as one undifferentiated run, and a reader scanning the closing balance
  // has no way to tell FY27/28 from FY28/29 without counting columns.
  const isYearEnd = (i + 1) % per === 0 && i + 1 < f.months.length;
  return `${isYearEnd ? " fyend" : ""}${beyond}`;
}

function cell(v, m, realWhenClosed = true, extra = "") {
  // In a closed month, a figure that is still forecast must not look like one
  // that came from the bank.
  const stillForecast = m.isActual && !realWhenClosed;
  const cls = [
    m.isActual ? "actualcol" : "",
    m.provisional ? "provisional" : "",
    stillForecast ? "stillfc" : "",
    typeof v === "number" && v <= -0.5 ? "neg" : "",
    extra.trim(),
  ].filter(Boolean).join(" ");

  if (v === null || v === undefined) {
    return `<td class="${cls} na" title="Not derivable from a bank summary">n/a</td>`;
  }
  const title = stillForecast
    ? ' title="Still forecast — Xero gives the month total, not the split across categories"'
    : "";
  return `<td class="${cls}"${title}>${Math.abs(v) < 0.5 ? "—" : money(v)}</td>`;
}

/**
 * Forecast versus actual on the closing NZD balance, for closed months only.
 * This is the row that says whether the model is any good — and the one the old
 * workbook could never show, because its "adjustments" absorbed the difference
 * before anyone could see it.
 */
function varianceRow(f) {
  if (!f.totals.actualMonths || !state.forecastOnly) return "";
  const byKey = Object.fromEntries(state.forecastOnly.months.map((m) => [m.key, m]));
  return `<tr class="sep"><th class="lab">Variance</th>${f.months.map((m, i) => `<td class="${span(f, i).trim()}"></td>`).join("")}</tr>
    <tr class="var">
      <th class="lab">NZD vs forecast</th>
      ${f.months.map((m, i) => {
        if (!m.isActual || !byKey[m.key]) return `<td class="na${span(f, i)}">—</td>`;
        const d = m.baseClosing - byKey[m.key].baseClosing;
        const sign = d > 0 ? "+" : "";
        return `<td class="actualcol ${d < -0.5 ? "neg" : d > 0.5 ? "pos" : ""}${span(f, i)}" title="Actual ${money(m.baseClosing)} vs forecast ${money(byKey[m.key].baseClosing)}">${
          Math.abs(d) < 0.5 ? "—" : sign + money(d)}</td>`;
      }).join("")}
    </tr>`;
}

function actualsPanel() {
  if (!state.actuals?.orgs?.length) return "";
  return `
    <section class="actuals">
      <h2>Xero actuals <span class="stamp">as at ${escapeHtml(state.actuals.asAt || "")}</span></h2>
      <div class="scroll">
        <table class="cftable tight">
          <thead><tr><th class="lab">Organisation</th><th>Bank</th><th>Receivables</th><th>Payables</th><th>In MTD</th><th>Out MTD</th></tr></thead>
          <tbody>
            ${state.actuals.orgs.map((o) => `
              <tr>
                <th class="lab">${escapeHtml(o.name)} <span class="cur">${escapeHtml(o.currency)}</span></th>
                <td class="${o.closingBalance < 0 ? "neg" : ""}">${money(o.closingBalance)}</td>
                <td>${money(o.receivables)}</td>
                <td>${money(o.payables)}</td>
                <td>${money(o.cashReceivedMTD)}</td>
                <td>${money(o.cashSpentMTD)}</td>
              </tr>`).join("")}
          </tbody>
        </table>
      </div>
      <p class="foot">One row per connected Xero organisation, in that organisation's own currency. Figures are never summed across currencies. If an entity you do not expect appears here, it has been authorised on the Xero app — pin the ones you want with XERO_TENANTS.</p>
    </section>`;
}

/* ---------------- programs ---------------- */

function programsView(f) {
  const byId = Object.fromEntries(f.programs.map((p) => [p.programId, p]));
  const ro = !state.canEdit;
  return `
    <div class="scroll">
      <table class="cftable edit">
        <thead><tr>
          <th class="lab">Program</th><th>Season</th><th>Departs</th><th>Returns</th>
          <th>Price</th><th>Sells in</th><th>Pax</th>
          <th>Fixed cost</th><th>Var / pax</th><th>Costs in</th>
          ${/* "Contribution" was already revenue less total cost — gross profit
               under a name that made it easy to miss. Renamed, and given the
               percentage beside it, because the dollar figure alone does not
               show that Aus Bali runs at 10% while NZA runs at 49%. */""}
          <th>Revenue</th><th>Total cost</th><th>Gross profit</th><th>GP %</th><th></th>
        </tr></thead>
        <tbody>
          ${(() => {
            /* SORTED BY DEPARTURE, BUT THE INDEX MUST NOT MOVE.
             *
             * Every input on a row carries data-i, and the handlers use it to
             * reach into state.assumptions.programs. Sorting the array itself,
             * or re-indexing after the sort, would mean typing in one row and
             * editing a different program — silently, and only for the rows
             * that moved. So the ORIGINAL index travels with each row and only
             * the display order changes.
             *
             * A program with no usable departure date sorts last rather than
             * throwing the order: that is where a freshly added row sits, which
             * is also where someone expects to find it. */
            const rows = state.assumptions.programs
              .map((p, i) => ({ p, i, key: /^\d{4}-\d{2}-\d{2}$/.test(String(p.startDate ?? "")) ? p.startDate : "9999-99-99" }))
              .sort((a, b) => a.key.localeCompare(b.key) || String(a.p.name).localeCompare(String(b.p.name)));

            // A thin rule where the fiscal year turns, so twenty-odd rows read
            // as a few seasons rather than one long list.
            const fyOf = (iso) => {
              const y = Number(iso.slice(0, 4)); const m = Number(iso.slice(5, 7));
              return Number.isFinite(y) && Number.isFinite(m) ? (m >= 4 ? y : y - 1) : null;
            };
            let lastFy = null;

            /* A subtotal for the year just ended, emitted at the rule.
             *
             * With four seasons on screen the per-program margins are the
             * interesting part, but the question underneath them is whether a
             * year's programs generate enough gross profit to cover the year's
             * overheads at all. That is a comparison nobody can do by eye down
             * a column of eleven numbers. */
            const subtotal = (fyEnded) => {
              const inYear = rows.filter((r) => r.key !== "9999-99-99" && fyOf(r.key) === fyEnded);
              const agg = inYear.reduce((s, r) => {
                const c = byId[r.p.id];
                if (!c) return s;
                return { pax: s.pax + (r.p.paxForecast || 0), rev: s.rev + c.grossRevenue, gp: s.gp + c.contribution };
              }, { pax: 0, rev: 0, gp: 0 });
              if (!agg.rev) return "";
              const pct = (agg.gp / agg.rev) * 100;
              return `<tr class="fysub">
                <th class="lab">FY ${fyEnded}/${String(fyEnded + 1).slice(2)} · ${inYear.length} program${inYear.length === 1 ? "" : "s"}</th>
                <td colspan="5"></td>
                <td>${agg.pax}</td>
                <td colspan="3"></td>
                <td>${money(agg.rev)}</td>
                <td>${money(agg.rev - agg.gp)}</td>
                <td class="${agg.gp < 0 ? "neg" : ""}">${money(agg.gp)}</td>
                <td class="${pct < 20 ? "gp-thin" : pct < 35 ? "gp-fair" : "gp-good"}">${pct.toFixed(1)}%</td>
                <td></td></tr>`;
            };

            return rows.map(({ p, i, key }, rowIndex) => {
            const c = byId[p.id];
            const fy = key === "9999-99-99" ? null : fyOf(key);
            const turned = fy !== null && lastFy !== null && fy !== lastFy;
            const closing = turned ? subtotal(lastFy) : "";
            if (fy !== null) lastFy = fy;
            return `${closing}${turned ? `<tr class="fyrule"><th class="lab">FY ${fy}/${String(fy + 1).slice(2)}</th><td colspan="14"></td></tr>` : ""}
            <tr data-i="${i}" class="${p.active ? "" : "off"}">
              <th class="lab"><input data-f="name" value="${escapeAttr(p.name)}" ${ro ? "disabled" : ""}></th>
              <td><select data-f="season" ${ro ? "disabled" : ""}>
                ${["Fall", "Spring", "Summer"].map((s) => `<option ${p.season === s ? "selected" : ""}>${s}</option>`).join("")}
              </select></td>
              <td><input type="date" data-f="startDate" value="${p.startDate}" ${ro ? "disabled" : ""}></td>
              <td><input type="date" data-f="endDate" value="${p.endDate}" ${ro ? "disabled" : ""}></td>
              <td><input type="number" data-f="price" value="${p.price}" step="100" ${ro ? "disabled" : ""}></td>
              <td><input data-f="currency" class="cur-in" value="${escapeAttr(p.currency)}" ${ro ? "disabled" : ""}></td>
              <td><input type="number" data-f="paxForecast" value="${p.paxForecast}" ${ro ? "disabled" : ""}></td>
              <td><input type="number" data-f="fixedCost" value="${p.fixedCost}" step="1000" ${ro ? "disabled" : ""}></td>
              <td><input type="number" data-f="variableCostPerPax" value="${p.variableCostPerPax}" step="100" ${ro ? "disabled" : ""}></td>
              <td><input data-f="costCurrency" class="cur-in" value="${escapeAttr(p.costCurrency || "NZD")}" ${ro ? "disabled" : ""}></td>
              ${(() => {
                // Margin on REVENUE, not markup on cost. Those differ by ten
                // points or more and the second flatters: the workbook's 36.16%
                // is contribution over cost, which on revenue is 26.6%.
                const gp = c ? c.contribution : null;
                const pct = c && c.grossRevenue > 0 ? (gp / c.grossRevenue) * 100 : null;
                const band = pct === null ? "" : pct < 0 ? "neg" : pct < 20 ? "gp-thin" : pct < 35 ? "gp-fair" : "gp-good";
                return `
              <td class="calc">${c ? money(c.grossRevenue) : "—"}</td>
              <td class="calc">${c ? money(c.totalCost) : "—"}</td>
              <td class="calc ${gp !== null && gp < 0 ? "neg" : ""}">${c ? money(gp) : "—"}</td>
              <td class="calc ${band}">${pct === null ? "—" : `${pct.toFixed(1)}%`}</td>`;
              })()}
              <td><button class="del" data-del="${i}" ${ro ? "disabled" : ""} title="Remove">×</button></td>
            </tr>`;
            }).join("")
            // The final year has no rule after it to hang its subtotal on, so
            // it is closed off explicitly. Without this the last — and usually
            // the least complete — year is the only one with no total, which is
            // exactly the one someone would assume had been counted.
            + subtotal(lastFy);
          })()}
        </tbody>
      </table>
    </div>
    ${ro ? "" : `<button id="addprog" class="btn-primary" style="margin-top:14px">Add program</button>`}
    <p class="foot">Sorted by departure date, with a subtotal at each fiscal year end. Editing a row still edits the program it names — the order on screen changes, the underlying list does not.</p>
    <p class="foot"><b>Gross profit</b> is revenue less that program's own costs — what it contributes before any overhead. <b>GP %</b> states it against revenue, not as a markup on cost: the two differ by ten points or more and the markup always flatters. Red is under 20%, amber under 35%.</p>
    <p class="foot">Nothing here carries overheads. A program showing a positive gross profit is not necessarily paying for itself — the year's overheads have to come out of the subtotal, which is the comparison the Surplus tab makes.</p>
    <p class="foot">Programs sell in USD and pay suppliers in NZD, so price and cost convert at different rates. Revenue is recognised over the months <b>up to and including the departure month</b>, so the departure date on this tab is what decides when a season lands in the P&amp;L — not the season name. Cash timing is separate again, and comes from the payment rules.</p>`;
}

/* ---------------- payment rules ---------------- */

/**
 * Extrapolated full-year surplus, against budget.
 *
 * THE ONE THING A READER MUST NOT DO HERE
 * ---------------------------------------
 * Compare these numbers to the Cash flow tab and conclude something is broken.
 * They are a different question. Revenue counts when it is RECOGNISED — Fall's
 * whole season in August — not when the student's money arrived, and the gap
 * between the two is deferred revenue, which on these books runs to seven
 * figures. So the note at the top of the panel is not decoration; it is the
 * thing that stops an hour being spent reconciling two numbers that were never
 * meant to agree.
 */
function surplusPanel() {
  const d = state.surplus;

  if (!d) {
    return `<section class="closebox">
      <h2>Surplus vs budget <span class="stamp">profit and loss</span></h2>
      <p class="foot">Full-year surplus or loss at 31 March: what the books say for the months already closed, plus the pax model for the rest, against what was budgeted in April.</p>
      <button class="btn-diag" id="loadsurplus" ${state.surplusBusy ? "disabled" : ""}>
        ${state.surplusBusy ? "Reading…" : "Work out the surplus"}
      </button>
    </section>`;
  }
  if (d.error) {
    return `<section class="closebox">
      <h2>Surplus vs budget</h2>
      <p class="foot">${escapeHtml(d.error)}${d.hint ? ` ${escapeHtml(d.hint)}` : ""}</p>
      <button class="btn-diag" id="loadsurplus">Try again</button>
    </section>`;
  }

  const m0 = (n) => (n === null || n === undefined ? "—" : Number(n).toLocaleString("en-NZ", { maximumFractionDigits: 0 }));
  const signed = (n) => (n === null || n === undefined ? "—" : `${n > 0 ? "+" : ""}${m0(n)}`);
  const L = d.lines ?? {};
  const v = d.variance;

  const td = d.toDate;
  const f0 = d.fiscalYearStartYear;
  const fyStartKey = `${f0}-04`;
  const MONTHNAMES = ["January","February","March","April","May","June","July","August","September","October","November","December"];
  const monthName = (key) => {
    if (!key) return "—";
    const m = Number(String(key).slice(5, 7));
    return MONTHNAMES[m - 1] ? `${MONTHNAMES[m - 1]} ${String(key).slice(2, 4)}` : key;
  };

  const row = (label, key, cls = "", sub = "") => {
    const l = L[key] ?? {};
    const vr = v ? v[key] : null;
    // Year-to-date budget and variance, for the closed months only. Without
    // these the Actual column has nothing to be judged against — twelve months
    // of plan beside five months of trading is not a comparison.
    const t = td?.[key] ?? {};
    return `<tr class="${cls}">
      <th class="lab">${label}${sub ? `<span class="rowsub">${sub}</span>` : ""}</th>
      <td>${m0(t.budget)}</td>
      <td>${m0(l.actual)}</td>
      <td class="${t.variance > 0.5 ? "pos" : t.variance < -0.5 ? "neg" : ""}">${signed(t.variance)}</td>
      <td class="fyend budgetcol">${m0(l.budget)}</td>
      ${/* A WORKING, NOT AN ANSWER, and styled to say so.
           On its own this column reads as seven catastrophic months: Fall's
           revenue recognised in August, which is closed, while three-quarters
           of Fall's costs land September to November, which is here. The
           surplus row of this column has no meaning by itself — only the two
           bold columns either side of it are results. */""}
      <td class="working">${m0(l.projected)}</td>
      <td><b>${m0(l.extrapolated)}</b></td>
      <td class="${vr > 0.5 ? "pos" : vr < -0.5 ? "neg" : ""}">${signed(vr)}</td>
    </tr>`;
  };

  const s = L.surplus ?? {};
  const ahead = v && v.surplus > 0;

  return `<section class="closebox">
    <h2>Surplus vs budget
      <span class="stamp">${d.actualMonths} actual · ${d.projectedMonths} projected${
        d.unsyncedClosedMonths ? ` · ${d.unsyncedClosedMonths} not read` : ""}</span></h2>

    ${(() => {
      /* THE ANSWER, IN WORDS, FIRST.
       *
       * Everything below this is working. The panel had the number but wrapped
       * it in four paragraphs of caveats, and the question "so what was the
       * budget and what are we getting" had to be asked three separate times.
       * Caveats that bury the answer are not caution, they are just noise. */
      if (s.budget === null || s.budget === undefined) return "";
      const gap = v?.surplus;
      const word = gap > 500 ? "ahead of" : gap < -500 ? "behind" : "in line with";
      return `<p class="headline">
        Budgeted <b>${signed(s.budget)}</b> for the year.
        Tracking to <b class="${s.extrapolated < 0 ? "neg" : "pos"}">${signed(s.extrapolated)}</b>.
        ${gap == null ? "" : `That is <b>${m0(Math.abs(gap))} ${word}</b> plan.`}
      </p>`;
    })()}

    <p class="foot"><b>This is the P&amp;L, not the bank.</b> Revenue counts in the month it is recognised — a whole season at once, the month before it departs — not when students pay. These figures will not agree with the Cash flow tab, and are not meant to: the difference is deferred revenue.</p>

    ${/* FIVE TILES THAT SAY WHICH PERIOD THEY COVER.
         Two of them used to read "vs budget to date" and "Versus budget",
         which are different questions wearing near-identical labels, and
         "Extrapolated FYE" is a phrase nobody outside a finance team uses. */""}
    <div class="tiles" style="margin:12px 0">
      <div class="tile">
        <span class="k">Plan for the year</span>
        <span class="v">${m0(s.budget)}</span>
        <span class="sub">budget set in April</span>
      </div>
      <div class="tile">
        <span class="k">Actual so far</span>
        <span class="v ${s.actual < 0 ? "neg" : ""}">${m0(s.actual)}</span>
        <span class="sub">${d.lastActualMonth ? `${td?.months ?? 0} months to ${escapeHtml(monthName(d.lastActualMonth))}`
          : d.closedRangeMonths ? `${d.closedRangeMonths} closed, P&amp;L not read`
          : "nothing closed yet"}</span>
      </div>
      ${td?.surplus?.variance != null ? `<div class="tile ${td.surplus.variance < 0 ? "alert" : ""}">
        <span class="k">…vs plan so far</span>
        <span class="v ${td.surplus.variance > 0.5 ? "pos" : td.surplus.variance < -0.5 ? "neg" : ""}">${signed(td.surplus.variance)}</span>
        <span class="sub">against ${m0(td.surplus.budget)} planned for those months</span>
      </div>` : ""}
      <div class="tile ${v && v.surplus < 0 ? "alert" : ""}">
        <span class="k">Forecast for the year</span>
        <span class="v ${s.extrapolated < 0 ? "neg" : ""}">${m0(s.extrapolated)}</span>
        <span class="sub">actual so far plus the rest</span>
      </div>
      ${v ? `<div class="tile ${v.surplus < 0 ? "alert" : ""}">
        <span class="k">…vs plan for the year</span>
        <span class="v ${v.surplus > 0.5 ? "pos" : v.surplus < -0.5 ? "neg" : ""}">${signed(v.surplus)}</span>
        <span class="sub">${ahead ? "ahead of plan" : "behind plan"}</span>
      </div>` : ""}
    </div>

    <div class="scroll">
      <table class="cftable tight">
        <thead>
          ${/* EVERY COLUMN SAYS WHAT PERIOD IT COVERS AND WHERE IT CAME FROM.
               Two columns both headed "Variance" and one headed "Budget" next
               to another headed "Budget to date" is a table you have to be told
               how to read — and Jake had to ask three times. The second line of
               each header is the part that was missing. */""}
          <tr>
            <th class="lab"></th>
            <th colspan="3">Months already closed · ${escapeHtml(monthName(fyStartKey))} to ${escapeHtml(monthName(td?.throughMonth))}</th>
            <th colspan="4" class="fystart">The whole year · ${escapeHtml(monthName(fyStartKey))} ${f0} to March ${String(f0 + 1).slice(2)}</th>
          </tr>
          <tr>
            <th class="lab"><span class="colsub">All figures NZD</span></th>
            <th>Budget<span class="colsub">for these ${td?.months ?? 0} months</span></th>
            <th>Actual<span class="colsub">from the books</span></th>
            <th>Difference<span class="colsub">actual vs budget</span></th>
            <th class="fyend">Budget<span class="colsub">for the full year</span></th>
            <th class="working">Still to come<span class="colsub">forecast, ${12 - (td?.months ?? 0)} months</span></th>
            <th>Full-year forecast<span class="colsub">actual + still to come</span></th>
            <th>Difference<span class="colsub">forecast vs budget</span></th>
          </tr>
        </thead>
        <tbody>
          ${row("Revenue", "revenue", "", "what the programs earn")}
          ${row("Cost of sales", "directCosts", "", "running the programs")}
          ${row("Overheads", "overheads", "", "running the company")}
          ${row("Surplus / (loss)", "surplus", "rule strong", "revenue less both")}
        </tbody>
      </table>
    </div>

    ${(() => {
      /* THE CAVEAT THAT HAS TO SIT WITH THE TO-DATE NUMBER.
       *
       * A season's revenue recognises whole, in one month, while its costs are
       * incurred over the months around it. So right after a recognition month
       * the year-to-date surplus is flattered by a season's revenue against a
       * fraction of its cost — and right before one it looks dire. Neither is a
       * result, and the figure invites being read as one. */
      if (!td?.months || td.months >= 12) return "";
      const gm = td.revenue.actual > 0
        ? Math.round((1 - td.directCosts.actual / td.revenue.actual) * 100) : null;
      return `<p class="foot"><b>Read the to-date surplus carefully.</b>
        A season's revenue lands in one month; its costs are spread over the months around it. So the figure runs high just after a recognition month and low just before one${
          gm != null ? `, and the ${gm}% gross margin it implies over these ${td.months} months is a timing artefact rather than the margin the programs actually make` : ""}.
        The full-year columns are where the two line up.</p>`;
    })()}

    <p class="foot"><b>Variance is stated so that positive is good news on every line.</b> Revenue ahead of budget is positive; costs under budget are also positive. The three add up to the surplus variance, which is what catches a flipped sign.</p>
    ${(() => {
      /* THE TRUE-UP, SHOWN. It rescales every projected cost figure, which is
       * consequential and otherwise completely invisible on screen. */
      const t = d.trueUp;
      if (!t?.applied) return "";
      const over = t.closedGap > 0;
      return `<p class="foot"><b>Program costs are trued up.</b>
        The model puts ${m0(t.modelYearTotal)} of program cost in the year. ${m0(t.incurredInClosed)} of that is already in the books, so the ${m0(t.remaining)} still to come is spread across the remaining months — rather than replaying the planned curve, which would have made the year's total depend on when the money happened to go out.
        ${Math.abs(t.closedGap) > 0.5 ? `The closed months ran <b>${m0(Math.abs(t.closedGap))} ${over ? "above" : "below"}</b> what the curve expected of them (${t.closedGapPct != null ? `${Math.abs(t.closedGapPct)}%` : ""}), so what remains is scaled by ${t.factor}.` : "They came in on the curve, so nothing was rescaled."}</p>`;
    })()}

    ${(() => {
      /* The revenue check, beside the cost true-up so the difference between
       * them is visible: one corrects, the other only reports. */
      const v = d.revenueCheck;
      if (!v || !v.plannedInClosed) return "";
      if (v.missingSeasonMonths?.length || v.surpriseSeasonMonths?.length) {
        // The warnings above already say this loudly and in full; repeating it
        // here would dilute rather than reinforce.
        return "";
      }
      const over = v.gap > 0;
      const material = Math.abs(v.gapPct ?? 0) >= 1;
      return `<p class="foot"><b>Revenue is checked, not corrected.</b>
        The model expected the closed months to recognise ${m0(v.plannedInClosed)}; the books show ${m0(v.bookedInClosed)}${
          material ? ` — <b>${m0(Math.abs(v.gap))} ${over ? "ahead" : "short"}</b>, ${Math.abs(v.gapPct)}%` : ", within 1%"}.
        ${material
          ? `That is pax or price moving, not timing, so the months still to come are deliberately left alone — inflating Spring to make up a shortfall in Fall would hide the thing worth knowing. If the same gap holds for the seasons ahead, the extrapolation is ${over ? "understated" : "overstated"} by roughly ${Math.abs(v.gapPct)}%.`
          : `Pax and prices are holding against what is entered, which is what makes the projected months trustworthy.`}</p>`;
    })()}

    <p class="foot"><b>Projected</b> months come from the pax model — each program's recognised revenue and its costs at the entered pax — with overheads from the Xero budget. So changing pax on the Programs tab moves this number, which is the point of looking at it in September rather than re-reading the budget.</p>
    ${(d.warnings ?? []).map((w) => `<p class="foot">${escapeHtml(w)}</p>`).join("")}

    <div class="scroll" style="margin-top:14px">
      <table class="cftable tight">
        <thead><tr><th class="lab">Month</th><th>Revenue</th><th class="lab">vs model</th><th>Cost of sales</th><th>Overheads</th><th>Surplus</th><th class="lab">From</th></tr></thead>
        <tbody>
          ${(d.months ?? []).map((m) => `
            <tr class="${m.source === "actual" ? "" : "muted"}">
              <th class="lab">${escapeHtml(m.key)}</th>
              <td>${m0(m.revenue)}</td>
              ${/* What the model expected of this month, for closed months only.
                   A blank here on a month the model thought would carry a season
                   is the recognition-month bug, visible at a glance. */""}
              <td class="lab">${m.source === "actual" && m.revenuePlanned > 0.5
                ? `<span class="stamp" title="Model expected ${m0(m.revenuePlanned)}">${
                    Math.abs(m.revenue - m.revenuePlanned) < Math.max(1_000, m.revenuePlanned * 0.01)
                      ? "on model"
                      : `${m.revenue > m.revenuePlanned ? "+" : ""}${m0(m.revenue - m.revenuePlanned)}`}</span>`
                : m.source === "actual" && m.revenue > 50_000
                  ? '<span class="stamp" title="The model expected nothing here">unexpected</span>'
                  : ""}</td>
              <td>${m0(m.directCosts)}</td>
              <td>${m0(m.overheads)}</td>
              <td class="${m.surplus < -0.5 ? "neg" : ""}">${m0(m.surplus)}</td>
              <td class="lab"><span class="stamp">${m.source === "actual" ? "books" : "model"}</span>${
                m.projectedBecause === "no P&L stored for a closed month" ? ' <span class="stamp">not synced</span>' : ""}${
                // A projected month whose cost was rescaled says so, with what
                // the curve had originally planned for it — otherwise the only
                // way to notice is to add the column up.
                m.trueUpApplied && Math.abs(m.directCostsAsPlanned - m.directCosts) > 0.5
                  ? ` <span class="stamp" title="Phasing curve planned ${m0(m.directCostsAsPlanned)}">trued up</span>` : ""}</td>
            </tr>`).join("")}
        </tbody>
      </table>
    </div>

    <button class="btn-diag" id="loadsurplus" ${state.surplusBusy ? "disabled" : ""}>
      ${state.surplusBusy ? "Reading…" : "Re-read"}
    </button>
  </section>`;
}

/**
 * What the overheads are made of.
 *
 * WHY A PANEL RATHER THAN AN ANSWER IN CHAT
 * -----------------------------------------
 * "Where do we cut" is not a question with one answer, and it is not a question
 * anyone should have to ask me twice. The P&L lines have been in the store
 * since the first sync; the dashboard showed a monthly total and nothing
 * underneath it. This reads what is already there.
 *
 * The ranking is by ANNUALISED cost, not by the largest single month. A 1,800
 * subscription paid every month outranks a 12,000 one-off, and should: the
 * first is 21,600 a year of standing commitment and the second is a decision
 * already made.
 */
function overheadLinesPanel() {
  const d = state.ohLines;
  const basis = state.ohLinesBasis ?? "cash";

  const basisPicker = `
    <div class="rates" style="margin:10px 0">
      ${[["cash", "Cash only"], ["total", "Everything in the P&L"]].map(([id, label]) => `
        <label class="rateopt ${basis === id ? "on" : ""}">
          <input type="radio" name="ohlbasis" value="${id}" ${basis === id ? "checked" : ""}>
          <span class="rl">${label}</span>
        </label>`).join("")}
    </div>`;

  if (!d) {
    return `<section class="closebox">
      <h2>What the overheads are <span class="stamp">from the P&amp;L</span></h2>
      <p class="foot">Every expense line in the books, ranked by what it costs a year, with the months it actually landed in. Reads the P&amp;L months already stored — no Xero calls.</p>
      <button class="btn-diag" id="loadohlines" ${state.ohLinesBusy ? "disabled" : ""}>
        ${state.ohLinesBusy ? "Reading the P&L…" : "Break down the overheads"}
      </button>
    </section>`;
  }
  if (d.error) {
    return `<section class="closebox">
      <h2>What the overheads are</h2>
      <p class="foot">${escapeHtml(d.error)}${d.hint ? ` ${escapeHtml(d.hint)}` : ""}</p>
      <button class="btn-diag" id="loadohlines">Try again</button>
    </section>`;
  }

  const money0 = (n) => Number(n).toLocaleString("en-NZ", { maximumFractionDigits: 0 });
  const c = d.concentration ?? { lines: 0, sharePct: 0 };

  /* The sparkline is twelve-ish bars, not a chart library.
   *
   * What it has to answer is one question — is this every month or is it a
   * spike — and a bar per observed month answers it at a glance without the
   * reader having to compare numbers across a wide row. */
  const scale = (l) => {
    const peak = Math.max(...l.amounts.map(Math.abs), 1);
    return l.amounts.map((v, i) => {
      const h = Math.round((Math.abs(v) / peak) * 100);
      return `<i style="height:${Math.max(h, v ? 6 : 1)}%" title="${escapeHtml(d.monthKeys[i] ?? "")}: ${money0(v)}"></i>`;
    }).join("");
  };

  const rows = (d.lines ?? []).filter((l) => Math.abs(l.total) > 0).slice(0, 40);

  return `<section class="closebox">
    <h2>What the overheads are
      <span class="stamp">${d.monthsObserved} months · ${basis === "cash" ? "cash only" : "everything"}</span></h2>
    <p class="foot">${money0(d.annualised)} a year, running at ${money0(d.monthlyMean)} a month across the ${d.monthsObserved} months in the books.
      ${c.lines ? `<b>${c.lines} lines make up ${c.sharePct}% of it</b> — that is the conversation.` : ""}</p>
    <p class="foot"><b>${money0(d.steadyTotal)}</b> of it is steady, month after month — contracts, subscriptions, people — and <b>${money0(d.lumpyTotal)}</b> arrives in lumps. The first is renegotiated, the second is decided one at a time, and they are rarely the same meeting.</p>
    ${basisPicker}
    ${d.truncatedMonths?.length ? `<p class="foot"><b>${d.truncatedMonths.length} month${d.truncatedMonths.length === 1 ? " was" : "s were"} stored before every line was kept</b> (${d.truncatedMonths.map(escapeHtml).join(", ")}), so only their twelve biggest lines are here. Anything smaller is missing from those months and its yearly figure is understated. Overheads → Diagnostics → Refresh Xero data now rewrites them.</p>` : ""}
    <div class="scroll">
      <table class="cftable tight">
        <thead><tr>
          <th class="lab">Line</th><th>A year</th><th>A month</th>
          <th>Months</th><th>Pattern</th><th class="lab">By month</th>
        </tr></thead>
        <tbody>
          ${rows.map((l) => `
            <tr>
              <th class="lab">${escapeHtml(l.name)}${l.nonCash ? ' <span class="stamp">non-cash</span>' : ""}</th>
              <td><b>${money0(l.annualised)}</b></td>
              <td>${money0(l.monthlyMean)}</td>
              <td>${l.monthsWithSpend}/${d.monthsObserved}</td>
              <td>${l.steady ? '<span class="stamp">steady</span>'
                    : `<span class="stamp">lumpy ×${l.spread.toFixed(1)}</span>`}</td>
              <td class="lab"><span class="spark">${scale(l)}</span></td>
            </tr>`).join("")}
        </tbody>
      </table>
    </div>
    <p class="foot"><b>A year</b> is the monthly average across every observed month, times twelve — including the months a line was zero. That is deliberate: dividing a line's total by only the months it appeared in would make a once-a-year cost look like a large standing one, which is exactly backwards for deciding what to cut.</p>
    <p class="foot"><b>Pattern</b> compares a line's biggest month against its own average. Steady means it lands most months at a similar size. <i>Lumpy ×4</i> means one month was four times the average — an event, not a run rate.</p>
    <button class="btn-diag" id="loadohlines" ${state.ohLinesBusy ? "disabled" : ""}>
      ${state.ohLinesBusy ? "Reading…" : "Re-read"}
    </button>
  </section>`;
}

/**
 * The profit and loss, openable.
 *
 * WHY THIS IS A SEPARATE TAB FROM "SURPLUS VS BUDGET"
 * ---------------------------------------------------
 * They read the same books and they answer different questions. The Surplus tab
 * is a forecast: five months of actual plus seven months of pax model, against
 * the budget, ending in one number for 31 March. This tab is the statement —
 * only what has actually been reported, with every account under it. Nothing
 * here is projected, and the year-end column is the budget rather than a
 * forecast, because a P&L that quietly contains a guess is not a P&L.
 *
 * So the two tabs will show different full-year figures, and should. If they
 * agreed, one of them would be lying about what it is.
 *
 * THE COLUMN THAT MATTERS
 * -----------------------
 * "Budget" here is cut to the months that have closed. Five months of trading
 * against a twelve-month plan reads as a spectacular underspend on every single
 * row, and it is the single easiest way to come away from this page with
 * entirely the wrong impression. The full-year budget is still shown, in its
 * own column past a rule, because it is what the year gets judged against — but
 * it is not the comparison.
 */
function pnlPanel() {
  const d = state.pnl;
  const basis = state.pnlBasis ?? "total";

  /* One definition of the controls, used on both the error path and the loaded
   * one. Two copies of the same radio group is two places for the value to
   * drift apart, and the drift shows up as a picker that does nothing. */
  const controls = (withMonths) => `
    <div class="rates" style="margin:10px 0">
      ${withMonths ? `<label class="rateopt ${state.pnlByMonth ? "on" : ""}">
        <input type="checkbox" id="pnlbymonth" ${state.pnlByMonth ? "checked" : ""}>
        <span class="rl">Show month by month</span>
      </label>` : ""}
      ${[["total", "The P&L as Xero prints it"], ["cash", "Cash only"]].map(([id, label]) => `
        <label class="rateopt ${basis === id ? "on" : ""}">
          <input type="radio" name="pnlbasis" value="${id}" ${basis === id ? "checked" : ""}>
          <span class="rl">${label}</span>
        </label>`).join("")}
    </div>`;

  if (!d) {
    return `<section class="closebox">
      <h2>Profit and loss <span class="stamp">from the books</span></h2>
      <p class="foot">The statement for the year so far — income, cost of sales and operating expenses — with every account underneath, against the budget for the same months. Reads what is already stored; no Xero calls.</p>
      <button class="btn-diag" id="loadpnl" ${state.pnlBusy ? "disabled" : ""}>
        ${state.pnlBusy ? "Reading…" : "Open the P&L"}
      </button>
    </section>`;
  }
  if (d.error) {
    return `<section class="closebox">
      <h2>Profit and loss</h2>
      <p class="foot">${escapeHtml(d.error)}${d.hint ? ` ${escapeHtml(d.hint)}` : ""}</p>
      ${controls(false)}
      <button class="btn-diag" id="loadpnl">Try again</button>
    </section>`;
  }

  const m0 = (n) => (n === null || n === undefined ? "—" : Number(n).toLocaleString("en-NZ", { maximumFractionDigits: 0 }));
  const signed = (n) => (n === null || n === undefined ? "—" : `${n > 0 ? "+" : ""}${m0(n)}`);
  const vcls = (n) => (n === null || n === undefined ? "" : n > 0.5 ? "pos" : n < -0.5 ? "neg" : "");
  const MONTHNAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const shortMonth = (key) => {
    if (!key) return "—";
    const m = Number(String(key).slice(5, 7));
    return `${MONTHNAMES[m - 1] ?? key} ${String(key).slice(2, 4)}`;
  };

  const open = state.pnlOpen ?? {};
  const byMonth = Boolean(state.pnlByMonth);
  const closed = new Set(d.closedSlots ?? []);
  const twist = (id) => `<span class="twist">${open[id] ? "▾" : "▸"}</span>`;

  /* Two column sets, because they answer different questions and mixing them
   * gives a table nobody can read: the summary is "how are we doing against
   * plan", the monthly view is "when did it happen". */
  const headCells = byMonth
    ? `${(d.monthKeys ?? []).map((k, i) => `<th class="${closed.has(i) ? "actualcol" : "na"}">${shortMonth(k)}</th>`).join("")}
       <th class="fystart">Total<span class="colsub">${d.monthsClosed} closed months</span></th>`
    : `<th>Actual<span class="colsub">${d.monthsClosed} months to ${escapeHtml(shortMonth(d.lastActualMonth))}</span></th>
       <th class="budgetcol">Budget<span class="colsub">same ${d.monthsClosed} months</span></th>
       <th>Difference<span class="colsub">actual vs budget</span></th>
       <th class="fystart budgetcol">Budget<span class="colsub">the full year</span></th>`;
  const colCount = byMonth ? 13 : 4;

  /* A row's figures. `o` is anything with months/total/budgetToDate/
   * varianceToDate/budgetTotal — a section, a line, a derived subtotal — so
   * every row in the table is rendered by the same function and cannot drift
   * from the one above it. */
  const cells = (o) => byMonth
    ? `${(o.months ?? Array(12).fill(0)).map((v, i) =>
         `<td class="${closed.has(i) ? "actualcol" : "na"}">${closed.has(i) ? m0(v) : ""}</td>`).join("")}
       <td class="fystart"><b>${m0(o.total)}</b></td>`
    : `<td><b>${m0(o.total)}</b></td>
       <td class="budgetcol">${m0(o.budgetToDate)}</td>
       <td class="${vcls(o.varianceToDate)}" ${o.budgetToDate ? `title="${Math.round((o.varianceToDate / Math.abs(o.budgetToDate)) * 100)}% of budget"` : ""}>${signed(o.varianceToDate)}</td>
       <td class="fystart budgetcol">${m0(o.budgetTotal)}</td>`;

  const sectionRows = (s) => {
    const isOpen = open[s.id];
    const head = `
      <tr class="pnlsec ${isOpen ? "on" : ""}" data-pnl="${s.id}">
        <th class="lab">${twist(s.id)}${escapeHtml(s.title)}
          <span class="rowsub">${escapeHtml(s.note ?? "")}</span></th>
        ${cells(s)}
      </tr>`;
    if (!isOpen) return head;

    const lineRows = s.lines.map((l) => {
      const lid = `${s.id}::${l.name}`;
      const lineOpen = open[lid];
      const r = `
        <tr class="pnlline ${lineOpen ? "on" : ""}" data-pnl="${escapeHtml(lid)}">
          <th class="lab">${byMonth ? "" : twist(lid)}${escapeHtml(l.name)}${
            l.budgetStatus === "unbudgeted" ? ' <span class="stamp tag-un">not in budget</span>' : ""}${
            l.budgetStatus === "nonCash" ? ' <span class="stamp">non-cash</span>' : ""}</th>
          ${cells(l)}
        </tr>`;
      // In the monthly view every row already shows its months, so opening a
      // line would repeat the row it sits on.
      if (!lineOpen || byMonth) return r;
      return r + `
        <tr class="pnlmonths">
          <th class="lab"></th>
          <td colspan="${colCount}">
            <table class="minimonths">
              <tr>${(d.monthKeys ?? []).map((k, i) =>
                `<th class="${closed.has(i) ? "" : "na"}">${shortMonth(k)}</th>`).join("")}</tr>
              <tr>${(l.months ?? []).map((v, i) =>
                `<td class="${closed.has(i) ? "" : "na"}">${closed.has(i) ? m0(v) : "—"}</td>`).join("")}</tr>
              ${l.budgetMonths ? `<tr class="bud">${l.budgetMonths.map((v) =>
                `<td>${m0(v)}</td>`).join("")}</tr>` : ""}
            </table>
            <span class="minilegend">actual${l.budgetMonths ? " · budget" : " · no budget for this account"}${
              closed.size < 12 ? ` · months past ${escapeHtml(shortMonth(d.lastActualMonth))} have not been reported yet` : ""}</span>
          </td>
        </tr>`;
    }).join("");

    /* THE ROW THAT KEEPS THE DRILL-DOWN HONEST.
     *
     * The section total comes from the P&L's own total, not from adding the
     * lines up. When the two differ — a month stored before every line was
     * kept — the difference is shown as its own row rather than left for the
     * reader to discover by adding a column of forty numbers. */
    const residual = s.residual?.material ? `
      <tr class="pnlline muted">
        <th class="lab">Not itemised<span class="rowsub">months stored before every line was kept — refresh to fill in</span></th>
        ${cells({ months: s.residual.months, total: s.residual.total, budgetToDate: null, varianceToDate: null, budgetTotal: null })}
      </tr>` : "";

    const budgetOnly = s.budgetOnly?.length ? `
      <tr class="pnlline sep"><th class="lab" colspan="${colCount + 1}">Budgeted, nothing spent yet</th></tr>` +
      s.budgetOnly.map((b) => `
        <tr class="pnlline muted">
          <th class="lab">${escapeHtml(b.name)}</th>
          ${byMonth
            ? `${Array(12).fill(0).map(() => `<td class="na"></td>`).join("")}<td class="fystart">0</td>`
            : `<td>0</td><td class="budgetcol">${m0(b.budgetToDate)}</td>
               <td class="${vcls(b.budgetToDate)}">${signed(b.budgetToDate)}</td>
               <td class="fystart budgetcol">${m0(b.budgetTotal)}</td>`}
        </tr>`).join("") : "";

    return head + lineRows + residual + budgetOnly;
  };

  const derivedRow = (o, cls) => `
    <tr class="${cls}">
      <th class="lab">${escapeHtml(o.title)}</th>
      ${cells(o)}
    </tr>`;

  const [income, cos, oh] = d.sections;
  const gp = d.grossProfit;
  const sp = d.surplus;

  return `<section class="closebox">
    <h2>Profit and loss
      <span class="stamp">${d.monthsClosed} month${d.monthsClosed === 1 ? "" : "s"} reported${
        basis === "cash" ? " · cash only" : ""}</span></h2>

    ${(() => {
      /* THE ANSWER FIRST, IN WORDS. Same reason as the Surplus tab: a page that
       * opens with a table makes the reader do the arithmetic that the page was
       * built to do for them. */
      if (!d.monthsClosed) return "";
      return `<p class="headline">
        Over ${d.monthsClosed} month${d.monthsClosed === 1 ? "" : "s"} to ${escapeHtml(shortMonth(d.lastActualMonth))}:
        income <b>${m0(income.total)}</b>, less cost of sales <b>${m0(cos.total)}</b>,
        leaves <b>${m0(gp.total)}</b>${d.grossMarginPct != null ? ` — a <b>${d.grossMarginPct}%</b> gross margin` : ""}.
        Operating expenses took <b>${m0(oh.total)}</b>, for a
        <b class="${sp.total < 0 ? "neg" : "pos"}">${signed(sp.total)}</b> ${sp.total < 0 ? "loss" : "surplus"}.
      </p>`;
    })()}

    <p class="foot"><b>This is what the books reported, not a forecast.</b> Only closed months are here, and the year-end column is the budget rather than an extrapolation. The Surplus tab answers the other question — where the full year lands — by adding the pax model to these months, so the two tabs will not show the same year-end figure.</p>

    ${controls(true)}

    <p class="foot">Click any line to open it. ${byMonth
      ? "Blank months have not been reported yet — they are not zeros."
      : "Sections open into their accounts; an account opens into its twelve months against budget."}</p>

    <div class="scroll">
      <table class="cftable tight pnl">
        <thead>
          <tr>
            <th class="lab"><span class="colsub">All figures NZD</span></th>
            ${headCells}
          </tr>
        </thead>
        <tbody>
          ${sectionRows(income)}
          ${sectionRows(cos)}
          ${derivedRow(gp, "rule strong")}
          ${sectionRows(oh)}
          ${derivedRow(sp, "rule strong")}
        </tbody>
      </table>
    </div>

    <p class="foot"><b>Difference is stated so that positive is good news on every row.</b> Income above budget is positive; costs under budget are also positive. The three sections' differences add to the surplus difference, which is the check that catches a flipped sign.</p>
    ${oh.unbudgetedTotal || cos.unbudgetedTotal ? `<p class="foot"><b>${m0(Math.abs(oh.unbudgetedTotal + cos.unbudgetedTotal))} has been spent on accounts with no budget line at all</b>, marked <i>not in budget</i>. That is not an overspend against a plan — there was no plan — so it never appears in any variance above, which is exactly why it is worth looking at.</p>` : ""}
    ${d.budgetDescription ? `<p class="foot">Budget: ${escapeHtml(d.budgetDescription)}.</p>` : ""}
    ${(d.warnings ?? []).map((w) => `<p class="foot">${escapeHtml(w)}</p>`).join("")}

    <button class="btn-diag" id="loadpnl" ${state.pnlBusy ? "disabled" : ""}>
      ${state.pnlBusy ? "Reading…" : "Re-read"}
    </button>
  </section>`;
}

/**
 * The caveat that has to travel with the tail.
 *
 * Months past 31 March exist so there is always a year of runway visible. They
 * are not a forecast of next year: no FY27/28 programs are entered, so no
 * student money arrives in them and no program cost goes out. Overheads repeat
 * from the same fiscal month a year earlier, because rent and wages continuing
 * is a far smaller assumption than any guess at next year's enrolments.
 *
 * The balance therefore falls through the tail. That fall is the shape of the
 * missing inputs, and saying so here — in the same view as the number, not in a
 * help page — is the difference between a prompt and a false alarm.
 */
function beyondNote(f) {
  const h = f.horizon;
  if (!h?.beyondFiscalYear) return "";
  const first = f.months[h.fiscalYearMonths];
  const last = f.months[f.months.length - 1];
  const scope = `Year totals and the tiles above cover FY${String(f.fiscalYearStartYear).slice(2)}/${String(f.fiscalYearStartYear + 1).slice(2)} only.`;

  if (!h.emptyFromLabel) {
    return `<p class="beyondnote"><b>${escapeHtml(first.label)} to ${escapeHtml(last.label)}</b> are beyond the reported year, shown so there are always two years of runway. Programs are entered right through, so these are a real forecast. ${scope}</p>`;
  }
  // What the runway's overheads are actually costed from. "Carried forward"
  // covers two quite different things — a budgeted figure and a hand-typed one
  // — and which it is decides how much weight the tail deserves.
  const fwd = (f.months.slice(h.fiscalYearMonths) ?? [])
    .map((m) => m.overheadCarriedFrom).filter(Boolean);
  const budgeted = fwd.filter((s) => s === "budget").length;
  const basis = !fwd.length ? ""
    : budgeted === fwd.length ? " Their overheads repeat this year's <b>Xero budget</b>, month for month."
    : budgeted ? ` Their overheads repeat this year's Xero budget where it has a figure (${budgeted} of 12 months) and the typed figure otherwise.`
    : " Their overheads repeat the <b>typed</b> figures — no Xero budget was found, so nothing here comes from a plan.";

  return `<p class="beyondnote"><b>${escapeHtml(h.emptyFromLabel)} onward has no programs entered</b> — ${h.emptyMonths} month${h.emptyMonths === 1 ? "" : "s"} of the ${h.beyondFiscalYear} past 31 March.
    Those months show overheads going out and no student money coming in.${basis}
    The balance falling away across them is the gap in the inputs, not a forecast, and no warning or tile above is drawn from them.
    Add the missing programs on the Programs tab and the tail fills in from there.</p>`;
}

/**
 * What the books say about cost phasing, next to what the model assumes.
 *
 * WHY THIS IS A PANEL AND NOT A DIAGNOSTIC
 * ----------------------------------------
 * The previous four steps each ended with "run this probe and send me the
 * output". That makes one person a courier for their own data, and it leaves
 * the answer in a conversation rather than on the page. So the derivation runs
 * server-side and reports itself here, with its own coverage and window.
 *
 * It does NOT adopt anything automatically. A curve built on half a cycle looks
 * every bit as authoritative as one built on two, and the difference matters
 * more than the shape does.
 */
function costCurvePanel() {
  const c = state.costCurve;
  if (!c) {
    return `<section class="closebox">
      <h2>Cost phasing <span class="stamp">from the books</span></h2>
      <p class="foot">The model spreads a program's cost 25% the month before departure and 45% in the departure month. That shape was invented. This reads what was actually paid, per season, against each season's departure.</p>
      <button class="btn-diag" id="loadcurve" ${state.curveBusy ? "disabled" : ""}>
        ${state.curveBusy ? "Reading the books…" : "Derive from actual spend"}
      </button>
    </section>`;
  }
  if (c.error) {
    return `<section class="closebox">
      <h2>Cost phasing</h2>
      <p class="foot">${escapeHtml(c.error)}${c.hint ? ` ${escapeHtml(c.hint)}` : ""}</p>
      <button class="btn-diag" id="loadcurve">Try again</button>
    </section>`;
  }

  const cov = c.coverageWeighted ?? {};
  const ev = c.evidence ?? {};

  /* "Nothing tagged" is only a fact about the books if the books were read.
   *
   * Across 4,000 line items it means nobody tags supplier spend. Across zero it
   * means nothing was fetched, which is a fact about this code. The panel said
   * the first when the truth was the second, so the sentence now states which. */
  const covLine = Object.entries(cov).length
    ? Object.entries(cov).map(([k, v]) => `<b>${escapeHtml(k)}</b> ${v}%`).join(" · ")
    : ev.lineItemsSeen
      ? `nothing tagged — ${Number(ev.lineItemsSeen).toLocaleString("en-NZ")} line items read and not one carries a Program or Season tag`
      : "nothing read yet — no line detail has been fetched, so this says nothing about the books";

  /* What to DO about it, which is different for each cause and was previously
   * left as an exercise. */
  const D = {
    "nothing-fetched": "No month has been fetched yet. Run <b>Overheads → Diagnostics → Refresh Xero data now</b> and let it finish.",
    "opex-stale": `The P&amp;L months in store were written before this code could read Cost of Sales, so they hold overheads but no program cost. The version stamp is now bumped, so <b>Overheads → Diagnostics → Refresh Xero data now</b> rewrites them. Nothing is wrong with the books.`,
    "history-short": "The refresh gets through the current year first and stops when its time is up, so the prior year is still short. Run <b>Overheads → Diagnostics → Refresh Xero data now</b> again — each run keeps what it got and carries on.",
  }[ev.diagnosis];

  const evidenceBlock = !ev.tx ? "" : `
    <p class="foot"><b>What was read:</b>
      bank detail ${ev.tx.stored}/${ev.tx.expected} months
      · P&amp;L ${ev.opex.stored}/${ev.opex.expected} months, ${ev.opex.withProgramCost} with program cost
      · ${Number(ev.lineItemsSeen || 0).toLocaleString("en-NZ")} line items
      ${ev.billsReferenced ? `· ${ev.billsFetched}/${ev.billsReferenced} supplier bills opened` : ""}
    </p>
    ${D ? `<p class="foot">${D}</p>` : ""}`;

  const pf = c.profile;
  const MONTHS = pf?.fiscalMonths ?? ["Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec","Jan","Feb","Mar"];

  /* The calendar profile, shown FIRST because it is usually the better trade.
   *
   * The season curves below depend on each payment carrying a tracking tag —
   * something nobody controls and which fails quietly when it is only sometimes
   * filled in. This depends on the year repeating, which anyone can check, and
   * it is measured on every dollar of program cost rather than the tagged
   * share. */
  const profileBlock = !pf ? "" : `
    <div class="closebox" style="margin:8px 0">
      <h2 style="font-size:14px">By calendar month
        <span class="stamp">${pf.adoptable ? "usable" : "not usable yet"}</span></h2>
      <p class="foot">Share of a year's program cost leaving in each fiscal month, from the P&amp;L's Cost of Sales. No tagging needed — this covers every dollar of program spend.</p>
      ${pf.shares ? `<p class="foot">${pf.shares.map((v, i) => `<span class="stamp">${MONTHS[i]} ${Math.round(v * 100)}%</span>`).join(" ")}</p>` : ""}
      <p class="foot">${(pf.perYear ?? []).map((y) => `FY${String(y.fiscalYear).slice(2)}/${String(y.fiscalYear + 1).slice(2)}: ${Number(y.total).toLocaleString("en-NZ")} over ${y.monthsWithData}/12 months${y.complete ? "" : " <b>(incomplete)</b>"}`).join(" · ") || "no program cost recorded"}</p>
      ${pf.adoptable ? "" : `<p class="foot"><b>Why not yet:</b> ${(pf.reasons ?? []).map(escapeHtml).join("; ")}.</p>`}
      ${pf.maxYearGapPct != null ? `<p class="foot">The observed years differ by up to ${pf.maxYearGapPct} points in a single month. ${pf.maxYearGapPct > 8 ? "That is the calendar assumption not holding — worth understanding before adopting." : "Close enough that the rhythm looks stable."}</p>` : ""}
      <p class="foot"><b>Shape only.</b> The amount comes from the model's own pax and per-pax costs, so more enrolments spend more on the same rhythm. What this cannot know is a season MOVING — shift Fall to October and real spend moves with it while these shares do not.</p>
    </div>`;

  /* THE SPLIT, shown before either curve.
   *
   * Programs in a season end on the same day but start on staggered dates, so a
   * later start means a SHORTER program — and the engine, which anchors
   * everything to the start date and has never read endDate, slides its whole
   * cost shape later instead of compressing it. How much that matters depends
   * entirely on how much of the money goes out during delivery rather than
   * before it, which is a question worth measuring rather than assuming. */
  const sp = c.split;
  const splitBlock = !sp ? "" : `
    <div class="closebox" style="margin:8px 0">
      <h2 style="font-size:14px">Before, during, after
        <span class="stamp">${sp.adoptable ? "measured" : "not measurable yet"}</span></h2>
      ${sp.overall ? `<p class="foot">
        <span class="stamp">run-up ${Math.round(sp.overall.before * 100)}%</span>
        <span class="stamp">during delivery ${Math.round(sp.overall.during * 100)}%</span>
        <span class="stamp">after it ends ${Math.round(sp.overall.after * 100)}%</span>
        — weighted across ${(sp.seasonYearsUsed ?? []).length} season${(sp.seasonYearsUsed ?? []).length === 1 ? "" : "s"} observed all the way through.</p>` : ""}
      ${(sp.seasonYears ?? []).map((y) => `<p class="foot">${escapeHtml(y.key)}: ${Number(y.total).toLocaleString("en-NZ")}${y.shares ? ` — ${Math.round(y.shares.before * 100)}/${Math.round(y.shares.during * 100)}/${Math.round(y.shares.after * 100)}` : ""}, runs ${escapeHtml(y.firstStart)} to ${escapeHtml(y.end ?? "?")}${y.staggerDays ? `, starts staggered over ${y.staggerDays} days` : ""}${y.complete ? "" : " <b>(run-up only)</b>"}</p>`).join("")}
      ${sp.adoptable ? "" : `<p class="foot"><b>Why not yet:</b> ${(sp.reasons ?? []).map(escapeHtml).join("; ")}.</p>`}
      ${sp.overall && sp.overall.during > 0.35 ? `<p class="foot"><b>This matters.</b> ${Math.round(sp.overall.during * 100)}% of program cost goes out while the group is away, and a program that starts a month later finishes on the same day — so it is a month shorter and that spend has to compress, not slide. The engine currently slides it.</p>` : ""}
      ${sp.overall && sp.overall.during <= 0.35 && sp.adoptable ? `<p class="foot">Most of the money is committed before anyone departs, so trip length matters less than the booking rhythm does — the calendar profile above carries most of the weight.</p>` : ""}
      ${sp.taggedToUnknownSeason ? `<p class="foot">${Number(sp.taggedToUnknownSeason).toLocaleString("en-NZ")} is tagged to a season with no end date in the model, so it cannot be placed. Add end dates on the Programs tab to include it.</p>` : ""}
    </div>`;

  const seasons = Object.entries(c.seasons ?? {});
  const unmatched = Object.entries(c.unmatchedOptions ?? {});

  const curveRow = (offsets) => {
    if (!offsets?.length) return `<td colspan="2" class="muted">—</td>`;
    return offsets.map((o) => `<span class="stamp">${o.monthOffset > 0 ? "+" : ""}${o.monthOffset}m ${Math.round(o.share * 100)}%</span>`).join(" ");
  };

  return `<section class="closebox">
    <h2>Cost phasing <span class="stamp">${c.monthsStored} months · ${c.categoryUsed}</span></h2>
    <p class="foot">Share of a season's spend by months from departure — negative is before. Derived from ${Number(c.totalOutAcrossMonths).toLocaleString("en-NZ")} of outgoing money across two fiscal years. Tagging coverage: ${covLine}.</p>
    ${evidenceBlock}

    ${splitBlock}
    ${profileBlock}
    <p class="foot"><b>By season, anchored to departure</b> — adapts when a season moves, but only covers spend that carries a season tag.</p>
    ${seasons.length ? seasons.map(([name, s]) => `
      <div class="closebox" style="margin:8px 0">
        <h2 style="font-size:14px">${escapeHtml(name)}
          <span class="stamp">${s.adoptable ? "usable" : "not usable yet"}</span></h2>
        <p class="foot">${Number(s.total).toLocaleString("en-NZ")} of spend · ${s.seasonYears} season${s.seasonYears === 1 ? "" : "s"} observed (${(s.observedYears ?? []).map(escapeHtml).join(", ")}) · window ${s.window?.first}m to ${s.window?.last > 0 ? "+" : ""}${s.window?.last}m</p>
        <p class="foot">${curveRow(s.offsets)}</p>
        ${s.adoptable ? "" : `<p class="foot"><b>Why not yet:</b> ${(s.reasons ?? []).map(escapeHtml).join("; ")}.</p>`}
        ${(s.anchors ?? []).some((a) => a.spreadDays > 21) ? `<p class="foot">Programs in this season depart up to ${Math.max(...s.anchors.map((a) => a.spreadDays || 0))} days apart, so the curve averages departures that are not aligned.</p>` : ""}
      </div>`).join("")
      : `<p class="foot">No season could be placed against a departure date. ${unmatched.length ? "Tags were found, but none matched a season in the model." : "No spend carries a season tag."}</p>`}

    <p class="foot"><b>The model currently uses</b> ${curveRow(c.current)} for every season.</p>

    ${unmatched.length ? `<p class="foot"><b>Tagged but unplaceable:</b> ${unmatched.slice(0, 12).map(([k, v]) => `${escapeHtml(k)} ${Number(v).toLocaleString("en-NZ")}`).join(" · ")}. These carry a tag that does not match a season in the model, so their spend is excluded rather than attached to the nearest thing that looks similar.</p>` : ""}

    ${c.unattributable?.spendWithoutLineDetail ? `<p class="foot">${Number(c.unattributable.spendWithoutLineDetail).toLocaleString("en-NZ")} of spend has no line detail to attribute by, and ${Number(c.unattributable.unconverted || 0).toLocaleString("en-NZ")} could not be converted to NZD honestly. Both count against the coverage above rather than being hidden.</p>` : ""}

    <button class="btn-diag" id="loadcurve" ${state.curveBusy ? "disabled" : ""}>
      ${state.curveBusy ? "Reading…" : "Re-read"}
    </button>
  </section>`;
}

function paymentsView() {
  const r = state.assumptions.defaultPaymentRules;
  const ro = !state.canEdit;
  const sum = r.bookingCurve.reduce((s, p) => s + p.share, 0);
  return `
    ${costCurvePanel()}
    <div class="two">
      <section>
        ${r.receiptsCurve?.length ? "" : `
        <h2>When students pay</h2>
        <label class="field"><span>Deposit at booking</span>
          <input type="number" id="deposit" value="${r.deposit}" step="50" ${ro ? "disabled" : ""}></label>
        <label class="field"><span>Balance due, days before departure</span>
          <input type="number" id="baldays" value="${r.balanceDueDaysBeforeDeparture}" step="5" ${ro ? "disabled" : ""}></label>`}
        <h2>Treasury</h2>
        <label class="field"><span>Minimum NZD balance to hold</span>
          <input type="number" id="buffer" value="${state.assumptions.baseMinimumBuffer ?? 0}" step="10000" ${ro ? "disabled" : ""}></label>
        <p class="foot">USD is converted only when the NZD account would fall below this. Raise it to convert earlier and hold less USD; lower it to hold USD longer and carry more rate risk.</p>
        <label class="field"><span>Share of receipts paid in NZD</span>
          <input type="number" id="nzdshare" value="${(((r.nzdReceiptShare ?? 0) * 100)).toFixed(1)}" step="1" min="0" max="100" ${ro ? "disabled" : ""}></label>
        <p class="foot">Funds arrive in USD except for students who pay NZD directly. That portion lands in the NZD account already converted, so it never passes through the treasury block. <b>This does not change Cash in, the closing position, or the rate sensitivity</b> — an NZD payment is the USD price converted at the day's rate, so it moves with the rate exactly as a USD payment does. What it changes is how much you actually have to convert, and when the NZD account is short.</p>
      </section>
      ${ratePanel(ro)}
      ${receiptsCurveSection(ro, sum)}
    </div>`;
}

/**
 * The single receipts curve.
 *
 * Deposits and balances were modelled separately for weeks, and every part of
 * that split turned out to be unverifiable — one part-paid invoice per student
 * means nothing in Xero says which instalment a payment was. Four inputs that
 * could each be wrong, with no way to check any of them.
 *
 * One curve. Measurable from receivable receipts, which is the point.
 */
function receiptsCurveSection(ro, legacySum) {
  const r = state.assumptions.defaultPaymentRules;
  const curve = r.receiptsCurve;

  if (!curve?.length) {
    return `<section>
      <h2>Payment timing <span class="stamp warn">deposits &amp; balances</span></h2>
      <p class="foot">This model still splits cash into a deposit at booking and a balance due ${escapeHtml(String(r.balanceDueDaysBeforeDeparture))} days before departure, timed by two separate curves. None of that split can be checked against Xero — a part-paid invoice does not say which instalment a payment was.</p>
      ${ro ? "" : `<button id="useReceiptsCurve" class="btn-primary">Switch to one revenue curve</button>`}
      <p class="foot">Switching replaces four inputs with one and does not change the year's total, only its timing.</p>
    </section>`;
  }

  const sum = curve.reduce((s, p) => s + p.share, 0);
  const within60 = curve.filter((p) => p.monthsBefore <= 2).reduce((s, p) => s + p.share, 0);

  return `<section>
    <h2>Revenue timing <span class="stamp ${Math.abs(sum - 1) > 0.001 ? "warn" : ""}">${(sum * 100).toFixed(1)}%</span></h2>
    <p class="foot">Share of a program's full price that arrives this many months before departure. <b>${((within60 / (sum || 1)) * 100).toFixed(0)}% lands within 60 days.</b></p>
    <div class="curve">
      ${curve.map((p, i) => `
        <label class="curverow ${p.monthsBefore <= 2 ? "near" : ""}">
          <span>${p.monthsBefore}mo</span>
          <input type="number" data-rcurve="${i}" value="${(p.share * 100).toFixed(1)}" step="0.1" ${ro ? "disabled" : ""}>
          <span class="pc">%</span>
          <span class="bar"><i style="width:${Math.min(100, p.share * 250)}%"></i></span>
        </label>`).join("")}
    </div>
    <p class="foot">A starting estimate. Replace it with the measured distribution once receivable receipts are flowing — that is the one input this whole model rests on, and the only one Xero can settle. Shares normalise to 100%, so the year's total never changes; only the timing does.</p>
  </section>`;
}

/**
 * When the balance is actually paid.
 *
 * The model used to drop the whole balance into a single month — the due date —
 * which is why the table showed money arriving in two or three months a year and
 * nothing in between. Students pay across a range, with the bulk inside the last
 * 60 days. The annual total is unchanged either way; what moves is WHICH MONTH
 * the money shows up in, which is the entire output of a cash forecast.
 */
function balanceCurveSection(ro) {
  const r = state.assumptions.defaultPaymentRules;
  const curve = r.balanceCurve;

  if (!curve?.length) {
    return `<section>
      <h2>Balance payments <span class="stamp warn">single lump</span></h2>
      <p class="foot">The whole balance is currently landing in one month, ${escapeHtml(String(r.balanceDueDaysBeforeDeparture))} days before departure. Real payments arrive across a range.</p>
      ${ro ? "" : `<button id="addbalcurve" class="btn-primary">Spread it across months</button>`}
    </section>`;
  }

  const sum = curve.reduce((s, p) => s + p.share, 0);
  // "Within 60 days" is offsets 2, 1 and 0 — the window Jake described as
  // carrying the bulk. Surfacing it makes the curve checkable at a glance
  // instead of requiring someone to add up seven boxes.
  const within60 = curve
    .filter((p) => p.monthsBefore <= 2)
    .reduce((s, p) => s + p.share, 0);

  return `<section>
    <h2>Balance payments <span class="stamp ${Math.abs(sum - 1) > 0.001 ? "warn" : ""}">${(sum * 100).toFixed(1)}%</span></h2>
    <p class="foot">Share of the balance paid this many months before departure. <b>${((within60 / (sum || 1)) * 100).toFixed(0)}% lands within 60 days.</b></p>
    <div class="curve">
      ${curve.map((p, i) => `
        <label class="curverow ${p.monthsBefore <= 2 ? "near" : ""}">
          <span>${p.monthsBefore}mo</span>
          <input type="number" data-balcurve="${i}" value="${(p.share * 100).toFixed(1)}" step="0.5" ${ro ? "disabled" : ""}>
          <span class="pc">%</span>
          <span class="bar"><i style="width:${Math.min(100, p.share * 250)}%"></i></span>
        </label>`).join("")}
    </div>
    <p class="foot">A starting shape, not a measurement — replace it with the real distribution once receivable receipts are flowing. Shares normalise to 100%, so the year's total never changes; only the timing does.</p>
  </section>`;
}

/**
 * Diagnostics.
 *
 * The probe endpoints sit under /api/ and verify an Identity token, which the
 * browser holds in memory rather than in a cookie — so pasting a probe URL into
 * the address bar returns "Sign in required." and always did. Asking someone to
 * visit one was asking for something that cannot work. Here they are as buttons
 * on the page that already has the token.
 *
 * Raw JSON on purpose: the whole point is to see what Xero actually returned,
 * not a tidied summary of it.
 */
function diagnosticsPanel(ro) {
  if (ro) return "";
  const fy = state.assumptions.fiscalYearStartYear;
  const checks = [
    ["opex", `?month=${fy}-04&report=opex`, "P&L for April"],
    ["bank", `?month=${fy}-04&report=bank`, "Bank summary for April"],
    ["budget", `?report=budget`, "List budgets"],
    // The gate on the cash-rows rebuild. Reconciles Bank Transactions +
    // Payments + Bank Transfers against the Bank Summary for a month: if the
    // detail does not add up to what Xero says moved, a source is missing and
    // nothing built on it can be trusted. Read `reconciliation` first.
    // Every closed month, because "which month does the discrepancy start in"
    // is the question that localises an opening-balance error — and a constant
    // offset from April onward is exactly that shape.
    // Can outgoing money be tied to a program at all? Everything about the cost
    // curve depends on the answer, and nothing else on this page reveals it.
    ["costs", `?report=costs`, "Cost attribution"],
    ...["04", "05", "06", "07", "08"].map((mm) => [
      `banktx${mm}`,
      `?month=${fy}-${mm}&report=banktx`,
      `Reconcile ${["Apr","May","Jun","Jul","Aug"][Number(mm) - 4]}`,
    ]),
  ];
  return `<section class="closebox">
    <h2>Diagnostics</h2>
    <p class="foot">What Xero actually returned, unedited. Use these when a figure looks wrong — they read only, and change nothing.</p>
    <div class="rates" style="margin-bottom:10px">
      ${checks.map(([id, qs, label]) => `
        <button class="btn-diag" data-diag="${escapeAttr(qs)}" data-diagid="${id}" ${state.diagBusy ? "disabled" : ""}>
          ${state.diagBusy === id ? "Checking…" : label}
        </button>`).join("")}
    </div>
    <div class="rates" style="margin-bottom:10px">
      <button class="btn-diag" data-refresh="" data-diagid="refresh" ${state.diagBusy ? "disabled" : ""}>
        ${state.diagBusy === "refresh" ? "Refreshing…" : "Refresh Xero data now"}
      </button>
      <button class="btn-diag" data-refresh="?force=1" data-diagid="refreshforce" ${state.diagBusy ? "disabled" : ""}>
        ${state.diagBusy === "refreshforce" ? "Refetching…" : "Force refetch every month"}
      </button>
    </div>
    <p class="foot">Closed months are cached, and the cache is what the table reads — so a fix to how a Xero report is parsed does not show up until the data is pulled again. The scheduled sync does that hourly and cannot be triggered by hand; these buttons run the same code now. <b>Refresh</b> refetches anything a newer parser would read differently. <b>Force</b> refetches everything regardless. A full year is sixty-odd Xero calls, far more than one web request can finish, so the work runs in the background and this page watches it — a forced refetch takes a few minutes.</p>
    ${state.diag ? `<pre class="diagout">${escapeHtml(state.diag)}</pre>` : ""}
  </section>`;
}

/**
 * Where the overheads row comes from.
 *
 * Closed months from the P&L, the rest from Xero's budget, typed figures for
 * anything neither covers. Shown rather than assumed, because the same row can
 * now hold three different kinds of number and they are not interchangeable.
 */
/**
 * Say what is ACTUALLY happening, not what is meant to happen.
 *
 * The first version of this panel stated "closed months come from the P&L"
 * whether or not a single month had one — which is the same failure as the
 * warning that claimed a month was missing Xero figures while showing them. A
 * panel that asserts an untrue thing is worse than one that says nothing.
 *
 * Three different "no actuals" cases, and they need different answers:
 * nothing has been closed, nothing has synced, or the sync ran and found
 * nothing for those months.
 */
function overheadStatus(want, o) {
  if (want !== "auto") {
    return `Pinned to the typed figures. The workbook's twelve numbers are a guess made once a year — Xero has both the real spend and the plan.`;
  }

  const closed = o?.closedMonths ?? 0;
  const stored = o?.opexMonthsStored ?? 0;
  const actual = o?.counts?.actual ?? 0;

  const past = actual > 0
    ? `<b>${actual} closed month${actual === 1 ? "" : "s"}</b> come from the P&amp;L.`
    : closed === 0
      ? `<b>No months are closed</b>, so none can use the P&amp;L — close them on the Month-end close control below.`
      : stored === 0
        ? `${closed} month${closed === 1 ? " is" : "s are"} closed but <b>the P&amp;L has not synced yet</b>. It runs hourly; if it stays empty, check the sync log for <code>opex=</code>.`
        : `${closed} month${closed === 1 ? " is" : "s are"} closed and the P&amp;L has synced, but not for those months.`;

  const future = o?.budget
    ? `The rest come from the Xero budget <b>${escapeHtml(o.budget.description)}</b> — ${o.budget.accounts} expense accounts, ${o.budget.monthsCovered} of 12 months budgeted. Months it does not reach keep their typed figure.`
    : `<b>No budget has synced yet</b>, so forecast months are using the typed figures. Check the sync log for <code>budgetAccounts=</code> — a scope error there means the budget consent did not take.`;

  // A closed month is cached forever, so the only thing that can make its
  // figure wrong is the code that read it changing underneath. Saying which
  // months are still on the old parser is the difference between "the numbers
  // don't match" and "those four refresh on the next sync".
  const stale = o?.staleMonths?.length
    ? ` <b>${o.staleMonths.length} month${o.staleMonths.length === 1 ? "" : "s"}</b> (${o.staleMonths.map(escapeHtml).join(", ")}) ${o.staleMonths.length === 1 ? "was" : "were"} read by an older version of the P&amp;L parser and ${o.staleMonths.length === 1 ? "is" : "are"} being refetched — the figures shown for ${o.staleMonths.length === 1 ? "it" : "them"} will change on the next hourly sync.`
    : "";

  return `${past} ${future}${stale}`;
}

function overheadSourcePanel(ro) {
  const o = state.overheads;
  const want = state.assumptions.overheadSource ?? "auto";

  const counts = o?.counts ?? {};
  const summary = ["actual", "budget", "typed"]
    .filter((k) => counts[k])
    .map((k) => `${counts[k]} ${k}`)
    .join(" · ");

  return `<section class="closebox">
    <h2>Overhead source ${summary ? `<span class="stamp">${summary}</span>` : ""}</h2>
    <div class="rates" style="margin-bottom:10px">
      ${[["auto", "Xero"], ["manual", "Typed below"]].map(([id, label]) => `
        <label class="rateopt ${want === id ? "on" : ""}">
          <input type="radio" name="ohsrc" value="${id}" ${want === id ? "checked" : ""} ${ro ? "disabled" : ""}>
          <span class="rl">${label}</span>
        </label>`).join("")}
    </div>
    ${want === "auto" ? `
    <div class="rates" style="margin:10px 0">
      ${[["total", "Total operating expenses"], ["cash", "Cash only"]].map(([id, label]) => `
        <label class="rateopt ${(state.assumptions.overheadBasis ?? "total") === id ? "on" : ""}">
          <input type="radio" name="ohbasis" value="${id}" ${(state.assumptions.overheadBasis ?? "total") === id ? "checked" : ""} ${ro ? "disabled" : ""}>
          <span class="rl">${label}</span>
        </label>`).join("")}
    </div>
    <p class="foot">${(state.assumptions.overheadBasis ?? "total") === "total"
      ? `Closed months use <b>Total Operating Expenses</b> exactly as the P&amp;L reports it. That line includes bank revaluations and unrealised currency movements, which are accounting entries rather than money leaving the account — on these books they swung by 33,805 in June alone, on the exchange rate rather than on anything spent.`
      : `Closed months use Total Operating Expenses with the non-cash lines removed — bank revaluations and unrealised currency movements. Closer to what actually left the bank; will not tie to the P&amp;L.`}</p>` : ""}
    <p class="foot">${overheadStatus(want, o)}</p>
  </section>`;
}

/**
 * Recognition months.
 *
 * Revenue moves from deferred to sales the month before a season starts. Until
 * now this lived only in the seed with no way to change it, and it was wrong:
 * Fall was set to September on the assumption the season departs in October. It
 * departs 1 September, so a "most recent September before departure" search
 * landed on September of the PREVIOUS year and took the whole season's revenue
 * out of the fiscal year. The deferred row went negative by the same amount.
 *
 * A value this consequential should not be reachable only by re-seeding.
 */
function recognitionControl(ro) {
  /* THE CONTROL IS GONE, AND THE EXPLANATION REPLACED IT.
   *
   * This used to be three dropdowns — one recognition month per season — and
   * they were the wrong shape for what the books do. Income for a season
   * arrives over the months up to AND INCLUDING its departure month, so there
   * is no single month to pick: the deadline is the departure date, which is
   * already on the Programs tab.
   *
   * Leaving the dropdowns would mean keeping a setting that changes nothing,
   * which is worse than removing it. What is left says where the behaviour now
   * comes from, because someone who remembers the control will come looking.
   */
  const programs = (state.assumptions.programs ?? []).filter((p) => p.active);
  const bySeason = {};
  for (const p of programs) {
    const m = Number(String(p.startDate ?? "").slice(5, 7));
    if (!m) continue;
    (bySeason[p.season] ??= new Set()).add(m);
  }
  const labels = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

  return `<section class="closebox">
    <h2>Revenue recognition <span class="stamp">from departure dates</span></h2>
    <p class="foot">A season's income is recognised over the months <b>up to and including the month it departs</b>. The model holds that deadline and lets the books hold the run-up: whatever has been recognised by the last closed month is fact, and only the remainder is left to land at the deadline.</p>
    <p class="foot">There is nothing to set here. The deadline is each program's own departure date on the Programs tab, so two programs in the same season departing in different months no longer share a recognition month — which is what the old per-season setting forced them to do.</p>
    ${Object.keys(bySeason).length ? `<p class="foot">${Object.entries(bySeason).map(([season, set]) =>
      `<span class="stamp">${escapeHtml(season)} recognises by ${[...set].sort((a, b) => a - b).map((m) => labels[m - 1]).join(", ")}</span>`).join(" ")}</p>` : ""}
    <p class="foot">Worth checking against the Income line on your P&amp;L: a season's revenue should be complete by the end of its departure month. If a departure date is wrong, the revenue lands in the wrong month — or outside the year — and the Surplus tab will say so once that month closes.</p>
  </section>`;
}

/**
 * The 1 April balances.
 *
 * These flow through all twelve months untouched, so a wrong NZD/USD split
 * converts at the wrong times for the entire year. That makes it the one input
 * most worth taking from the bank rather than from a number typed once — but
 * the source has to be visible, because a figure that silently changed itself
 * is worse than a wrong one somebody chose.
 */
function openingsControl(ro) {
  const o = state.openings;
  const a = state.assumptions;
  const want = a.openingBalanceSource ?? "xero";
  const live = want === "xero" && o?.source === "xero";
  const currencies = ["NZD", a.settlementCurrency || "USD"];

  const stamp = !o ? ""
    : o.source === "xero"
      ? `<span class="stamp">from Xero${o.mixed ? " — partly" : ""}</span>`
      : o.source === "manual-no-data"
        ? `<span class="stamp warn">no April data yet</span>`
        : `<span class="stamp">typed</span>`;

  return `<section class="closebox">
    <h2>Opening balances at 1 April ${stamp}</h2>
    <div class="rates" style="margin-bottom:10px">
      ${[["xero", "From Xero"], ["manual", "Typed below"]].map(([id, label]) => `
        <label class="rateopt ${want === id ? "on" : ""}">
          <input type="radio" name="opensrc" value="${id}" ${want === id ? "checked" : ""} ${ro ? "disabled" : ""}>
          <span class="rl">${label}</span>
          <span class="rv">${id === "xero" && o?.fromXero
            ? currencies.map((c) => o.fromXero[c] != null ? money(o.fromXero[c]) : "—").join(" / ")
            : currencies.map((c) => money(o?.typed?.[c] ?? 0)).join(" / ")}</span>
        </label>`).join("")}
    </div>
    <div class="openings">
      ${currencies.map((cur) => `
        <label class="field wide"><span>Opening ${escapeHtml(cur)} balance at 1 April</span>
          <input type="number" data-open="${escapeAttr(cur)}" value="${a.openingBalances?.[cur] ?? 0}"
            step="1000" ${ro || live ? "disabled" : ""}></label>`).join("")}
    </div>
    <p class="foot">${
      o?.source === "manual-no-data" && want === "xero"
        ? `Set to read from Xero, but April has not been synced yet — the typed figures are being used until it has.`
      : live && o.mixed
        ? `Some currencies came from Xero and some did not. A currency with no Xero bank account keeps its typed figure rather than becoming zero — check the ones showing a dash above.`
      : live
        ? `Read from April's bank summary. This is the opening column — the balance at the first of the month — so it is right even while April is still running.`
        : `Typed figures are in use. The workbook's single blended balance is almost certainly the wrong NZD/USD split.`
    }</p>
  </section>`;
}

/**
 * Locking a month is a deliberate act, not a date calculation. Month-end close
 * is not instant — late supplier invoices and bank feeds land days afterwards —
 * so a month shows as actual only once someone says it is done.
 */
function closeControl() {
  const a = state.assumptions;
  const ro = !state.canEdit;
  const labels = ["Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec","Jan","Feb","Mar"];
  const fy = a.fiscalYearStartYear;
  const options = labels.map((l, i) => {
    const abs = 3 + i;
    const y = fy + Math.floor(abs / 12);
    const key = `${y}-${String((abs % 12) + 1).padStart(2, "0")}`;
    return {
      key,
      label: `${l} ${String(y).slice(2)}`,
      has: state.actualMonthsAvailable.includes(key),
      partial: state.partialMonth === key,
    };
  });
  const current = a.actualsThroughMonth || "";

  return `<section class="closebox">
    <h2>Month-end close</h2>
    <p class="foot">Months up to and including your choice show what actually happened, pulled from Xero. Everything after stays forecast, and re-bases onto the real closing balance.</p>
    <label class="field wide"><span>Actuals through</span>
      <select id="closethru" ${ro ? "disabled" : ""}>
        <option value="">Nothing closed — all forecast</option>
        ${options.map((o) => `<option value="${o.key}" ${current === o.key ? "selected" : ""} ${o.has ? "" : "disabled"}>${o.label}${o.has ? "" : (o.partial ? " — month still running" : " — no Xero data")}</option>`).join("")}
      </select></label>
    <p class="foot">${
      state.actualMonthsAvailable.length
        ? `Xero figures stored for ${state.actualMonthsAvailable.length} closed month${state.actualMonthsAvailable.length === 1 ? "" : "s"}.${state.partialMonth ? " The current month is syncing too, but cannot be closed until it ends." : ""}`
        : `No Xero months stored yet — run the Xero sync before closing anything.`
    }</p>
  </section>`;
}

function ratePanel(ro) {
  const fx = state.fx;
  const a = state.assumptions;
  const cur = a.settlementCurrency || "USD";
  const src = a.planningRateSource || "manual";
  const active = resolvedRate();

  if (!fx) {
    return `<section>
      <h2>Planning rate</h2>
      <p class="foot">No live rate stored yet. Run the daily <code>fx-sync</code> function once and this fills in. Until then the forecast plans at the pinned rate below.</p>
      <label class="field"><span>${escapeHtml(cur)} → NZD (manual)</span>
        <input type="number" data-fx="${escapeAttr(cur)}" value="${a.fxRates[cur] ?? 1}" step="0.001" ${ro ? "disabled" : ""}></label>
    </section>`;
  }

  const options = [
    ["avg90", "90-day average", fx.avg90],
    ["avg60", "60-day average", fx.avg60],
    ["avg30", "30-day average", fx.avg30],
    ["current", "Spot", fx.current],
    ["manual", "Pinned", a.fxRates[cur] ?? 1],
  ];

  // What a move to each end of the observed range does to the year.
  const at = (rate) => {
    const alt = { ...a, fxRates: { ...a.fxRates, [cur]: rate } };
    return buildForecast(alt).totals;
  };
  const lo = at(fx.low90), hi = at(fx.high90), now = at(active);

  return `<section>
    <h2>Planning rate <span class="stamp">${escapeHtml(fx.source)} · ${escapeHtml(fx.asOf)}</span></h2>
    ${fx.degraded ? `<p class="foot warnfoot">Only a spot rate was available, so the averages below are all the same number.</p>` : ""}
    <div class="rates">
      ${options.map(([id, label, rate]) => `
        <label class="rateopt ${src === id ? "on" : ""}">
          <input type="radio" name="rsrc" value="${id}" ${src === id ? "checked" : ""} ${ro ? "disabled" : ""}>
          <span class="rl">${label}</span>
          <span class="rv">${Number(rate).toFixed(4)}</span>
        </label>`).join("")}
    </div>
    ${src === "manual" ? `
      <label class="field"><span>Pinned ${escapeHtml(cur)} → NZD</span>
        <input type="number" data-fx="${escapeAttr(cur)}" value="${a.fxRates[cur] ?? 1}" step="0.001" ${ro ? "disabled" : ""}></label>` : ""}
    <h2 style="margin-top:1rem">Rate sensitivity</h2>
    <p class="foot">The year re-run at the low and high of the observed 90-day range, holding everything else constant.</p>
    <table class="cftable tight sens">
      <thead><tr><th class="lab"></th><th>Rate</th><th>Lowest NZD</th><th>Total position</th></tr></thead>
      <tbody>
        <tr><th class="lab">90-day low</th><td>${fx.low90.toFixed(4)}</td>
          <td class="${lo.lowestBaseClosing < 0 ? "neg" : ""}">${money(lo.lowestBaseClosing)}</td>
          <td class="${lo.closingBalance < 0 ? "neg" : ""}">${money(lo.closingBalance)}</td></tr>
        <tr class="strong"><th class="lab">Planning at</th><td>${active.toFixed(4)}</td>
          <td class="${now.lowestBaseClosing < 0 ? "neg" : ""}">${money(now.lowestBaseClosing)}</td>
          <td class="${now.closingBalance < 0 ? "neg" : ""}">${money(now.closingBalance)}</td></tr>
        <tr><th class="lab">90-day high</th><td>${fx.high90.toFixed(4)}</td>
          <td class="${hi.lowestBaseClosing < 0 ? "neg" : ""}">${money(hi.lowestBaseClosing)}</td>
          <td class="${hi.closingBalance < 0 ? "neg" : ""}">${money(hi.closingBalance)}</td></tr>
      </tbody>
    </table>
    <p class="foot">Spread of ${money(hi.closingBalance - lo.closingBalance)} on the closing position across the range the rate actually traded in over the last quarter. Neither end is a forecast — both happened.</p>
  </section>`;
}

/* ---------------- overheads ---------------- */

function overheadsView() {
  const ro = !state.canEdit;
  const labels = ["Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec", "Jan", "Feb", "Mar"];
  const rows = [
    ["Overheads", "monthlyOverheads"],
    ["Capital", "monthlyCapital"],
    ["Tax", "monthlyTax"],
  ];
  return `
    ${recognitionControl(ro)}
    ${closeControl()}
    ${openingsControl(ro)}
    <div class="scroll">
      <table class="cftable edit">
        <thead><tr><th class="lab"></th>${labels.map((l) => `<th>${l}</th>`).join("")}<th>Total</th></tr></thead>
        <tbody>
          ${rows.map(([label, key]) => {
            // Overheads can come from three places and the row must say which,
            // month by month. A figure that silently changed its source is
            // worse than a wrong one, because nobody can tell them apart.
            const src = key === "monthlyOverheads" ? (state.overheads?.sources ?? null) : null;
            const live = key === "monthlyOverheads" && state.overheads?.months
              ? state.overheads.months : null;
            return `
            <tr><th class="lab">${label}</th>
              ${state.assumptions[key].map((v, i) => {
                const from = src?.[i] ?? "typed";
                const shown = from === "typed" ? v : Math.round(live[i]);
                return `<td class="ohcell ${from}">
                  <input type="number" data-m="${key}" data-i="${i}" value="${shown}" step="1000"
                    ${ro || from !== "typed" ? "disabled" : ""}
                    title="${from === "actual" ? "From the P&L — this month is closed"
                          : from === "budget" ? "From the Xero budget"
                          : "Typed"}">
                  ${src ? `<span class="ohtag">${from === "actual" ? "actual" : from === "budget" ? "budget" : ""}</span>` : ""}
                </td>`;
              }).join("")}
              <td class="calc">${money((live ?? state.assumptions[key]).reduce((s, n) => s + Number(n), 0))}</td>
            </tr>`;
          }).join("")}
        </tbody>
      </table>
    </div>
    ${overheadSourcePanel(ro)}
    ${overheadLinesPanel()}
    ${diagnosticsPanel(ro)}
    <p class="foot">Positive numbers. The forecast subtracts them. GST and PAYE belong here as their own rows once you decide how to phase them — neither exists in the current workbook.</p>
    <p class="foot">The runway months past 31 March repeat these twelve by fiscal month — April next year takes April's figure, and so on. What they repeat is the <b>forward</b> basis: the Xero budget where it has a figure, the typed number where it does not. Never the actual. A closed month holds what was really spent, and carrying that into a forecast two years out would mix history into a plan — and get worse every month as more of the year closes.</p>`;
}

/* ------------------------------------------------------------------ */

function wire() {
  document.querySelectorAll("[data-tab]").forEach((b) =>
    b.addEventListener("click", () => { state.tab = b.dataset.tab; render(); }));

  el("save")?.addEventListener("click", save);
  el("seed")?.addEventListener("click", seed);
  el("addprog")?.addEventListener("click", addProgram);

  document.querySelectorAll("tr[data-i] [data-f]").forEach((input) =>
    input.addEventListener("change", (e) => {
      const i = Number(e.target.closest("tr").dataset.i);
      const field = e.target.dataset.f;
      const numeric = ["price", "paxForecast", "fixedCost", "variableCostPerPax"];
      state.assumptions.programs[i][field] = numeric.includes(field)
        ? Number(e.target.value) : e.target.value;
      touch();
    }));

  document.querySelectorAll("[data-del]").forEach((b) =>
    b.addEventListener("click", () => {
      state.assumptions.programs.splice(Number(b.dataset.del), 1);
      touch();
    }));

  el("deposit")?.addEventListener("change", (e) => {
    state.assumptions.defaultPaymentRules.deposit = Number(e.target.value); touch();
  });
  el("baldays")?.addEventListener("change", (e) => {
    state.assumptions.defaultPaymentRules.balanceDueDaysBeforeDeparture = Number(e.target.value); touch();
  });
  document.querySelectorAll("[data-open]").forEach((input) =>
    input.addEventListener("change", (e) => {
      state.assumptions.openingBalances = {
        ...state.assumptions.openingBalances,
        [e.target.dataset.open]: Number(e.target.value),
      };
      touch();
    }));

  // The per-season recognition dropdowns are gone — the deadline comes from
  // each program's departure date now — so there is nothing left to wire. The
  // stored `recognitionMonths` is left alone rather than deleted: it costs
  // nothing, and stripping a field out of everyone's saved model to tidy up is
  // how a rollback stops working.

  document.querySelectorAll("[data-diag]").forEach((b) =>
    b.addEventListener("click", async () => {
      state.diagBusy = b.dataset.diagid;
      state.diag = null;
      render();
      // finally, for the same reason as the refresh button below: a busy flag
      // set before an await must be cleared on every path out, or a working
      // request that happens to return early leaves the UI claiming it is still
      // going.
      try {
        const res = await fetch(`${API}/cash-xero-probe${b.dataset.diag}`, { credentials: "include" });
        // Text first: a function that times out returns Netlify's HTML error
        // page, and res.json() on that throws with nothing useful to show.
        const raw = await res.text();
        let body;
        try { body = JSON.parse(raw); }
        catch { body = { error: `Unexpected ${res.status} response`, responseStart: raw.slice(0, 300) }; }
        state.diag = `HTTP ${res.status}\n\n${JSON.stringify(body, null, 2)}`;
      } catch (err) {
        state.diag = `Request failed: ${err.message}`;
      } finally {
        state.diagBusy = null;
        render();
      }
    }));

  el("loadcurve")?.addEventListener("click", async () => {
    state.curveBusy = true;
    render();
    try {
      const res = await fetch(`${API}/cash-cost-curve`, { credentials: "include" });
      const raw = await res.text();
      try { state.costCurve = JSON.parse(raw); }
      catch { state.costCurve = { error: `Unexpected ${res.status} response` }; }
    } catch (err) {
      state.costCurve = { error: err.message };
    } finally {
      // finally, for the same reason as every other busy flag on this page.
      state.curveBusy = false;
      render();
    }
  });

  el("loadsurplus")?.addEventListener("click", async () => {
    state.surplusBusy = true;
    render();
    try {
      const res = await fetch(`${API}/cash-surplus`, { credentials: "include" });
      const raw = await res.text();
      try { state.surplus = JSON.parse(raw); }
      catch { state.surplus = { error: `Unexpected ${res.status} response` }; }
    } catch (err) {
      state.surplus = { error: err.message };
    } finally {
      state.surplusBusy = false;
      render();
    }
  });

  el("loadpnl")?.addEventListener("click", async () => {
    state.pnlBusy = true;
    render();
    try {
      const basis = state.pnlBasis ?? "total";
      const res = await fetch(`${API}/cash-pnl?basis=${basis}`, { credentials: "include" });
      const raw = await res.text();
      try { state.pnl = JSON.parse(raw); }
      catch { state.pnl = { error: `Unexpected ${res.status} response` }; }
    } catch (err) {
      state.pnl = { error: err.message };
    } finally {
      // finally, for the same reason as every other busy flag on this page: a
      // success path that returns early leaves the button reading "Reading…"
      // for ever, which looks exactly like a request that hung.
      state.pnlBusy = false;
      render();
    }
  });

  document.querySelectorAll("[name=pnlbasis]").forEach((r) =>
    r.addEventListener("change", () => {
      state.pnlBasis = r.value;
      // Re-reads rather than filtering in the browser. Which lines are non-cash
      // is the parser's own judgement, and a second copy of it here is a second
      // thing to keep in step.
      el("loadpnl")?.click();
    }));

  el("pnlbymonth")?.addEventListener("change", (e) => {
    // Purely a view change — same data, different columns — so no refetch.
    state.pnlByMonth = e.target.checked;
    render();
  });

  document.querySelectorAll("[data-pnl]").forEach((row) =>
    row.addEventListener("click", (e) => {
      // A click anywhere on the row, except on a control inside it.
      if (e.target.closest("input, select, button, a")) return;
      const id = row.dataset.pnl;
      state.pnlOpen = { ...(state.pnlOpen ?? {}), [id]: !(state.pnlOpen ?? {})[id] };
      render();
    }));

  el("loadohlines")?.addEventListener("click", async () => {
    state.ohLinesBusy = true;
    render();
    try {
      const basis = state.ohLinesBasis ?? "cash";
      const res = await fetch(`${API}/cash-overhead-lines?basis=${basis}`, { credentials: "include" });
      const raw = await res.text();
      try { state.ohLines = JSON.parse(raw); }
      catch { state.ohLines = { error: `Unexpected ${res.status} response` }; }
    } catch (err) {
      state.ohLines = { error: err.message };
    } finally {
      state.ohLinesBusy = false;
      render();
    }
  });

  document.querySelectorAll("[name=ohlbasis]").forEach((r) =>
    r.addEventListener("change", () => {
      state.ohLinesBasis = r.value;
      // Re-reads rather than re-filtering in the browser: the cash/total split
      // is decided by the parser's own non-cash list, and a second copy of that
      // judgement here is a second place for it to drift.
      el("loadohlines")?.click();
    }));

  document.querySelectorAll("[data-refresh]").forEach((b) =>
    b.addEventListener("click", async () => {
      state.diagBusy = b.dataset.diagid;
      state.diag = null;
      render();

      /* try/FINALLY, and the finally is the point.
       *
       * The first version cleared the busy flag on the error path and on the
       * fall-through, but the success path returned early — so a refresh that
       * worked perfectly left the button reading "Refetching…" for ever, which
       * looks exactly like one that hung. The data was in the store; only the
       * button was lying.
       *
       * A flag set before an await and cleared afterwards belongs in a finally.
       * There is no path out of this function that should leave it set. */
      try {
        /* START, THEN POLL.
         *
         * The refresh used to run inside this request. It could not: a full
         * year is sixty-odd Xero calls, one month of transactions is six of
         * them on its own, and a Netlify function gets ten seconds. Three
         * rounds of shrinking the budget produced three HTTP 504s.
         *
         * Now a background worker does it with a fifteen-minute allowance and
         * writes progress to a blob; this just starts it and watches. */
        const res = await fetch(`${API}/cash-xero-refresh${b.dataset.refresh}`, {
          method: "POST", credentials: "include",
        });
        const raw = await res.text();
        let body;
        try { body = JSON.parse(raw); }
        catch {
          throw new Error(`Unexpected ${res.status} response: ${raw.slice(0, 200)}`);
        }
        if (!res.ok || body.started === false) {
          if (body.status?.running) {
            state.diag = "A refresh is already running — watching it.";
          } else {
            throw new Error(body.error || body.note || `Could not start (${res.status})`);
          }
        }

        // Poll until it stops running. Generous ceiling: a forced refetch of a
        // full year is a few minutes of Xero calls.
        let status = null;
        for (let tick = 0; tick < 240; tick++) {
          await new Promise((r) => setTimeout(r, 2000));
          const s2 = await fetch(`${API}/cash-xero-refresh`, { credentials: "include" });
          const j = await s2.json().catch(() => null);
          status = j?.status ?? null;
          state.diag = status?.running
            ? `Refreshing… ${status.summary ?? ""}`.trim()
            : (status?.summary ?? status?.error ?? "Finishing…");
          render();
          if (status && !status.running) break;
        }

        // The refreshed figures are in the blob store now, not in this page.
        await boot();
        state.diag = status?.error
          ? `Refresh reported a problem:\n\n${JSON.stringify(status, null, 2)}`
          : `${status?.summary ?? "Done."}\n\n${JSON.stringify(status, null, 2)}`;
      } catch (err) {
        state.diag = `Request failed: ${err.message}`;
      } finally {
        state.diagBusy = null;
        render();
      }
    }));

  document.querySelectorAll("input[name=ohbasis]").forEach((input) =>
    input.addEventListener("change", (e) => {
      state.assumptions.overheadBasis = e.target.value; touch();
    }));

  document.querySelectorAll("input[name=ohsrc]").forEach((input) =>
    input.addEventListener("change", (e) => {
      state.assumptions.overheadSource = e.target.value; touch();
    }));

  document.querySelectorAll("input[name=opensrc]").forEach((input) =>
    input.addEventListener("change", (e) => {
      state.assumptions.openingBalanceSource = e.target.value; touch();
    }));

  el("closethru")?.addEventListener("change", (e) => {
    state.assumptions.actualsThroughMonth = e.target.value || null;
    touch();
  });

  el("nzdshare")?.addEventListener("change", (e) => {
    const pct = Math.min(Math.max(Number(e.target.value) || 0, 0), 100);
    state.assumptions.defaultPaymentRules.nzdReceiptShare = pct / 100;
    touch();
  });

  el("buffer")?.addEventListener("change", (e) => {
    state.assumptions.baseMinimumBuffer = Number(e.target.value); touch();
  });

  document.querySelectorAll("input[name=rsrc]").forEach((input) =>
    input.addEventListener("change", (e) => {
      state.assumptions.planningRateSource = e.target.value; touch();
    }));

  document.querySelectorAll("[data-fx]").forEach((input) =>
    input.addEventListener("change", (e) => {
      state.assumptions.fxRates[e.target.dataset.fx] = Number(e.target.value); touch();
    }));

  document.querySelectorAll("[data-rcurve]").forEach((input) =>
    input.addEventListener("change", (e) => {
      state.assumptions.defaultPaymentRules.receiptsCurve[Number(e.target.dataset.rcurve)].share =
        Number(e.target.value) / 100;
      touch();
    }));

  el("useReceiptsCurve")?.addEventListener("click", () => {
    state.assumptions.defaultPaymentRules.receiptsCurve = [
      { monthsBefore: 12, share: 0.006 }, { monthsBefore: 11, share: 0.008 },
      { monthsBefore: 10, share: 0.010 }, { monthsBefore: 9, share: 0.013 },
      { monthsBefore: 8, share: 0.016 }, { monthsBefore: 7, share: 0.019 },
      { monthsBefore: 6, share: 0.028 }, { monthsBefore: 5, share: 0.035 },
      { monthsBefore: 4, share: 0.050 }, { monthsBefore: 3, share: 0.090 },
      { monthsBefore: 2, share: 0.250 }, { monthsBefore: 1, share: 0.340 },
      { monthsBefore: 0, share: 0.135 },
    ];
    touch();
  });

  document.querySelectorAll("[data-balcurve]").forEach((input) =>
    input.addEventListener("change", (e) => {
      state.assumptions.defaultPaymentRules.balanceCurve[Number(e.target.dataset.balcurve)].share =
        Number(e.target.value) / 100;
      touch();
    }));

  el("addbalcurve")?.addEventListener("click", () => {
    state.assumptions.defaultPaymentRules.balanceCurve = [
      { monthsBefore: 6, share: 0.03 }, { monthsBefore: 5, share: 0.04 },
      { monthsBefore: 4, share: 0.06 }, { monthsBefore: 3, share: 0.10 },
      { monthsBefore: 2, share: 0.30 }, { monthsBefore: 1, share: 0.37 },
      { monthsBefore: 0, share: 0.10 },
    ];
    touch();
  });

  document.querySelectorAll("[data-curve]").forEach((input) =>
    input.addEventListener("change", (e) => {
      state.assumptions.defaultPaymentRules.bookingCurve[Number(e.target.dataset.curve)].share =
        Number(e.target.value) / 100;
      touch();
    }));

  document.querySelectorAll("[data-m]").forEach((input) =>
    input.addEventListener("change", (e) => {
      state.assumptions[e.target.dataset.m][Number(e.target.dataset.i)] = Number(e.target.value);
      touch();
    }));
}

function touch() {
  state.dirty = true;
  state.error = null;
  render();
}

function addProgram() {
  const fy = state.assumptions.fiscalYearStartYear;
  state.assumptions.programs.push({
    id: `p${Date.now()}`,
    name: "New program",
    season: "Fall",
    startDate: `${fy}-10-01`,
    endDate: `${fy}-12-01`,
    price: 15500,
    currency: "USD",
    fixedCost: 0,
    variableCostPerPax: 0,
    costCurrency: "NZD",
    paxForecast: 0,
    active: true,
  });
  touch();
}

async function seed() {
  const btn = el("seed");
  if (btn) { btn.disabled = true; btn.textContent = "Loading…"; }
  try {
    const data = await api("/cash-admin", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "seed",
        fiscalYearStartYear: state.assumptions.fiscalYearStartYear,
      }),
    });
    state.assumptions = data.assumptions;
    state.dirty = false;
    state.tab = "programs";   // land where the placeholders need attention
  } catch (err) {
    state.error = err.message;
  }
  render();
}

async function save() {
  state.saving = true; render();
  try {
    const data = await api("/cash-admin", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "save", assumptions: state.assumptions }),
    });
    state.assumptions = data.assumptions;
    state.dirty = false;
  } catch (err) {
    state.error = `Not saved: ${err.message}`;
  } finally {
    state.saving = false;
    render();
  }
}

/* ---------------- chart ---------------- */

let chart = null;

/**
 * Two series on purpose. The NZD account decides whether a supplier can be
 * paid; the total position shows how much cover the unconverted USD represents.
 * The gap between them IS the treasury question, so plotting only one would
 * hide half of it.
 */
function drawChart(f) {
  const canvas = el("chart");
  if (!canvas || typeof Chart === "undefined") return;
  if (chart) { chart.destroy(); chart = null; }

  const labels = f.months.map((m) => m.label);
  const base = f.months.map((m) => Math.round(m.baseClosing));
  const total = f.months.map((m) => Math.round(m.closing));

  /* The tail is drawn dashed and unfilled.
   *
   * It has overheads in it and no programs, so it descends steadily — and on a
   * shared y-axis that descent sets the scale and flattens the fiscal year,
   * which is the part anyone is actually reading. Dashing the segment past 31
   * March keeps the runway visible while making it unmistakably a different
   * kind of line: solid is a forecast, dashed is what happens if next year is
   * never entered. */
  const per = f.horizon?.fiscalYearMonths ?? 12;
  const fyLast = per - 1;
  const inTail = (ctx) => ctx.p1DataIndex > fyLast;
  // Indices sitting on a 31 March, for the year-boundary rules on the x axis.
  const fyEnds = new Set(
    f.months.map((m, i) => (m.month === 3 ? i : -1)).filter((i) => i >= 0));

  chart = new Chart(canvas.getContext("2d"), {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: "NZD account",
          data: base,
          borderColor: "#288195",
          backgroundColor: "rgba(85,187,210,0.16)",
          borderWidth: 2,
          fill: "origin",
          tension: 0.15,
          segment: {
            borderDash: (ctx) => (inTail(ctx) ? [5, 4] : undefined),
            borderColor: (ctx) => (inTail(ctx) ? "#9aa7b4" : undefined),
          },
          // Months where the NZD account is under water get called out — but
          // only inside the fiscal year. A red dot in the tail would flag the
          // absence of next year's programs as a liquidity event.
          pointBackgroundColor: base.map((v, i) => (i > fyLast ? "#c3cbd4" : v < 0 ? "#b02a37" : "#288195")),
          pointRadius: base.map((v, i) => (i > fyLast ? 2 : v < 0 ? 4 : 3)),
        },
        {
          label: "Incl. unconverted USD",
          data: total,
          borderColor: "#b0b8c4",
          borderWidth: 1.5,
          borderDash: [5, 4],
          fill: false,
          tension: 0.15,
          pointRadius: 0,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { labels: { boxWidth: 14, font: { size: 12 }, color: "#6b7280" } },
        tooltip: {
          callbacks: {
            label: (c) => `${c.dataset.label}: ${money(c.parsed.y)}`,
          },
        },
      },
      scales: {
        y: {
          ticks: {
            color: "#98a2b3",
            font: { size: 11 },
            callback: (v) => shortMoney(v),
          },
          grid: {
            color: (c) => (c.tick.value === 0 ? "#b02a37" : "#eef1f5"),
            lineWidth: (c) => (c.tick.value === 0 ? 1.5 : 1),
          },
        },
        x: {
          ticks: {
            color: "#98a2b3",
            font: { size: 11 },
            // Nearly three years of months will not fit as labels. Rather than
            // letting Chart.js drop them at whatever interval fits — which
            // lands on arbitrary months and makes the axis hard to read — every
            // third month is labelled and the rest are blank, so the spacing is
            // regular and the fiscal-year ends stay findable.
            autoSkip: false,
            maxRotation: 0,
            callback(value, index) {
              const step = labels.length > 18 ? 3 : labels.length > 13 ? 2 : 1;
              return index % step === 0 ? labels[index] : "";
            },
          },
          grid: {
            display: true,
            // A vertical rule at each 31 March, matching the table's divider.
            color: (c) => (fyEnds.has(c.index) ? "#cbd5e1" : "transparent"),
            lineWidth: 1,
            drawTicks: false,
          },
        },
      },
    },
  });
}

function shortMoney(v) {
  const a = Math.abs(v);
  if (a >= 1e6) return `${(v / 1e6).toFixed(1)}m`;
  if (a >= 1e3) return `${Math.round(v / 1e3)}k`;
  return `${Math.round(v)}`;
}

/* ---------------- utils ---------------- */

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
const escapeAttr = escapeHtml;

window.addEventListener("beforeunload", (e) => {
  if (state.dirty) { e.preventDefault(); e.returnValue = ""; }
});

boot();

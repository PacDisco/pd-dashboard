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
    state.effectiveRate = data.effectiveRate ?? null;
    state.canEdit = data.canEdit;
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

/** Assumptions with the planning rate applied — never mutates state. */
function effectiveAssumptions() {
  const a = state.assumptions;
  const cur = a.settlementCurrency || "USD";
  return { ...a, fxRates: { ...a.fxRates, [cur]: resolvedRate() } };
}

function render() {
  const f = buildForecast(effectiveAssumptions());
  el("app").innerHTML = `
    ${topBar(f)}
    ${emptyState()}
    ${warnings(f)}
    ${tabs()}
    <div class="panel">${
      state.tab === "forecast" ? forecastView(f)
      : state.tab === "programs" ? programsView(f)
      : state.tab === "payments" ? paymentsView()
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
        <span class="fy">FY ${fy}/${String(fy + 1).slice(2)} · Apr–Mar</span>
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
  ];
  return `<nav class="tabs">${items
    .map(([id, label]) => `<button data-tab="${id}" class="${state.tab === id ? "on" : ""}">${label}</button>`)
    .join("")}</nav>`;
}

/* ---------------- forecast ---------------- */

function forecastView(f) {
  const rows = [
    ["Deposits in", (m) => m.depositsIn],
    ["Balances in", (m) => m.balancesIn],
    ["Cash in", (m) => m.cashIn, "strong"],
    ["Program costs", (m) => -m.programCostsOut],
    ["Overheads", (m) => -m.overheads],
    ["Capital", (m) => -m.capital],
    ["Tax", (m) => -m.tax],
    ["Net movement", (m) => m.net, "strong"],
  ];

  const treasuryRows = [
    ["USD received", (m) => m.fxIn],
    ["USD converted", (m) => -m.fxConverted],
    ["USD balance", (m) => m.fxClosing, "strong"],
    ["NZD from conversion", (m) => m.baseFromConversion],
    ["NZD account", (m) => m.baseClosing, "rule"],
    ["Total position (NZD)", (m) => m.closing, "muted"],
    ["Revenue recognised", (m) => m.recognisedRevenue, "muted"],
    ["Deferred revenue", (m) => m.deferredRevenueBalance, "muted"],
  ];

  return `
    <figure class="chartwrap">
      <div style="position:relative;height:250px"><canvas id="chart"></canvas></div>
      <figcaption>NZD account by month, with the total position including unconverted USD behind it. The dashed red line is zero.</figcaption>
    </figure>
    <div class="scroll">
      <table class="grid">
        <thead><tr><th class="lab"></th>${f.months.map((m) => `<th>${m.label}</th>`).join("")}</tr></thead>
        <tbody>
          ${rows.map(([label, get, cls]) => `
            <tr class="${cls || ""}">
              <th class="lab">${label}</th>
              ${f.months.map((m) => {
                const v = get(m);
                return `<td class="${v <= -0.5 ? "neg" : ""}">${Math.abs(v) < 0.5 ? "—" : money(v)}</td>`;
              }).join("")}
            </tr>`).join("")}
          <tr class="sep"><th class="lab">Treasury</th>${f.months.map(() => "<td></td>").join("")}</tr>
          ${treasuryRows.map(([label, get, cls]) => `
            <tr class="${cls || ""}">
              <th class="lab">${label}</th>
              ${f.months.map((m) => {
                const v = get(m);
                return `<td class="${v <= -0.5 ? "neg" : ""}">${Math.abs(v) < 0.5 ? "—" : money(v)}</td>`;
              }).join("")}
            </tr>`).join("")}
        </tbody>
      </table>
    </div>
    <p class="foot">Funds are collected in USD and converted only when the NZD account would fall below the buffer. <b>NZD account</b> is the row that says whether you can pay a supplier; <b>Total position</b> values unconverted USD at the planning rate and is a mark-to-market figure, not spendable cash.</p>
    ${actualsPanel()}`;
}

function actualsPanel() {
  if (!state.actuals?.orgs?.length) return "";
  return `
    <section class="actuals">
      <h2>Xero actuals <span class="stamp">as at ${escapeHtml(state.actuals.asAt || "")}</span></h2>
      <div class="scroll">
        <table class="grid tight">
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
      <table class="grid edit">
        <thead><tr>
          <th class="lab">Program</th><th>Season</th><th>Departs</th><th>Returns</th>
          <th>Price</th><th>Sells in</th><th>Pax</th>
          <th>Fixed cost</th><th>Var / pax</th><th>Costs in</th>
          <th>Revenue</th><th>Total cost</th><th>Contribution</th><th></th>
        </tr></thead>
        <tbody>
          ${state.assumptions.programs.map((p, i) => {
            const c = byId[p.id];
            return `<tr data-i="${i}" class="${p.active ? "" : "off"}">
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
              <td class="calc">${c ? money(c.grossRevenue) : "—"}</td>
              <td class="calc">${c ? money(c.totalCost) : "—"}</td>
              <td class="calc ${c && c.contribution < 0 ? "neg" : ""}">${c ? money(c.contribution) : "—"}</td>
              <td><button class="del" data-del="${i}" ${ro ? "disabled" : ""} title="Remove">×</button></td>
            </tr>`;
          }).join("")}
        </tbody>
      </table>
    </div>
    ${ro ? "" : `<button id="addprog" class="btn-primary" style="margin-top:14px">Add program</button>`}
    <p class="foot">Programs sell in USD and pay suppliers in NZD, so price and cost convert at different rates. Revenue is recognised in the month before the season starts — September, January and June — regardless of when the cash arrives. Cash timing comes from the payment rules.</p>`;
}

/* ---------------- payment rules ---------------- */

function paymentsView() {
  const r = state.assumptions.defaultPaymentRules;
  const ro = !state.canEdit;
  const sum = r.bookingCurve.reduce((s, p) => s + p.share, 0);
  return `
    <div class="two">
      <section>
        <h2>When students pay</h2>
        <label class="field"><span>Deposit at booking</span>
          <input type="number" id="deposit" value="${r.deposit}" step="50" ${ro ? "disabled" : ""}></label>
        <label class="field"><span>Balance due, days before departure</span>
          <input type="number" id="baldays" value="${r.balanceDueDaysBeforeDeparture}" step="5" ${ro ? "disabled" : ""}></label>
        <h2>Treasury</h2>
        <label class="field"><span>Minimum NZD balance to hold</span>
          <input type="number" id="buffer" value="${state.assumptions.baseMinimumBuffer ?? 0}" step="10000" ${ro ? "disabled" : ""}></label>
        <p class="foot">USD is converted only when the NZD account would fall below this. Raise it to convert earlier and hold less USD; lower it to hold USD longer and carry more rate risk.</p>
      </section>
      ${ratePanel(ro)}
      <section>
        <h2>Booking curve <span class="stamp ${Math.abs(sum - 1) > 0.001 ? "warn" : ""}">${(sum * 100).toFixed(1)}%</span></h2>
        <p class="foot">Share of each cohort that books this many months before departure.</p>
        <div class="curve">
          ${r.bookingCurve.map((p, i) => `
            <label class="curverow">
              <span>${p.monthsBefore}mo</span>
              <input type="number" data-curve="${i}" value="${(p.share * 100).toFixed(1)}" step="0.5" ${ro ? "disabled" : ""}>
              <span class="pc">%</span>
              <span class="bar"><i style="width:${Math.min(100, p.share * 400)}%"></i></span>
            </label>`).join("")}
        </div>
        <p class="foot">Shares are normalised to 100% when the forecast runs, so a curve that doesn't add up bends the timing but never changes total revenue.</p>
      </section>
    </div>`;
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
    <table class="grid tight sens">
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
    <div class="openings">
      ${["NZD", state.assumptions.settlementCurrency || "USD"].map((cur) => `
        <label class="field wide"><span>Opening ${escapeHtml(cur)} balance at 1 April</span>
          <input type="number" data-open="${escapeAttr(cur)}" value="${state.assumptions.openingBalances?.[cur] ?? 0}" step="1000" ${ro ? "disabled" : ""}></label>`).join("")}
    </div>
    <div class="scroll">
      <table class="grid edit">
        <thead><tr><th class="lab"></th>${labels.map((l) => `<th>${l}</th>`).join("")}<th>Total</th></tr></thead>
        <tbody>
          ${rows.map(([label, key]) => `
            <tr><th class="lab">${label}</th>
              ${state.assumptions[key].map((v, i) => `
                <td><input type="number" data-m="${key}" data-i="${i}" value="${v}" step="1000" ${ro ? "disabled" : ""}></td>`).join("")}
              <td class="calc">${money(state.assumptions[key].reduce((s, n) => s + Number(n), 0))}</td>
            </tr>`).join("")}
        </tbody>
      </table>
    </div>
    <p class="foot">Positive numbers. The forecast subtracts them. GST and PAYE belong here as their own rows once you decide how to phase them — neither exists in the current workbook.</p>`;
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
          // Months where the NZD account is under water get called out.
          pointBackgroundColor: base.map((v) => (v < 0 ? "#b02a37" : "#288195")),
          pointRadius: base.map((v) => (v < 0 ? 4 : 3)),
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
        x: { ticks: { color: "#98a2b3", font: { size: 11 } }, grid: { display: false } },
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

<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Pacific Discovery · Sales Funnel</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,500;9..144,600;9..144,700&family=Inter:wght@300;400;500;600;700&display=swap" rel="stylesheet" />
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script>
<style>
  :root {
    --bg:        #0e1413;
    --panel:    #141c1b;
    --panel-2:  #1a2322;
    --line:      #243130;
    --text:     #e6efed;
    --muted:    #8aa19d;
    --accent:   #d8a657;  /* warm gold */
    --accent-2: #6ab39a;  /* sage / sea */
    --warn:     #d96a4e;  /* coral */
    --good:     #88c9a1;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: var(--bg); color: var(--text); font-family: 'Inter', system-ui, sans-serif; }
  body {
    min-height: 100vh;
    background:
      radial-gradient(1200px 600px at 80% -10%, rgba(216,166,87,0.06), transparent 60%),
      radial-gradient(900px 500px at -10% 30%, rgba(106,179,154,0.05), transparent 60%),
      var(--bg);
  }
  .wrap { max-width: 1280px; margin: 0 auto; padding: 48px 32px 96px; }
  header { display: flex; flex-wrap: wrap; align-items: end; justify-content: space-between; gap: 24px; margin-bottom: 40px; }
  .title {
    font-family: 'Fraunces', Georgia, serif;
    font-weight: 500;
    font-size: clamp(34px, 4.5vw, 52px);
    line-height: 1.05;
    letter-spacing: -0.02em;
    margin: 0 0 8px;
  }
  .title em { color: var(--accent); font-style: italic; font-weight: 400; }
  .subtitle { color: var(--muted); font-size: 14px; max-width: 540px; }
  .controls { display: flex; gap: 12px; align-items: center; font-size: 13px; color: var(--muted); }
  .controls input {
    background: var(--panel); border: 1px solid var(--line); color: var(--text);
    padding: 8px 12px; border-radius: 6px; font: inherit; font-size: 13px;
  }
  .controls button {
    background: var(--accent); color: #1a1208; border: 0;
    padding: 9px 16px; border-radius: 6px; font: inherit; font-weight: 600;
    cursor: pointer; transition: transform 80ms ease, opacity 200ms;
  }
  .controls button:hover { transform: translateY(-1px); }
  .controls button:disabled { opacity: 0.5; cursor: wait; }
  .meta { color: var(--muted); font-size: 12px; margin-top: 8px; }

  /* KPI strip */
  .kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 16px; margin-bottom: 32px; }
  .kpi {
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: 12px;
    padding: 20px 22px;
    position: relative;
    overflow: hidden;
  }
  .kpi::before {
    content: ''; position: absolute; top: 0; left: 0; right: 0; height: 2px;
    background: linear-gradient(90deg, var(--accent), transparent 60%);
    opacity: 0.7;
  }
  .kpi .label { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; font-weight: 500; }
  .kpi .value { font-family: 'Fraunces', serif; font-size: 38px; font-weight: 500; margin-top: 6px; letter-spacing: -0.02em; }
  .kpi .sub { color: var(--muted); font-size: 12px; margin-top: 2px; }

  /* Chart cards */
  .cards { display: grid; gap: 20px; grid-template-columns: 1fr; }
  @media (min-width: 980px) { .cards { grid-template-columns: 1fr 1fr; } }
  .card {
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: 14px;
    padding: 24px 24px 16px;
    min-height: 320px;
    position: relative;
  }
  .card.wide { grid-column: 1 / -1; }
  .card h2 {
    font-family: 'Fraunces', serif;
    font-weight: 500;
    font-size: 20px;
    margin: 0 0 4px;
    letter-spacing: -0.01em;
  }
  .card .h-sub { color: var(--muted); font-size: 12px; margin-bottom: 18px; }
  .chart-wrap { position: relative; height: 280px; }
  .card.wide .chart-wrap { height: 340px; }

  /* Loading skeleton */
  .skeleton {
    position: absolute; inset: 60px 24px 16px; border-radius: 8px;
    background: linear-gradient(110deg, var(--panel-2) 30%, #1e2827 50%, var(--panel-2) 70%);
    background-size: 200% 100%; animation: shimmer 1.4s linear infinite;
    pointer-events: none;
  }
  @keyframes shimmer { to { background-position: -200% 0; } }
  .hidden { display: none; }

  .error { color: var(--warn); font-size: 13px; padding: 12px; background: rgba(217,106,78,0.08); border: 1px solid rgba(217,106,78,0.25); border-radius: 8px; }

  /* Footnotes */
  .footnote { color: var(--muted); font-size: 12px; line-height: 1.6; margin-top: 32px; max-width: 720px; }
  .footnote strong { color: var(--text); font-weight: 500; }

  /* Table */
  table { width: 100%; border-collapse: collapse; font-size: 13px; margin-top: 6px; }
  thead th { text-align: right; padding: 10px 12px; color: var(--muted); font-weight: 500; font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; border-bottom: 1px solid var(--line); }
  thead th:first-child { text-align: left; }
  tbody td { padding: 9px 12px; border-bottom: 1px solid rgba(36,49,48,0.5); text-align: right; font-variant-numeric: tabular-nums; }
  tbody td:first-child { text-align: left; color: var(--muted); font-weight: 500; }
  tbody tr:hover { background: rgba(216,166,87,0.03); }
  tfoot td { padding: 12px; border-top: 1px solid var(--line); font-weight: 600; text-align: right; font-variant-numeric: tabular-nums; }
  tfoot td:first-child { text-align: left; color: var(--accent); }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <div>
      <h1 class="title">Sales <em>Funnel</em></h1>
      <p class="subtitle">Opportunities, sales, and contact intake across the five season pipelines. Live from HubSpot.</p>
    </div>
    <div class="controls">
      <label>From <input type="month" id="from" /></label>
      <label>To <input type="month" id="to" /></label>
      <button id="refresh">Refresh</button>
    </div>
  </header>

  <div class="meta" id="generated"></div>
  <div id="error-banner" class="error hidden" style="margin-bottom: 24px;"></div>

  <!-- KPI strip -->
  <section class="kpis" id="kpis"></section>

  <!-- Cards: each chart loads on demand -->
  <section class="cards">
    <div class="card wide">
      <h2>Funnel by month</h2>
      <div class="h-sub">Opportunities = entered Application Fee Received. Sales = entered Deposit Paid OR Closed Won without DP.</div>
      <div class="chart-wrap"><canvas id="chart-funnel"></canvas><div class="skeleton" id="skel-funnel"></div></div>
    </div>

    <div class="card">
      <h2>Sales mix</h2>
      <div class="h-sub">Via Deposit Paid vs. skipped straight to Closed Won.</div>
      <div class="chart-wrap"><canvas id="chart-sales-mix"></canvas><div class="skeleton" id="skel-sales-mix"></div></div>
    </div>

    <div class="card">
      <h2>PD contacts created</h2>
      <div class="h-sub">Top-of-funnel: new contacts tagged <em>Pacific Discovery</em>.</div>
      <div class="chart-wrap"><canvas id="chart-contacts"></canvas><div class="skeleton" id="skel-contacts"></div></div>
    </div>

    <div class="card wide">
      <h2>Full breakdown</h2>
      <div class="h-sub">Monthly numbers behind the charts. Click a month to see deals that skipped Deposit Paid.</div>
      <div id="table-wrap"></div>
    </div>
  </section>

  <p class="footnote">
    <strong>Source:</strong> HubSpot CRM, live on each page load.
    <strong>Pipelines:</strong> Fall Semester, Fall Mini Semester, Spring Semester, Spring Mini Semester, Summer Program.
    <strong>Excluded:</strong> College credit add-on deals, test accounts.
    <strong>Sale definition:</strong> A deal that entered Deposit Paid in the month, OR entered Closed Won in the month without ever having entered Deposit Paid.
  </p>
</div>

<script>
  // -------- Defaults: last 13 months --------
  function defaultRange() {
    const now = new Date();
    const to = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const back = new Date(now.getFullYear(), now.getMonth() - 12, 1);
    const from = `${back.getFullYear()}-${String(back.getMonth() + 1).padStart(2, '0')}`;
    return { from, to };
  }

  const fromInput = document.getElementById('from');
  const toInput = document.getElementById('to');
  const refreshBtn = document.getElementById('refresh');
  const errorBanner = document.getElementById('error-banner');
  const generatedEl = document.getElementById('generated');
  const kpisEl = document.getElementById('kpis');
  const tableWrap = document.getElementById('table-wrap');

  const def = defaultRange();
  fromInput.value = def.from;
  toInput.value = def.to;

  // -------- Chart theme defaults --------
  Chart.defaults.color = '#8aa19d';
  Chart.defaults.font.family = "'Inter', system-ui, sans-serif";
  Chart.defaults.font.size = 11;
  Chart.defaults.borderColor = '#243130';

  const COLORS = {
    accent:   '#d8a657',
    accent2:  '#6ab39a',
    warn:     '#d96a4e',
    good:     '#88c9a1',
    muted:    '#8aa19d',
  };

  let charts = {};

  function showSkeletons(on) {
    ['funnel', 'sales-mix', 'contacts'].forEach((k) => {
      document.getElementById(`skel-${k}`).classList.toggle('hidden', !on);
    });
  }

  function fmtMonthLabel(ym) {
    const [y, m] = ym.split('-').map(Number);
    const d = new Date(Date.UTC(y, m - 1, 1));
    return d.toLocaleString('en', { month: 'short', year: '2-digit' });
  }

  function renderKpis(data) {
    const sum = (arr) => arr.reduce((a, b) => a + b, 0);
    const opps = sum(data.opportunities);
    const sales = sum(data.totalSales);
    const skipped = sum(data.salesSkipDp);
    const contacts = sum(data.contacts);
    const conv = opps > 0 ? Math.round((sales / opps) * 100) : 0;

    const cards = [
      { label: 'Opportunities', value: opps, sub: 'App Fee Received' },
      { label: 'Total Sales', value: sales, sub: `${conv}% of opps` },
      { label: 'Skipped DP → CW', value: skipped, sub: 'Closed without deposit stage' },
      { label: 'PD Contacts', value: contacts.toLocaleString(), sub: 'New, tagged Pacific Discovery' },
    ];
    kpisEl.innerHTML = cards.map((c) => `
      <div class="kpi">
        <div class="label">${c.label}</div>
        <div class="value">${c.value}</div>
        <div class="sub">${c.sub}</div>
      </div>`).join('');
  }

  function renderFunnel(data) {
    const ctx = document.getElementById('chart-funnel');
    if (charts.funnel) charts.funnel.destroy();
    charts.funnel = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: data.months.map(fmtMonthLabel),
        datasets: [
          {
            label: 'Sales (via DP)',
            data: data.salesViaDp,
            backgroundColor: COLORS.accent2,
            borderRadius: 4,
            stack: 'sales',
            order: 2,
          },
          {
            label: 'Sales (skipped DP)',
            data: data.salesSkipDp,
            backgroundColor: COLORS.good,
            borderRadius: 4,
            stack: 'sales',
            order: 2,
          },
          {
            label: 'Opportunities',
            type: 'line',
            data: data.opportunities,
            borderColor: COLORS.accent,
            backgroundColor: COLORS.accent,
            borderWidth: 2.5,
            tension: 0.35,
            pointRadius: 4,
            pointHoverRadius: 6,
            order: 1,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { position: 'bottom', labels: { usePointStyle: true, padding: 16 } },
          tooltip: { mode: 'index', intersect: false },
        },
        scales: {
          x: { stacked: true, grid: { display: false } },
          y: { stacked: true, beginAtZero: true, grid: { color: '#1f2a29' } },
        },
      },
    });
  }

  function renderSalesMix(data) {
    const ctx = document.getElementById('chart-sales-mix');
    if (charts.salesMix) charts.salesMix.destroy();
    charts.salesMix = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: data.months.map(fmtMonthLabel),
        datasets: [
          { label: 'Via Deposit Paid', data: data.salesViaDp, backgroundColor: COLORS.accent2, borderRadius: 3 },
          { label: 'Skipped DP', data: data.salesSkipDp, backgroundColor: COLORS.good, borderRadius: 3 },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { position: 'bottom', labels: { usePointStyle: true, padding: 16 } } },
        scales: {
          x: { stacked: true, grid: { display: false } },
          y: { stacked: true, beginAtZero: true, grid: { color: '#1f2a29' } },
        },
      },
    });
  }

  function renderContacts(data) {
    const ctx = document.getElementById('chart-contacts');
    if (charts.contacts) charts.contacts.destroy();
    charts.contacts = new Chart(ctx, {
      type: 'line',
      data: {
        labels: data.months.map(fmtMonthLabel),
        datasets: [{
          label: 'PD Contacts created',
          data: data.contacts,
          borderColor: COLORS.accent,
          backgroundColor: 'rgba(216,166,87,0.12)',
          fill: true,
          tension: 0.35,
          borderWidth: 2.5,
          pointRadius: 3,
          pointHoverRadius: 6,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { grid: { display: false } },
          y: { beginAtZero: true, grid: { color: '#1f2a29' } },
        },
      },
    });
  }

  function renderTable(data) {
    const rows = data.months.map((m, i) => {
      const total = data.totalSales[i];
      const skip = data.salesSkipDp[i];
      const skipNames = data.skippedDeals[m] || [];
      const tip = skipNames.length
        ? ` title="${skipNames.map(s => s.name).join(' · ')}"`
        : '';
      return `<tr>
        <td>${fmtMonthLabel(m)}</td>
        <td>${data.contacts[i].toLocaleString()}</td>
        <td>${data.opportunities[i]}</td>
        <td>${data.salesViaDp[i]}</td>
        <td${tip}${skip > 0 ? ' style="cursor:help;color:var(--good)"' : ''}>${skip}</td>
        <td><strong style="color:var(--text)">${total}</strong></td>
      </tr>`;
    }).join('');

    const sums = ['contacts', 'opportunities', 'salesViaDp', 'salesSkipDp', 'totalSales'].map(k =>
      data[k].reduce((a, b) => a + b, 0)
    );

    tableWrap.innerHTML = `
      <table>
        <thead>
          <tr>
            <th>Month</th>
            <th>Contacts</th>
            <th>Opportunities</th>
            <th>Sales (DP)</th>
            <th>Sales (skip)</th>
            <th>Total Sales</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
        <tfoot>
          <tr>
            <td>Total</td>
            <td>${sums[0].toLocaleString()}</td>
            <td>${sums[1]}</td>
            <td>${sums[2]}</td>
            <td>${sums[3]}</td>
            <td>${sums[4]}</td>
          </tr>
        </tfoot>
      </table>`;
  }

  async function load() {
    refreshBtn.disabled = true;
    refreshBtn.textContent = 'Loading…';
    errorBanner.classList.add('hidden');
    showSkeletons(true);

    try {
      const url = `/api/sales-funnel-data?from=${fromInput.value}&to=${toInput.value}`;
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Server ${res.status}: ${errText}`);
      }
      const data = await res.json();
      if (data.error) throw new Error(data.error);

      renderKpis(data);
      // Each chart renders independently — easy to lazy-load further later
      renderFunnel(data);
      renderSalesMix(data);
      renderContacts(data);
      renderTable(data);

      generatedEl.textContent = `Updated ${new Date(data.generatedAt).toLocaleString()}`;
    } catch (err) {
      errorBanner.textContent = `Failed to load: ${err.message}`;
      errorBanner.classList.remove('hidden');
      console.error(err);
    } finally {
      showSkeletons(false);
      refreshBtn.disabled = false;
      refreshBtn.textContent = 'Refresh';
    }
  }

  refreshBtn.addEventListener('click', load);
  load();
</script>
</body>
</html>

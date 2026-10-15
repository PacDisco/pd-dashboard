/**
 * Time Tracker reports — one engine for every way a report leaves the app.
 *
 * The "⭳ Export report" download (CSV or PDF), the weekly / fortnightly email
 * and the "send now" test all go through buildReport() → toCsv() / toPdf() /
 * toEmail(). Nothing is drawn in the browser, so the file someone downloads and
 * the file that lands in an inbox on Monday morning cannot disagree.
 *
 * Pure apart from loadReportEntries(), which takes the caller's `sql` so this
 * module never opens a database connection of its own.
 *
 * ROUNDING follows the rest of the tracker (see ROUND_TO_MINUTES in
 * time-tracking.js): entries are exact; billing rounds a person's TOTAL for the
 * period to the nearest quarter hour, once. A team report therefore rounds per
 * contractor and adds those up — never per entry, never the whole team at once.
 *
 * TIMEZONES: entries carry a `work_date` the browser chose plus exact instants.
 * The only thing this module formats in a timezone is the start / finish clock
 * time, and it uses the timezone the report was asked for in (the browser's for
 * a download, the one saved on the schedule for an email).
 */

'use strict';

const ROUND_TO_MINUTES = 15;
const MIN_BILLABLE_MINUTES = 15;
const DEFAULT_TZ = 'Pacific/Auckland';
const NO_BRAND = 'Unassigned';
const NO_PROJECT = 'No project';

// Same rule as ENTRY_BRAND_SQL in time-tracking.js — the entry's own brand wins,
// otherwise the project's, blanks fold into ''. A test pins the two together.
const REPORT_BRAND_SQL =
  `COALESCE(NULLIF(BTRIM(e.brand), ''), NULLIF(BTRIM(p.brand), ''), '')`;

const REPORT_SELECT = `
  SELECT e.id, e.contractor_id, e.project_id, e.work_date, e.started_at, e.ended_at,
         e.minutes, e.description, e.source, e.locked, e.approval_id,
         p.name AS project_name, p.code AS project_code, p.brand AS project_brand,
         ${REPORT_BRAND_SQL} AS brand,
         -- Personal projects (MIGRATION-time-projects-owner.sql). Read through
         -- to_jsonb so this select still runs on a database that hasn't had
         -- that migration yet — every project is then simply a team project.
         to_jsonb(p)->>'owner_email' AS project_owner,
         (SELECT COALESCE(oc.full_name, oc.email) FROM time_contractors oc
           WHERE oc.email = to_jsonb(p)->>'owner_email') AS project_owner_name,
         c.email AS contractor_email, c.full_name AS contractor_name,
         c.hourly_rate, c.currency
  FROM time_entries e
  LEFT JOIN time_projects p ON p.id = e.project_id
  JOIN time_contractors c   ON c.id = e.contractor_id
`;

function roundBillableMinutes(raw) {
  const n = Number(raw) || 0;
  if (n <= 0) return 0;
  return Math.max(MIN_BILLABLE_MINUTES, Math.round(n / ROUND_TO_MINUTES) * ROUND_TO_MINUTES);
}

/* ------------------------------------------------------------------ options */

/**
 * Columns an entries table can carry. Order here is the order they print in,
 * whatever order someone ticked them.
 */
const COLUMNS = {
  date:        { label: 'Date' },
  contractor:  { label: 'Contractor', team: true },
  email:       { label: 'Email', team: true },
  project:     { label: 'Project' },
  code:        { label: 'Code' },
  brand:       { label: 'Brand' },
  description: { label: 'Description' },
  started:     { label: 'Started' },
  finished:    { label: 'Finished' },
  hours:       { label: 'Hours' },
  status:      { label: 'Status' },
  source:      { label: 'Source' },
};
const COLUMN_KEYS = Object.keys(COLUMNS);
const DEFAULT_COLUMNS = {
  self: ['date', 'project', 'brand', 'description', 'started', 'finished', 'hours', 'status'],
  team: ['date', 'contractor', 'project', 'brand', 'description', 'hours', 'status'],
};

const GROUPS = {
  none:       'No grouping',
  day:        'Day',
  week:       'Week',
  project:    'Project',
  brand:      'Brand',
  contractor: 'Contractor',
};
const STATUSES = { all: 'All entries', approved: 'Approved only', unapproved: 'Not yet approved' };
const FORMATS = ['csv', 'pdf'];
const FREQUENCIES = { weekly: 7, fortnightly: 14 };

function isYmd(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
  if (!m) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !isNaN(d) && d.getUTCMonth() + 1 === Number(m[2]) && d.getUTCDate() === Number(m[3]);
}

function validTz(tz) {
  if (!tz) return DEFAULT_TZ;
  try { new Intl.DateTimeFormat('en-NZ', { timeZone: String(tz) }); return String(tz); }
  catch { return DEFAULT_TZ; }
}

function idList(raw, label) {
  if (raw === undefined || raw === null || raw === '') return [];
  if (!Array.isArray(raw)) throw new Error(`${label} must be a list`);
  const out = [];
  for (const v of raw) {
    const n = Number(v);
    // 0 is meaningful for projects: "entries with no project".
    if (!Number.isInteger(n) || n < 0) throw new Error(`${label} must be ids`);
    if (!out.includes(n)) out.push(n);
  }
  return out.slice(0, 500);
}

/**
 * Validate what a person asked for into options the engine trusts.
 *
 * `scope` is decided by the SERVER from who is asking, never read from the body:
 * a 'self' report has its contractor filter thrown away and replaced with the
 * caller, so naming someone else in it does nothing.
 *
 * `requireDates` is false for a schedule, whose period is worked out each time
 * it sends.
 */
function normalizeOptions(raw, { scope, requireDates = true } = {}) {
  const o = raw && typeof raw === 'object' ? raw : {};
  if (scope !== 'self' && scope !== 'team') throw new Error('unknown report scope');

  let from = null, to = null;
  if (requireDates || o.from || o.to) {
    if (!isYmd(o.from)) throw new Error('pick a start date for the report');
    if (!isYmd(o.to)) throw new Error('pick an end date for the report');
    from = o.from; to = o.to;
    if (from > to) throw new Error('the start date is after the end date');
    const days = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000;
    if (days > 400) throw new Error('a report can cover at most about a year — split it up');
  }

  const groupBy = GROUPS[o.group_by] ? o.group_by : 'none';
  const status = STATUSES[o.status] ? o.status : 'all';
  const detail = o.detail === 'summary' ? 'summary' : 'entries';

  let columns = Array.isArray(o.columns) ? o.columns.filter((c) => COLUMNS[c]) : [];
  if (scope === 'self') columns = columns.filter((c) => !COLUMNS[c].team);
  if (!columns.length) columns = DEFAULT_COLUMNS[scope].slice();
  columns = COLUMN_KEYS.filter((k) => columns.includes(k));       // canonical order

  const brands = Array.isArray(o.brands)
    ? [...new Set(o.brands.map((b) => String(b == null ? '' : b).trim().slice(0, 100)))]
    : [];

  return {
    from, to,
    contractor_ids: scope === 'team' ? idList(o.contractor_ids, 'contractor_ids') : [],
    project_ids: idList(o.project_ids, 'project_ids'),
    brands,
    status,
    group_by: groupBy,
    detail,
    columns,
    include_money: !!o.include_money,
    title: o.title ? String(o.title).trim().slice(0, 120) : '',
  };
}

/* ---------------------------------------------------------------- formatting */

function ymd(raw) {
  if (raw === null || raw === undefined) return '';
  if (raw instanceof Date) {
    // Same reasoning as dstr() in time-tracking.js: a DATE comes back as either
    // UTC or local midnight depending on the driver; read it with the matching
    // getters so the day never shifts.
    const utc = raw.getUTCHours() === 0 && raw.getUTCMinutes() === 0 && raw.getUTCSeconds() === 0;
    const y = utc ? raw.getUTCFullYear() : raw.getFullYear();
    const m = (utc ? raw.getUTCMonth() : raw.getMonth()) + 1;
    const d = utc ? raw.getUTCDate() : raw.getDate();
    return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }
  return String(raw).slice(0, 10);
}

const hours = (min) => (Math.round(((Number(min) || 0) / 60) * 100) / 100).toFixed(2);

function clock(iso, tz) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return '';
  return new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
function longDate(s) {
  if (!isYmd(s)) return String(s || '');
  const d = new Date(`${s}T00:00:00Z`);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}
function dayLabel(s) {
  const d = new Date(`${s}T00:00:00Z`);
  return `${DOW[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}
function rangeLabel(from, to) {
  return from === to ? longDate(from) : `${longDate(from)} – ${longDate(to)}`;
}
function addDaysYmd(s, n) {
  const d = new Date(`${s}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function mondayOfYmd(s) {
  const d = new Date(`${s}T00:00:00Z`);
  return addDaysYmd(s, -((d.getUTCDay() + 6) % 7));
}

/** Today's calendar date in a timezone, as YYYY-MM-DD. */
function todayIn(tz, now = new Date()) {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', { timeZone: validTz(tz), year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

/* ------------------------------------------------------------------- the engine */

const personName = (e) => e.contractor_name || e.contractor_email || 'Unknown';
const brandOf = (e) => String(e.brand || '').trim() || NO_BRAND;

function cell(key, e, tz) {
  switch (key) {
    case 'date':        return ymd(e.work_date);
    case 'contractor':  return personName(e);
    case 'email':       return e.contractor_email || '';
    case 'project':     return e.project_name || NO_PROJECT;
    case 'code':        return e.project_code || '';
    case 'brand':       return brandOf(e);
    case 'description': return e.description || '';
    case 'started':     return clock(e.started_at, tz);
    case 'finished':    return clock(e.ended_at, tz);
    case 'hours':       return hours(e.minutes);
    case 'status':      return e.locked ? 'Approved' : 'Not approved';
    case 'source':      return e.source || '';
    default:            return '';
  }
}

function groupKey(groupBy, e) {
  const d = ymd(e.work_date);
  switch (groupBy) {
    case 'day':        return { key: d, label: dayLabel(d), sort: d };
    case 'week': {
      const m = mondayOfYmd(d);
      return { key: m, label: `Week of ${longDate(m)}`, sort: m };
    }
    case 'project': {
      const label = e.project_name || NO_PROJECT;
      return { key: `p${e.project_id || 0}`, label, sort: (e.project_id ? '0' : '1') + label.toLowerCase() };
    }
    case 'brand': {
      const label = brandOf(e);
      return { key: label, label, sort: (label === NO_BRAND ? '1' : '0') + label.toLowerCase() };
    }
    case 'contractor': {
      const label = personName(e);
      return { key: `c${e.contractor_id}`, label, sort: label.toLowerCase() };
    }
    default: return { key: 'all', label: 'All entries', sort: '' };
  }
}

function summarise(entries, keyFn) {
  const by = new Map();
  for (const e of entries) {
    const g = keyFn(e);
    if (!by.has(g.key)) by.set(g.key, { key: g.key, label: g.label, sort: g.sort, minutes: 0, count: 0, entries: [] });
    const row = by.get(g.key);
    row.minutes += Number(e.minutes) || 0;
    row.count += 1;
    row.entries.push(e);
  }
  return [...by.values()];
}

/**
 * Build the report. Inputs are plain rows (REPORT_SELECT's shape), so the same
 * call serves a download, an email and the tests.
 *
 * @param {object}   args
 * @param {object[]} args.entries   rows from loadReportEntries()
 * @param {object}   args.options   output of normalizeOptions()
 * @param {'self'|'team'} args.scope
 * @param {string}   [args.subject] who a self report is about (display name)
 * @param {string}   [args.tz]
 * @param {Date}     [args.now]
 */
function buildReport({ entries, options, scope, subject, tz, now = new Date() }) {
  const o = options;
  const zone = validTz(tz);
  const brandSet = o.brands.length ? new Set(o.brands.map((b) => b || NO_BRAND)) : null;
  const projectSet = o.project_ids.length ? new Set(o.project_ids) : null;
  const contractorSet = o.contractor_ids.length ? new Set(o.contractor_ids) : null;

  const rows = (entries || [])
    .filter((e) => e.ended_at)                                         // a running timer isn't time yet
    .filter((e) => { const d = ymd(e.work_date); return (!o.from || d >= o.from) && (!o.to || d <= o.to); })
    .filter((e) => !contractorSet || contractorSet.has(e.contractor_id))
    .filter((e) => !projectSet || projectSet.has(e.project_id || 0))
    .filter((e) => !brandSet || brandSet.has(brandOf(e)))
    .filter((e) => o.status === 'all' || (o.status === 'approved' ? !!e.locked : !e.locked))
    .sort((a, b) => ymd(a.work_date).localeCompare(ymd(b.work_date))
      || personName(a).localeCompare(personName(b))
      || Date.parse(a.started_at) - Date.parse(b.started_at));

  const groups = summarise(rows, (e) => groupKey(o.group_by, e))
    .sort((a, b) => a.sort.localeCompare(b.sort));

  // Billing rounds each person's period total once. Summing those is the team's
  // billable figure; rounding the team's raw total instead would bill a
  // different number from the timesheets that get approved.
  const people = summarise(rows, (e) => ({ key: `c${e.contractor_id}`, label: personName(e), sort: personName(e).toLowerCase() }))
    .sort((a, b) => a.sort.localeCompare(b.sort))
    .map((p) => {
      const first = p.entries[0];
      const rate = first.hourly_rate === null || first.hourly_rate === undefined ? null : Number(first.hourly_rate);
      const billable = roundBillableMinutes(p.minutes);
      return {
        contractor_id: first.contractor_id,
        name: p.label,
        email: first.contractor_email || '',
        minutes: p.minutes,
        count: p.count,
        billable_minutes: billable,
        rate,
        currency: first.currency || 'NZD',
        amount: rate === null ? null : Math.round((billable / 60) * rate * 100) / 100,
        approved_minutes: p.entries.filter((e) => e.locked).reduce((s, e) => s + (Number(e.minutes) || 0), 0),
      };
    });

  const minutes = rows.reduce((s, e) => s + (Number(e.minutes) || 0), 0);
  const minutesTotal = minutes;
  const billable = people.reduce((s, p) => s + p.billable_minutes, 0);

  // Money totals only add up within one currency.
  const moneyByCurrency = {};
  for (const p of people) {
    if (p.amount === null) continue;
    moneyByCurrency[p.currency] = Math.round(((moneyByCurrency[p.currency] || 0) + p.amount) * 100) / 100;
  }

  const byBrand = summarise(rows, (e) => groupKey('brand', e)).sort((a, b) => b.minutes - a.minutes || a.sort.localeCompare(b.sort));
  // Time per project for the period — the table every report leads with.
  const byProject = summarise(rows, (e) => groupKey('project', e))
    .sort((a, b) => b.minutes - a.minutes || a.sort.localeCompare(b.sort))
    .map((g) => {
      const f = g.entries[0];
      const peopleOn = summarise(g.entries, (e) => ({ key: `c${e.contractor_id}`, label: personName(e), sort: personName(e).toLowerCase() }))
        .sort((a, b) => b.minutes - a.minutes || a.sort.localeCompare(b.sort));
      return {
        label: g.label,
        code: f.project_id ? (f.project_code || '') : '',
        brand: f.project_id ? (String(f.project_brand || '').trim() || NO_BRAND) : '',
        owner: f.project_id ? (f.project_owner ? (f.project_owner_name || f.project_owner) : 'Team') : '',
        minutes: g.minutes,
        count: g.count,
        share: minutesTotal ? g.minutes / minutesTotal : 0,
        people: peopleOn.map((x) => ({ name: x.label, minutes: x.minutes, count: x.count })),
      };
    });

  const title = o.title || (scope === 'team' ? 'Team time report' : `Time report — ${subject || 'me'}`);

  return {
    title,
    scope,
    subject: subject || '',
    from: o.from,
    to: o.to,
    period: o.from && o.to ? rangeLabel(o.from, o.to) : '',
    tz: zone,
    generated_at: now.toISOString(),
    generated_label: `${todayIn(zone, now)} ${clock(now.toISOString(), zone)} (${zone})`,
    options: o,
    filters: describeFilters(o, scope, people),
    columns: o.columns.map((k) => ({ key: k, label: COLUMNS[k].label })),
    rows: rows.map((e) => ({ entry: e, cells: o.columns.map((k) => cell(k, e, zone)) })),
    groups: groups.map((g) => ({
      label: g.label, minutes: g.minutes, count: g.count,
      rows: g.entries.map((e) => o.columns.map((k) => cell(k, e, zone))),
    })),
    people,
    byBrand: byBrand.map((g) => ({ label: g.label, minutes: g.minutes, count: g.count })),
    byProject,
    totals: { minutes, billable_minutes: billable, count: rows.length, money: moneyByCurrency },
  };
}

function describeFilters(o, scope, people) {
  const bits = [];
  if (scope === 'team') {
    bits.push(o.contractor_ids.length ? `${o.contractor_ids.length} selected ${o.contractor_ids.length === 1 ? 'person' : 'people'}` : 'Everyone');
  }
  if (o.project_ids.length) bits.push(`${o.project_ids.length} project${o.project_ids.length === 1 ? '' : 's'}`);
  if (o.brands.length) bits.push(`Brand: ${o.brands.map((b) => b || NO_BRAND).join(', ')}`);
  if (o.status !== 'all') bits.push(STATUSES[o.status]);
  if (o.group_by !== 'none') bits.push(`Grouped by ${GROUPS[o.group_by].toLowerCase()}`);
  if (o.detail === 'summary') bits.push('Summary only');
  return bits.join(' · ');
}

/* -------------------------------------------------------------------------- CSV */

function csvCell(v) {
  let s = String(v === null || v === undefined ? '' : v);
  // A cell starting with = + - @ is run as a formula by Excel and Sheets. Time
  // descriptions are free text typed by anyone, so neutralise it.
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
const csvLine = (arr) => arr.map(csvCell).join(',');

const pct = (share) => `${(Math.round(share * 1000) / 10).toFixed(1)}%`;

/** A second summary for the chosen grouping, when it isn't projects already. */
function extraGroupSummary(r) {
  const g = r.options.group_by;
  if (g === 'none' || g === 'project') return null;
  return { title: GROUPS[g], rows: r.groups.map((x) => ({ label: x.label, minutes: x.minutes, count: x.count })) };
}

/** Team reports break each project down by who worked on it. */
const showProjectPeople = (r) => r.scope === 'team' && r.people.length > 1 && r.byProject.length > 0;

function toCsv(r) {
  const out = [];
  out.push(csvLine(['Report', r.title]));
  if (r.period) out.push(csvLine(['Period', r.period]));
  if (r.filters) out.push(csvLine(['Filters', r.filters]));
  out.push(csvLine(['Generated', r.generated_label]));
  out.push('');

  if (r.options.detail === 'entries') {
    // A grouped CSV carries the group in its own first column — unless the
    // group IS one of the chosen columns already (grouped by project with a
    // Project column), where a second copy would just be noise.
    const GROUP_COL = { day: 'date', project: 'project', brand: 'brand', contractor: 'contractor' };
    const grouped = r.options.group_by !== 'none' && !r.options.columns.includes(GROUP_COL[r.options.group_by]);
    // The group sits in its own first column rather than as header rows between
    // blocks, so the sheet still sorts and pivots as one table.
    out.push(csvLine([...(grouped ? [GROUPS[r.options.group_by]] : []), ...r.columns.map((c) => c.label)]));
    for (const g of r.groups) {
      for (const cells of g.rows) out.push(csvLine([...(grouped ? [g.label] : []), ...cells]));
    }
    if (!r.rows.length) out.push(csvLine(['No entries match this report.']));
    out.push('');
  }

  // Time per project — always present, whatever the grouping.
  const team = r.scope === 'team';
  out.push(csvLine(['Time by project', 'Code', 'Brand', ...(team ? ['Owner', 'People'] : []), 'Entries', 'Hours', '% of total']));
  for (const p of r.byProject) {
    out.push(csvLine([p.label, p.code, p.brand, ...(team ? [p.owner, p.people.length] : []), p.count, hours(p.minutes), pct(p.share)]));
  }
  out.push(csvLine(['Total', '', '', ...(team ? ['', r.people.length] : []), r.totals.count, hours(r.totals.minutes), r.totals.count ? '100.0%' : '']));
  out.push('');

  if (showProjectPeople(r)) {
    out.push(csvLine(['Project', 'Person', 'Entries', 'Hours']));
    for (const p of r.byProject) for (const x of p.people) out.push(csvLine([p.label, x.name, x.count, hours(x.minutes)]));
    out.push('');
  }

  const extra = extraGroupSummary(r);
  if (extra) {
    out.push(csvLine([`Hours by ${extra.title.toLowerCase()}`, 'Entries', 'Hours']));
    for (const x of extra.rows) out.push(csvLine([x.label, x.count, hours(x.minutes)]));
    out.push(csvLine(['Total', r.totals.count, hours(r.totals.minutes)]));
    out.push('');
  }

  if (r.scope === 'team' || r.options.include_money) {
    const money = r.options.include_money;
    out.push(csvLine(['Person', 'Entries', 'Hours (exact)', 'Billable hours', ...(money ? ['Rate', 'Currency', 'Amount'] : [])]));
    for (const p of r.people) {
      out.push(csvLine([p.name, p.count, hours(p.minutes), hours(p.billable_minutes),
        ...(money ? [p.rate === null ? 'no rate' : p.rate.toFixed(2), p.currency, p.amount === null ? '' : p.amount.toFixed(2)] : [])]));
    }
    out.push(csvLine(['Total', r.totals.count, hours(r.totals.minutes), hours(r.totals.billable_minutes),
      ...(money ? ['', '', Object.entries(r.totals.money).map(([c, v]) => `${v.toFixed(2)} ${c}`).join(' + ')] : [])]));
    out.push('');
  } else {
    out.push(csvLine(['Billable hours (rounded to the nearest quarter hour)', hours(r.totals.billable_minutes)]));
  }

  // BOM so Excel opens it as UTF-8 (macrons, en dashes).
  return '﻿' + out.join('\r\n') + '\r\n';
}

/* -------------------------------------------------------------------------- PDF */

/**
 * The PDF standard fonts cover Windows-1252 only. Fold accents (ā → a, so a
 * macron prints rather than turning into garbage), swap the few symbols the app
 * uses, and drop anything else that can't print.
 */
function pdfText(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/→/g, '->').replace(/←/g, '<-').replace(/−/g, '-')
    // Helvetica's middle dot doesn't draw in jsPDF; the bullet does.
    .replace(/·/g, '•')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^\x09\x0A\x0D\x20-\x7E\xA0-\xFF–—‘’“”•…€]/g, '');
}

const TEAL = [15, 118, 110];
const INK = [17, 24, 39];
const GREY = [107, 114, 128];

function toPdf(r) {
  // Required lazily: jsPDF is ~400 KB and most calls to this module are CSVs.
  const { jsPDF } = require('jspdf');
  const { autoTable } = require('jspdf-autotable');

  const wide = r.options.detail === 'entries' && r.columns.length > 6;
  const doc = new jsPDF({ orientation: wide ? 'landscape' : 'portrait', unit: 'pt', format: 'a4' });
  const W = doc.internal.pageSize.getWidth();
  const M = 40;
  let y = M;

  doc.setFont('helvetica', 'bold'); doc.setFontSize(17); doc.setTextColor(...INK);
  doc.text(pdfText(r.title), M, y + 6);
  y += 24;
  doc.setFont('helvetica', 'normal'); doc.setFontSize(10); doc.setTextColor(...GREY);
  if (r.period) { doc.text(pdfText(r.period), M, y); y += 14; }
  if (r.filters) {
    const lines = doc.splitTextToSize(pdfText(r.filters), W - 2 * M);
    doc.text(lines, M, y); y += 13 * lines.length;
  }
  doc.setFontSize(8.5);
  doc.text(pdfText(`Generated ${r.generated_label}`), M, y); y += 18;

  // Headline numbers.
  const kpis = [
    ['Hours worked', `${hours(r.totals.minutes)} h`],
    ['Billable (nearest 1/4 h)', `${hours(r.totals.billable_minutes)} h`],
    ['Entries', String(r.totals.count)],
  ];
  if (r.options.include_money && Object.keys(r.totals.money).length) {
    kpis.push(['Amount', Object.entries(r.totals.money).map(([c, v]) => `${v.toFixed(2)} ${c}`).join(' + ')]);
  }
  const boxW = (W - 2 * M - (kpis.length - 1) * 8) / kpis.length;
  kpis.forEach(([label, value], i) => {
    const x = M + i * (boxW + 8);
    doc.setDrawColor(229, 231, 235); doc.setFillColor(249, 250, 251);
    doc.roundedRect(x, y, boxW, 44, 6, 6, 'FD');
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(...GREY);
    doc.text(pdfText(label.toUpperCase()), x + 10, y + 15);
    doc.setFont('helvetica', 'bold'); doc.setFontSize(13); doc.setTextColor(...INK);
    doc.text(pdfText(value), x + 10, y + 33);
  });
  y += 60;

  const tableBase = {
    margin: { left: M, right: M, bottom: 40 },
    styles: { font: 'helvetica', fontSize: 8.5, cellPadding: 4, textColor: INK, lineColor: [238, 242, 247], lineWidth: 0.5 },
    headStyles: { fillColor: TEAL, textColor: [255, 255, 255], fontStyle: 'bold' },
    theme: 'grid',
  };
  const section = (label) => {
    if (y > doc.internal.pageSize.getHeight() - 90) { doc.addPage(); y = M; }
    doc.setFont('helvetica', 'bold'); doc.setFontSize(11); doc.setTextColor(...INK);
    doc.text(pdfText(label), M, y); y += 6;
  };
  const after = () => { y = doc.lastAutoTable.finalY + 20; };

  const bold = (v) => ({ content: v, styles: { fontStyle: 'bold' } });
  const team = r.scope === 'team';

  // Time per project — every report leads with it.
  section('Time by project');
  {
    const head = ['Project', 'Code', 'Brand', ...(team ? ['Owner', 'People'] : []), 'Entries', 'Hours', '%'];
    const right = {};
    for (let i = team ? 4 : 3; i < head.length; i++) right[i] = { halign: 'right' };
    autoTable(doc, {
      ...tableBase, startY: y,
      head: [head],
      body: [
        ...r.byProject.map((p) => [pdfText(p.label), pdfText(p.code), pdfText(p.brand),
          ...(team ? [pdfText(p.owner), String(p.people.length)] : []), String(p.count), hours(p.minutes), pct(p.share)]),
        [bold('Total'), '', '', ...(team ? ['', bold(String(r.people.length))] : []),
          bold(String(r.totals.count)), bold(hours(r.totals.minutes)), r.totals.count ? bold('100.0%') : ''],
      ],
      columnStyles: right,
    });
    after();
  }

  if (showProjectPeople(r)) {
    section('Projects by person');
    const body = [];
    for (const p of r.byProject) {
      body.push([{ content: pdfText(`${p.label}  —  ${hours(p.minutes)} h`), colSpan: 3,
        styles: { fillColor: [240, 253, 250], fontStyle: 'bold', textColor: [17, 94, 89] } }]);
      for (const x of p.people) body.push([pdfText(x.name), String(x.count), hours(x.minutes)]);
    }
    autoTable(doc, {
      ...tableBase, startY: y,
      head: [['Person', 'Entries', 'Hours']],
      body,
      columnStyles: { 1: { halign: 'right', cellWidth: 60 }, 2: { halign: 'right', cellWidth: 70 } },
    });
    after();
  }

  const extra = extraGroupSummary(r);
  if (extra) {
    section(`Hours by ${extra.title.toLowerCase()}`);
    autoTable(doc, {
      ...tableBase, startY: y,
      head: [[pdfText(extra.title), 'Entries', 'Hours']],
      body: [...extra.rows.map((x) => [pdfText(x.label), String(x.count), hours(x.minutes)]),
        [bold('Total'), bold(String(r.totals.count)), bold(hours(r.totals.minutes))]],
      columnStyles: { 1: { halign: 'right', cellWidth: 60 }, 2: { halign: 'right', cellWidth: 70 } },
    });
    after();
  }

  if (r.options.group_by !== 'brand' && r.byBrand.length > 1) {
    section('Hours by brand');
    autoTable(doc, {
      ...tableBase, startY: y,
      head: [['Brand', 'Entries', 'Hours']],
      body: r.byBrand.map((s) => [pdfText(s.label), String(s.count), hours(s.minutes)]),
      columnStyles: { 1: { halign: 'right', cellWidth: 60 }, 2: { halign: 'right', cellWidth: 70 } },
    });
    after();
  }

  if (r.scope === 'team' || r.options.include_money) {
    const money = r.options.include_money;
    section(r.scope === 'team' ? 'By person' : 'Billing');
    autoTable(doc, {
      ...tableBase, startY: y,
      head: [['Person', 'Entries', 'Hours', 'Billable', ...(money ? ['Rate', 'Amount'] : [])]],
      body: r.people.map((p) => [pdfText(p.name), String(p.count), hours(p.minutes), hours(p.billable_minutes),
        ...(money ? [p.rate === null ? 'no rate' : `${p.rate.toFixed(2)} ${p.currency}`,
          p.amount === null ? '-' : `${p.amount.toFixed(2)} ${p.currency}`] : [])]),
      columnStyles: { 1: { halign: 'right' }, 2: { halign: 'right' }, 3: { halign: 'right' }, 4: { halign: 'right' }, 5: { halign: 'right' } },
    });
    after();
  }

  if (r.options.detail === 'entries') {
    section('Entries');
    const n = r.columns.length;
    const hoursIdx = r.columns.findIndex((c) => c.key === 'hours');
    const body = [];
    const grouped = r.options.group_by !== 'none';
    for (const g of r.groups) {
      if (grouped) {
        body.push([{ content: pdfText(`${g.label}  —  ${hours(g.minutes)} h`), colSpan: n,
          styles: { fillColor: [240, 253, 250], fontStyle: 'bold', textColor: [17, 94, 89] } }]);
      }
      for (const cells of g.rows) body.push(cells.map(pdfText));
    }
    if (!body.length) body.push([{ content: 'No entries match this report.', colSpan: n, styles: { textColor: GREY } }]);
    const colStyles = {};
    if (hoursIdx >= 0) colStyles[hoursIdx] = { halign: 'right' };
    const descIdx = r.columns.findIndex((c) => c.key === 'description');
    if (descIdx >= 0) colStyles[descIdx] = { cellWidth: 'auto', minCellWidth: 120 };
    autoTable(doc, {
      ...tableBase, startY: y,
      head: [r.columns.map((c) => c.label)],
      body,
      columnStyles: colStyles,
      showHead: 'everyPage',
    });
    after();
  }

  // Footer on every page.
  const pages = doc.getNumberOfPages();
  for (let i = 1; i <= pages; i++) {
    doc.setPage(i);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(...GREY);
    const H = doc.internal.pageSize.getHeight();
    doc.text(pdfText(`${r.title} · ${r.period}`), M, H - 20);
    doc.text(`Page ${i} of ${pages}`, W - M, H - 20, { align: 'right' });
  }

  return Buffer.from(doc.output('arraybuffer'));
}

/* ------------------------------------------------------------------------ email */

const escHtml = (s) => String(s === null || s === undefined ? '' : s)
  .replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/**
 * The email body: the headline numbers and the summary table, so the report is
 * readable without opening an attachment. The full thing is attached.
 */
function toEmail(r, { frequency, siteUrl, attachments = [] } = {}) {
  const every = frequency === 'fortnightly' ? 'fortnightly' : 'weekly';
  const subject = `${r.title} · ${r.period}`;
  const projects = r.byProject;
  const link = siteUrl ? `${siteUrl.replace(/\/+$/, '')}/time-tracking/` : '';
  const money = r.options.include_money && Object.keys(r.totals.money).length
    ? Object.entries(r.totals.money).map(([c, v]) => `${v.toFixed(2)} ${c}`).join(' + ') : '';

  const text = [
    r.title, r.period, r.filters, '',
    `Hours worked: ${hours(r.totals.minutes)} h`,
    `Billable (nearest quarter hour): ${hours(r.totals.billable_minutes)} h`,
    `Entries: ${r.totals.count}`,
    ...(money ? [`Amount: ${money}`] : []),
    '',
    'Time by project:',
    ...projects.map((p) => `  ${p.label}${p.code ? ` (${p.code})` : ''}: ${hours(p.minutes)} h · ${pct(p.share)}`),
    ...(r.scope === 'team' ? ['', 'By person:', ...r.people.map((p) => `  ${p.name}: ${hours(p.minutes)} h (billable ${hours(p.billable_minutes)} h)`)] : []),
    '',
    attachments.length ? `Attached: ${attachments.join(', ')}` : '',
    `You get this ${every} because a scheduled report was set up in the Time Tracker.`,
    link ? `Change or stop it: ${link}` : '',
  ].filter((l) => l !== null).join('\n');

  const td = 'padding:7px 10px;border-bottom:1px solid #eef2f7';
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#111827;max-width:620px">
<p style="margin:0 0 4px;font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#0f766e;font-weight:bold">Time Tracker · ${escHtml(every)} report</p>
<h2 style="margin:0 0 4px;font-size:20px">${escHtml(r.title)}</h2>
<p style="margin:0 0 14px;color:#6b7280">${escHtml(r.period)}${r.filters ? `<br><span style="font-size:12px">${escHtml(r.filters)}</span>` : ''}</p>
<table cellpadding="0" cellspacing="0" style="width:100%;border-collapse:separate;border-spacing:8px 0;margin:0 -8px 16px"><tr>
${[['Hours worked', `${hours(r.totals.minutes)} h`], ['Billable', `${hours(r.totals.billable_minutes)} h`], ['Entries', String(r.totals.count)], ...(money ? [['Amount', money]] : [])]
    .map(([l, v]) => `<td style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:10px"><div style="font-size:11px;text-transform:uppercase;color:#6b7280">${escHtml(l)}</div><div style="font-size:18px;font-weight:bold;margin-top:4px">${escHtml(v)}</div></td>`).join('')}
</tr></table>
<table cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;border:1px solid #e5e7eb">
<tr><th style="${td};text-align:left;background:#0f766e;color:#fff">Project</th><th style="${td};text-align:right;background:#0f766e;color:#fff">Hours</th><th style="${td};text-align:right;background:#0f766e;color:#fff">%</th></tr>
${projects.map((p) => `<tr><td style="${td}">${escHtml(p.label)}${p.code ? ` <span style="color:#9ca3af">${escHtml(p.code)}</span>` : ''}${r.scope === 'team' && p.people.length ? `<div style="font-size:12px;color:#6b7280">${p.people.map((x) => `${escHtml(x.name)} ${hours(x.minutes)}`).join(' · ')}</div>` : ''}</td><td style="${td};text-align:right">${hours(p.minutes)}</td><td style="${td};text-align:right;color:#6b7280">${pct(p.share)}</td></tr>`).join('\n')}
<tr><td style="${td};font-weight:bold">Total</td><td style="${td};text-align:right;font-weight:bold">${hours(r.totals.minutes)}</td><td style="${td}"></td></tr>
</table>
${r.scope === 'team' && r.people.length ? `<table cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;border:1px solid #e5e7eb;margin-top:14px">
<tr><th style="${td};text-align:left;background:#f9fafb">Person</th><th style="${td};text-align:right;background:#f9fafb">Hours</th><th style="${td};text-align:right;background:#f9fafb">Billable</th>${r.options.include_money ? `<th style="${td};text-align:right;background:#f9fafb">Amount</th>` : ''}</tr>
${r.people.map((p) => `<tr><td style="${td}">${escHtml(p.name)}</td><td style="${td};text-align:right">${hours(p.minutes)}</td><td style="${td};text-align:right">${hours(p.billable_minutes)}</td>${r.options.include_money ? `<td style="${td};text-align:right">${p.amount === null ? 'no rate' : `${p.amount.toFixed(2)} ${escHtml(p.currency)}`}</td>` : ''}</tr>`).join('\n')}
</table>` : ''}
${attachments.length ? `<p style="margin:16px 0 0;font-size:13px;color:#374151">Attached: ${attachments.map(escHtml).join(', ')}</p>` : ''}
<p style="margin:18px 0 0;font-size:12px;color:#9ca3af">You get this ${escHtml(every)} because a scheduled report was set up in the Time Tracker.${link ? ` <a href="${escHtml(link)}" style="color:#0f766e">Change or stop it</a>.` : ''}</p>
</div>`;

  return { subject, text, html };
}

/* ------------------------------------------------------------------- schedules */

/**
 * Scheduled reports go out on Mondays and cover the whole weeks just finished:
 * Mon–Sun for weekly, the two Mon–Sun weeks for fortnightly.
 */
function periodForSend(sendOn, frequency) {
  const days = FREQUENCIES[frequency] || 7;
  const end = addDaysYmd(mondayOfYmd(sendOn), -1);      // the Sunday just gone
  return { from: addDaysYmd(end, -(days - 1)), to: end };
}

/** The first Monday strictly after `today`. */
function firstSendOn(today) {
  return addDaysYmd(mondayOfYmd(today), 7);
}

/** Step a send date forward past `today`, skipping any missed runs. */
function advanceSendOn(sendOn, frequency, today) {
  const step = FREQUENCIES[frequency] || 7;
  let next = addDaysYmd(sendOn, step);
  while (next <= today) next = addDaysYmd(next, step);
  return next;
}

function fileBase(r) {
  const who = r.scope === 'team' ? 'team' : (r.subject || 'me');
  const slug = String(who).normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'report';
  return `time-report-${slug}-${r.from}_to_${r.to}`;
}

/** Render every requested format into attachments: [{ filename, mime, content: Buffer }]. */
function renderFiles(r, formats) {
  const base = fileBase(r);
  const out = [];
  for (const f of formats) {
    if (f === 'csv') out.push({ filename: `${base}.csv`, mime: 'text/csv', content: Buffer.from(toCsv(r), 'utf8') });
    if (f === 'pdf') out.push({ filename: `${base}.pdf`, mime: 'application/pdf', content: toPdf(r) });
  }
  return out;
}

/* ------------------------------------------------------------------------- data */

/**
 * The rows a report is built from. `contractorIds` null means everyone. The
 * finer filters (project, brand, status) are applied in buildReport so the
 * download and the tests run one code path.
 */
async function loadReportEntries(sql, { from, to, contractorIds }) {
  if (contractorIds && !contractorIds.length) contractorIds = null;
  return contractorIds
    ? sql.query(`${REPORT_SELECT}
        WHERE e.work_date BETWEEN $1 AND $2 AND e.ended_at IS NOT NULL AND e.contractor_id = ANY($3::int[])
        ORDER BY e.work_date, e.started_at`, [from, to, contractorIds])
    : sql.query(`${REPORT_SELECT}
        WHERE e.work_date BETWEEN $1 AND $2 AND e.ended_at IS NOT NULL
        ORDER BY e.work_date, e.started_at`, [from, to]);
}

/* --------------------------------------------------------------- recipients */

const EMAIL_RE = /^[^\s@,;<>"]+@[^\s@,;<>"]+\.[^\s@,;<>"]+$/;
const MAX_RECIPIENTS = 10;

function normalizeRecipients(raw) {
  const list = Array.isArray(raw) ? raw : String(raw || '').split(/[\s,;]+/);
  const out = [];
  for (const r of list) {
    const e = String(r || '').trim().toLowerCase();
    if (!e) continue;
    if (!EMAIL_RE.test(e) || e.length > 254) throw new Error(`"${e}" isn't an email address`);
    if (!out.includes(e)) out.push(e);
  }
  if (out.length > MAX_RECIPIENTS) throw new Error(`send to at most ${MAX_RECIPIENTS} addresses`);
  return out;
}

module.exports = {
  REPORT_SELECT, REPORT_BRAND_SQL, COLUMNS, COLUMN_KEYS, DEFAULT_COLUMNS, GROUPS, STATUSES, FORMATS, FREQUENCIES,
  DEFAULT_TZ, MAX_RECIPIENTS,
  normalizeOptions, buildReport, toCsv, toPdf, toEmail, renderFiles, fileBase,
  periodForSend, firstSendOn, advanceSendOn, todayIn, validTz, isYmd, addDaysYmd, mondayOfYmd,
  loadReportEntries, normalizeRecipients, roundBillableMinutes, pdfText, csvCell,
};

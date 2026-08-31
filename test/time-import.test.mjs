/**
 * Unit tests for Time Tracker bulk import.
 *
 * Two halves, matching where the work actually happens:
 *
 *   1. The browser's parser — turning a pasted block of spreadsheet into rows.
 *      This is where a wrong answer is silent and expensive: 03/04 read as the
 *      3rd of April instead of the 4th of March puts a month of hours on the
 *      wrong days and nothing looks broken.
 *
 *   2. The server's row validator — the half that decides what's allowed in.
 *      The rule that matters most: a contractor's rows are pinned to them no
 *      matter what the pasted sheet says in its email column.
 *
 * The parser is lifted out of time-tracking/index.html and run in a VM rather
 * than duplicated here, so these tests fail if the shipped page changes.
 *
 * Usage: node test/time-import.test.mjs
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

// Arrays built inside the VM have that realm's Array prototype, so deepEqual
// sees "same structure, not reference-equal". Array.from re-homes them.
let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok   ${name}`); passed++; }
  catch (err) { console.error(`  FAIL ${name}\n       ${err.message}`); failed++; }
}

// ═══════════════════════════════════════════
// LOAD THE SHIPPED PARSER
// ═══════════════════════════════════════════
const html = fs.readFileSync(path.join(root, 'time-tracking/index.html'), 'utf8');

const START = '/* ---------------------------------------------------------- bulk import */';
const END = '/* ------------------------------------------------------------------- CSV */';
const a = html.indexOf(START);
const b = html.indexOf(END);
assert.ok(a > 0 && b > a, 'could not find the bulk-import block in time-tracking/index.html');

const localToIso = html.match(/function localToIso[\s\S]*?\n}/);
assert.ok(localToIso, 'could not find localToIso in time-tracking/index.html');

const sandbox = { console, ME: null, document: undefined };
vm.createContext(sandbox);
vm.runInContext(localToIso[0] + '\n' + html.slice(a, b), sandbox, { filename: 'time-tracking.import.js' });

const {
  parseDelimited, sniffDelimiter, parseLooseDate, parseClock, parseHoursVal,
  mapHeaderRow, looksLikeHeader, buildImportRows
} = sandbox;

const minutesOf = (row) => Math.round((Date.parse(row.ended_at) - Date.parse(row.started_at)) / 60000);

// ═══════════════════════════════════════════
// DELIMITED TEXT
// ═══════════════════════════════════════════
console.log('\nparsing pasted text');

test('a quoted field keeps its commas', () => {
  const rows = parseDelimited('a,"one, two",c', ',');
  assert.deepEqual(Array.from(rows[0]), ['a', 'one, two', 'c']);
});

test('doubled quotes collapse to one', () => {
  const rows = parseDelimited('a,"say ""hi""",c', ',');
  assert.deepEqual(Array.from(rows[0]), ['a', 'say "hi"', 'c']);
});

test('blank lines are dropped, not turned into empty rows', () => {
  const rows = parseDelimited('a,b\n\n\nc,d\n', ',');
  assert.equal(rows.length, 2);
});

test('tabs win the delimiter sniff — that is what a spreadsheet copies', () => {
  assert.equal(sniffDelimiter('Date\tHours\n2026-08-24\t3.5'), '\t');
  assert.equal(sniffDelimiter('Date,Hours\n2026-08-24,3.5'), ',');
  assert.equal(sniffDelimiter('Date;Hours\n2026-08-24;3.5'), ';');
});

// ═══════════════════════════════════════════
// DATES — the expensive-to-get-wrong ones
// ═══════════════════════════════════════════
console.log('\ndates');

test('ISO passes through', () => {
  assert.equal(parseLooseDate('2026-08-24').ymd, '2026-08-24');
});

test('slash dates are read day/month, and say so', () => {
  const d = parseLooseDate('03/04/2026');
  assert.equal(d.ymd, '2026-04-03', 'must be 3 April, not 4 March');
  assert.equal(d.slash, true, 'the preview has to be able to warn about this');
});

test('a two-digit year lands this century', () => {
  assert.equal(parseLooseDate('24/08/26').ymd, '2026-08-24');
});

test('an impossible date is rejected rather than rolled over', () => {
  assert.equal(parseLooseDate('31/02/2026').ymd, null);
  assert.equal(parseLooseDate('2026-13-01').ymd, null);
});

test('month names work both ways round', () => {
  assert.equal(parseLooseDate('24 Aug 2026').ymd, '2026-08-24');
  assert.equal(parseLooseDate('24 August 2026').ymd, '2026-08-24');
  assert.equal(parseLooseDate('Aug 24, 2026').ymd, '2026-08-24');
});

test('junk is null, never a guess', () => {
  assert.equal(parseLooseDate('last tuesday'), null);
  assert.equal(parseLooseDate(''), null);
});

// ═══════════════════════════════════════════
// CLOCK TIMES AND DURATIONS
// ═══════════════════════════════════════════
console.log('\ntimes and durations');

test('clock times in the shapes people actually type', () => {
  assert.equal(parseClock('9:00'), '09:00');
  assert.equal(parseClock('09:00'), '09:00');
  assert.equal(parseClock('0900'), '09:00');
  assert.equal(parseClock('9am'), '09:00');
  assert.equal(parseClock('5:30 PM'), '17:30');
  assert.equal(parseClock('12am'), '00:00');
  assert.equal(parseClock('12pm'), '12:00');
  assert.equal(parseClock('17:30:00'), '17:30');
});

test('an out-of-range clock is rejected', () => {
  assert.equal(parseClock('25:00'), null);
  assert.equal(parseClock('9:75'), null);
  assert.equal(parseClock('13pm'), null);
});

test('durations: decimal, h:mm, and written-out', () => {
  assert.equal(parseHoursVal('1.5'), 1.5);
  assert.equal(parseHoursVal('1:30'), 1.5);
  assert.equal(parseHoursVal('1h 30m'), 1.5);
  assert.equal(parseHoursVal('2h'), 2);
  assert.equal(parseHoursVal('90m'), 1.5);
  assert.equal(parseHoursVal('1,5'), 1.5);
  assert.equal(parseHoursVal('nope'), null);
});

// ═══════════════════════════════════════════
// COLUMN MAPPING
// ═══════════════════════════════════════════
console.log('\ncolumn mapping');

test('headers are matched by name, in any order', () => {
  const { map } = mapHeaderRow(['Hours', 'Description', 'Date', 'Project']);
  assert.equal(map.date, 2);
  assert.equal(map.project, 3);
  assert.equal(map.hours, 0);
  assert.equal(map.description, 1);
});

test('an explicit Email column beats a loose Contractor one', () => {
  // This is the export round-trip: both columns are present, and binding the
  // person to the display name would reject every row.
  const { map } = mapHeaderRow(['Date', 'Contractor', 'Email', 'Project', 'Code', 'Description', 'Started', 'Finished', 'Hours', 'Status']);
  assert.equal(map.email, 2, 'the person must bind to Email, not Contractor');
  assert.equal(map.project, 3, 'Project beats the weaker Code alias');
});

test('unrecognised columns are reported, not silently eaten', () => {
  const { unmapped } = mapHeaderRow(['Date', 'Hours', 'Invoice ref']);
  assert.deepEqual(Array.from(unmapped), ['Invoice ref']);
});

test('a row of data is not mistaken for a header', () => {
  assert.equal(looksLikeHeader(['2026-08-24', 'WEB', '3.5']), false);
  assert.equal(looksLikeHeader(['Date', 'Project', 'Hours']), true);
});

// ═══════════════════════════════════════════
// WHOLE-PASTE BEHAVIOUR
// ═══════════════════════════════════════════
console.log('\nbuilding rows from a paste');

test('a tab-separated paste with a header becomes rows', () => {
  const out = buildImportRows('Date\tProject\tDescription\tHours\n2026-08-24\tWEB\tFunnel report\t3.5');
  assert.equal(out.errors.length, 0);
  assert.equal(out.rows.length, 1);
  assert.equal(out.rows[0].work_date, '2026-08-24');
  assert.equal(out.rows[0].project, 'WEB');
  assert.equal(out.rows[0].description, 'Funnel report');
  assert.equal(minutesOf(out.rows[0]), 210);
});

test('start + finish wins over an hours column when both are given', () => {
  const out = buildImportRows('Date,Started,Finished,Hours\n2026-08-24,09:00,12:00,99');
  assert.equal(minutesOf(out.rows[0]), 180);
});

test('hours-only anchors at 09:00 and keeps the work date', () => {
  const out = buildImportRows('Date,Hours\n2026-08-24,2');
  assert.equal(out.rows[0].work_date, '2026-08-24');
  assert.equal(minutesOf(out.rows[0]), 120);
  assert.equal(new Date(out.rows[0].started_at).getHours(), 9, 'local 09:00, as the by-hand modal does');
});

test('a finish before the start is read as crossing midnight', () => {
  const out = buildImportRows('Date,Started,Finished\n2026-08-24,22:00,02:00');
  assert.equal(minutesOf(out.rows[0]), 240);
});

test('a row with no usable times is an error, not a zero-length entry', () => {
  const out = buildImportRows('Date,Project,Hours\n2026-08-24,WEB,\n2026-08-25,WEB,2');
  assert.equal(out.rows.length, 1);
  assert.equal(out.errors.length, 1);
  assert.equal(out.errors[0].line, 2, 'the line number must match the spreadsheet');
  assert.match(out.errors[0].message, /no start\/finish times and no hours/);
});

test('an unreadable date is an error naming what it could not read', () => {
  const out = buildImportRows('Date,Hours\nsomeday,2');
  assert.equal(out.rows.length, 0);
  assert.match(out.errors[0].message, /couldn't read the date "someday"/);
});

test('a name in the person column is refused rather than silently reassigned', () => {
  // Left to itself this row would import onto whoever pasted it — which is how
  // one person quietly ends up with the whole team's hours.
  const out = buildImportRows('Date,Contractor,Hours\n2026-08-24,Jane Doe,2');
  assert.equal(out.rows.length, 0);
  assert.match(out.errors[0].message, /is a name, not an email/);
});

test('this dashboard\'s own CSV export pastes straight back in', () => {
  // The round trip is the point of the column order: export a week, fix it in
  // Excel, paste it back. If this breaks, the export and import have drifted.
  const out = buildImportRows([
    'Date,Contractor,Email,Project,Code,Description,Started,Finished,Hours,Status',
    '2026-08-24,Jane Doe,jane@x.com,Website rebuild,WEB,Funnel report,09:00,12:30,3.50,unapproved'
  ].join('\n'));
  assert.equal(out.errors.length, 0);
  assert.equal(out.rows[0].contractor_email, 'jane@x.com', 'must bind to Email, not the display name');
  assert.equal(out.rows[0].project, 'Website rebuild');
  assert.equal(minutesOf(out.rows[0]), 210);
  // Contractor is listed too: Email already claimed the person, so the display
  // name is surplus. Saying so beats silently dropping a column.
  assert.deepEqual(Array.from(out.unmapped), ['Contractor', 'Code', 'Status']);
});

test('a warning about day/month only fires for rows that survived', () => {
  // A slash date on a row that was rejected anyway sends people hunting for a
  // problem that isn't in the import.
  const out = buildImportRows('Date,Hours\n24/08/2026,\n2026-08-25,2');
  assert.equal(out.slashDates, false);
});

test('slash dates anywhere in the paste raise the day/month flag', () => {
  assert.equal(buildImportRows('Date,Hours\n2026-08-24,2').slashDates, false);
  assert.equal(buildImportRows('Date,Hours\n24/08/2026,2').slashDates, true);
});

test('a headerless paste falls back to the export column order', () => {
  const out = buildImportRows('2026-08-24,Jane Doe,jane@x.com,Website,WEB,Funnel report,09:00,12:30,3.5,unapproved');
  assert.equal(out.rows.length, 1);
  assert.equal(out.rows[0].work_date, '2026-08-24');
  assert.equal(out.rows[0].contractor_email, 'jane@x.com');
  assert.equal(out.rows[0].project, 'Website');
  assert.equal(minutesOf(out.rows[0]), 210);
});

// ═══════════════════════════════════════════
// SERVER-SIDE ROW VALIDATION
// ═══════════════════════════════════════════
console.log('\nserver row validation');

process.env.NETLIFY_DATABASE_URL = 'postgres://unused';
const { __test } = require(path.join(root, 'netlify/functions/time-tracking.js'));
const { validateImportRow, resolveProject, namesSomeoneElse, roundBillableMinutes, MAX_MINUTES } = __test;

const PROJECTS = new Map([
  ['c:web', { id: 7, name: 'Website rebuild', code: 'WEB', is_active: true }],
  ['n:website rebuild', { id: 7, name: 'Website rebuild', code: 'WEB', is_active: true }],
  ['n:old thing', { id: 9, name: 'Old thing', code: null, is_active: false }]
]);
const SELF = { id: 1, email: 'jake@example.com', full_name: 'Jake', is_active: true };
const MATE = { id: 2, email: 'sam@example.com', full_name: 'Sam', is_active: true };
const GONE = { id: 3, email: 'ex@example.com', full_name: 'Ex', is_active: false };
const PEOPLE = new Map([['sam@example.com', MATE], ['ex@example.com', GONE], ['jake@example.com', SELF]]);

const ctxFor = (isManager) => ({ self: SELF, byKey: PROJECTS, byEmail: PEOPLE, isManager });
const row = (over) => ({
  work_date: '2026-08-24',
  started_at: '2026-08-24T09:00:00.000Z',
  ended_at: '2026-08-24T12:00:00.000Z',
  project: 'WEB',
  ...over
});

test('a good row resolves its project and lands on the caller', () => {
  const out = validateImportRow(row(), ctxFor(false));
  assert.equal(out.contractor_id, 1);
  assert.equal(out.project_id, 7);
  assert.equal(out.minutes, 180);
  assert.equal(out.source, undefined, 'source is set at insert time, not here');
});

// ═══════════════════════════════════════════
// QUARTER-HOUR ROUNDING — of TOTALS, not entries
// ═══════════════════════════════════════════
console.log('\nquarter-hour rounding (totals)');

test('exact quarters are left alone', () => {
  [15, 30, 45, 60, 90, 480, 945].forEach((m) => assert.equal(roundBillableMinutes(m), m));
});

test('rounds to the NEAREST quarter, not up and not down', () => {
  assert.equal(roundBillableMinutes(22), 15, '22 min is nearer 15 than 30');
  assert.equal(roundBillableMinutes(23), 30, '23 min is nearer 30 than 15');
  assert.equal(roundBillableMinutes(52), 45);
  assert.equal(roundBillableMinutes(53), 60);
});

test('a half-quarter goes up', () => {
  assert.equal(roundBillableMinutes(37.5), 45);
});

test('zero stays zero — an empty week is not a quarter of an hour', () => {
  assert.equal(roundBillableMinutes(0), 0);
  assert.equal(roundBillableMinutes(null), 0);
  assert.equal(roundBillableMinutes(-5), 0);
});

test('but any real total bills at least a quarter', () => {
  assert.equal(roundBillableMinutes(1), 15);
  assert.equal(roundBillableMinutes(7), 15);
});

test('no 24h cap — this rounds a period, not an entry', () => {
  // A week's total is expected to exceed MAX_MINUTES; capping it would silently
  // truncate anyone working more than a single day in the period.
  assert.equal(roundBillableMinutes(MAX_MINUTES * 3), MAX_MINUTES * 3);
  assert.equal(roundBillableMinutes(2402), 2400);
});

test('rounding the total beats rounding each entry — the regression this fixes', () => {
  // Reconstructs the reported case: a fortnight of 14 entries totalling 938
  // minutes (15.63 h). Rounded individually and then summed they came to 915
  // (15.25 h) — 23 minutes of worked time lost to accumulated rounding. What 938
  // minutes actually rounds to is 945 (15.75 h), and that is now what bills.
  const perEntry = (m) => Math.max(15, Math.round(m / 15) * 15);
  const entries = [52, 52, 52, 62, 75, 75, 75, 75, 75, 75, 75, 75, 60, 60];
  const raw = entries.reduce((a, b) => a + b, 0);
  assert.equal(entries.length, 14);
  assert.equal(raw, 938, 'fixture must reproduce the reported total');
  assert.equal(entries.map(perEntry).reduce((a, b) => a + b, 0), 915, 'the old behaviour');
  assert.equal(roundBillableMinutes(raw), 945, 'what 938 minutes actually rounds to');
});

test('the loss from per-entry rounding grows with the entry count', () => {
  // Why this is a design flaw and not a rounding curiosity: each entry can lose
  // up to 7 minutes, and nothing brings them back.
  const perEntry = (m) => Math.max(15, Math.round(m / 15) * 15);
  const drift = (n) => {
    const es = Array.from({ length: n }, () => 22);          // each loses 7
    const raw = es.reduce((a, b) => a + b, 0);
    return es.map(perEntry).reduce((a, b) => a + b, 0) - roundBillableMinutes(raw);
  };
  assert.ok(Math.abs(drift(40)) > Math.abs(drift(10)), 'more entries, more drift');
});

test('an imported row is stored EXACT — rounding is not its job', () => {
  // 09:00 → 12:07 is 187 minutes on the clock and 187 in the database.
  const out = validateImportRow(row({ ended_at: '2026-08-24T12:07:00.000Z' }), ctxFor(false));
  assert.equal(out.minutes, 187);
  assert.equal(out.ended_at, '2026-08-24T12:07:00.000Z');
});

test('a 2-minute import row keeps its 2 minutes', () => {
  const out = validateImportRow(row({ ended_at: '2026-08-24T09:02:00.000Z' }), ctxFor(false));
  assert.equal(out.minutes, 2);
});

test('a zero-length row is still refused', () => {
  assert.throws(() => validateImportRow(row({ ended_at: row().started_at }), ctxFor(false)),
    /not after the start/);
});

test('a project matches on code or on name, case-insensitively', () => {
  assert.equal(resolveProject(PROJECTS, 'web').id, 7);
  assert.equal(resolveProject(PROJECTS, 'Website Rebuild').id, 7);
  assert.equal(resolveProject(PROJECTS, '').id, null, 'no project is allowed');
});

test('an unknown project names itself in the error', () => {
  assert.throws(() => resolveProject(PROJECTS, 'Wbe'), /no project called "Wbe"/);
});

test('an archived project is refused rather than quietly revived', () => {
  assert.throws(() => resolveProject(PROJECTS, 'Old thing'), /archived/);
});

test('a contractor cannot import onto anyone else, whatever the sheet says', () => {
  assert.throws(
    () => validateImportRow(row({ contractor_email: 'sam@example.com' }), ctxFor(false)),
    /only import your own time/
  );
});

test('a manager can, and the row lands on that person', () => {
  const out = validateImportRow(row({ contractor_email: 'sam@example.com' }), ctxFor(true));
  assert.equal(out.contractor_id, 2);
  assert.equal(out.contractor_name, 'Sam');
});

test('a contractor naming their own email is fine, not an escalation', () => {
  const out = validateImportRow(row({ contractor_email: 'JAKE@example.com' }), ctxFor(false));
  assert.equal(out.contractor_id, 1);
  assert.equal(namesSomeoneElse('jake@example.com', ctxFor(false)), false);
});

test('an unknown email is refused rather than creating a contractor', () => {
  assert.throws(
    () => validateImportRow(row({ contractor_email: 'nobody@example.com' }), ctxFor(true)),
    /no contractor with the email/
  );
});

test('a deactivated person cannot be imported onto', () => {
  assert.throws(
    () => validateImportRow(row({ contractor_email: 'ex@example.com' }), ctxFor(true)),
    /deactivated/
  );
});

test('a backwards or zero-length row is refused', () => {
  assert.throws(() => validateImportRow(row({ ended_at: '2026-08-24T09:00:00.000Z' }), ctxFor(false)),
    /not after the start/);
});

test('a row longer than a day is refused — that is the DB constraint too', () => {
  assert.throws(() => validateImportRow(row({ ended_at: '2026-08-26T09:00:00.000Z' }), ctxFor(false)),
    /longer than 24 hours/);
});

test('a bad date is refused', () => {
  assert.throws(() => validateImportRow(row({ work_date: 'someday' }), ctxFor(false)), /Invalid date/);
});

console.log(`\n${passed}/${passed + failed} passed`);
if (failed) process.exit(1);

/**
 * Boots the real time-tracking page in Chromium against a stubbed API, signs in
 * as a manager, and checks the Team view shows hours per brand — then shoots the
 * roster and the entries modal.
 */
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
const PAGE = new URL('../time-tracking/index.html', import.meta.url).href;
const SHOT = process.argv[2];   // optional directory to drop screenshots into

const day = (n) => `2026-09-${String(n).padStart(2, '0')}`;
let id = 0;
// `brand` is what the server resolved; `entry_brand` is the raw override, set
// only when the work diverged from its project's brand.
const entry = (contractor_id, brand, project, d, mins, locked = false, entry_brand = null) => ({
  id: ++id, contractor_id, project_id: 1, project_name: project,
  project_brand: entry_brand ? 'Pacific Discovery' : brand, entry_brand, brand,
  work_date: d, started_at: `${d}T09:00:00Z`,
  ended_at: `${d}T${String(9 + Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}:00Z`,
  minutes: mins, description: null, source: 'timer', locked, approval_id: locked ? 7 : null,
});

const ENTRIES = [
  entry(1, 'Pacific Discovery', 'Website rebuild',     day(14), 195),
  entry(1, 'Pacific Discovery', 'Website rebuild',     day(15), 142),
  entry(1, 'Unearthed Education', 'Leader portal',     day(15), 128),
  entry(1, 'EDA Group', 'Cash forecast',               day(16),  97),
  entry(1, null, 'Admin catch-up',                     day(17),  38),
  // Booked off a Pacific Discovery project onto Unearthed — the shared-project case.
  entry(1, 'Unearthed Education', 'Website rebuild',   day(18),  60, false, 'Unearthed Education'),
  entry(2, 'Pure Exploration', 'Trip logistics',       day(14), 240, true),
  entry(2, 'Pure Exploration', 'Trip logistics',       day(16), 115),
  entry(2, 'Conference', 'Booth build',                day(17),  90),
];

// A project per shape: single-brand, a different brand, and the one that gets
// shared across brands.
const PROJECTS = [
  { id: 1, name: 'Website rebuild', code: 'WEB', brand: 'Pacific Discovery', is_active: true, sort_order: 10 },
  { id: 2, name: 'Leader portal', code: 'LEAD', brand: 'Unearthed Education', is_active: true, sort_order: 20 },
  { id: 3, name: 'Housekeeping', code: 'ADMIN', brand: null, is_active: true, sort_order: 30 },
];

const ROUTES = {
  me: { contractor: { id: 9, email: 'jake@boulderdigitalmedia.com', full_name: 'Jake' }, isManager: true,
        currencies: ['NZD', 'USD'], projects: PROJECTS, running: null, serverNow: new Date().toISOString() },
  contractors: { from: day(14), to: day(20), contractors: [
    { id: 1, email: 'sam@example.com', full_name: 'Sam Rivers', hourly_rate: 45, currency: 'NZD',
      vendor_name: '', is_active: true, period_minutes: 660, period_minutes_exact: 660,
      unapproved_minutes: 660, last_logged: day(18), timer_running: false },
    // No name yet — the state every contractor row starts in, and the one the
    // Approved timesheets table falls back to showing a raw email for.
    { id: 2, email: 'ana@example.com', full_name: null, hourly_rate: null, currency: 'NZD',
      vendor_name: 'Mercer Ltd', is_active: true, period_minutes: 445, period_minutes_exact: 445,
      unapproved_minutes: 205, last_logged: day(17), timer_running: true },
  ] },
  entries: { entries: ENTRIES, from: day(14), to: day(20), contractor_id: 'all' },
  approvals: { approvals: [
    // 22.25 h approved at 42.50/h = 945.63 — the shape payroll actually sees.
    { id: 31, contractor_id: 1, contractor_email: 'outreach@pacificdiscovery.org', contractor_name: null,
      period_start: day(7), period_end: day(13), total_minutes: 1335, hourly_rate: 42.5, currency: 'NZD',
      amount: 945.63, approved_by: 'director@pacificdiscovery.org', payment_id: null, paid: null,
      brand_minutes: [{ brand: 'Pacific Discovery', minutes: 1125 }, { brand: 'Unearthed Education', minutes: 185 },
                      { brand: '', minutes: 25 }] },
    // Approved before a rate was set — hours split, money can't yet.
    { id: 32, contractor_id: 2, contractor_email: 'operations@unearthededucation.org', contractor_name: 'Ana Mercer',
      period_start: day(7), period_end: day(13), total_minutes: 930, hourly_rate: null, currency: 'NZD',
      amount: null, approved_by: 'generalmanager@unearthededucation.org', payment_id: null, paid: null,
      brand_minutes: [{ brand: 'Unearthed Education', minutes: 930 }] },
  ] },
  projects: { projects: PROJECTS },
};

// PW_CHROMIUM lets a sandbox point at a Chromium it already has, instead of
// having `playwright install` fetch a second copy.
const browser = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
page.on('pageerror', (e) => { console.error('PAGE ERROR:', e.message); process.exitCode = 1; });

// Netlify Identity never loads offline — stand in a manager who is already signed in.
await page.addInitScript(() => {
  const handlers = {};
  window.netlifyIdentity = {
    on: (ev, fn) => { handlers[ev] = fn; },
    init: () => setTimeout(() => handlers.init && handlers.init({ jwt: async () => 'stub' }), 0),
    open: () => {}, close: () => {}, logout: () => {},
  };
});
await page.route('**/api/time-tracking*', (route) => {
  const action = new URL(route.request().url()).searchParams.get('action');
  route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(ROUTES[action] || {}) });
});
await page.route('**/netlify-identity-widget.js', (r) => r.fulfill({ status: 200, contentType: 'application/javascript', body: '' }));
await page.route('**/cdn.tailwindcss.com*', (r) => r.continue());

await page.goto(PAGE);
await page.waitForSelector('#tab-team:not(.hidden)', { timeout: 15000 });
await page.click('#tab-team');
await page.waitForSelector('#view-team tr.brand-row', { timeout: 15000 });

// --- the roster now answers "how many hours for each brand"
const chips = await page.$$eval('#team-rows tr.brand-row .bchip',
  (els) => els.map((e) => e.textContent.replace(/\s+/g, ' ').trim()));
console.log('roster chips:\n  ' + chips.join('\n  '));
assert.ok(chips.some((t) => /^Pacific Discovery 5\.62 h$/.test(t)), 'PD total (195+142 = 337 min = 5.62 h)');
assert.ok(chips.some((t) => /^Unearthed Education 3\.13 h$/.test(t)),
  'UE total includes the hour booked off a Pacific Discovery project');
assert.ok(chips.some((t) => /^EDA Group 1\.62 h$/.test(t)), 'EDA total');
assert.ok(chips.some((t) => /^Unassigned 0\.63 h$/.test(t)), 'unbranded time is visible, not dropped');
assert.ok(chips.some((t) => /^Pure Exploration 5\.92 h 1\.92 to approve$/.test(t)),
  'partly-approved brand calls out what is still to approve');

// brand rows sit under the right contractor and every finished minute is accounted for
// Matched on the email, not the name: the name is an editable input now, and an
// input's value is not text content.
for (const [who, mins] of [['sam@example.com', 660], ['ana@example.com', 445]]) {
  const row = page.locator('#team-rows tr.has-brands', { hasText: who });
  const sum = await row.locator('xpath=following-sibling::tr[1]').locator('.bchip b')
    .evaluateAll((els) => els.reduce((s, e) => s + Math.round(parseFloat(e.textContent) * 60), 0));
  assert.equal(sum, mins, `${who}: brand subtotals must account for all ${mins} worked minutes`);
}
if (SHOT) await page.locator('#view-team > div').first().screenshot({ path: `${SHOT}/roster.png` });

// --- the entries modal, grouped by brand
await page.locator('#team-rows tr', { hasText: 'sam@example.com' }).getByRole('button', { name: 'entries' }).click();
await page.waitForSelector('.modal tr.bgrp');
const groups = await page.$$eval('.modal tr.bgrp', (els) => els.map((e) => ({
  brand: e.querySelector('.bgrp-name').childNodes[1].textContent.trim(),
  subtotal: e.children[1].textContent.trim(),
  state: e.children[2].textContent.trim(),
})));
console.log('modal groups:\n  ' + groups.map((g) => `${g.brand} — ${g.subtotal} h (${g.state})`).join('\n  '));
assert.deepEqual(groups.map((g) => g.brand),
  ['EDA Group', 'Unearthed Education', 'Pacific Discovery', 'Unassigned'], 'declared order first, Unassigned last');
assert.equal(groups.find((g) => g.brand === 'Pacific Discovery').subtotal, '5.62',
  'each group carries its own subtotal — and the overridden hour is NOT in it');
assert.equal(groups.find((g) => g.brand === 'Unearthed Education').subtotal, '3.13',
  'the overridden hour counts towards the brand it was booked to, not its project');

// every entry row is filed under exactly one brand group — none stranded
const groupRows = await page.$$eval('.modal tbody tr', (els) => els.filter((e) => !e.classList.contains('bgrp')).length);
assert.equal(groupRows, 6, 'all six of this contractor\'s entries are listed under a brand');
const footTotal = await page.$eval('.modal tfoot td:nth-child(2)', (e) => e.textContent.trim());
assert.equal(footTotal, '11.00', 'footer total matches the 660 worked minutes');
if (SHOT) await page.locator('.modal').screenshot({ path: `${SHOT}/modal.png` });
await page.locator('.modal').getByRole('button', { name: 'Close' }).click();

// --- Approved timesheets: what payroll reads
const payout = await page.$$eval('#appr-rows tr.brand-row .bchip',
  (els) => els.map((e) => e.textContent.replace(/\s+/g, ' ').trim()));
console.log('approved-timesheet chips:\n  ' + payout.join('\n  '));
assert.ok(payout.some((t) => /^Pacific Discovery 18\.75 h 796\.88 NZD$/.test(t)), 'PD hours and its share of the payout');
assert.ok(payout.some((t) => /^Unassigned 0\.42 h [\d.]+ NZD$/.test(t)), 'unbranded time is visible to payroll too');
assert.ok(payout.some((t) => /^Unearthed Education 15\.50 h$/.test(t)), 'an unrated timesheet shows hours and no money');

// the allocated shares reconcile to the approved amount, to the cent
const paid = await page.$$eval('#appr-rows tr', (rows) => {
  const out = [];
  for (let i = 0; i < rows.length; i++) {
    if (!rows[i].classList.contains('has-brands')) continue;
    const total = rows[i].children[3].textContent.trim();
    const shares = [...rows[i + 1].querySelectorAll('.bchip-amt')].map((e) => parseFloat(e.textContent));
    out.push({ total, shares });
  }
  return out;
});
const money = paid.find((r) => r.total.startsWith('945.63'));
assert.equal(Math.round(money.shares.reduce((s, n) => s + n, 0) * 100), 94563,
  'per-brand amounts must sum exactly to the approved payout');
const unrated = paid.find((r) => r.total.includes('no rate'));
assert.deepEqual(unrated.shares, [], 'no rate ⇒ no invented per-brand amounts');
if (SHOT) await page.locator('#view-team > div').nth(1).screenshot({ path: `${SHOT}/approved.png` });

// --- an admin can put a name on an email address
const nameField = page.locator('#team-rows tr', { hasText: 'sam@example.com' }).locator('input').first();
assert.equal(await nameField.inputValue(), 'Sam Rivers', 'an existing name shows in the field');
const blank = page.locator('#team-rows tr', { hasText: 'ana@example.com' }).locator('input').first();
assert.equal(await blank.getAttribute('placeholder'), 'ana@example.com',
  'with no name set the field falls back to showing the email');
const patched = page.waitForRequest(
  (r) => r.method() === 'POST' && /action=save-contractor/.test(r.url()), { timeout: 10000 });
await blank.fill('Ana Mercer');
await blank.blur();
assert.deepEqual(JSON.parse((await patched).postData()), { id: 2, patch: { full_name: 'Ana Mercer' } },
  'editing the field patches full_name for that contractor');

// --- the CSV export carries the brand
const csv = await page.evaluate(async () => {
  // Capture the blob and neuter the anchor click: an actual download would just
  // hang a headless browser with nowhere to put the file.
  const realCreate = URL.createObjectURL, realClick = HTMLAnchorElement.prototype.click;
  let blob = null;
  URL.createObjectURL = (b) => { blob = b; return 'blob:stub'; };
  URL.revokeObjectURL = () => {};
  HTMLAnchorElement.prototype.click = function () {};
  try { document.getElementById('btn-csv').click(); }
  finally { URL.createObjectURL = realCreate; HTMLAnchorElement.prototype.click = realClick; }
  return blob ? blob.text() : '';
});
const [head, ...body] = csv.replace(/^\uFEFF/, '').split('\r\n');
assert.equal(head.split(',').pop(), 'Brand', 'Brand is the LAST column — a header-less re-import reads by position');
assert.deepEqual(head.split(',').slice(0, 10),
  ['Date', 'Contractor', 'Email', 'Project', 'Code', 'Description', 'Started', 'Finished', 'Hours', 'Status'],
  'the original ten columns keep their positions, so Bulk import still reads them');
assert.ok(body.some((r) => r.endsWith(',Pacific Discovery')), 'rows carry their brand');
assert.ok(body.some((r) => r.endsWith(',Unassigned')), 'unbranded rows say so rather than ending blank');

// --- the timer: a brand comes along with the project, and can be changed
await page.click('#tab-week');
if (SHOT) await page.locator('#timer-inputs').screenshot({ path: `${SHOT}/timer.png` });
const brandSel = page.locator('#t-brand');
await page.selectOption('#t-project', '1');
assert.equal(await brandSel.inputValue(), 'Pacific Discovery',
  'picking a project fills its brand in — nobody has to think about this field');
assert.ok((await brandSel.locator('option:checked').textContent()).includes('(project default)'),
  'and it says where that came from');
await page.selectOption('#t-project', '2');
assert.equal(await brandSel.inputValue(), 'Unearthed Education', 'changing project re-defaults the brand');
await page.selectOption('#t-project', '3');
assert.equal(await brandSel.inputValue(), '', 'a project with no brand defaults to unassigned');

const opts = await brandSel.locator('option').evaluateAll((els) => els.map((e) => e.value));
assert.ok(opts.includes('Pacific Discovery') && opts.includes('Unearthed Education'),
  'every brand in use is selectable');

// the shared-project case: pick a project, then book it to a different brand
await page.selectOption('#t-project', '1');
await page.selectOption('#t-brand', 'Unearthed Education');
const started = page.waitForRequest((r) => r.method() === 'POST' && /action=start/.test(r.url()), { timeout: 10000 });
await page.route('**/api/time-tracking?action=start*', (route) => route.fulfill({
  status: 200, contentType: 'application/json', body: JSON.stringify({ running: null, started: true }) }));
await page.click('#btn-start');
const sent = JSON.parse((await started).postData());
assert.equal(sent.project_id, '1');
assert.equal(sent.brand, 'Unearthed Education',
  'the brand the person picked is what gets sent, not the project\'s');
if (SHOT) await page.locator('#timer-inputs').screenshot({ path: `${SHOT}/timer-override.png` });

await browser.close();
console.log('\nteam brand view: all checks passed');

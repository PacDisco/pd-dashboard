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
const entry = (contractor_id, brand, project, d, mins, locked = false) => ({
  id: ++id, contractor_id, project_id: 1, project_name: project, project_brand: brand,
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
  entry(2, 'Pure Exploration', 'Trip logistics',       day(14), 240, true),
  entry(2, 'Pure Exploration', 'Trip logistics',       day(16), 115),
  entry(2, 'Conference', 'Booth build',                day(17),  90),
];

const ROUTES = {
  me: { contractor: { id: 9, email: 'jake@boulderdigitalmedia.com', full_name: 'Jake' }, isManager: true,
        currencies: ['NZD', 'USD'], projects: [], running: null, serverNow: new Date().toISOString() },
  contractors: { from: day(14), to: day(20), contractors: [
    { id: 1, email: 'sam@example.com', full_name: 'Sam Rivers', hourly_rate: 45, currency: 'NZD',
      vendor_name: '', is_active: true, period_minutes: 600, period_minutes_exact: 600,
      unapproved_minutes: 600, last_logged: day(17), timer_running: false },
    { id: 2, email: 'ana@example.com', full_name: 'Ana Mercer', hourly_rate: null, currency: 'NZD',
      vendor_name: 'Mercer Ltd', is_active: true, period_minutes: 445, period_minutes_exact: 445,
      unapproved_minutes: 205, last_logged: day(17), timer_running: true },
  ] },
  entries: { entries: ENTRIES, from: day(14), to: day(20), contractor_id: 'all' },
  approvals: { approvals: [] },
  projects: { projects: [] },
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
assert.ok(chips.some((t) => /^Unearthed Education 2\.13 h$/.test(t)), 'UE total');
assert.ok(chips.some((t) => /^EDA Group 1\.62 h$/.test(t)), 'EDA total');
assert.ok(chips.some((t) => /^Unassigned 0\.63 h$/.test(t)), 'unbranded time is visible, not dropped');
assert.ok(chips.some((t) => /^Pure Exploration 5\.92 h 1\.92 to approve$/.test(t)),
  'partly-approved brand calls out what is still to approve');

// brand rows sit under the right contractor and every finished minute is accounted for
for (const [name, mins] of [['Sam Rivers', 600], ['Ana Mercer', 445]]) {
  const row = page.locator('#team-rows tr.has-brands', { hasText: name });
  const sum = await row.locator('xpath=following-sibling::tr[1]').locator('.bchip b')
    .evaluateAll((els) => els.reduce((s, e) => s + Math.round(parseFloat(e.textContent) * 60), 0));
  assert.equal(sum, mins, `${name}: brand subtotals must account for all ${mins} worked minutes`);
}
if (SHOT) await page.locator('#view-team > div').first().screenshot({ path: `${SHOT}/roster.png` });

// --- the entries modal, grouped by brand
await page.locator('#team-rows tr', { hasText: 'Sam Rivers' }).getByRole('button', { name: 'entries' }).click();
await page.waitForSelector('.modal tr.bgrp');
const groups = await page.$$eval('.modal tr.bgrp', (els) => els.map((e) => ({
  brand: e.querySelector('.bgrp-name').childNodes[1].textContent.trim(),
  subtotal: e.children[1].textContent.trim(),
  state: e.children[2].textContent.trim(),
})));
console.log('modal groups:\n  ' + groups.map((g) => `${g.brand} — ${g.subtotal} h (${g.state})`).join('\n  '));
assert.deepEqual(groups.map((g) => g.brand),
  ['EDA Group', 'Unearthed Education', 'Pacific Discovery', 'Unassigned'], 'declared order first, Unassigned last');
assert.equal(groups.find((g) => g.brand === 'Pacific Discovery').subtotal, '5.62', 'each group carries its own subtotal');

// every entry row is filed under exactly one brand group — none stranded
const groupRows = await page.$$eval('.modal tbody tr', (els) => els.filter((e) => !e.classList.contains('bgrp')).length);
assert.equal(groupRows, 5, 'all five of this contractor\'s entries are listed under a brand');
const footTotal = await page.$eval('.modal tfoot td:nth-child(2)', (e) => e.textContent.trim());
assert.equal(footTotal, '10.00', 'footer total matches the 600 worked minutes');
if (SHOT) await page.locator('.modal').screenshot({ path: `${SHOT}/modal.png` });

await browser.close();
console.log('\nteam brand view: all checks passed');

/**
 * Smoke test for dropped students on the Enrollment dashboard.
 *
 * Runs the real enrollment/index.html in headless Chromium against a mocked
 * /api/enrollment and /api/enrollment-status, and asserts the behaviour that
 * would actually break in production:
 *
 *   - the Status column offers "Mark dropped", and a dropped student shows the
 *     badge, the reason and a muted row
 *   - the headcount card and the season tab badge exclude dropped students
 *     while Total Amount and Total Paid still include them
 *   - the popup refuses to save a drop with no reason, before any POST
 *   - a successful drop updates the badge, the cards and the tab badge without
 *     a page reload, and keeps the user on the tab they were looking at
 *   - putting a student back reverses all of it
 *   - a rejected save (no permission) is shown and changes nothing
 *
 * Usage:  node test/drop-student.smoke.mjs
 * Requires: playwright (chromium). Skips with a clear message if unavailable.
 */

import http from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  console.log('SKIP: playwright is not installed — run `npm i -D playwright` to enable this test.');
  process.exit(0);
}

// ═══════════════════════════════════════════
// FIXTURES
// ═══════════════════════════════════════════
const deal = (over) => Object.assign({
  id: '1',
  studentName: 'Student One',
  pdProgram: 'Australia & Bali Semester',
  pipeline: 'Fall Semester',
  season: 'Fall',
  travelYear: '2026',
  stage: 'Closed Won',
  amount: 15500,
  totalPaid: 15500,
  excludeFromCount: false,
  dropped: false,
  dropReason: '',
  droppedBy: '',
  droppedAt: '',
  hubspotUrl: 'https://example.invalid/deal/1',
  shirtSize: 'M',
  shirtSizeRaw: 'Medium',
  shirtSizeSource: 'application',
  shippingAddress: null,
  shippingAddressSource: '',
  shippingAddressComplete: false,
  applicationSubmittedAt: '',
  contacts: [],
  contactEmails: []
}, over);

const DEALS = [
  deal({ id: '101', studentName: 'Alex Channing' }),
  deal({ id: '102', studentName: 'Chloe Moore', totalPaid: 17750 }),
  // Already dropped when the page loads.
  deal({
    id: '103', studentName: 'Delaney Hixon', dropped: true,
    dropReason: 'Withdrew for medical reasons',
    droppedBy: 'Jake', droppedAt: '2026-08-20T02:00:00.000Z'
  }),
  deal({ id: '104', studentName: 'Ella Glave' })
];

// 4 deals, 1 already dropped → 3 students; money counts all four.
const AMOUNT = DEALS.reduce((s, d) => s + d.amount, 0);
const PAID = DEALS.reduce((s, d) => s + d.totalPaid, 0);

const ENROLLMENT = {
  updatedAt: new Date('2026-08-22T00:00:00Z').toISOString(),
  totalStudents: 3,
  totalAmount: AMOUNT,
  totalPaid: PAID,
  outstanding: AMOUNT - PAID,
  droppedStudents: 1,
  dropsAvailable: true,
  dropsError: '',
  currentTabs: [{
    key: 'Fall 2026', season: 'Fall', year: '2026',
    deals: DEALS, countedDeals: 3, droppedDeals: 1
  }],
  pastTabs: [],
  propertyOptions: { insurance_policy: [] },
  shirtSizeOptions: [{ code: 'M', label: 'M (Medium)' }],
  shirtCountryOptions: [{ code: 'US', name: 'United States' }],
  applicationLookupOk: true
};

// ═══════════════════════════════════════════
// MOCK SERVER
// ═══════════════════════════════════════════
const posted = [];
let failNextPost = null;

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const send = (status, obj) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(obj));
  };

  if (url.pathname === '/api/enrollment') return send(200, ENROLLMENT);

  // The T-shirt column loads separately; keep it quiet and out of the way.
  if (url.pathname === '/api/shirt-orders' && req.method === 'GET') {
    return send(200, { ok: true, product: null, ordersByDeal: {} });
  }

  if (url.pathname === '/api/enrollment-status' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const payload = JSON.parse(body || '{}');
      posted.push(payload);
      if (failNextPost) {
        const msg = failNextPost;
        failNextPost = null;
        return send(403, { error: msg });
      }
      const dropping = payload.action === 'drop';
      send(200, {
        ok: true,
        dealId: payload.dealId,
        action: payload.action,
        dropped: dropping,
        record: dropping ? {
          reason: payload.reason,
          droppedBy: 'Jake',
          droppedByEmail: 'jake@boulderdigitalmedia.com',
          droppedAt: '2026-08-22T03:00:00.000Z',
          studentName: payload.studentName
        } : null,
        warning: null
      });
    });
    return;
  }

  if (url.pathname === '/' || url.pathname === '/enrollment/' || url.pathname === '/enrollment/index.html') {
    const html = readFileSync(join(ROOT, 'enrollment', 'index.html'), 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end(html);
  }

  res.writeHead(404); res.end('not found');
});

await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;

// ═══════════════════════════════════════════
// TEST RUN
// ═══════════════════════════════════════════
const results = [];
const check = (name, fn) => {
  try { fn(); results.push(['PASS', name]); }
  catch (err) { results.push(['FAIL', `${name} — ${err.message}`]); }
};

let browser;
try {
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    args: ['--no-sandbox']
  });
} catch (err) {
  console.log(`SKIP: could not launch Chromium (${err.message})`);
  server.close();
  process.exit(0);
}

const page = await browser.newPage();
const consoleErrors = [];
page.on('pageerror', (e) => consoleErrors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });

let tailwindCss = '';
try { tailwindCss = readFileSync(process.env.TAILWIND_CSS || '/tmp/tailwind.min.css', 'utf8'); } catch {}
await page.route('**/tailwind*.css', (r) => r.fulfill({ status: 200, contentType: 'text/css', body: tailwindCss }));

await page.goto(`${base}/enrollment/index.html`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#dashboard:not(.hidden)', { timeout: 15000 });

const rowFor = async (name) => {
  const rows = await page.$$('table[data-table]:first-of-type tbody tr.data-row');
  for (const r of rows) {
    const txt = await r.$eval('td:first-child', (td) => td.textContent.trim());
    if (txt === name) return r;
  }
  throw new Error(`row not found: ${name}`);
};

const statusText = async (name) =>
  (await (await rowFor(name)).$eval('td.status-cell', (td) => td.textContent.trim()));

// The first sub-tab's summary cards ("All"), which is what the user sees first.
const cards = () => page.$eval('.sub-tab-content:not(.hidden)', (el) => {
  const vals = Array.from(el.querySelectorAll('.grid > div')).map((d) => d.textContent.trim());
  return vals;
});
const tabBadge = () => page.$eval('.tab-btn', (b) => b.textContent.trim());

// ── 1. Initial render ──────────────────────────────────────────────────
const alexStatus = await statusText('Alex Channing');
const delaneyStatus = await statusText('Delaney Hixon');

check('an active student is offered the Mark dropped button', () => {
  assert.match(alexStatus, /Mark dropped/);
});
check('a dropped student shows the Dropped badge instead', () => {
  assert.match(delaneyStatus, /Dropped/);
  assert.doesNotMatch(delaneyStatus, /Mark dropped/);
});

const delaneyTip = await (await rowFor('Delaney Hixon'))
  .$eval('td.status-cell button', (b) => b.getAttribute('title'));
check('the badge carries the reason, who marked it and the counting rule', () => {
  assert.match(delaneyTip, /Withdrew for medical reasons/);
  assert.match(delaneyTip, /Jake/);
  assert.match(delaneyTip, /still count/i);
});

const delaneyRowClass = await (await rowFor('Delaney Hixon')).getAttribute('class');
check('the dropped row is visually distinguished', () => {
  assert.match(delaneyRowClass, /dropped-row/);
});

const delaneyStillListed = Boolean(await rowFor('Delaney Hixon'));
check('the dropped student keeps their row — dropping is not deleting', () => {
  assert.equal(delaneyStillListed, true);
});

const initialCards = await cards();
check('the headcount card excludes the dropped student', () => {
  assert.match(initialCards[0], /Total Students3/);
});
check('the money cards still include the dropped student', () => {
  assert.match(initialCards[1], /\$62,000\.00/); // 4 × 15,500
  assert.match(initialCards[2], /\$64,250\.00/); // includes Delaney's 15,500
});
check('the headcount card explains where the missing student went', () => {
  assert.match(initialCards[0], /1 dropped/);
});
const initialBadge = await tabBadge();
check('the season tab badge counts students, not dropped students', () => {
  assert.match(initialBadge, /Fall 2026\s*3/);
});

const subtitle = await page.$eval('#subtitle', (el) => el.textContent);
check('the subtitle names the drops rather than leaving the numbers unexplained', () => {
  assert.match(subtitle, /1 dropped/);
});

// ── 2. A drop with no reason is refused before any POST ────────────────
await (await rowFor('Alex Channing')).$eval('td.status-cell button', (b) => b.click());
await page.waitForSelector('#drop-modal:not(.hidden)');

const modalSub = await page.$eval('#drop-modal-sub', (el) => el.textContent);
check('the popup names the student it is about to drop', () => {
  assert.match(modalSub, /Alex Channing/);
});

await page.click('#drop-submit');
const emptyErr = await page.$eval('#drop-error', (el) => ({ hidden: el.classList.contains('hidden'), text: el.textContent }));
check('an empty reason is refused in the popup', () => {
  assert.equal(emptyErr.hidden, false);
  assert.match(emptyErr.text, /reason/i);
});
check('nothing was posted for the empty reason', () => {
  assert.equal(posted.length, 0);
});

// ── 3. A real drop ─────────────────────────────────────────────────────
await page.fill('#drop-reason', 'Deferred to Spring 2027');
await page.click('#drop-submit');
await page.waitForFunction(() => document.getElementById('drop-modal').classList.contains('hidden'));

check('the POST carries the deal, the action, the reason and the name', () => {
  assert.equal(posted.length, 1);
  assert.deepEqual(posted[0], {
    dealId: '101', action: 'drop', reason: 'Deferred to Spring 2027', studentName: 'Alex Channing'
  });
});

const alexAfter = await statusText('Alex Channing');
check('the row flips to Dropped without a page reload', () => {
  assert.match(alexAfter, /Dropped/);
});

const afterCards = await cards();
check('the headcount falls by one', () => {
  assert.match(afterCards[0], /Total Students2/);
});
check('Total Amount is unchanged by the drop', () => {
  assert.match(afterCards[1], /\$62,000\.00/);
});
check('Total Paid is unchanged by the drop', () => {
  assert.match(afterCards[2], /\$64,250\.00/);
});
const badgeAfterDrop = await tabBadge();
check('the tab badge follows the headcount', () => {
  assert.match(badgeAfterDrop, /Fall 2026\s*2/);
});
check('the dropped count on the card follows too', () => {
  assert.match(afterCards[0], /2 dropped/);
});

// ── 4. Putting a student back ──────────────────────────────────────────
await (await rowFor('Alex Channing')).$eval('td.status-cell button', (b) => b.click());
await page.waitForSelector('#drop-modal:not(.hidden)');

const reopened = await page.$eval('#drop-reason', (el) => el.value);
check('reopening a dropped student shows the reason already on file', () => {
  assert.equal(reopened, 'Deferred to Spring 2027');
});
const undoVisible = await page.$eval('#drop-undo', (el) => !el.classList.contains('hidden'));
check('a dropped student is offered the way back', () => {
  assert.equal(undoVisible, true);
});

await page.click('#drop-undo');
await page.waitForFunction(() => document.getElementById('drop-modal').classList.contains('hidden'));

check('the undo posts an undrop', () => {
  assert.equal(posted.length, 2);
  assert.equal(posted[1].action, 'undrop');
});

const restoredCards = await cards();
check('the student is back in the count', () => {
  assert.match(restoredCards[0], /Total Students3/);
});
check('the money never moved through either change', () => {
  assert.match(restoredCards[1], /\$62,000\.00/);
  assert.match(restoredCards[2], /\$64,250\.00/);
});
const alexRestored = await statusText('Alex Channing');
check('the restored row shows Mark dropped again', () => {
  assert.match(alexRestored, /Mark dropped/);
});

// ── 5. A refused save changes nothing ──────────────────────────────────
failNextPost = 'Marking a student dropped needs one of these roles: admin, operations, programs, admissions.';
await (await rowFor('Ella Glave')).$eval('td.status-cell button', (b) => b.click());
await page.waitForSelector('#drop-modal:not(.hidden)');
await page.fill('#drop-reason', 'Changed their mind');
await page.click('#drop-submit');
await page.waitForFunction(() => {
  const el = document.getElementById('drop-error');
  return el && !el.classList.contains('hidden');
});

const refusedErr = await page.$eval('#drop-error', (el) => el.textContent);
check("the server's reason for refusing is shown verbatim", () => {
  assert.match(refusedErr, /roles: admin, operations/);
});
const stillOpen = await page.$eval('#drop-modal', (el) => !el.classList.contains('hidden'));
check('the popup stays open so the attempt is not silently lost', () => {
  assert.equal(stillOpen, true);
});
const submitLive = await page.$eval('#drop-submit', (b) => !b.disabled && b.textContent.trim());
check('the button re-enables after a refusal', () => {
  assert.equal(submitLive, 'Mark as dropped');
});

// Close via the Cancel path rather than clicking the overlay: the overlay sits
// behind the dialog, so a synthetic click on it is intercepted by the body.
await page.evaluate(() => closeDropModal());
await page.waitForFunction(() => document.getElementById('drop-modal').classList.contains('hidden'));

const finalCards = await cards();
check('a refused drop left the counts alone', () => {
  assert.match(finalCards[0], /Total Students3/);
});
const ellaAfterRefusal = await statusText('Ella Glave');
check('a refused drop left the row alone', () => {
  assert.match(ellaAfterRefusal, /Mark dropped/);
});

// The deliberate 403 in section 5 makes Chromium log a resource-load error.
// That is the browser reporting the response we asked for, not a page fault.
const realErrors = consoleErrors.filter((e) => !/Failed to load resource/.test(e));
check('no uncaught JS errors during the whole run', () => {
  assert.deepEqual(realErrors, []);
});

// ═══════════════════════════════════════════
// REPORT
// ═══════════════════════════════════════════
await browser.close();
server.close();

let failed = 0;
for (const [status, name] of results) {
  if (status === 'PASS') console.log(`  ok   ${name}`);
  else { console.error(`  FAIL ${name}`); failed++; }
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);

/**
 * Smoke test for the Enrollment dashboard's T-shirt feature.
 *
 * Runs the real enrollment/index.html in headless Chromium against mocked
 * /api/enrollment and /api/shirt-orders responses, and asserts the things that
 * would actually break in production:
 *
 *   - the Shirt Size column renders sizes, provenance and blanks correctly
 *   - sorting by Shirt Size orders XS→3XL with "no size" last, and the money
 *     columns still sort numerically after the column insert
 *   - the Order T-Shirt popup pre-fills size + address from the application
 *   - the popup blocks submission when required address fields are missing
 *   - a successful POST flips the row to an "Ordered" badge
 *   - a student who already has an order sees the duplicate warning
 *
 * Usage:  node test/shirt-order.smoke.mjs
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
// FIXTURES — shaped exactly like the real payloads
// ═══════════════════════════════════════════
const deal = (over) => Object.assign({
  id: '1',
  studentName: 'Student One',
  pdProgram: 'Bali Summer Program',
  pipeline: 'Summer Program',
  season: 'Summer',
  travelYear: '2026',
  stage: 'Closed Won',
  amount: 5000,
  totalPaid: 5000,
  excludeFromCount: false,
  hubspotUrl: 'https://example.invalid/deal/1',
  shirtSize: null,
  shirtSizeRaw: '',
  shirtSizeSource: '',
  shippingAddress: null,
  shippingAddressSource: '',
  shippingAddressComplete: false,
  applicationSubmittedAt: '',
  contacts: [],
  contactEmails: []
}, over);

const FULL_ADDRESS = {
  address1: '586 Eastwood St',
  address2: '',
  city: 'Grand Junction',
  province: 'Colorado',
  zip: '81504',
  country: 'United States',
  countryCode: 'US',
  provinceCode: 'CO',
  phone: '+15551234567'
};

const DEALS = [
  deal({
    id: '101', studentName: 'Emma Lyons', shirtSize: 'M', shirtSizeRaw: 'Medium',
    shirtSizeSource: 'application', shippingAddress: FULL_ADDRESS,
    shippingAddressSource: 'application', shippingAddressComplete: true,
    amount: 5000, totalPaid: 5000,
    contacts: [
      { id: 'c1', name: 'Hannah Lyons', email: 'hlyons@fastmail.invalid', phone: '', hubspotUrl: '#' },
      { id: 'c2', name: 'Emma Lyons', email: 'lyonsemma403@example.invalid', phone: '555', hubspotUrl: '#' }
    ]
  }),
  deal({
    id: '102', studentName: 'Rachel Stern', shirtSize: '2XL', shirtSizeRaw: 'XX-large',
    shirtSizeSource: 'application', shippingAddress: FULL_ADDRESS,
    shippingAddressSource: 'application', shippingAddressComplete: true,
    amount: 3275, totalPaid: 3275,
    contacts: [{ id: 'c3', name: 'Rachel Stern', email: 'rachel@example.invalid', phone: '', hubspotUrl: '#' }]
  }),
  deal({
    id: '103', studentName: 'Nia Tomalin', shirtSize: 'XS', shirtSizeRaw: 'X-small',
    shirtSizeSource: 'application', shippingAddress: FULL_ADDRESS,
    shippingAddressSource: 'application', shippingAddressComplete: true,
    amount: 6550, totalPaid: 6550,
    contacts: [{ id: 'c4', name: 'Nia Tomalin', email: 'nia@example.invalid', phone: '', hubspotUrl: '#' }]
  }),
  // Size inherited from a parent's HubSpot record — must be flagged, not trusted.
  deal({
    id: '104', studentName: 'Ryan Little', shirtSize: 'L', shirtSizeRaw: 'Large',
    shirtSizeSource: 'hubspot contact', shippingAddress: FULL_ADDRESS,
    shippingAddressSource: 'hubspot contact (mailing)', shippingAddressComplete: true,
    amount: 7000, totalPaid: 7000,
    contacts: [{ id: 'c5', name: 'Ryan Little', email: 'ryan@example.invalid', phone: '', hubspotUrl: '#' }]
  }),
  // Abigail's case: application address with the country inferred from the state.
  deal({
    id: '106', studentName: 'Abigail Dailey', shirtSize: 'L', shirtSizeRaw: 'Large',
    shirtSizeSource: 'application',
    shippingAddress: {
      address1: '4145 Captain Jack ln', address2: '', city: 'Colorado Springs',
      province: 'Colorado', zip: '80924', country: '',
      countryCode: 'US', countrySource: 'inferred from state', provinceCode: 'CO', phone: ''
    },
    shippingAddressSource: 'application', shippingAddressComplete: true,
    amount: 7000, totalPaid: 7000,
    contacts: [{ id: 'c7', name: 'Abigail Dailey', email: 'abbydailey8@example.invalid', phone: '', hubspotUrl: '#' }]
  }),
  // No size and an unusable address — the hardest case for the popup.
  deal({
    id: '105', studentName: 'Nobody Home', shirtSize: null, shirtSizeSource: '',
    shippingAddress: null, shippingAddressComplete: false,
    amount: 1000, totalPaid: 0,
    contacts: [{ id: 'c6', name: 'Nobody Home', email: 'nobody@example.invalid', phone: '', hubspotUrl: '#' }]
  })
];

const ENROLLMENT = {
  updatedAt: new Date('2026-08-18T00:00:00Z').toISOString(),
  totalStudents: DEALS.length,
  totalAmount: DEALS.reduce((s, d) => s + d.amount, 0),
  totalPaid: DEALS.reduce((s, d) => s + d.totalPaid, 0),
  outstanding: 1000,
  currentTabs: [{ key: 'Summer 2026', season: 'Summer', year: '2026', deals: DEALS, countedDeals: DEALS.length }],
  pastTabs: [],
  propertyOptions: { insurance_policy: [] },
  shirtSizeOptions: [
    { code: 'XS', label: 'XS (X-small)' }, { code: 'S', label: 'S (Small)' },
    { code: 'M', label: 'M (Medium)' }, { code: 'L', label: 'L (Large)' },
    { code: 'XL', label: 'XL (X-large)' }, { code: '2XL', label: '2XL (XX-large)' },
    { code: '3XL', label: '3XL (XXX-large)' }
  ],
  shirtCountryOptions: [
    { code: 'AU', name: 'Australia' }, { code: 'BR', name: 'Brazil' },
    { code: 'CA', name: 'Canada' }, { code: 'NZ', name: 'New Zealand' },
    { code: 'GB', name: 'United Kingdom' }, { code: 'US', name: 'United States' }
  ],
  applicationLookupOk: true
};

const PRODUCT = {
  id: 'gid://shopify/Product/1',
  title: 'Pacific Discovery T-Shirt',
  imageUrl: '',
  variants: [
    { id: 'v-xs', title: 'XS', size: 'XS', sku: 'IM-PD-TEE-XS', price: '20.00', inventoryQuantity: 27, availableForSale: true },
    { id: 'v-s', title: 'S', size: 'S', sku: 'IM-PD-TEE-S', price: '20.00', inventoryQuantity: 43, availableForSale: true },
    { id: 'v-m', title: 'M', size: 'M', sku: 'IM-PD-TEE-M', price: '20.00', inventoryQuantity: 34, availableForSale: true },
    { id: 'v-l', title: 'L', size: 'L', sku: 'IM-PD-TEE-L', price: '20.00', inventoryQuantity: 32, availableForSale: true },
    { id: 'v-xl', title: 'XL', size: 'XL', sku: 'IM-PD-TEE-XL', price: '20.00', inventoryQuantity: 36, availableForSale: true },
    { id: 'v-2xl', title: '2XL', size: '2XL', sku: 'IM-PD-TEE-2XL', price: '20.00', inventoryQuantity: 27, availableForSale: true },
    // Out of stock on purpose: the dropdown must disable it.
    { id: 'v-3xl', title: '3XL', size: '3XL', sku: 'IM-PD-TEE-3XL', price: '20.00', inventoryQuantity: 0, availableForSale: false }
  ]
};

// Nia already has a shirt — her row must show the badge and her popup must warn.
const EXISTING_ORDERS = {
  '103': [{
    orderId: 'gid://shopify/Order/999', orderName: '#1042',
    createdAt: '2026-08-01T10:00:00Z',
    adminUrl: 'https://admin.shopify.com/store/pure-exploration/orders/999',
    fulfillmentStatus: 'UNFULFILLED', financialStatus: 'PAID',
    items: [{ quantity: 1, size: 'XS', title: 'Pacific Discovery T-Shirt' }]
  }]
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

  if (url.pathname === '/api/shirt-orders' && req.method === 'GET') {
    return send(200, { ok: true, product: PRODUCT, ordersByDeal: EXISTING_ORDERS });
  }

  if (url.pathname === '/api/shirt-orders' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const payload = JSON.parse(body || '{}');
      posted.push(payload);
      if (failNextPost) {
        const msg = failNextPost;
        failNextPost = null;
        return send(422, { error: msg });
      }
      send(200, {
        ok: true, dealId: payload.dealId, size: payload.size, quantity: payload.quantity,
        order: {
          orderId: 'gid://shopify/Order/1000', orderName: '#1043',
          createdAt: new Date('2026-08-18T01:00:00Z').toISOString(),
          adminUrl: 'https://admin.shopify.com/store/pure-exploration/orders/1000',
          financialStatus: 'PAID', fulfillmentStatus: 'UNFULFILLED', total: '20.00 USD'
        },
        shippedTo: '586 Eastwood St, Grand Junction, CO, 81504, United States',
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

// Tailwind comes from a CDN that isn't reachable here; stub it so layout code
// doesn't hang the load. The test asserts behaviour, not pixels.
await page.route('**/tailwind*.css', (r) => r.fulfill({ status: 200, contentType: 'text/css', body: '' }));

await page.goto(`${base}/enrollment/index.html`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#dashboard:not(.hidden)', { timeout: 15000 });
// Wait for the Shopify pass to repaint the T-shirt column.
await page.waitForFunction(() => window.__shirtProduct !== null, { timeout: 15000 });

// ── 1. Column header exists, in the right place ─────────────────────────
const headers = await page.$$eval('table thead th', (ths) => ths.map((t) => t.textContent.replace(/[▴▾\s]+$/, '').trim()));
check('Shirt Size column sits between Travel Year and Stage', () => {
  assert.deepEqual(headers.slice(0, 6), ['Student Name', 'PD Program', 'Pipeline', 'Travel Year', 'Shirt Size', 'Stage']);
});
check('T-Shirt action column is last', () => {
  assert.equal(headers[headers.length - 1], 'T-Shirt');
});

// ── 2. Cell contents ───────────────────────────────────────────────────
const rowFor = async (name) => {
  const rows = await page.$$('table[data-table]:first-of-type tbody tr.data-row');
  for (const r of rows) {
    const txt = await r.$eval('td:first-child', (td) => td.textContent.trim());
    if (txt === name) return r;
  }
  throw new Error(`row not found: ${name}`);
};

const sizeCellText = async (name) => (await (await rowFor(name)).$eval('td:nth-child(5)', (td) => td.textContent.trim()));

const emmaSize = await sizeCellText('Emma Lyons');
const rachelSize = await sizeCellText('Rachel Stern');
const ryanSize = await sizeCellText('Ryan Little');
const nobodySize = await sizeCellText('Nobody Home');

check('application-sourced size shows just the size', () => assert.equal(emmaSize, 'M'));
check('XX-large maps through to the 2XL variant', () => assert.equal(rachelSize, '2XL'));
check('non-application size is flagged with ?', () => assert.equal(ryanSize, 'L ?'));
check('missing size renders an em dash', () => assert.equal(nobodySize, '—'));

const ryanTitle = await (await rowFor('Ryan Little')).$eval('td:nth-child(5) span', (s) => s.getAttribute('title'));
check('flagged size explains its provenance', () => {
  assert.match(ryanTitle, /hubspot contact/);
  assert.match(ryanTitle, /worth confirming/);
});

// ── 3. Ordered badge ───────────────────────────────────────────────────
const niaCell = await (await rowFor('Nia Tomalin')).$eval('td:last-child', (td) => td.textContent.trim());
check('student with an existing order shows the Ordered badge', () => assert.match(niaCell, /Ordered/));
const emmaCell = await (await rowFor('Emma Lyons')).$eval('td:last-child', (td) => td.textContent.trim());
check('student without an order shows Order T-Shirt', () => assert.match(emmaCell, /Order T-Shirt/));

// ── 4. Sorting ─────────────────────────────────────────────────────────
// The dashboard renders one table per sub-tab ("All" plus one per program), so
// every row selector must be scoped to a single table or it spans all of them.
// Scope to ONE table via a Locator. $$eval selectors are not scoped by an
// ancestor selector alone here, so use locator.first() explicitly.
const table = page.locator('table[data-table]').first();
const colText = (n) => table.locator(`tbody tr.data-row td:nth-child(${n})`).allTextContents()
  .then((xs) => xs.map((x) => x.trim()));

await table.locator('th[data-sort="shirt"]').click();
let order = await colText(5);
check('shirt sort runs small→large with blanks last', () => {
  assert.deepEqual(order, ['XS', 'M', 'L', 'L ?', '2XL', '—']);
});

await table.locator('th[data-col="6"]').click(); // Total Amount, ascending
let amounts = await colText(7);
check('money columns still sort numerically after the column insert', () => {
  assert.deepEqual(amounts, ['$1,000.00', '$3,275.00', '$5,000.00', '$6,550.00', '$7,000.00', '$7,000.00']);
});

// ── 5. Popup pre-fill ──────────────────────────────────────────────────
await (await rowFor('Emma Lyons')).$eval('td:last-child button', (b) => b.click());
await page.waitForSelector('#shirt-modal:not(.hidden)');

const prefill = await page.evaluate(() => ({
  size: document.getElementById('shirt-size').value,
  qty: document.getElementById('shirt-qty').value,
  addr1: document.getElementById('shirt-addr1').value,
  city: document.getElementById('shirt-city').value,
  zip: document.getElementById('shirt-zip').value,
  country: document.getElementById('shirt-country').value,
  prov: document.getElementById('shirt-prov').value,
  email: document.getElementById('shirt-email').value,
  sub: document.getElementById('shirt-modal-sub').textContent,
  total: document.getElementById('shirt-total').textContent,
  receipt: document.getElementById('shirt-receipt').checked,
  existingHidden: document.getElementById('shirt-existing').classList.contains('hidden')
}));

check('popup pre-fills the application size', () => assert.equal(prefill.size, 'M'));
check('popup pre-fills the application address', () => {
  assert.equal(prefill.addr1, '586 Eastwood St');
  assert.equal(prefill.city, 'Grand Junction');
  assert.equal(prefill.zip, '81504');
  assert.equal(prefill.country, 'US');
  assert.equal(prefill.prov, 'CO');
});
check("popup picks the student's email, not the parent's", () => {
  assert.equal(prefill.email, 'lyonsemma403@example.invalid');
});
check('popup shows the student and program in the subtitle', () => {
  assert.match(prefill.sub, /Emma Lyons/);
  assert.match(prefill.sub, /Bali Summer Program/);
});
check('popup shows a live total', () => assert.match(prefill.total, /1 × \$20\.00.*\$20\.00/));
check('receipt-to-student defaults to off', () => assert.equal(prefill.receipt, false));
check('no duplicate warning for a first order', () => assert.equal(prefill.existingHidden, true));

const sizeOpts = await page.$$eval('#shirt-size option', (os) => os.map((o) => ({ v: o.value, t: o.textContent, d: o.disabled })));
check('size dropdown shows live stock', () => {
  const m = sizeOpts.find((o) => o.v === 'M');
  assert.match(m.t, /34 in stock/);
});
check('out-of-stock size is disabled', () => {
  const x = sizeOpts.find((o) => o.v === '3XL');
  assert.equal(x.d, true);
  assert.match(x.t, /out of stock/);
});

// ── 6. Client-side validation ──────────────────────────────────────────
await page.fill('#shirt-addr1', '');
await page.click('#shirt-submit');
let err = await page.$eval('#shirt-error', (e) => ({ hidden: e.classList.contains('hidden'), text: e.textContent }));
check('blank street address is refused before any POST', () => {
  assert.equal(err.hidden, false);
  assert.match(err.text, /street address is required/i);
  assert.equal(posted.length, 0);
});

await page.fill('#shirt-addr1', '586 Eastwood St');
await page.fill('#shirt-prov', '');
await page.click('#shirt-submit');
err = await page.$eval('#shirt-error', (e) => e.textContent);
check('US address without a state is refused', () => {
  assert.match(err, /state\/province code is required for US/i);
  assert.equal(posted.length, 0);
});

// ── 7. Server-side rejection is surfaced ───────────────────────────────
await page.fill('#shirt-prov', 'CO');
failNextPost = 'Shopify rejected the order — shippingAddress.zip: is invalid';
await page.click('#shirt-submit');
await page.waitForFunction(() => {
  const b = document.getElementById('shirt-submit');
  return b && !b.disabled;
}, { timeout: 5000 });
err = await page.$eval('#shirt-error', (e) => e.textContent);
check('a Shopify rejection is shown verbatim and the button re-enables', () => {
  assert.match(err, /shippingAddress\.zip/);
  assert.equal(posted.length, 1);
});

// ── 8. Happy path ──────────────────────────────────────────────────────
await page.fill('#shirt-qty', '2');
await page.click('#shirt-submit');
await page.waitForSelector('#shirt-success:not(.hidden)', { timeout: 5000 });

const success = await page.$eval('#shirt-success', (e) => e.textContent);
check('success panel names the order and the destination', () => {
  assert.match(success, /#1043/);
  assert.match(success, /M ×2/);
  assert.match(success, /Grand Junction/);
});
const submitHidden = await page.$eval('#shirt-submit', (b) => b.style.display === 'none');
check('submit button hides after success so nobody double-orders', () => assert.equal(submitHidden, true));

const sent = posted[posted.length - 1];
check('POST body carries everything the function needs', () => {
  assert.equal(sent.dealId, '101');
  assert.equal(sent.studentName, 'Emma Lyons');
  assert.equal(sent.size, 'M');
  assert.equal(sent.quantity, 2);
  assert.equal(sent.sendReceipt, false);
  assert.equal(sent.address.countryCode, 'US');
  assert.equal(sent.address.provinceCode, 'CO');
  assert.equal(sent.address.city, 'Grand Junction');
});

await page.evaluate(() => closeShirtModal());
const emmaCellAfter = await (await rowFor('Emma Lyons')).$eval('td:last-child', (td) => td.textContent.trim());
check('row flips to Ordered without a page reload', () => assert.match(emmaCellAfter, /Ordered ×2/));

// ── 8b. Inferred country ───────────────────────────────────────────────
await (await rowFor('Abigail Dailey')).$eval('td:last-child button', (b) => b.click());
await page.waitForSelector('#shirt-modal:not(.hidden)');
const inferred = await page.evaluate(() => ({
  country: document.getElementById('shirt-country').value,
  prov: document.getElementById('shirt-prov').value,
  src: document.getElementById('shirt-addr-source').textContent,
  size: document.getElementById('shirt-size').value
}));
check('a country inferred from the state is pre-selected, not left blank', () => {
  assert.equal(inferred.country, 'US');
  assert.equal(inferred.prov, 'CO', 'the province must be the code Shopify wants, not "Colorado"');
  assert.equal(inferred.size, 'L');
});
check('an inferred country is disclosed rather than passed off as the application', () => {
  assert.match(inferred.src, /country inferred from state/);
});
await page.evaluate(() => closeShirtModal());

// ── 9. Duplicate warning ───────────────────────────────────────────────
await (await rowFor('Nia Tomalin')).$eval('td:last-child button[data-shirt-deal]', (b) => b.click());
await page.waitForSelector('#shirt-modal:not(.hidden)');
const dupWarn = await page.$eval('#shirt-existing', (e) => ({ hidden: e.classList.contains('hidden'), text: e.textContent }));
check('a student with an order sees a duplicate warning naming it', () => {
  assert.equal(dupWarn.hidden, false);
  assert.match(dupWarn.text, /Already ordered/);
  assert.match(dupWarn.text, /#1042/);
  assert.match(dupWarn.text, /second shirt/);
});
await page.evaluate(() => closeShirtModal());

// ── 10. The no-data case ───────────────────────────────────────────────
await (await rowFor('Nobody Home')).$eval('td:last-child button', (b) => b.click());
await page.waitForSelector('#shirt-modal:not(.hidden)');
const empty = await page.evaluate(() => ({
  size: document.getElementById('shirt-size').value,
  note: document.getElementById('shirt-size-note').textContent,
  addr: document.getElementById('shirt-addr1').value,
  src: document.getElementById('shirt-addr-source').textContent
}));
check('no size on file leaves the dropdown unset and says why', () => {
  assert.equal(empty.size, '');
  assert.match(empty.note, /No size on file/);
});
check('no address on file is called out rather than shown blank', () => {
  assert.equal(empty.addr, '');
  assert.match(empty.src, /nothing on file/);
});

check('no uncaught JS errors during the whole run', () => {
  const real = consoleErrors.filter((e) => !/tailwind|favicon|net::ERR|Failed to load resource/i.test(e));
  assert.deepEqual(real, []);
});

await browser.close();
server.close();

// ═══════════════════════════════════════════
// REPORT
// ═══════════════════════════════════════════
let failed = 0;
for (const [status, name] of results) {
  if (status === 'FAIL') failed++;
  console.log(`${status === 'PASS' ? '  ok  ' : '  FAIL'} ${name}`);
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);

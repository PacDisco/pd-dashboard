// test/cash-receipts.test.mjs
//
// Receivable receipts: paging, season attribution, currency, and the one
// behaviour that matters more than the rest — money that cannot be attributed
// must show up as unattributed, never spread across the seasons that happen to
// be recognisable.
//
// Run: node test/cash-receipts.test.mjs

import assert from "node:assert/strict";
import {
  fetchPayments,
  fetchInvoicesByIds,
  attributeReceipts,
  seasonLookup,
  invoiceSeasonWeights,
} from "../netlify/functions/_shared/cash-receipts.mjs";

const near = (a, b, tol, msg) =>
  assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b}`);

const PROGRAMS = [
  { name: "Aus Bali", season: "Fall", xeroTrackingOption: "Aus Bali" },
  { name: "CAS", season: "Fall", xeroTrackingOption: "CAS" },
  { name: "SAS", season: "Spring", xeroTrackingOption: "SAS" },
  { name: "Hawaii Mini", season: "Summer", xeroTrackingOption: "Hawaii Mini" },
];

const invoice = (id, lines) => ({ InvoiceID: id, LineItems: lines });
const line = (amount, option, accountCode = "200") => ({
  LineAmount: amount,
  AccountCode: accountCode,
  Tracking: option ? [{ Name: "Program", Option: option }] : [],
});
const payment = (id, amount, rate, invoiceId, currency = "USD") => ({
  PaymentID: id,
  Amount: amount,
  CurrencyRate: rate,
  PaymentType: "ACCRECPAYMENT",
  Status: "AUTHORISED",
  Invoice: { InvoiceID: invoiceId, CurrencyCode: currency },
});

/* ---------- paging ---------- */

{
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = new URL(String(url));
    const page = Number(u.searchParams.get("page"));
    calls.push({ page, where: u.searchParams.get("where") });
    // Two full pages, then a short one.
    const n = page <= 2 ? 100 : 7;
    return new Response(
      JSON.stringify({ Payments: Array.from({ length: n }, (_, i) => payment(`p${page}-${i}`, 100, 1, "inv")) }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };

  const { payments, truncated } = await fetchPayments("tok", "ten", "2026-08");
  globalThis.fetch = originalFetch;

  assert.equal(payments.length, 207, "every page is collected");
  assert.equal(truncated, false);
  assert.equal(calls.length, 3, "stops on the first short page");
  assert.match(calls[0].where, /PaymentType=="ACCRECPAYMENT"/, "asks only for AR receipts");
  assert.match(calls[0].where, /Date>=DateTime\(2026,8,1\)/, "from the first of the month");
  assert.match(calls[0].where, /Date<DateTime\(2026,9,1\)/, "to the first of the next — exclusive");
  console.log("✓ payments are paged until a short page");
}

/* ---------- a month that overruns the page cap must say so ---------- */

{
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ Payments: Array.from({ length: 100 }, (_, i) => payment(`p${i}`, 1, 1, "inv")) }),
      { status: 200, headers: { "content-type": "application/json" } });

  const { truncated } = await fetchPayments("tok", "ten", "2026-08", { maxPages: 3 });
  globalThis.fetch = originalFetch;

  assert.equal(truncated, true, "a truncated pull must be flagged, not returned quietly");
  console.log("✓ hitting the page cap is reported");
}

/* ---------- invoices are batched, not fetched one at a time ---------- */

{
  const batches = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const ids = new URL(String(url)).searchParams.get("IDs").split(",");
    batches.push(ids.length);
    return new Response(JSON.stringify({ Invoices: ids.map((id) => invoice(id, [line(100, "CAS")])) }),
      { status: 200, headers: { "content-type": "application/json" } });
  };

  const ids = Array.from({ length: 95 }, (_, i) => `inv-${i}`);
  // Duplicates are normal: one invoice part-paid twice is two payments.
  const byId = await fetchInvoicesByIds("tok", "ten", [...ids, ...ids.slice(0, 20)]);
  globalThis.fetch = originalFetch;

  assert.equal(byId.size, 95, "every invoice comes back once");
  assert.deepEqual(batches, [40, 40, 15], "batched, and de-duplicated before batching");
  console.log("✓ invoices are de-duplicated and batched");
}

/* ---------- season attribution ---------- */

{
  const lookup = seasonLookup(PROGRAMS);
  assert.equal(lookup.get("cas").season, "Fall");
  assert.equal(lookup.get("sas").season, "Spring");
  assert.equal(lookup.get("hawaii mini").season, "Summer");
  console.log("✓ tracking options map to seasons, case and space insensitive");

  const single = invoiceSeasonWeights(invoice("i1", [line(15_500, "CAS")]), lookup);
  assert.deepEqual([...single], [["Fall", 1]]);

  // One invoice covering two programs in different seasons splits by amount,
  // rather than the first match winning the whole payment.
  const mixed = invoiceSeasonWeights(
    invoice("i2", [line(9_000, "CAS"), line(3_000, "SAS")]), lookup);
  near(mixed.get("Fall"), 0.75, 1e-9, "Fall share");
  near(mixed.get("Spring"), 0.25, 1e-9, "Spring share");
  console.log("✓ an invoice spanning two seasons splits pro-rata by line amount");
}

/* ---------- THE ONE THAT MATTERS: unknown money stays visible ---------- */

{
  const invoices = new Map([
    ["a", invoice("a", [line(10_000, "CAS")])],
    ["b", invoice("b", [line(10_000, "Some Other Thing")])],   // unmapped option
    ["c", invoice("c", [line(10_000, null)])],                  // no tracking at all
  ]);
  const payments = [
    payment("p1", 10_000, 1, "a"),
    payment("p2", 10_000, 1, "b"),
    payment("p3", 10_000, 1, "c"),
    payment("p4", 10_000, 1, "missing-invoice"),                // invoice not returned
  ];

  const r = attributeReceipts("2026-08", payments, invoices, PROGRAMS);

  near(r.total, 40_000, 0.01, "total is every payment");
  near(r.bySeason.Fall.base, 10_000, 0.01, "only the mapped one is Fall");
  near(r.unattributed, 30_000, 0.01, "everything else is unattributed, not guessed");
  assert.equal(r.bySeason.Spring, undefined, "no money invented into other seasons");

  // Season totals plus unattributed must equal the month. If this ever fails,
  // the table will not add up and nobody will know why.
  const summed = Object.values(r.bySeason).reduce((s, v) => s + v.base, 0);
  near(summed, r.total, 0.01, "seasons plus unattributed reconcile to the total");
  console.log("✓ unattributable money is surfaced, never spread across seasons");

  assert.deepEqual(r.diagnostics.invoicesNotReturned, ["missing-invoice"]);
  const seen = r.diagnostics.trackingOptionsSeen;
  assert.ok(seen.some((o) => o.label === "Program: CAS" && o.matched === true));
  assert.ok(seen.some((o) => o.label === "Program: Some Other Thing" && o.matched === false),
    "an unrecognised option is named, so the fix is obvious");
  console.log("✓ diagnostics name the options that did not match");
}

/* ---------- currency ---------- */

{
  const invoices = new Map([["a", invoice("a", [line(15_500, "CAS")])]]);
  // 12,000 USD at 1.7019 is what actually hit the NZD books.
  const r = attributeReceipts("2026-08", [payment("p1", 12_000, 1.7019, "a", "USD")], invoices, PROGRAMS);

  near(r.total, 20_422.8, 0.01, "base currency uses the payment's own rate");
  near(r.totalNative, 12_000, 0.01, "native amount is kept as invoiced");
  near(r.byCurrency.USD.base, 20_422.8, 0.01);
  near(r.byCurrency.USD.native, 12_000, 0.01);
  console.log("✓ payments convert at their own CurrencyRate, and both sides are kept");

  // A payment already in base currency has no rate to apply.
  const flat = attributeReceipts("2026-08", [{ Amount: 5_000, Invoice: { InvoiceID: "a" } }], invoices, PROGRAMS);
  near(flat.total, 5_000, 0.01, "a missing CurrencyRate means base currency, not zero");
  console.log("✓ a missing CurrencyRate does not zero the payment");
}

console.log("\nAll receipts tests passed.");

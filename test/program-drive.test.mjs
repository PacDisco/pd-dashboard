// npm run test:program-drive
// Google Picker config endpoint: editors only, clear message when not set up.
import test from "node:test";
import assert from "node:assert/strict";
import { makeHandler, pickerConfig } from "../netlify/functions/program-drive.mjs";

const GOOD = {
  GOOGLE_PICKER_CLIENT_ID: "123456789012-abcdefghijklmnop.apps.googleusercontent.com",
  GOOGLE_PICKER_API_KEY: "AIzaSyA-1234567890abcdefghijklmnopqrs",
  GOOGLE_PICKER_APP_ID: "123456789012",
};
const get = (h, qs = "action=config") => h(new Request(`https://dash.test/api/program-drive?${qs}`));

test("editors get the picker config", async () => {
  const h = makeHandler({ requireEditor: async () => ({ actor: "Megan" }), env: GOOD });
  const r = await get(h);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { clientId: GOOD.GOOGLE_PICKER_CLIENT_ID, apiKey: GOOD.GOOGLE_PICKER_API_KEY, appId: GOOD.GOOGLE_PICKER_APP_ID });
});

test("no session → no config", async () => {
  const h = makeHandler({ requireEditor: async () => new Response('{"error":"Sign in required."}', { status: 401 }), env: GOOD });
  assert.equal((await get(h)).status, 401);
});

test("not set up → 503 naming exactly what's missing", async () => {
  const h = makeHandler({ requireEditor: async () => ({}), env: { GOOGLE_PICKER_CLIENT_ID: GOOD.GOOGLE_PICKER_CLIENT_ID } });
  const r = await get(h);
  assert.equal(r.status, 503);
  const { error } = await r.json();
  assert.match(error, /GOOGLE_PICKER_API_KEY, GOOGLE_PICKER_APP_ID/);
  assert.doesNotMatch(error, /CLIENT_ID/);
});

test("obviously wrong values are caught", () => {
  assert.deepEqual(pickerConfig({ ...GOOD, GOOGLE_PICKER_APP_ID: "my-project-name" }).missing, ["GOOGLE_PICKER_APP_ID"]);
  assert.deepEqual(pickerConfig({ ...GOOD, GOOGLE_PICKER_CLIENT_ID: "abc" }).missing, ["GOOGLE_PICKER_CLIENT_ID"]);
  assert.equal(pickerConfig({ ...GOOD, GOOGLE_PICKER_API_KEY: " " + GOOD.GOOGLE_PICKER_API_KEY + " " }).apiKey, GOOD.GOOGLE_PICKER_API_KEY);
});

test("only the config action exists", async () => {
  const h = makeHandler({ requireEditor: async () => ({}), env: GOOD });
  assert.equal((await get(h, "action=list")).status, 400);
});

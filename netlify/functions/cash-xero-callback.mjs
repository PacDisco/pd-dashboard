/**
 * OAuth redirect target. Xero sends the user back here with a one-time code.
 * Exchanges it for tokens and stores them. Runs once at setup; after that the
 * scheduled sync keeps the tokens alive on its own.
 *
 * This URL must match XERO_REDIRECT_URI exactly and be registered on the app
 * in the Xero developer portal, e.g.
 *   https://dashboard.pacificdiscovery.org/.netlify/functions/cash-xero-callback
 */
import { exchangeCode, getConnections, requireEnv } from "./_shared/cash-xero.mjs";
import { getStore } from "@netlify/blobs";
export default async (req, _context) => {
    const url = new URL(req.url);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const error = url.searchParams.get("error");
    if (error) {
        return new Response(`Xero returned an error: ${error}`, { status: 400 });
    }
    if (!code) {
        return new Response("Missing authorization code", { status: 400 });
    }
    const store = getStore({ name: "cash-xero-auth", consistency: "strong" });
    const expected = await store.get("state", { type: "text" });
    if (!state || !expected || state !== expected) {
        return new Response("State mismatch — start again from cash-xero-auth", { status: 400 });
    }
    await store.delete("state");
    const record = await exchangeCode(code, requireEnv("XERO_REDIRECT_URI"));
    const connections = await getConnections(record.access_token);
    const list = connections.map((c) => `  • ${c.tenantName}  (${c.tenantId})`).join("\n");
    return new Response(`Xero connected.\n\nOrganisations authorised:\n${list}\n\n` +
        `Copy the tenant IDs above into the XERO_TENANTS environment variable if you\n` +
        `want to pin a specific set and order. Leave it unset to sync all of them.\n\n` +
        `You can close this tab. The scheduled sync takes over from here.\n`, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
};

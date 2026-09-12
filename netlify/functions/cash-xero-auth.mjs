/**
 * One-time consent kickoff.
 *
 * Hit this in a browser ONCE, signed in to Xero as a user who can see all four
 * EDA Group organisations. On the Xero consent screen, tick every org you want
 * on the dashboard — you get one refresh token covering all of them.
 *
 * Protected by a shared secret so a stray visit can't start an auth flow:
 *   /.netlify/functions/cash-xero-auth?key=<XERO_SETUP_KEY>
 */
import { SCOPES, requireEnv } from "./_shared/cash-xero.mjs";
import { randomUUID } from "node:crypto";
import { getStore } from "@netlify/blobs";
export default async (req, _context) => {
    const url = new URL(req.url);
    if (url.searchParams.get("key") !== requireEnv("XERO_SETUP_KEY")) {
        return new Response("Not found", { status: 404 });
    }
    // CSRF guard — checked on the way back in xero-callback.
    const state = randomUUID();
    await getStore({ name: "cash-xero-auth", consistency: "strong" }).set("state", state, {
        metadata: { createdAt: Date.now() },
    });
    const authorize = new URL("https://login.xero.com/identity/connect/authorize");
    authorize.searchParams.set("response_type", "code");
    authorize.searchParams.set("client_id", requireEnv("XERO_CLIENT_ID"));
    authorize.searchParams.set("redirect_uri", requireEnv("XERO_REDIRECT_URI"));
    authorize.searchParams.set("scope", SCOPES);
    authorize.searchParams.set("state", state);
    return Response.redirect(authorize.toString(), 302);
};

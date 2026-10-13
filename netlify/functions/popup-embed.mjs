// netlify/functions/popup-embed.mjs
//
// PUBLIC. What the website loads:
//
//   GET /api/popup-embed            the popup script (GTM Custom HTML tag):
//                                   <script src="https://dashboard.pacificdiscovery.org/api/popup-embed" async></script>
//   GET /api/popup-embed?runtime=1  the same code as window.PDPopupRuntime, for the designer preview
//   GET /api/popup-embed?img=<key>  an image uploaded in the designer
//
// Only switched-on popups are included, with only what the page needs to draw
// them (no HubSpot property names, no editor notes). Cached for 60 seconds at
// the CDN, so a saved change reaches the site within about a minute.

import { matchPage, publicConfig } from "./_shared/popups-core.mjs";
import { embedScript, previewScript } from "./_shared/popup-runtime.mjs";
import { popupStore, readDoc } from "./_shared/popups-store.mjs";

const IMG_RE = /^[a-z0-9]{4,20}-[a-f0-9]{12}\.(jpg|png|webp|gif)$/;
const JS = "application/javascript; charset=utf-8";

export default async (req) => {
  const url = new URL(req.url);
  const store = popupStore();

  const img = url.searchParams.get("img");
  if (img !== null) {
    if (!IMG_RE.test(img)) return new Response("Not found", { status: 404 });
    const hit = await store.getWithMetadata(`img/${img}`, { type: "arrayBuffer" }).catch(() => null);
    if (!hit || !hit.data) return new Response("Not found", { status: 404 });
    return new Response(hit.data, {
      headers: {
        "Content-Type": hit.metadata?.type || "image/jpeg",
        "Cache-Control": "public, max-age=31536000, immutable",
        "Access-Control-Allow-Origin": "*",
        "X-Content-Type-Options": "nosniff",
      },
    });
  }

  if (url.searchParams.has("runtime")) {
    return new Response(previewScript(matchPage), { headers: { "Content-Type": JS, "Cache-Control": "no-cache" } });
  }

  let config = [];
  try {
    config = publicConfig(await readDoc(store), url.origin);
  } catch (e) {
    // Never break the website: a failed read serves an empty script.
    console.error("[popup-embed]", e);
  }
  return new Response(embedScript(matchPage, config, `${url.origin}/api/popup-submit`), {
    headers: {
      "Content-Type": JS,
      "Cache-Control": "public, max-age=60",
      "Netlify-CDN-Cache-Control": "public, s-maxage=60, stale-while-revalidate=300",
      "Access-Control-Allow-Origin": "*",
      "X-Content-Type-Options": "nosniff",
    },
  });
};

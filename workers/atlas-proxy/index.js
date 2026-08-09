// atlas-proxy — Cloudflare Worker pass-through to Dapper's Atlas marketplace
// service (api.production.atlas.dapperlabs.com), the source behind the
// #1 / perfect-mint serial-listing ingest (scripts/ingest-topshot-active-listings.mjs).
//
// WHY THIS EXISTS: the GitHub Actions runner IP is intermittently WAF-blocked
// by Atlas (pipeline `topshot-active-listings-ingest` failing ~83% with
// `egress_blocked`). Cloudflare Worker egress rides different IPs — the same
// trick topshot-proxy uses to reach nbatopshot GQL that Vercel/Supabase can't.
//
// ⚠ HYPOTHESIS, UNVERIFIED FROM CI: whether Cloudflare egress is Atlas-WAF-
// allowed is NOT proven (Atlas is a different WAF/service than the GQL host).
// After `wrangler deploy`, run ONE probe (see README) before wiring the runner.
// If Cloudflare is also blocked, this lane is dead — fall back to running the
// script from the residential box.
//
// Single upstream (the script only ever calls SearchMarketplaceTransactions),
// so no routing — every authorized POST forwards its body verbatim to Atlas
// with the browser/Connect headers Atlas expects, and returns Atlas's response
// verbatim (status + JSON body) so the caller's parsing is unchanged.
//
// Auth: X-Proxy-Secret header must match env.PROXY_SECRET.

const ATLAS_URL =
  "https://api.production.atlas.dapperlabs.com/public/atlas.v1.MarketplaceService/SearchMarketplaceTransactions";

// Injected server-side so the caller only sends the JSON body + the shared
// secret — matches the ATLAS_HEADERS the direct-curl path uses today.
const ATLAS_HEADERS = {
  "connect-protocol-version": "1",
  "content-type": "application/json",
  Origin: "https://dapper.market",
  Referer: "https://dapper.market/",
  "User-Agent":
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
};

export default {
  async fetch(request, env) {
    if (request.method === "GET") {
      return new Response("atlas-proxy ok", { status: 200, headers: { "Content-Type": "text/plain" } });
    }
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }
    const auth = request.headers.get("X-Proxy-Secret");
    if (!auth || auth !== env.PROXY_SECRET) {
      return new Response("Unauthorized", { status: 401 });
    }

    const body = await request.text();
    let upstream;
    try {
      upstream = await fetch(ATLAS_URL, { method: "POST", headers: ATLAS_HEADERS, body });
    } catch (err) {
      return new Response(JSON.stringify({ error: "upstream_fetch_failed", detail: String(err) }), {
        status: 502,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
    }
    const data = await upstream.text();
    return new Response(data, {
      status: upstream.status,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    });
  },
};

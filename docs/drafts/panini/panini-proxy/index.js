// panini-proxy — Cloudflare Worker (DRAFT / not deployed).
//
// Fronts Panini Blockchain's hardened gateway POST https://nft.paniniamerica.net/onepanini
// for the Plane-A "onepanini" feed mode. Vercel/Supabase egress is bot-detected
// (Signifyd) and naive calls 426; this worker runs from Cloudflare IPs and replays
// the app's exact request shape.
//
// AUTH — own rotation surface. NEVER shares TS_PROXY_SECRET / INGEST_SECRET_TOKEN.
//   Inbound:  X-Proxy-Secret  == env.PANINI_PROXY_SECRET   (set via `wrangler secret put`)
//   Outbound: whatever static headers /onepanini requires (captured at discovery)
//
// Deploy: see README.md. Until the upstream request format is captured from a
// logged-in session (the one open discovery item), the UPSTREAM_HEADERS block is a
// placeholder and the worker will pass through a 426 — which is the honest, inert
// state.

const UPSTREAM = "https://nft.paniniamerica.net/onepanini";

// TODO(discovery) CLOSED 2026-07-19 — WILL NOT BE FILLED, and this worker will not be
// deployed. The premise was that /onepanini could be replayed from Cloudflare given the right
// static headers. It cannot: the request carries a 15-minute SIGNATURE bound to a logged-in
// session, so there is no set of static headers that makes this work — crafting the GQL call
// returns 426 regardless of origin IP. That is why the shipped design inverts the approach and
// lets the SITE sign every request natively in a real logged-in browser
// (scripts/ingest-panini-runner.mjs), which also means RPC never holds the raw token.
// The dead-end lanes (crafted GQL → 426, psku derivation, fetch override) are written up in
// docs/handoff-2026-07-19-panini-catalog-and-candy-offers.md — do not re-derive them.
// Left inert rather than deleted as the record of a rejected approach.
const UPSTREAM_HEADERS = {
  "Content-Type": "application/json",
  "Origin": "https://nft.paniniamerica.net",
  "Referer": "https://nft.paniniamerica.net/",
  // "x-panini-app-version": "…",
  // "x-…": "…",
};

export default {
  async fetch(request, env) {
    if (request.method !== "POST") {
      return json({ error: "method_not_allowed" }, 405);
    }
    // Inbound auth — constant-time-ish compare on the dedicated secret.
    const got = request.headers.get("X-Proxy-Secret") || "";
    if (!env.PANINI_PROXY_SECRET || got !== env.PANINI_PROXY_SECRET) {
      return json({ error: "unauthorized" }, 401);
    }

    let body;
    try {
      body = await request.text(); // pass the caller's onepanini query through verbatim
    } catch {
      return json({ error: "bad_body" }, 400);
    }

    try {
      const upstream = await fetch(UPSTREAM, {
        method: "POST",
        headers: UPSTREAM_HEADERS,
        body,
      });
      const text = await upstream.text();
      return new Response(text, {
        status: upstream.status,
        headers: { "Content-Type": upstream.headers.get("Content-Type") || "application/json" },
      });
    } catch (e) {
      return json({ error: "upstream_fetch_failed", detail: String(e) }, 502);
    }
  },
};

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

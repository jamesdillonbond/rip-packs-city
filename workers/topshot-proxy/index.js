// Multi-collection GQL proxy — routes requests to the correct upstream
// based on the URL path. Cloudflare Workers bypass the IP blocks that
// prevent Vercel + Supabase egress from reaching Dapper Labs GQL endpoints
// directly.
//
// AllDay has TWO graphql endpoints with non-overlapping schemas:
//   - public-api.nflallday.com/graphql   (searchMomentNFTsV2, searchPackNFTsV2 — wallet/pack queries)
//   - nflallday.com/consumer/graphql     (getMintedMoment — moment-by-id, only place flowSerialNumber lives)
// Both need the proxy because Cloudflare WAF blocks Vercel + Supabase egress on both hostnames.
//
// Routes:
//   POST /                  → public-api.nbatopshot.com/graphql  (legacy default, backward compat)
//   POST /topshot           → public-api.nbatopshot.com/graphql
//   POST /allday            → public-api.nflallday.com/graphql
//   POST /allday-consumer   → nflallday.com/consumer/graphql
//
// Auth: X-Proxy-Secret header must match env.PROXY_SECRET (single secret
// shared across all routes — single rotation surface).
//
// /allday-consumer additional gating: the consumer endpoint serves a reduced
// public schema (no getMintedMoment) to non-browser-fingerprinted requests.
// This route adds Origin / Referer / browser User-Agent so the schema flips
// to the full view. Scoped to this route only — public-api routes stay on
// the bare "sports-collectible-tool/0.1" UA they've always used.

const UPSTREAM_MAP = {
  "topshot":             "https://public-api.nbatopshot.com/graphql",
  "allday":              "https://public-api.nflallday.com/graphql",
  "allday-consumer":     "https://nflallday.com/consumer/graphql",
  // Browser-fingerprinted TS routes (2026-06-15). Intended to unblock
  // execution-gated ops (searchMintedMoments) via the /allday-consumer trick.
  // VERIFIED INEFFECTIVE for that op (kept only as harmless passthroughs):
  //   - topshot-browser (public-api + browser headers): searchMintedMoments
  //     still returns generic "unknown field" — the gate is an operation /
  //     persisted-query allowlist, NOT UA/header based. getMintedMoment works.
  //   - topshot-marketplace (website endpoint): returns a Cloudflare MANAGED
  //     bot challenge ("Just a moment…") that header spoofing can't pass.
  // Conclusion: no server-side path to enumerate an edition's moments+owners.
  "topshot-browser":     "https://public-api.nbatopshot.com/graphql",
  "topshot-marketplace": "https://nbatopshot.com/marketplace/graphql",
};

const DEFAULT_ROUTE = "topshot";
const DEFAULT_UA = "sports-collectible-tool/0.1";

// Route-scoped header overrides merged on top of the defaults. Only set the
// keys a route actually needs — empty/missing entries are no-ops.
const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const ROUTE_HEADERS = {
  "allday-consumer": {
    "Origin": "https://nflallday.com",
    "Referer": "https://nflallday.com/",
    "User-Agent": BROWSER_UA,
  },
  "topshot-browser": {
    "Origin": "https://nbatopshot.com",
    "Referer": "https://nbatopshot.com/",
    "User-Agent": BROWSER_UA,
  },
  "topshot-marketplace": {
    "Origin": "https://nbatopshot.com",
    "Referer": "https://nbatopshot.com/",
    "User-Agent": BROWSER_UA,
  },
};

export default {
  async fetch(request, env) {
    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, X-Proxy-Secret",
          "Access-Control-Max-Age": "86400",
        },
      });
    }

    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    const authHeader = request.headers.get("X-Proxy-Secret");
    if (!authHeader || authHeader !== env.PROXY_SECRET) {
      return new Response("Unauthorized", { status: 401 });
    }

    // Determine upstream from URL path. Empty / "all-day" alias preserved for
    // backward compatibility with earlier callers.
    const url = new URL(request.url);
    let path = url.pathname.replace(/^\/+|\/+$/g, "").toLowerCase();
    if (path === "all-day") path = "allday";

    const matchedRoute = UPSTREAM_MAP[path] ? path : DEFAULT_ROUTE;
    const upstream = UPSTREAM_MAP[matchedRoute];

    const upstreamHeaders = {
      "Content-Type": "application/json",
      "User-Agent": DEFAULT_UA,
      ...(ROUTE_HEADERS[matchedRoute] || {}),
    };

    const body = await request.text();
    const upstreamRes = await fetch(upstream, {
      method: "POST",
      headers: upstreamHeaders,
      body,
    });

    const data = await upstreamRes.text();
    return new Response(data, {
      status: upstreamRes.status,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    });
  },
};

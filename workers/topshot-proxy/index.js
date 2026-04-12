// Multi-collection GQL proxy — routes requests to the correct upstream
// based on the URL path. Cloudflare Workers bypass the IP blocks that
// prevent Vercel from reaching Dapper Labs GQL endpoints directly.
//
// Routes:
//   POST /              → public-api.nbatopshot.com/graphql  (legacy, backward compat)
//   POST /topshot       → public-api.nbatopshot.com/graphql
//   POST /allday        → public-api.nflallday.com/graphql
//
// Auth: X-Proxy-Secret header must match env.PROXY_SECRET

const UPSTREAM_MAP = {
  topshot: "https://public-api.nbatopshot.com/graphql",
  allday: "https://public-api.nflallday.com/graphql",
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

    // Determine upstream from URL path
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/+|\/+$/g, "").toLowerCase();

    let upstream;
    if (path === "allday" || path === "all-day") {
      upstream = UPSTREAM_MAP.allday;
    } else {
      // Default: Top Shot (backward compatible — "/" or "/topshot")
      upstream = UPSTREAM_MAP.topshot;
    }

    const body = await request.text();
    const upstreamRes = await fetch(upstream, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "sports-collectible-tool/0.1",
      },
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

// Disney Pinnacle GQL proxy — Cloudflare Workers bypass the IP blocks that
// prevent Vercel from reaching public-api.disneypinnacle.com directly.
//
// Route: POST /graphql → public-api.disneypinnacle.com/graphql
// Auth:  X-Proxy-Secret header must match env.PROXY_SECRET
//
// Smoke test after deploy:
//   curl https://pinnacle-proxy.tdillonbond.workers.dev/graphql \
//     -X POST \
//     -H 'Content-Type: application/json' \
//     -H 'X-Proxy-Secret: <secret>' \
//     -d '{"query": "{ __typename }"}'

const UPSTREAM = "https://public-api.disneypinnacle.com/graphql";

export default {
  async fetch(request, env) {
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

    const body = await request.text();
    const upstreamRes = await fetch(UPSTREAM, {
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

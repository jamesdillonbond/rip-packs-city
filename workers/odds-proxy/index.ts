// odds-proxy — fronts the-odds-api.com so the API key stays out of Vercel
// and Supabase env vars. Same secret-rotation surface as topshot-proxy:
//   PROXY_SECRET = TS_PROXY_SECRET (clients send X-Proxy-Secret)
//   ODDS_API_KEY = the-odds-api.com key (worker-only; written via
//                  `wrangler secret put ODDS_API_KEY --name odds-proxy`)
//
// Routes (GET, gated by X-Proxy-Secret == env.PROXY_SECRET):
//   GET /v4/sports/basketball_nba/odds[?regions=...&markets=...&oddsFormat=...]
//   GET /v4/sports/basketball_nba/scores  (placeholder; passthrough only)
//
// The route mirrors the-odds-api.com path so callers can keep their query
// param shape unchanged. The worker injects apiKey from its secret store.
//
// Cache:
//   /odds   → 5 min (the-odds-api.com refreshes every few minutes; 5min
//             keeps us comfortably under 500 req/month at one cron pull
//             every 60 minutes on a 10-hour active window).
//   /scores → 1 min (live scoring; not currently consumed but reserved).

interface Env {
  PROXY_SECRET: string;
  ODDS_API_KEY: string;
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Proxy-Secret",
  "Access-Control-Max-Age": "86400",
};

function jsonResponse(body: unknown, status: number, cacheSeconds = 0): Response {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  };
  if (cacheSeconds > 0) headers["Cache-Control"] = `public, max-age=${cacheSeconds}`;
  return new Response(JSON.stringify(body), { status, headers });
}

function passthroughResponse(upstreamBody: string, status: number, cacheSeconds = 0, extraHeaders: Record<string, string> = {}): Response {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    ...extraHeaders,
  };
  if (cacheSeconds > 0) headers["Cache-Control"] = `public, max-age=${cacheSeconds}`;
  return new Response(upstreamBody, { status, headers });
}

// Whitelist incoming query params so callers can't slip arbitrary fields
// through to the upstream (apiKey injection at the worker keeps the key in
// one place).
const ALLOWED_PARAMS = new Set([
  "regions",
  "markets",
  "oddsFormat",
  "dateFormat",
  "eventIds",
  "bookmakers",
  "commenceTimeFrom",
  "commenceTimeTo",
]);

async function handleSportsBasketballNbaOdds(request: Request, env: Env): Promise<Response> {
  const inUrl = new URL(request.url);
  const upstream = new URL("https://api.the-odds-api.com/v4/sports/basketball_nba/odds");
  // Sensible defaults so callers can hit the route with no query params.
  const defaults: Record<string, string> = {
    regions: "us",
    markets: "h2h,spreads,totals",
    oddsFormat: "american",
  };
  for (const [k, v] of Object.entries(defaults)) upstream.searchParams.set(k, v);
  for (const [k, v] of inUrl.searchParams) {
    if (ALLOWED_PARAMS.has(k)) upstream.searchParams.set(k, v);
  }
  upstream.searchParams.set("apiKey", env.ODDS_API_KEY);

  const res = await fetch(upstream.toString(), { method: "GET" });
  const text = await res.text();
  // The-odds-api emits useful quota headers — surface them so the caller
  // can monitor usage from pipeline_runs without re-querying.
  const quotaHeaders: Record<string, string> = {};
  const remaining = res.headers.get("x-requests-remaining");
  const used = res.headers.get("x-requests-used");
  const last = res.headers.get("x-requests-last");
  if (remaining != null) quotaHeaders["X-Quota-Remaining"] = remaining;
  if (used != null) quotaHeaders["X-Quota-Used"] = used;
  if (last != null) quotaHeaders["X-Quota-Last"] = last;

  if (!res.ok) {
    return jsonResponse(
      {
        error: "upstream_failed",
        status: res.status,
        body_excerpt: text.slice(0, 800),
        quota_remaining: remaining,
        quota_used: used,
      },
      502,
    );
  }

  return passthroughResponse(text, 200, 300, quotaHeaders);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    if (request.method !== "GET") {
      return jsonResponse({ error: "method_not_allowed" }, 405);
    }

    const auth = request.headers.get("X-Proxy-Secret");
    if (!auth || auth !== env.PROXY_SECRET) {
      return jsonResponse({ error: "unauthorized" }, 401);
    }
    if (!env.ODDS_API_KEY) {
      return jsonResponse({ error: "odds_api_key_missing" }, 500);
    }

    const path = new URL(request.url).pathname.replace(/\/+$/g, "").toLowerCase();
    switch (path) {
      case "/v4/sports/basketball_nba/odds":
        return handleSportsBasketballNbaOdds(request, env);
      default:
        return jsonResponse({ error: "route_not_found", path }, 404);
    }
  },
};

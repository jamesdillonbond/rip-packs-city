// odds-proxy — fronts the-odds-api.com so the API key stays out of Vercel
// and Supabase env vars. Same secret-rotation surface as topshot-proxy:
//   PROXY_SECRET = TS_PROXY_SECRET (clients send X-Proxy-Secret)
//   ODDS_API_KEY = the-odds-api.com key (worker-only; written via
//                  `wrangler secret put ODDS_API_KEY --name odds-proxy`)
//
// Routes (GET, gated by X-Proxy-Secret == env.PROXY_SECRET):
//   GET /v4/sports/basketball_nba/odds[?regions=...&markets=...&oddsFormat=...]
//   GET /v4/sports/basketball_nba/scores[?daysFrom=1..3&dateFormat=...&eventIds=...]
//
// Each route mirrors the-odds-api.com path so callers can keep their query
// param shape unchanged. The worker injects apiKey from its secret store.
//
// Cache:
//   /odds   → 5 min (the-odds-api.com refreshes every few minutes; 5min
//             keeps us comfortably under 500 req/month at one cron pull
//             every 60 minutes on a 10-hour active window).
//   /scores → 1 min (live scoring; refreshes fast). Not currently consumed,
//             but implemented so a caller can pull it without a worker change.
//             `daysFrom` is left to the caller (omitting it returns only
//             live/upcoming games at 1 credit; adding it costs 2 credits).

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

// Whitelist incoming query params per route so callers can't slip arbitrary
// fields through to the upstream (apiKey injection at the worker keeps the key
// in one place).
const ODDS_ALLOWED_PARAMS = new Set([
  "regions",
  "markets",
  "oddsFormat",
  "dateFormat",
  "eventIds",
  "bookmakers",
  "commenceTimeFrom",
  "commenceTimeTo",
]);
const SCORES_ALLOWED_PARAMS = new Set(["daysFrom", "dateFormat", "eventIds"]);

interface RouteConfig {
  upstreamPath: string;
  // Sensible defaults so callers can hit the route with no query params.
  defaults: Record<string, string>;
  allowed: Set<string>;
  cacheSeconds: number;
}

// Shared pass-through core: builds the upstream URL from defaults + allowlisted
// caller params, injects the apiKey, forwards the-odds-api quota headers, and
// redacts an upstream failure to an 800-char excerpt.
async function proxyToOddsApi(request: Request, env: Env, cfg: RouteConfig): Promise<Response> {
  const inUrl = new URL(request.url);
  const upstream = new URL(`https://api.the-odds-api.com${cfg.upstreamPath}`);
  for (const [k, v] of Object.entries(cfg.defaults)) upstream.searchParams.set(k, v);
  for (const [k, v] of inUrl.searchParams) {
    if (cfg.allowed.has(k)) upstream.searchParams.set(k, v);
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

  return passthroughResponse(text, 200, cfg.cacheSeconds, quotaHeaders);
}

function handleSportsBasketballNbaOdds(request: Request, env: Env): Promise<Response> {
  return proxyToOddsApi(request, env, {
    upstreamPath: "/v4/sports/basketball_nba/odds",
    defaults: { regions: "us", markets: "h2h,spreads,totals", oddsFormat: "american" },
    allowed: ODDS_ALLOWED_PARAMS,
    cacheSeconds: 300,
  });
}

function handleSportsBasketballNbaScores(request: Request, env: Env): Promise<Response> {
  return proxyToOddsApi(request, env, {
    upstreamPath: "/v4/sports/basketball_nba/scores",
    defaults: { dateFormat: "iso" },
    allowed: SCORES_ALLOWED_PARAMS,
    cacheSeconds: 60,
  });
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
      case "/v4/sports/basketball_nba/scores":
        return handleSportsBasketballNbaScores(request, env);
      default:
        return jsonResponse({ error: "route_not_found", path }, 404);
    }
  },
};

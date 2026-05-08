// Reddit listing proxy — fronts reddit.com/r/{subreddit}/new.json (and
// related listing endpoints) so the ingest-external-announcements pipeline
// can reach Reddit from Vercel + Supabase egress, both of which Reddit
// blocks at the IP layer (302 → /captcha or 429).
//
// Cloudflare Worker IPs are not on Reddit's blocklist today, so this
// worker cleanly passes through provided we send a real User-Agent.
// Anonymous/empty UAs get hard-blocked.
//
// Routes (GET only — Reddit listing endpoints don't take POST):
//   GET /r/<subreddit>/new.json[?limit=N]
//   GET /r/<subreddit>/hot.json
//   GET /r/<subreddit>/top.json[?t=day]
//   GET /comments/<id>.json
//
// The path is forwarded verbatim to https://www.reddit.com{path}; query
// params pass through. Anything other than the documented prefixes returns
// 404 to avoid being a generic open relay.
//
// Auth: X-Proxy-Secret header must match env.PROXY_SECRET (same shared
// secret pattern as topshot-proxy / pinnacle-proxy / etc — a single
// rotation rotates all workers).

const UPSTREAM_BASE = "https://www.reddit.com";
const ALLOWED_PREFIXES = [/^\/r\/[A-Za-z0-9_]+\/(new|hot|top|rising)\.json$/, /^\/comments\/[A-Za-z0-9_]+\.json$/];
// Reddit hard-blocks the default cf-fetcher / null UAs and the generic
// "Mozilla/..." UA gets soft-throttled. Their docs ask for a contact-aware
// UA — use this format and update if anyone has a complaint.
const USER_AGENT = "rip-packs-city-announcements/0.1 (by /u/rippackscity; ops contact: tdillonbond@gmail.com)";
const CACHE_TTL_SECONDS = 60;

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, X-Proxy-Secret",
          "Access-Control-Max-Age": "86400",
        },
      });
    }
    if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });

    const authHeader = request.headers.get("X-Proxy-Secret");
    if (!authHeader || authHeader !== env.PROXY_SECRET) {
      return new Response("Unauthorized", { status: 401 });
    }

    const url = new URL(request.url);
    const allowed = ALLOWED_PREFIXES.some((re) => re.test(url.pathname));
    if (!allowed) {
      return new Response(JSON.stringify({ error: "path_not_allowed", pathname: url.pathname }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }

    const upstreamUrl = `${UPSTREAM_BASE}${url.pathname}${url.search}`;
    const cache = caches.default;
    const cacheKey = new Request(upstreamUrl, { method: "GET" });

    const cached = await cache.match(cacheKey);
    if (cached) {
      const out = new Response(cached.body, cached);
      out.headers.set("X-Cache", "HIT");
      out.headers.set("Access-Control-Allow-Origin", "*");
      return out;
    }

    let upstreamRes;
    try {
      upstreamRes = await fetch(upstreamUrl, {
        method: "GET",
        headers: {
          "User-Agent": USER_AGENT,
          "Accept": "application/json",
        },
        cf: { cacheTtl: CACHE_TTL_SECONDS, cacheEverything: true },
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: "upstream_fetch_failed", detail: String(err).slice(0, 200) }), {
        status: 502,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
    }

    const body = await upstreamRes.text();
    const out = new Response(body, {
      status: upstreamRes.status,
      headers: {
        "Content-Type": upstreamRes.headers.get("content-type") ?? "application/json",
        "Cache-Control": `public, max-age=${CACHE_TTL_SECONDS}`,
        "Access-Control-Allow-Origin": "*",
        "X-Cache": "MISS",
      },
    });

    if (upstreamRes.ok) {
      ctx.waitUntil(cache.put(cacheKey, out.clone()));
    }
    return out;
  },
};

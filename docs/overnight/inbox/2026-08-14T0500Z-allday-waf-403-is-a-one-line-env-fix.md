# All Day's WAF 403 is almost certainly a ONE-LINE env change — `ALLDAY_PROXY_URL` route

**Filed** 2026-08-14 05:00Z by Claude Code (interactive), by reading `workers/topshot-proxy/` rather than
guessing. Supersedes the "operator question, unresolved" framing in
`2026-08-14T0330Z-search-players-by-college.md`.
**Status** QUEUED — needs ONE env-var change + a probe re-run. No code change required.
**Severity** medium-high. Blocks All Day descriptions, player bio, and college — a whole collection.

## The symptom

`/api/admin/discover-moment-descriptors` (2026-08-13) returned All Day **INCONCLUSIVE**: `HTTP 403` with an
HTML `<title>block</title>` page, on the CONTROL fields. Separately, `ALLDAY_RELAY_QUERY` in
`lib/editions-hydrate.ts` has selected `play { description }` since 2026-08-11 and All Day still holds
**ZERO** descriptions (6,190 editions, 0 prose). Same wall, two symptoms.

## What the worker source actually says

`workers/topshot-proxy/index.js`:

```
UPSTREAM_MAP = {
  "allday":          "https://public-api.nflallday.com/graphql",
  "allday-consumer": "https://nflallday.com/consumer/graphql",
}
ROUTE_HEADERS = {
  "allday-consumer": { Origin: "https://nflallday.com", Referer: "https://nflallday.com/", "User-Agent": <browser UA> },
}
DEFAULT_UA = "sports-collectible-tool/0.1"
```

**Only `/allday-consumer` carries a browser fingerprint.** `/allday` sends the bare
`sports-collectible-tool/0.1` UA with no `Origin` and no `Referer` — exactly the shape a Cloudflare WAF
blocks. `lib/editions-hydrate.ts` likewise sends only `Content-Type`, `User-Agent:
rip-packs-city/editions-hydrate` and `X-Proxy-Secret`.

And `workers/topshot-proxy/README.md` sets the intended config:

```
TS_PROXY_URL     = https://topshot-proxy.<sub>.workers.dev
ALLDAY_PROXY_URL = https://topshot-proxy.<sub>.workers.dev/allday      <-- /allday, NOT /allday-consumer
```

## The likely fix

    ALLDAY_PROXY_URL = https://topshot-proxy.<sub>.workers.dev/allday-consumer

Two independent reasons that route is right, not one:

1. **Fingerprint.** It is the only All Day route that injects `Origin` / `Referer` / browser UA — the
   headers a WAF checks, and the ones every current caller lacks.
2. **Endpoint correctness.** `allEditions` — the query BOTH the probe arm and `lib/editions-hydrate.ts`
   use — belongs to the **consumer** endpoint. That is `ALLDAY_GQL_DEFAULT` in editions-hydrate
   (`https://nflallday.com/consumer/graphql`) and it is `/allday-consumer`'s upstream. If
   `ALLDAY_PROXY_URL` is currently `/allday`, the query is also being sent to the *wrong endpoint*
   (public-api serves the wallet/marketplace ops), independent of the WAF.

## ⚠ What the 403 does NOT prove, and why I nearly got this wrong

I first concluded "the request never reached the worker, because the worker answers 401 plain-text
`Unauthorized` on bad auth and we saw an HTML 403 instead."

**That inference is invalid.** The worker passes the upstream response straight through:

```
return new Response(data, { status: upstreamRes.status, ... })
```

So an origin block page arrives byte-identical whether we called the origin directly or proxied. The only
response shape that would PROVE the worker was reached is its own plain-text 401. Recorded because it is
the same class of error as everything else this week: reading a downstream artifact as evidence about an
upstream hop.

## Also worth knowing: the worker never 404s on a bad path

```
const matchedRoute = UPSTREAM_MAP[path] ? path : DEFAULT_ROUTE;   // DEFAULT_ROUTE = "topshot"
```

An unrecognised path silently proxies to **Top Shot**. So a typo'd All Day route does not fail loudly —
it sends an All Day query to the Top Shot endpoint and comes back as a confusing GraphQL field error. Worth
a `400` on unknown path, but that is a worker deploy (`wrangler deploy`) and therefore operator-gated.

## The `${TS_PROXY_URL}/allday` regression guard — resolved, not contradicted

`api-admin-discover-moment-descriptors.test.ts` asserts All Day is posted to `ALLDAY_PROXY_URL` and **not**
to a TS_PROXY_URL subpath, recording a V1 404. That looked like it contradicted CLAUDE.md's statement that
the worker exposes `/allday`. It does not: per the README, `ALLDAY_PROXY_URL` **is** a worker subpath
already. The guard's rule is about **where the URL comes from** — read the configured variable, never
rebuild it from `TS_PROXY_URL` and let the two drift — not about what it may point at. Keep the guard.

## Verification (one probe re-run, no code deploy)

After changing the env var and redeploying (⚠ an env change needs a real rebuild — an empty or docs-only
commit is skipped by `vercel.json`'s `ignoreCommand`):

    curl -X POST https://www.rippackscity.com/api/admin/discover-moment-descriptors \
      -H "Authorization: Bearer $RPC_ADMIN_TOKEN"

Read `allday.conclusive`. If the CONTROL fields (`playerName`, `classification`) return `yes`, All Day is
unblocked and the arm's `college` / `school` / bio results become trustworthy in the same response — which
settles the college question for the collection that has most of those players. The new
`allday.transport_ladder` reports per-endpoint status, so a remaining failure names which hop failed.

If it is still 403 after pointing at `/allday-consumer`, the fingerprint is no longer sufficient and the
next lever is the worker itself (add the browser headers to `/allday`, or a fresh UA), which is a
`wrangler deploy`.

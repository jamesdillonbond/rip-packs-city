# Handoff — turn on the `sports-proxy` `/nba/odds` route (operator, ~2 min)

**Date:** 2026-08-08 · **Author:** Claude Code (interactive) · **Status:** code shipped to `main` (`55ab7b9c`), route is inert until you run the two commands below.

## What shipped

`workers/sports-proxy/index.ts` `handleOdds()` was a reserved `501 odds_route_pending_api_key`
stub with a "wire when the key arrives" TODO. It is now a real key-gated pass-through to
`https://api.the-odds-api.com/v4/sports/basketball_nba/odds`, mirroring the dedicated
`odds-proxy` worker:

- Whitelisted POST-body params over sensible defaults (`regions=us`, `markets=h2h,spreads,totals`, `oddsFormat=american`); unknown fields ignored.
- `apiKey` injected from the worker-only `ODDS_API_KEY` secret (never in Vercel/Supabase env or the repo).
- the-odds-api quota headers surfaced as `X-Quota-Remaining` / `X-Quota-Used` / `X-Quota-Last`.
- `502` on upstream failure, 5-min cache on success.

**Honest inert state:** while `ODDS_API_KEY` is unset the route still returns the exact
`501 odds_route_pending_api_key`, so nothing breaks before the key is bound and the two
existing stub tests stay green.

## Why this route exists (it overlaps the dedicated `odds-proxy`)

The dedicated `odds-proxy` worker already fronts the-odds-api.com as a **GET** relay, and the
live `sync-nba-odds` consumer (edge fn + `/api/cron/sync-nba-odds`) reads from it. This new
`sports-proxy` route is a **POST** convenience alias so the odds feed is reachable from the
same `SPORTS_PROXY_URL` surface as the other NBA routes. **No consumer depends on it today** —
it does not need to be turned on for any current pipeline. Turn it on only if you want a
single-surface consumer to use it.

## The two commands (Cloudflare — run locally, needs `wrangler login`)

```sh
cd workers/sports-proxy
wrangler secret put ODDS_API_KEY --name rpc-sports-proxy   # paste the the-odds-api.com key
wrangler deploy
```

That's it. No Vercel deploy, no DB change, no env change on the RPC side.

## Verify

```sh
# 501 before the key is bound / on a worker without the secret:
curl -s -X POST https://rpc-sports-proxy.tdillonbond.workers.dev/nba/odds \
  -H "X-Proxy-Secret: <TS_PROXY_SECRET>" -d '{}'
#   -> {"error":"odds_route_pending_api_key"}   (HTTP 501)

# After the secret is set + deployed:
curl -s -X POST https://rpc-sports-proxy.tdillonbond.workers.dev/nba/odds \
  -H "X-Proxy-Secret: <TS_PROXY_SECRET>" -d '{"regions":"us","markets":"h2h"}'
#   -> JSON array of NBA odds; response carries X-Quota-Remaining
```

## Revert

`git revert 55ab7b9c` (code + docs + test only; nothing deployed to unwind). To disable the
route at runtime without a code change, `wrangler secret delete ODDS_API_KEY --name
rpc-sports-proxy` and redeploy — it falls back to the honest `501`.

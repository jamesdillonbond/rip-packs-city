# Sports Data Proxy Worker

Routes NBA stats, DraftKings, and (future) Odds API requests through Cloudflare
to bypass the Vercel/Supabase egress blocks against `stats.nba.com` and
`api.draftkings.com`.

## Routes

| Path | Upstream | Cache |
|------|----------|-------|
| `POST /nba/scoreboard` | stats.nba.com/stats/scoreboardV2 (pass-through) | 5 min |
| `POST /nba/draftkings-projections` | DraftKings draftgroups + draftables (normalized) | 10 min |
| `POST /nba/odds` | reserved — returns 501 until Odds API key is provisioned | — |

All routes require `X-Proxy-Secret` header matching the worker's `PROXY_SECRET`.

### Request bodies

- `POST /nba/scoreboard` — `{"gameDate": "MM/DD/YYYY"}` (Eastern-day, format the
  same as `stats.nba.com` expects).
- `POST /nba/draftkings-projections` — `{}` (no params; the worker resolves
  today's NBA draft group via the public lobby contests feed, picks the
  most-frequent Classic NBA group whose start date is today in ET, and returns
  its draftables normalized to `{draftGroupId, gameDate, players[...], games[...]}`.
  `games` is the deduplicated list of competitions (one per `competitionId`)
  with parsed `homeAbbr`/`awayAbbr`/`startTime`/`gameDate` so consumers can
  populate `nba_games` from the same payload.) Returns
  `{draftGroupId: null, players: [], games: [], note: "no_nba_slate_today"}`
  on a no-game day so callers can distinguish "scrape worked, no games" from
  a failure.
- `POST /nba/odds` — `{}` (501 until the key arrives).

## Deploy (run locally — needs Cloudflare account)

```sh
npm install -g wrangler
wrangler login
cd workers/sports-proxy
wrangler deploy
wrangler secret put PROXY_SECRET
```

When prompted for `PROXY_SECRET`, paste the **same value** already stored in
the `topshot-proxy` worker's `PROXY_SECRET` (current shared value:
`rpc-proxy-2026`). Both workers are independent secret-rotation surfaces — they
share the value today only for operational simplicity, and either can be rotated
on its own when needed.

After deploy, the worker URL will be:

```
https://rpc-sports-proxy.tdillonbond.workers.dev
```

## Wire into RPC

Add to **Vercel** env (production target):

```
SPORTS_PROXY_URL = https://rpc-sports-proxy.tdillonbond.workers.dev
```

Add to **Supabase project secrets** (dashboard → Project settings → Edge
functions → Secrets):

```
SPORTS_PROXY_URL = https://rpc-sports-proxy.tdillonbond.workers.dev
```

`sync-nba-projections` sends `X-Proxy-Secret: ${TS_PROXY_SECRET}` (existing
Supabase secret, same value as the worker's `PROXY_SECRET`). No new secret is
required on the Supabase side.

## Adding the Odds API key later

When the Odds API key is provisioned:

1. `cd workers/sports-proxy && wrangler secret put ODDS_API_KEY` and paste the
   key.
2. Replace `handleOdds()` in `index.ts` with a real handler that fetches
   `https://api.the-odds-api.com/v4/sports/basketball_nba/odds` with
   `?apiKey=${env.ODDS_API_KEY}`, mirrors the `/nba/scoreboard` pass-through
   shape, and caches for 60 min.
3. `wrangler deploy`.
4. Build the consumer at `supabase/functions/sync-nba-odds/index.ts` per
   `docs/nba-pipelines.md` Prompt 1B.

## Notes

- Cloudflare Workers free tier: 100,000 requests/day — well within budget.
- Worker only accepts `POST` with the correct `X-Proxy-Secret`.
- No data is stored or logged inside the worker.
- CORS preflight (`OPTIONS`) is handled automatically.

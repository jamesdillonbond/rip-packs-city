# Sports Data Proxy Worker

Routes NBA stats, DraftKings, and Odds API requests through Cloudflare to bypass
the Vercel/Supabase egress blocks against `stats.nba.com` and
`api.draftkings.com`, and to keep the the-odds-api.com key out of Vercel/Supabase
env.

## Routes

| Path | Upstream | Cache |
|------|----------|-------|
| `POST /nba/scoreboard` | stats.nba.com/stats/scoreboardV2 (pass-through) | 5 min |
| `POST /nba/draftkings-projections` | DraftKings draftgroups + draftables (normalized) | 10 min |
| `POST /nba/odds` | the-odds-api.com NBA odds (pass-through; key-gated, 501 until `ODDS_API_KEY` bound) | 5 min |

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
- `POST /nba/odds` — optional JSON body, all fields optional:
  `{regions, markets, oddsFormat, dateFormat, eventIds, bookmakers,
  commenceTimeFrom, commenceTimeTo}`. Defaults to
  `regions=us`, `markets=h2h,spreads,totals`, `oddsFormat=american`; unknown
  fields are ignored (whitelist). Relays to
  `api.the-odds-api.com/v4/sports/basketball_nba/odds` with the key injected as
  `?apiKey=`, and surfaces the-odds-api quota headers as
  `X-Quota-Remaining`/`X-Quota-Used`/`X-Quota-Last`. Returns 501
  (`odds_route_pending_api_key`) while `ODDS_API_KEY` is unset.

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

## Enabling the Odds API route

The `/nba/odds` handler is wired (pass-through to the-odds-api.com with the key
injected as `?apiKey=`, mirroring the dedicated `odds-proxy` worker). It stays a
501 (`odds_route_pending_api_key`) until the key is bound, so no code change is
needed to turn it on:

1. `cd workers/sports-proxy && wrangler secret put ODDS_API_KEY --name rpc-sports-proxy`
   and paste the key.
2. `wrangler deploy`.
3. Build the consumer at `supabase/functions/sync-nba-odds/index.ts` per
   `docs/nba-pipelines.md` Prompt 1B.

> Note: the dedicated `odds-proxy` worker also fronts the-odds-api.com (as a GET
> relay). This route exists so the odds feed can be consumed from the same
> `SPORTS_PROXY_URL` surface as the other NBA routes; either can be used.

## Notes

- Cloudflare Workers free tier: 100,000 requests/day — well within budget.
- Worker only accepts `POST` with the correct `X-Proxy-Secret`.
- No data is stored or logged inside the worker.
- CORS preflight (`OPTIONS`) is handled automatically.

# NBA pipelines (Fast Break + Road to the Ring)

These two Supabase edge functions feed `nba_games`, `nba_players`,
`nba_player_projections`, and `nba_player_aliases` for the Top Shot Fast
Break optimizer (`/api/fast-break/*`) and the RTR picks recommender
(`/api/rtr/*`).

DraftKings is the single source for both `nba_games` and
`nba_player_projections` — `sync-nba-projections` reads the DK draftables
payload once per run and writes both tables. Live scores are not currently
tracked (deferred to a future ESPN-based scores pipeline if needed).

The third source — sportsbook moneylines — lives in a separate edge
function (`sync-nba-odds`) gated on an Odds API key. The Cloudflare Worker
hop is already in place (`workers/sports-proxy` exposes `/nba/odds` as a
501 placeholder); when the key arrives, swap the placeholder for a real
upstream fetch and ship `sync-nba-odds` per Prompt 1B.

Both functions follow the same patterns as `compute-topshot-pack-ev`:
service-role client, `Bearer ${INGEST_SECRET_TOKEN}` auth, background work
via `EdgeRuntime.waitUntil`, structured logging through the
`log_pipeline_run` RPC. The HTTP response returns immediately; the actual
work is observable in `pipeline_runs` filtered by pipeline name.

## Architecture (proxy hop)

`api.draftkings.com` blocks Vercel and Supabase egress IPs.
`sync-nba-projections` therefore goes through the `rpc-sports-proxy`
Cloudflare Worker rather than calling upstream directly. That single
proxy call returns both projections AND today's games (derived from the
`competition` field on each draftable), so a single edge-function
invocation populates both `nba_games` and `nba_player_projections`:

```
sync-nba-projections  ──POST /nba/draftkings-projections──►  rpc-sports-proxy  ──►  api.draftkings.com/draftgroups/v1/...
                          (returns both `players[]` and `games[]` for the slate)
                              │
                              └──► writes nba_games (upsert by external_game_id) THEN nba_player_projections

sync-nba-odds (TODO)  ──POST /nba/odds─────────────────────►  rpc-sports-proxy  ──►  api.the-odds-api.com (pending key)
```

The edge function sends `X-Proxy-Secret: ${TS_PROXY_SECRET}`. The worker
compares against `env.PROXY_SECRET`. The two binding names exist so the
secret can be rotated independently of `topshot-proxy` if needed; today
they share the same value (single rotation surface). See
`workers/sports-proxy/README.md` for deploy + secret commands.

The `/nba/scoreboard` route on the worker is retained as a transparent
pass-through (5 min cache) but no edge function consumes it today — kept
in place in case a future scores pipeline needs it via a different
upstream. The `/nba/draftkings-projections` route does the multi-call DK
shape parsing inside the worker — finds today's NBA Classic draft group
from the lobby contests feed, fetches `/draftables` for it, dedupes
CPT/UTIL slot duplicates, derives the unique-by-`competitionId` games
list, and returns `{draftGroupId, gameDate, players[...], games[...]}`.
The edge function only consumes the cleaner shape (10 min cache).

---

## sync-nba-projections

**What it does.** Pulls today's NBA DraftKings projections (FP, salary,
status, opponent) AND today's games (parsed from the same draftables
payload) from `api.draftkings.com` (via the `rpc-sports-proxy` Cloudflare
Worker). Upserts into `public.nba_games` first (so the immediately-
following game-match step picks them up), then upserts into
`public.nba_player_projections` with `source = 'draftkings'`. Resolves
players against `nba_players.full_name_normalized` first, then
`nba_player_aliases.alias_normalized`, then auto-INSERTs a new
`nba_players` row if neither hits.

**Proxy hop.** The function `POST`s
`{SPORTS_PROXY_URL}/nba/draftkings-projections` with `{}` body and
`X-Proxy-Secret: ${TS_PROXY_SECRET}` header. The worker:
1. Calls `GET https://www.draftkings.com/lobby/getcontests?sport=NBA` to
   discover the active draft group (`/draftgroups/v1/draftgroups` returns
   400 without filters and is not viable as a discovery surface).
2. Filters to Classic NBA contests (`gameTypeId === 70`) grouped by `dg`,
   keeps groups whose start date (in ET) is today, and picks the most
   referenced (largest contest count for that draft group).
3. Calls `GET .../draftgroups/v1/draftgroups/{id}/draftables` for that
   group.
4. Dedupes CPT/UTIL slot duplicates (keeps the smallest `rosterSlotId`
   entry), and additionally derives the unique-by-`competitionId` games
   list from the same draftables payload — each `competition.name` is
   parsed `"{AWAY} @ {HOME}"` into `homeAbbr`/`awayAbbr`, `startTime` is
   passed through, and `gameDate` is the ET-day of `startTime`.
5. Returns `{draftGroupId, gameDate, players: [{name, teamAbbr, position,
   salary, status, projFp, opponentAbbr, gameStartTime}], games: [{gameId,
   name, homeAbbr, awayAbbr, startTime, gameDate}]}`.
6. On a no-game day returns `200` with
   `{draftGroupId: null, players: [], games: [], note: "no_nba_slate_today"}`
   so the edge function logs a benign skip rather than an error.

The edge function consumes the already-clean shape — no DK-specific
parsing remains on the Supabase side.

**Game upsert (replaces sync-nba-games).** The retired `sync-nba-games`
pipeline (which scraped `stats.nba.com/scoreboardV2`) was dropped entirely
on 2026-05-06; DK's `competition` data on each draftable is now the single
source of truth for `nba_games`. The edge function calls
`upsertGames(proxy.games, gameDate, started)` BEFORE the player resolver
runs so `loadTodaysGames(gameDate)` picks up the just-inserted rows on
the same invocation. Mapping is direct:

| `nba_games` column | DK source field | Notes |
|---|---|---|
| `external_game_id` | `competition.competitionId` (stringified) | DK namespace, distinct from the legacy 0042400301-style stats.nba.com IDs |
| `game_date` | derived from `competition.startTime` (ET-day) | falls back to `proxy.gameDate` if `startTime` is missing |
| `home_team_abbr` | parsed right side of `"{AWAY} @ {HOME}"` | |
| `away_team_abbr` | parsed left side of `"{AWAY} @ {HOME}"` | |
| `tipoff_at` | `competition.startTime` (already ISO with TZ) | |
| `status` | derived from `startTime` vs `now()`: `> 4h ago` → `final`, `±4h` → `live`, else `scheduled` | DK doesn't expose live game state; this is a coarse heuristic |
| `home_score`, `away_score` | left NULL | DK doesn't provide live scores |

`onConflict: external_game_id`. Rows missing parsed home/away are counted
as `games_skipped` in `pipeline_runs.extra` rather than written. Live
scores are deferred to a future pipeline (likely ESPN-based) when needed.

**Player resolution.** JS-side normalization mirrors
`public.normalize_player_name`: `NFD` → strip combining marks → strip
non-alphabetic → lowercase. Edge cases (e.g. `Đ`, `ø`) that JS NFD doesn't
decompose cleanly are caught on the alias-lookup pass (which runs against
the SQL canonical form once `match-topshot-players` has aliased it).

**Game matching.** For each matched player, joins the team abbreviation
against today's `nba_games` row where `home_team_abbr` or
`away_team_abbr` equals the team. Players on non-playing teams are
counted as `no_game_match_count` and a sample of names goes into
`pipeline_runs.extra.no_game_match_samples` for visibility.

**UNIQUE.** `(nba_player_id, game_id, source)`. The same player can carry
projections from multiple sources later without conflict.

**Injury status mapping.** Empty / `NONE` / `GO` / `AVAILABLE` →
`ACTIVE`. `GTD`, `Q`, `QUESTIONABLE`, `DTD` → `QUESTIONABLE`. `OUT`,
`INJ`, `INJURED`, `OFS` → `OUT`. Confidence is fixed at `MED` for v1.

**Trigger.**

```
curl -X POST \
  -H "Authorization: Bearer $INGEST_SECRET_TOKEN" \
  https://bxcqstmqfzmuolpuynti.supabase.co/functions/v1/sync-nba-projections
```

**Cron-job.org schedule.** Every 2 hr from 12pm ET through 1am ET (8 runs
per active-game day). The DFF page typically updates around mid-morning
ET for that night's slate; running before noon ET gives stale data.

---

## match-topshot-players

**What it does.** One-shot backfill that walks distinct
`wallet_moments_cache.player_name` values for the Top Shot collection
(`95f28a17-224a-4025-96ad-adf8a4c63bfd`), separates already-resolved names
(via `nba_players.full_name_normalized` OR
`nba_player_aliases.alias_normalized`) from unresolved, and runs `pg_trgm`
similarity against `nba_players.full_name`. Auto-INSERTs into
`nba_player_aliases` (with `source = 'auto'`) when there's exactly one
match above 0.85. Names with zero matches OR ≥2 ambiguous matches AND ≥5
distinct owning wallets land in `pipeline_runs.extra.needs_manual_review`
for hand-curation.

**Where the SQL lives.** `public.match_topshot_players_run()` (added in
the matching migration). The edge function is a thin wrapper around a
single RPC call so the heavy lifting stays one round-trip from Postgres.
Service-role only — `EXECUTE` is revoked from `PUBLIC`, `anon`,
`authenticated`.

**Idempotent.** `nba_player_aliases.alias_normalized` is `UNIQUE`; the
RPC uses `ON CONFLICT DO NOTHING`. Safe to run nightly.

**Threshold rationale.** 0.85 is high enough to avoid Donovan-Mitchell /
Mitchell-Robinson collisions. The uniqueness check
(`candidate_count = 1`) catches the few cases where two different NBA
players are both above the threshold for the same input.

**Trigger.**

```
curl -X POST \
  -H "Authorization: Bearer $INGEST_SECRET_TOKEN" \
  https://bxcqstmqfzmuolpuynti.supabase.co/functions/v1/match-topshot-players
```

**Cron-job.org schedule.** Once daily at 4am ET. Catches new wallets
indexed during the day without colliding with the every-2-hour projections
refresh.

---

## Verification checklist after first deploy

After `supabase functions deploy <name>` for each:

1. **sync-nba-projections** — POST it once. Confirm both halves wrote:
   - `SELECT COUNT(*) FROM nba_games WHERE game_date = current_date;`
     matches the expected slate.
   - `SELECT COUNT(*) FROM nba_player_projections WHERE game_date = current_date AND source = 'draftkings';`
     returns at least 100 rows on a normal slate (DK exposes the full
     roster, not just chalk plays).
   - In the latest `pipeline_runs` row, `extra.games_total` and
     `extra.games_upserted` should both be ≥ 1, and `extra.no_game_match_count`
     should drop to near zero (residual gap is players in the contest pool
     whose team isn't on the slate — happens occasionally on DK).
   - On the first run after switching to the worker,
     `pipeline_runs.extra.players_auto_inserted` will be high (the seed only
     covers ~70 players); subsequent runs trend to ~0.
2. **match-topshot-players** — POST it once. Inspect the latest
   `pipeline_runs` row for this pipeline; the `extra.summary.auto_aliased`
   counter should be > 0 on the first run if there are any
   wallet_moments_cache names that didn't already alias. Subsequent runs
   should report `auto_aliased = 0` until new wallets are scanned.

If either function logs `error: "missing_proxy_env"`, set
`SPORTS_PROXY_URL` and confirm `TS_PROXY_SECRET` exist in the Supabase
edge-function secrets dashboard. If either logs `proxy_HTTP_502` with
`upstream_error` / `body_excerpt` populated, the worker reached upstream
and upstream rejected — inspect the body excerpt before redeploying.

---

## Cron-job.org configuration table

| Job | Schedule | Endpoint |
|---|---|---|
| sync-nba-projections | every 2 hr 12pm-1am ET | `POST /functions/v1/sync-nba-projections` |
| match-topshot-players | once daily at 4am ET | `POST /functions/v1/match-topshot-players` |

> The legacy `sync-nba-games` job (every 30 min, scoreboardV2) was retired
> on 2026-05-06 along with its edge function. Remove the entry from
> cron-job.org by hand if it's still scheduled there.

All three carry `Authorization: Bearer $INGEST_SECRET_TOKEN` (same token
as the rest of the cron-job.org fleet — see `docs/TOKEN_ROTATION.md`
when rotating).

---

## Where Prompt 1B (sync-nba-odds) plugs in

The Cloudflare hop is already shipped — `rpc-sports-proxy` exposes
`POST /nba/odds` as a 501 placeholder returning
`{error: "odds_route_pending_api_key"}`.

Once the Odds API key is registered:
- Add `ODDS_API_KEY` to `rpc-sports-proxy` via
  `wrangler secret put ODDS_API_KEY` and replace the `handleOdds()`
  placeholder in `workers/sports-proxy/index.ts` with a fetch against
  `https://api.the-odds-api.com/v4/sports/basketball_nba/odds`
  (passing `?apiKey=${env.ODDS_API_KEY}`). Mirror the
  `/nba/scoreboard` pass-through pattern; cache 60 min.
- `supabase/functions/sync-nba-odds` — POSTs `{SPORTS_PROXY_URL}/nba/odds`
  with `X-Proxy-Secret: ${TS_PROXY_SECRET}`, matches odds-API events to
  `nba_games` rows by team abbreviation + `game_date`, writes
  `home_moneyline`, `away_moneyline`, `home_spread`, `total_points`,
  `last_synced_at`. Skips games with `status = 'final'`. Cron every
  60 min during NBA active hours (4pm-2am ET) to stay under the
  500-req/month free tier.

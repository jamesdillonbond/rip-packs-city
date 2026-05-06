# NBA pipelines (Fast Break + Road to the Ring)

These three Supabase edge functions feed `nba_games`, `nba_players`,
`nba_player_projections`, and `nba_player_aliases` for the Top Shot Fast
Break optimizer (`/api/fast-break/*`) and the RTR picks recommender
(`/api/rtr/*`).

The fourth source — sportsbook moneylines — lives in a separate edge
function (`sync-nba-odds`) plus a Cloudflare Worker (`workers/odds-proxy`)
gated on an Odds API key. That layer ships separately as Prompt 1B.

All three functions follow the same patterns as `compute-topshot-pack-ev`:
service-role client, `Bearer ${INGEST_SECRET_TOKEN}` auth, background work
via `EdgeRuntime.waitUntil`, structured logging through the
`log_pipeline_run` RPC. The HTTP response returns immediately; the actual
work is observable in `pipeline_runs` filtered by pipeline name.

---

## sync-nba-games

**What it does.** Pulls today's NBA schedule from
`https://stats.nba.com/stats/scoreboardV2` and upserts into
`public.nba_games` keyed on `external_game_id`.

**Headers required.** `stats.nba.com` 403s requests without realistic
browser headers. The function sets `User-Agent` (Chrome 124),
`Referer: https://www.nba.com/`, `Origin: https://www.nba.com`,
`x-nba-stats-origin: stats`, `x-nba-stats-token: true`.

**Date handling.** `GAME_DATE_EST` is the ET-day the game belongs to. The
function uses `Intl.DateTimeFormat("America/New_York")` for both the
`MM/DD/YYYY` API parameter and the `YYYY-MM-DD` `game_date` column.

**Status mapping.** `GAME_STATUS_ID`: 1 → `scheduled`, 2 → `live`,
3 → `final`. Anything else is logged as `unknown_status_count` in
`pipeline_runs.extra` and stored as `scheduled`.

**Tipoff parsing.** Best-effort. Before tipoff, `GAME_STATUS_TEXT` carries
a string like `"7:00 pm ET"`. The function parses that, combines with
`GAME_DATE_EST` and the live `Intl` ET offset (EDT/EST aware), and stores
as `tipoff_at`. Once a game is live or final, that string switches to
`"Q3 5:23"` / `"Final"` and parsing returns `null`.

To prevent live/final polls from nulling out a previously-stored tipoff,
the upsert is two-pass:

1. Pass 1 sends only the always-fresh fields (`status`, `home_score`,
   `away_score`, etc). `tipoff_at` is omitted, so the existing column value
   is preserved on update.
2. Pass 2 sends `tipoff_at` for the subset of games where the current poll
   parsed it successfully.

**Failure behaviour.** Non-200 from `stats.nba.com`, network errors, or
JSON parse failures all log to `pipeline_runs` with `ok=false` and exit
without touching existing rows. **Never delete or null any nba_games row
on a failed poll.**

**Trigger.**

```
curl -X POST \
  -H "Authorization: Bearer $INGEST_SECRET_TOKEN" \
  https://bxcqstmqfzmuolpuynti.supabase.co/functions/v1/sync-nba-games
```

**Cron-job.org schedule.** Every 30 min, no time restriction.
`*/30 * * * *`.

---

## sync-nba-projections

**What it does.** Scrapes
`https://www.dailyfantasyfuel.com/nba/projections` for today's NBA
DraftKings projections (FP, minutes, status) and upserts into
`public.nba_player_projections` with `source = 'dailyfantasyfuel'`.
Resolves players against `nba_players.full_name_normalized` first, then
`nba_player_aliases.alias_normalized`, then auto-INSERTs a new
`nba_players` row if neither hits.

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

**Injury status mapping.** Empty / `NONE` / `GO` → `ACTIVE`. `GTD`,
`Q`, `QUESTIONABLE`, `DTD` → `QUESTIONABLE`. `OUT`, `INJ`, `INJURED`,
`OFS` → `OUT`. Confidence is fixed at `MED` for v1.

**Scraping risk.** DFF can change page structure. The extractor tries two
strategies in order:
1. Inline JSON blob (`__NEXT_DATA__`, `window.__INITIAL_STATE__`,
   `window.__NUXT__`, `var projectionsData = …`).
2. HTML `<table>` with a recognizable header row containing "Player"
   and "Proj" columns.

If both miss, the function logs `error: "no_rows_parsed"` plus an HTML
excerpt to `pipeline_runs.extra.body_excerpt` so the parser can be
adjusted without redeploying blind.

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
indexed during the day without colliding with the 30-min `sync-nba-games`
cycle or the every-2-hour projections refresh.

---

## Verification checklist after first deploy

After `supabase functions deploy <name>` for each:

1. **sync-nba-games** — POST it once. Confirm
   `SELECT COUNT(*) FROM nba_games WHERE game_date = current_date;` matches
   the expected slate (2 conference-semis games on 2026-05-05).
2. **sync-nba-projections** — POST it once after `sync-nba-games` has
   populated today's slate. Confirm
   `SELECT COUNT(*) FROM nba_player_projections WHERE game_date = current_date AND source = 'dailyfantasyfuel';`
   returns at least 30 rows (typically 50-150 depending on slate size).
3. **match-topshot-players** — POST it once. Inspect the latest
   `pipeline_runs` row for this pipeline; the `extra.summary.auto_aliased`
   counter should be > 0 on the first run if there are any
   wallet_moments_cache names that didn't already alias. Subsequent runs
   should report `auto_aliased = 0` until new wallets are scanned.

If `sync-nba-projections` returns `error: "no_rows_parsed"`, inspect
`pipeline_runs.extra.body_excerpt` — the DFF page structure has shifted
and the regex extractors need adjustment.

---

## Cron-job.org configuration table

| Job | Schedule | Endpoint |
|---|---|---|
| sync-nba-games | `*/30 * * * *` (every 30 min) | `POST /functions/v1/sync-nba-games` |
| sync-nba-projections | every 2 hr 12pm-1am ET | `POST /functions/v1/sync-nba-projections` |
| match-topshot-players | once daily at 4am ET | `POST /functions/v1/match-topshot-players` |

All three carry `Authorization: Bearer $INGEST_SECRET_TOKEN` (same token
as the rest of the cron-job.org fleet — see `docs/TOKEN_ROTATION.md`
when rotating).

---

## Where Prompt 1B (odds-proxy + sync-nba-odds) plugs in

Once the Odds API key is registered:
- `workers/odds-proxy` — Cloudflare Worker proxy mirroring
  `topshot-proxy`. Bypasses the Vercel/Supabase egress block on
  `the-odds-api.com`. `X-Proxy-Secret` matches `TS_PROXY_SECRET`.
- `supabase/functions/sync-nba-odds` — pulls
  `https://api.the-odds-api.com/v4/sports/basketball_nba/odds` via the
  worker, matches odds-API events to `nba_games` rows by team
  abbreviation + `game_date`, writes `home_moneyline`, `away_moneyline`,
  `home_spread`, `total_points`, `last_synced_at`. Skips games with
  `status = 'final'`. Cron every 60 min during NBA active hours
  (4pm-2am ET) to stay under the 500-req/month free tier.

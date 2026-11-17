# Full platform audit — 2026-07-10 (interactive Cowork, Trevor-directed)

**Scope:** DB integrity, all 4 scheduler surfaces, 339-page programmatic sweep (250 editions / 50 packs / 20 sets / 20 teams incl. auth+SEO+images), Chrome visual QA (edition/moment/pack/team/board pages, all 4 collections), competitor pass (dapper.market, ufcstrike.com, disneypinnacle.com), scheduled-task output review, FMV/pack-EV parity review.

## Verdict

Platform is GREEN and deep: 339/339 sampled pages 200 with no login leaks, FMV present on 100% of sampled pages and **0 editions with >=3 sales/90d lacking FMV**, parallels 0 orphans, badge inheritance 5/5 pass, username resolution 98.4% of active traders, sitemap/canonical/OG/robots all crawler-clean, all 87 cron-job.org entries enabled, GHA green, Sentry 0 unresolved. The real findings are below.

## Shipped this session

| Item | What | Revert |
|---|---|---|
| `audit_20260710_circ_floor_raise_impossible_parallel_stragglers` | Floor-raised `circulation_count` to max sold serial for the 4 `::` stragglers (`118:4134::8` 1→9, `223:7518::20` 7→8, `224:7680::21` 1→5, `224:7684::21` 3→4). Trust breach `topshot_impossible_parallel_serials` **4→0**. Evidence-based (a sale at serial N proves circ>=N), NOT a blind hand-edit; audit table carries old values. | `UPDATE editions e SET circulation_count=a.old_circ FROM audit_20260710_circ_floor_raise a WHERE e.external_id=a.external_id AND e.collection_id='95f28a17-224a-4025-96ad-adf8a4c63bfd'` |
| `audit_20260710_pack_dist_title_mojibake_fix` | 43 double-encoded pack titles fixed (ElClÃ¡sico→ElClásico, Gaudí, Charrúa; Golazos+AllDay). 0 remaining. | `UPDATE pack_distributions pd SET title=a.old_title FROM audit_20260710_pack_title_mojibake a WHERE pd.id=a.id` |
| `audit_20260710_allday_pack_dist_totals_sync` | AllDay `pack_distributions` never carried minted/opened (generated cols sealed+depletion therefore 0 on all 3,052) → board depletion showed 0.0% everywhere. New SECDEF `sync_allday_pack_dist_totals()` from `v_allday_pack_info`, backfilled (**2,906 dists now carry real depletion**), pg_cron `rpc-sync-allday-pack-dist-totals` @ `12,42 * * * *`. secdef violations []. | `cron.unschedule` + `DROP FUNCTION` + NULL the cols (in migration comment) |
| `audit_20260710_pack_table_rows_depletion_coalesce` | `pack_table_rows.depletion_pct` falls back to EV-pipeline depletion when pd has none (fixes Golazos EV rows). | recreate view with `pd.depletion_pct` (prior def in migration history) |
| `4969aef` (code) | Stress-test dists hidden on every collection board (TS "2026 Stress Test Pack 5" was headlining); tier chips humanized (`In_season_standard`→"in season standard"); PriceCell dash instead of $0.00 when no price data. | `git revert 4969aef` |

## Operator items (Trevor — this machine)

1. **Two home Task Scheduler ingests are down** (both need residential egress; Atlas WAF blocks Vercel + GHA):
   - **"RPC Deal Board Ingest"** (topshot-active-listings, every 3h) — last ok **07-07 22:13Z**. `topshot_active_listings` stale 2+ days; 208 rows still `active=true` unverified → serial-board asks unverified until it runs.
   - **"RPC AllDay Badge Ingest"** — last ok **07-06 12:37Z**.
   Check Task Scheduler (both are "run while logged on" — a reboot/logoff ~07-07 likely stopped them); logs at `%LOCALAPPDATA%\rpc-deal-board-ingest\ingest.log` and `%LOCALAPPDATA%\rpc-allday-badge-ingest\`.
2. `.env.local` `INGEST_SECRET_TOKEN` does not authenticate against admin routes (page-gate `?token=` works, Bearer on `/api/admin/*` 401s) — matches the known stale-token note; sync when convenient.

## Queued (CC / next passes)

1. **VERCEL-CRON-MISATTRIB-DRAIN-500 (MED).** `/api/admin/drain-topshot-misattribution?rekey=1` (daily 11:00Z Vercel cron) has 500'd instantly since 07-07 (last ok 07-06 11:00Z) with ZERO function output and no `pipeline_runs` row — the classic pre-logger crash class. Repro: the cron fires with `CRON_SECRET`; manual Bearer probes with the local INGEST token 401 (stale local token). Lever: wrap the handler top in try/catch→`log_pipeline_run`, or `vercel logs` the next 11:00Z tick; suspect env/import-level failure introduced 07-06→07-07.
2. **ALLDAY-MARKETPLACE-GQL-403 (MED).** `allday-listing-cache` marketplace leg logs `GQL page 0 http 403: <title>block</title>` + `marketplace fetch returned 0 rows` — Cloudflare WAF now blocks this Vercel-egress GQL call. Route it through `topshot-proxy /allday` like every other AllDay GQL read (ingest-path change → CC with diff; do not auto-ship).
3. **UFC market plane decision (strategy, Trevor).** ufcstrike.com now banners **"MIGRATE TO APTOS"** — UFC Strike is leaving Flow. Flow-side UFC sales frozen since 2026-05-13 (813,435 historical sales intact), cached_listings UFC = 1 row, dapper.market does not list UFC. RPC options: (a) mark UFC "historical / migrated to Aptos" honestly in UI copy + stop UFC live-market crons; (b) treat Aptos as a possible future chain (out of thesis for now). Nothing in trust-health watches UFC sales recency — deliberately add nothing until the decision.
4. **UFC unmapped bridge (LOW).** 262 unresolved `unmapped_sales` rows (newest sold_at 2026-04-18) — the pipeline-alert "edition-resolution bridge pending". Historical completeness only.
5. **fmv-recalc step1a failure creep (watch, existing family).** 12 fails/24h all at `step1a_edition_page` — highest-frequency failure in the fleet; folds into FMV-RECALC-EDITION-FETCH-TIMEOUT-CREEP + DAYTIME-CONTENTION.
6. **wallet-username-resolver 60s timeouts (LOW).** ~5 ticks/day fail at exactly 60s with resolved:0 (route budget, not the resolver — coverage is 98.4% and latest ticks ok). If it grows, raise the route budget or shrink batch (300).
7. **Soft-404 class (LOW, SEO).** Streamed `notFound()` pages return 200 + doubled-suffix title + wrong canonical (`/nba-top-shot/team/ogs`, exhibition teams, UUID-fossil editions). Not in sitemap; add noindex/404-status on the streamed notFound path when touching those routes.
8. **Recharts container warning spam** (`width(-1)/height(-1)`) on edition-page SSR logs — cosmetic log pollution, FmvHistoryChart container sizing.
9. **Cosmetics:** `25-26&#x27;` apostrophe artifact in pack titles; trailing-hyphen set slugs (`denied-`) round-trip fine (leave unless slug churn is acceptable); `/pinnacle/*` (wrong slug) falls back to TS-branded "coming soon" instead of 404.

## Parity review (FMV / Pack EV across collections)

| Capability | TS | AllDay | Golazos | Pinnacle | UFC |
|---|---|---|---|---|---|
| FMV (sales+ask) | ✅ H+M 5,173 | ✅ H+M 805 | ✅ (thin, honest) | ✅ render-keyed | frozen w/ market |
| Pack EV | ✅ 1,187 dists, calibrated | ✅ 521 + reality board | ✅ 27 | ✅ 78 supply-weighted | n/a (no packs) |
| Serial/jersey FMV | ✅ power+jersey models | ❌ **gap** | ❌ (too thin) | ✅ render serial-premium | ❌ |
| Special-serial owners board | ✅ | ✅ | declined (sparse) | ❌ (unassessed) | declined (sparse) |
| Badges | ✅ | ✅ (Atlas) | ❌ no source | n/a | ❌ no source |
| Offers indexed | ✅ (subedition-aware) | ❌ **gap** | ❌ | ❌ | ❌ |
| Sales depth | 2020→ | 2022-11→ (pre-2023 needs spork worker, operator-gated) | 2022-11→ | 2024-12→ | 2022→05-2026 (frozen) |

Top parity plays: **AllDay serial/jersey FMV port** (models exist, data exists: 12k jersey-numbered editions is TS — AllDay equivalents need `editions.jersey_number` coverage first) and **AllDay offers indexing** (DapperOffersV2 covers AllDay; the TS offers indexer is the template).

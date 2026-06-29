---
name: rpc-data
description: Rip Packs City data-warehouse context — load when querying or analyzing the RPC Supabase database (project bxcqstmqfzmuolpuynti): FMV, sales, editions, wallets, pack EV, pack history, pipelines, traction. Triggers on "query RPC", "how many", "analyze our data", "pull the numbers", or any write-query/analyze task against RPC. Encodes collection UUIDs, the two collection vocabularies, enum casing, partitioning, the canonical-edition predicate, and canonical query patterns so SQL is correct first time.
---

# RPC data-warehouse context

Postgres on Supabase, project `bxcqstmqfzmuolpuynti`. Read via `execute_sql` (one statement per call; PostgREST/MCP caps large reads — use `LIMIT`). Pair with the `data` plugin's analyze / write-query skills. Always confirm columns with `information_schema.columns` before a non-trivial query.

## Collections — two vocabularies (critical)

| Vocabulary | Used by | Values |
|---|---|---|
| Long-form | `sales`, `editions`, `collections.slug` | `nba_top_shot`, `nfl_all_day`, `laliga_golazos`, `disney_pinnacle`, `ufc_strike` |
| Short-form | `flowty_*` tables (CHECK-constrained) | `topshot`, `allday`, `golazos`, `pinnacle`, `ufc` |

Bridge view: `analytics_sales` (long→short). **Collection UUIDs:** TopShot `95f28a17-224a-4025-96ad-adf8a4c63bfd` · AllDay `dee28451-5d62-409e-a1ad-a83f763ac070` · Golazos `06248cc4-b85f-47cd-af67-1855d14acd75` · UFC `9b4824a8-736d-4a96-b450-8dcc0c46b023` · Pinnacle `7dd9dd11-e8b6-45c4-ac99-71331f959714`. Every dependent row reaches chain via `collection_id` FK; `collection_chains` view is the canonical join. All 5 published = `chain='flow'`.

## Key tables

- **`editions`** (29 cols) — `external_id`: integer-pair `setID:playID` is the canonical BASE form for TS, and `setID:playID::subID` is the canonical form for SubEdition **parallels** (the Stage-B `::` editions, ~1,775 as of 2026-06-20). UUID-pair rows are inert dupes. **Always filter product metrics to canonical: `external_id ~ '^[0-9]+:[0-9]+(::[0-9]+)?$'`** — the old `^[0-9]+:[0-9]+$` silently drops the `::` parallels (≈16% of canonical TS editions); there are also thousands of inert UUID rows to exclude. Denormalized `player_name`/`set_name`/`tier`/`team_name`/`circulation_count` are safe to select. `players.jersey_number` exists (drives jersey-match special serials). Pinnacle lives in `pinnacle_editions` + `pinnacle_catalog` (render_id PK).
- **`fmv_snapshots`** — partitioned, NO source column. `confidence` enum UPPERCASE: `HIGH|MEDIUM|LOW|ASK_ONLY|SALES_ONLY|STALE|NO_DATA`. **Latest per edition:** `SELECT DISTINCT ON (edition_id) ... ORDER BY edition_id, computed_at DESC`. Daily duplicates are intentional history. **Pinnacle FMV is render-keyed and is NOT in `fmv_snapshots`:** current per-render values live on `pinnacle_catalog.fmv_*` (render_id PK; same `fmv_confidence` enum), per-render CHANGE HISTORY in `pinnacle_fmv_history` (engine `pinnacle-2.0.0-render`). The old `pinnacle_fmv_snapshots` table was **DROPPED 2026-06-08** — querying it now 42P01-errors; only `pinnacle_fmv_snapshots_backup_20260608` survives. **Pinnacle ASK has two surfaces (footgun):** render floor `pinnacle_catalog.floor_ask` (raw UFix64÷1e8, full-rewritten once daily by `pinnacle_catalog_set_floor_asks`; powers ASK_ONLY FMV + every public render/edition/set page) and the narrow live `pinnacle_editions.ask` (`ask_source='pinnacle_direct'`, written ~every 15min by `pinnacle-listings-reconcile`). `pinnacle_listings_direct` is EMPTY/dead and `pinnacle_cached_listings` is the dead Flowty $1-floor cache (frozen 06-08) — neither is an ask source. Pinnacle freshness+correctness are watched in `v_rpc_trust_health` (`pinnacle_ask_stale_hours`, `pinnacle_fmv_stale_hours`, `pinnacle_render_floor_stale_hours`, `pinnacle_fmv_impossible_flags`).
- **`sales`** — year-partitioned (`sales_2020`…`sales_2026`), dedup on `transaction_hash` (per-partition unique). Has `buyer_address`/`seller_address`/`serial_number`. `sold_at DESC` indexes exist.
- **`pack_purchases`** — buyer/seller/sale_price (DUC≈USD 1:1)/sealed_at/event_kind (`secondary_sale`/`primary_withdraw`/`primary_mint`). **TS rows carry NO dist at event time** (`pack_name` NULL too; the on-chain PackNFT has no distId — it exists only in the Minted event): `pack_dist_id` is populated ONLY via the `pack_rips` bridge (backfill + trigger `pack_rips_propagate_dist_trg`, ~20% of secondary sales and growing as packs open). Never re-derive dist from events.
- **History RPCs (SECDEF, service_role-only):** `get_pack_sales_history(collection_id, dist_id, limit)` (kind-tagged 'top'/'recent'), `get_edition_recent_sales(edition_id, limit)`, `get_edition_special_serials(edition_id)` (#1/jersey/low/last_mint + last sale).
- **`wallet_moments_cache` (wmc)** — UNIQUE `(wallet_address, collection_id, moment_id)`. `edition_key` MUST equal `editions.external_id`. ~1.58M rows / ~241 wallets — aggregate scans are heavy; `idx_wmc_last_seen_at` exists.
- **Pack EV:** `pack_ev_latest` (view, `pack_price>0`), `topshot_pack_ev_targets` (~800 live), `pack_grail_metrics_mv` (hourly). Per-tier remaining/original live in `pack_distributions.metadata` (v20+). Pool rows rebuild every EV tick — never one-time-fix pool data.
- **Pipelines:** `pipeline_runs` — `pipeline` (text), `ok` (bool), `extra` (jsonb → `extra->>'key'`). Silent-degradation = ok=true with 0 rows over many runs.
- **Traction:** `support_conversations` (filter `is_smoke_test IS NOT TRUE`), `outbound_clicks` (sensor live since 2026-06-08), `allow_list` (`status='active'` only valid access state), `points_ledger` (distinct user_id over 7d = WAU proxy).

## Canonical patterns

- Latest FMV per edition: `SELECT DISTINCT ON (edition_id) edition_id, fmv_usd, confidence FROM fmv_snapshots WHERE collection_id = '<uuid>' ORDER BY edition_id, computed_at DESC` — then join editions and filter canonical for TS.
- Pipeline health (48h): `SELECT pipeline, count(*), count(*) FILTER (WHERE NOT ok) AS fails, max(finished_at) FROM pipeline_runs WHERE started_at > now()-interval '48 hours' GROUP BY 1`.
- **Health fns return a SINGLE jsonb row** — `detect_stalled_pipelines()`, `get_pipeline_alerts()`, `check_secdef_anon_execute_violations()`, `check_public_security_invariants()`: read the VALUE (`[]` = clean); `count(*)` always returns 1 and is a false finding.
- Enum filters use `=` / `.eq`, never `ilike`.

## Pitfalls

- `n_live_tup` reads 0 when stats were never collected — use `count(*)` for anything that matters.
- Security checks joining `pg_class ... relrowsecurity=false` must add `AND relkind IN ('r','p')` or views false-positive.
- ~119 public SECURITY DEFINER insights views are by-design, not findings.
- Cron start-minutes were deliberately staggered off :00/:20/:40 on 2026-06-07 — `docs/operations/cron-schedule.md` is the verified reference; odd minutes are expected.
- Zero-lifetime-sale editions with a lone ask = troll listings — never auto-price them (FMV coverage is honestly complete).

## Extend this skill

Run `data:data-context-extractor` in ITERATION MODE to add domain references as query patterns stabilize.

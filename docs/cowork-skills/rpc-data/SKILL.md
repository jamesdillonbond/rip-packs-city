---
name: rpc-data
description: Rip Packs City data-warehouse context — load when querying or analyzing the RPC Supabase database (project bxcqstmqfzmuolpuynti): FMV, sales, editions, wallets, pack EV, pipelines, traction. Triggers on "query RPC", "how many", "analyze our data", "pull the numbers", or any write-query/analyze task against RPC. Encodes collection UUIDs, the two collection vocabularies, enum casing, partitioning, and canonical query patterns so SQL is correct first time.
---

# RPC data-warehouse context

Postgres on Supabase, project `bxcqstmqfzmuolpuynti`. Read via `execute_sql` (one statement per call; PostgREST/MCP caps large reads — use `LIMIT`). Pair with the `data` plugin's analyze / write-query skills. Always confirm columns with `information_schema.columns` before a non-trivial query.

## Collections — two vocabularies (critical)

| Vocabulary | Used by | Values |
|---|---|---|
| Long-form | `sales`, `editions`, `collections.slug` | `nba_top_shot`, `nfl_all_day`, `laliga_golazos`, `disney_pinnacle`, `ufc_strike` |
| Short-form | `flowty_*` tables (CHECK-constrained) | `topshot`, `allday`, `golazos`, `pinnacle`, `ufc` |

Bridge view: `analytics_sales` (long→short). **Collection UUIDs:** TopShot `95f28a17-224a-4025-96ad-adf8a4c63bfd` · AllDay `dee28451-5d62-409e-a1ad-a83f763ac070` · Golazos `06248cc4-b85f-47cd-af67-1855d14acd75` · UFC `9b4824a8-736d-4a96-b450-8dcc0c46b023` · Pinnacle `7dd9dd11-e8b6-45c4-ac99-71331f959714`. Every dependent row reaches chain via `collection_id` FK; `collection_chains` view (`collection_id, chain, slug, name`) is the canonical join. All 5 published = `chain='flow'`.

## Key tables

- **`editions`** (29 cols) — `external_id` (varchar; integer-pair `setID:playID` is canonical for TS, UUID-pair is a legacy/inert key), `collection_id`, denormalized `player_name`/`set_name`/`tier`/`team_name`/`circulation_count` (safe to select). Pinnacle lives in a separate `pinnacle_editions` (text id, `edition_key` = `royalty_code:variant_type:printing`).
- **`fmv_snapshots`** — partitioned, NO source column. `confidence` enum UPPERCASE: `HIGH|MEDIUM|LOW|ASK_ONLY|SALES_ONLY|STALE|NO_DATA`. **Latest per edition:** `SELECT DISTINCT ON (edition_id) ... ORDER BY edition_id, computed_at DESC`. Daily duplicates are intentional history. Pinnacle FMV is in `pinnacle_fmv_snapshots`, NOT here.
- **`sales`** — year-partitioned (`sales_2020`…`sales_2026`), dedup on `transaction_hash`. `sales_<year>_sold_at_idx` exists (DESC) — don't re-add.
- **`wallet_moments_cache` (wmc)** — UNIQUE `(wallet_address, collection_id, moment_id)`. `edition_key` MUST equal `editions.external_id`.
- **Pack EV:** `pack_ev_latest` (view, `pack_price>0`), `pack_grail_metrics_mv` (matview, hourly). `pack_distributions.metadata->>'retail_price_usd'` = 0 for reward packs.
- **Pipelines:** `pipeline_runs` — `pipeline` (text, not function_name), `ok` (bool, not status), `extra` (jsonb → `extra->>'key'`), `rows_written`. Silent-degradation = `ok=true` with 0 rows over many runs.
- **Traction:** `support_conversations` (filter `is_smoke_test IS NOT TRUE` — ~90% of rows are smoke tests; real traffic is low), `outbound_clicks` (has `created_at, surface, destination, fmv_usd, discount_pct` — instrumentation live since 2026-05-30), `email_subscribers`, `portfolio_snapshots`, `allow_list` (`status='active'` is the only valid access state).

## Canonical patterns

- Latest FMV per edition: `SELECT DISTINCT ON (edition_id) edition_id, fmv_usd, confidence FROM fmv_snapshots WHERE collection_id = '<uuid>' ORDER BY edition_id, computed_at DESC`.
- FMV confidence mix (latest): wrap the DISTINCT ON in a subquery, `GROUP BY confidence`.
- Pipeline health (48h): `SELECT pipeline, count(*), count(*) FILTER (WHERE NOT ok) AS fails, max(finished_at) FROM pipeline_runs WHERE started_at > now()-interval '48 hours' GROUP BY 1`.
- Enum filters use `.eq` / `=`, never `ilike`.

## Pitfalls

- `n_live_tup` reads 0 when stats were never collected — use `count(*)` for anything that matters.
- Security checks that join `pg_class ... relrowsecurity=false` must add `AND relkind IN ('r','p')` or every view false-positives (RLS doesn't apply to views).
- `health_check()` RPC contract has drifted — query metrics directly rather than relying on its sub-fields.
- ~119 public views are SECURITY DEFINER by design for `/insights`; that's not automatically a finding.

## Extend this skill

Run `data:data-context-extractor` in ITERATION MODE to add domain references (e.g. badges, insider signals, Beezie/Base `evm_*` plane) as query patterns stabilize.

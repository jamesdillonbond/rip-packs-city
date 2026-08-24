---
name: rpc-data
description: Rip Packs City data-warehouse context — load when querying or analyzing the RPC Supabase database (project bxcqstmqfzmuolpuynti): FMV, sales, editions, wallets, pack EV, pack history, pipelines, traction. Triggers on "query RPC", "how many", "analyze our data", "pull the numbers", or any write-query/analyze task against RPC. Encodes collection UUIDs, the two collection vocabularies, enum casing, partitioning, the canonical-edition predicate, and canonical query patterns so SQL is correct first time.
---

# RPC data-warehouse context

Postgres on Supabase, project `bxcqstmqfzmuolpuynti`. Read via `execute_sql` (one statement per call). Pair with the `data` plugin's analyze / write-query skills. Always confirm columns with `information_schema.columns` before a non-trivial query.

🚨 **THE 1000-ROW CAP IS NOT LIFTED BY A BIGGER `LIMIT` (corrected 2026-08-24; this line used to say "use `LIMIT`").** PostgREST caps reads at 1000 rows and **CLAMPS an explicit `.limit()` above that** — so a `.limit(10000)` hands back 1000 rows to a caller who believes they have 10,000, which is a partial read rendering as a complete one. **For a TOTAL, read the returned `count` (`head: true`), never `rows.length`.** Aggregate in SQL, or paginate. ⚠ **Any `.range()` pagination MUST carry a deterministic `.order()` on a UNIQUE key**, or it reads the right *number* of rows and the wrong *rows* — the duplicates and omissions CANCEL, so every count-based check passes and only a DISTINCT count or a set comparison sees it.

## Collections — two vocabularies (critical)

| Vocabulary | Used by | Values |
|---|---|---|
| Long-form | `sales`, `editions`, `collections.slug` | `nba_top_shot`, `nfl_all_day`, `laliga_golazos`, `disney_pinnacle`, `ufc_strike` |
| Short-form | `flowty_transactions` (CHECK-constrained); `flowty_loans` / `flowty_loan_events` have NO CHECK | `topshot`, `allday`, `golazos`, `pinnacle`, `ufc`, `unknown` — **`other` is NOT valid** |

⚠ **Because only `flowty_transactions` is CHECK-constrained, a wrong value fails LOUDLY there and persists SILENTLY in the other two, where it never matches** (verified against `pg_constraint` 2026-08-24). Bridge long→short with the `analytics_sales` view's CASE.

**Collection UUIDs — there are SEVEN, not five.** Read them from the live-derived table in `docs/reference/schema-truth.md` rather than a hardcoded list here (re-verified against `public.collections` 2026-08-24, zero drift). The five published Flow collections are joined by **`candy_mlb` (`solana`)** and **`panini_blockchain` (`ethereum`)**, both `is_active=false` — ⚠ **but `is_active` is NOT the public-visibility switch**: both have public insights boards, so a "how many" query that stops at the five silently undercounts. Every dependent row reaches chain via `collection_id` FK; `collection_chains` view is the canonical join.

## Key tables

- **`editions`** (29 cols) — `external_id`: integer-pair `setID:playID` is the canonical BASE form for TS, and `setID:playID::subID` is the canonical form for SubEdition **parallels** (the Stage-B `::` editions, ~1,775 as of 2026-06-20). UUID-pair rows are inert dupes. **Always filter product metrics to canonical: `external_id ~ '^[0-9]+:[0-9]+(::[0-9]+)?$'`** — the old `^[0-9]+:[0-9]+$` silently drops the `::` parallels (≈16% of canonical TS editions); there are also thousands of inert UUID rows to exclude. Denormalized `player_name`/`set_name`/`tier`/`team_name`/`circulation_count` are safe to select. `players.jersey_number` exists (drives jersey-match special serials). Pinnacle lives in `pinnacle_editions` + `pinnacle_catalog` (render_id PK).
- **`fmv_snapshots`** — partitioned, NO source column. `confidence` enum UPPERCASE: `HIGH|MEDIUM|LOW|ASK_ONLY|SALES_ONLY|STALE|NO_DATA`. **Latest per edition:** `SELECT DISTINCT ON (edition_id) ... ORDER BY edition_id, computed_at DESC`. Daily duplicates are intentional history. **Pinnacle FMV is render-keyed and is NOT in `fmv_snapshots`:** current per-render values live on `pinnacle_catalog.fmv_*` (render_id PK; same `fmv_confidence` enum), per-render CHANGE HISTORY in `pinnacle_fmv_history` (engine `pinnacle-2.0.0-render`). The old `pinnacle_fmv_snapshots` table was **DROPPED 2026-06-08** — querying it now 42P01-errors; only `pinnacle_fmv_snapshots_backup_20260608` survives. **Pinnacle ASK has two surfaces (footgun):** render floor `pinnacle_catalog.floor_ask` (raw UFix64÷1e8, full-rewritten once daily by `pinnacle_catalog_set_floor_asks`; powers ASK_ONLY FMV + every public render/edition/set page) and the narrow live `pinnacle_editions.ask` (`ask_source='pinnacle_direct'`, written ~every 15min by `pinnacle-listings-reconcile`). `pinnacle_listings_direct` is EMPTY/dead and `pinnacle_cached_listings` is the dead Flowty $1-floor cache (frozen 06-08) — neither is an ask source. Pinnacle freshness+correctness are watched in `v_rpc_trust_health` (`pinnacle_ask_stale_hours`, `pinnacle_fmv_stale_hours`, `pinnacle_render_floor_stale_hours`, `pinnacle_fmv_impossible_flags`).
- **`sales`** — year-partitioned (`sales_2020`…`sales_2026`), dedup on `transaction_hash` (per-partition unique). Has `buyer_address`/`seller_address`/`serial_number`. `sold_at DESC` indexes exist.
- **`pack_purchases`** — buyer/seller/sale_price (DUC≈USD 1:1)/sealed_at/event_kind (`secondary_sale`/`primary_withdraw`/`primary_mint`). **TS rows carry NO dist at event time** (`pack_name` NULL too; the on-chain PackNFT has no distId — it exists only in the Minted event): `pack_dist_id` is populated ONLY via the `pack_rips` bridge (backfill + trigger `pack_rips_propagate_dist_trg`, ~20% of secondary sales and growing as packs open). Never re-derive dist from events.
- **History RPCs (SECDEF, service_role-only):** `get_pack_sales_history(collection_id, dist_id, limit)` (kind-tagged 'top'/'recent'), `get_edition_recent_sales(edition_id, limit)`, `get_edition_special_serials(edition_id)` (#1/jersey/low/last_mint + last sale).
- **`wallet_moments_cache` (wmc)** — UNIQUE `(wallet_address, collection_id, moment_id)`. `edition_key` MUST equal `editions.external_id`. ~1.58M rows / ~241 wallets — aggregate scans are heavy; `idx_wmc_last_seen_at` exists.
- **Offers — PER-PRINTING since 2026-07-07 (footgun).** `edition_offers` (aggregate, keyed by `external_id` string NOT edition_id): base `setID:playID` rows = the Standard printing; `setID:playID::subID` rows = that PARALLEL's own `highest_offer`/`low_ask` (the GQL sweep keys by `parallelID`). Blending offers across printings was a bug — **never re-blend `::` back onto the base**. `offers` (raw on-chain event feed, `offer_type ∈ {edition, serial, subedition}`, `status` uses `'open'` not `'active'`): `offer_type='subedition'` rows are keyed to the `::` edition (base-edition fallback only when the parallel isn't cataloged yet). `audit_20260707_offer_sub_backfill` is the historical re-key audit/revert map (3,602 open subedition offers re-keyed off the base). `get_edition_high_offer(p_edition_id uuid)` returns 4 cols `(highest_offer, low_ask, updated_at, offer_scope)` where `offer_scope ∈ {'parallel','edition'}`; on a `::` page best offer = `GREATEST(own-printing offer, base edition-grain chain offer)` since an edition-level OffersV2 offer is fillable by any printing.
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

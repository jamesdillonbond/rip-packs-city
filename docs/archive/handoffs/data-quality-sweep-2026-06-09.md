# RPC weekly data-quality + reconciliation sweep — 2026-06-09

Read-only sweep (scheduled `rpc-data-quality-sweep`). Supabase project `bxcqstmqfzmuolpuynti`. Shipped nothing (one active issue is already queued + off-limits; the new finding needs a code look). A quiet week with two things worth a CC/operator look.

## Status: HEALTHY — needs attention on 2 items (1 already escalated)

All eight integrity/freshness checks pass except where noted. The only live degradation (Pinnacle on-chain ASK staleness) is already queued from the 06-09 night pass and is worsening, not new.

## Per-check results

| # | Check | Result | Verdict |
|---|---|---|---|
| 1 | `v_fmv_sanity_flags` | 0 rows | ✅ clean (corroborated: `v_rpc_trust_health.fmv_sanity_flags`=0) |
| 2 | `v_offer_sanity_flags` | 174 flags, max gap $5,222 | ⚠️ structural, see below (was 132 on 06-07) |
| 3a | editions w/o any fmv_snapshot | 0 across all collections | ✅ every edition has ≥ a NO_DATA snapshot |
| 3b | wmc edition_key ↔ editions.external_id | drain NOT regressed (2 int_pair orphans); see UFC below | ⚠️ UFC coverage gap |
| 3c | sales (7d) with null edition_id | 0 | ✅ clean |
| 4 | unmapped_sales unresolved | 183 (AllDay 182, Golazos 1) | ✅ flat vs 06-09 baseline |
| 5 | Sentinel TS UUID-keyed (48h) | 0 | ✅ clean (ok<250; trust-health `ts_uuid_dupes_created_24h`=0) |
| 6 | FMV freshness + coverage | all fresh; TS HIGH 552 | ✅ see below |
| 7 | Pack-EV staleness (>3d) | TS 439/1172, AllDay 4/521 | ✅ board itself fresh (1.09d), tail-only |
| 8 | Offer-indexer liveness (24h) | TS 94.2%, AllDay 97.1%, sweep 100% | ✅ all live + growing |

### Check 6 detail — FMV freshness + coverage (all healthy)
- Sales-path writers all fresh: Golazos 3 min, TS 2 min, UFC 2 min, AllDay 1 min (≪ 60 min threshold).
- TS coverage (latest-per-edition): HIGH **552**, MEDIUM 2,340 (HIGH+MED 2,892), LOW 6,445, ASK_ONLY 1,001, NO_DATA 4,946, STALE 239, SALES_ONLY 19 (total 15,542). HIGH 552 is well above the ~400 floor; HIGH+MED flat vs the ~2,917 last-known (06-09). NO_DATA is the structurally-unpriceable zero-sale tail (expected).
- Pinnacle FMV now lives on `pinnacle_catalog` (the legacy `pinnacle_fmv_snapshots` table was dropped 06-08). `fmv_computed_at` 6.4h old — that is **fresh for its daily cadence** (ran 10:07Z today via pinnacle-sync); 1,806/2,103 renders priced (86%), 890 HIGH+MED.

### Check 7 detail — pack-EV
- AllDay healthy (4 stale of 521). TS shows 439/1,172 older than 3 days, but this is the long tail, not the visible product: `v_rpc_trust_health.pack_ev_board_max_stale_days` = **1.09** (breach at 2), and `pack_ev_board_pct_depleted` = 0. Consistent with the known throughput ceiling (PACKEV-THROUGHPUT, already evaluated/closed — the EV *board* stays fresh; the tail cycles on a ~6-day cadence). Newest TS snapshot 16:25Z today, so the pipeline is running. No action.

### Check 8 detail — offers (healthy growth)
- topshot-offers-indexer 69 runs/24h, 94.2% ok (the ~6% fails are the known cron-rush connection-pool transient class). allday-offers-indexer 97.1%. offers-sweep 100%. All last-ran within ~15 min.
- `offers` table: 6,021 open / 2,139 editions; 2,703 filled; 3,166 cancelled (11,890 total). Strong week-over-week growth from the June-4 snapshot (644 total / 500 open / 331 editions) — healthy accrual, not a problem.

## Flags

### 1. PINNACLE-RECONCILE-TIMEOUT — worsening (already queued, off-limits)
`v_rpc_trust_health.pinnacle_ask_stale_hours` = **11.9h** (breach at 3h) — up from 3.8h when the 06-09 night pass first escalated it. It did **not** durably self-heal: the on-chain Pinnacle ASK writer `pinnacle-listings-reconcile` keeps timing out on the ~8s service_role statement cap, so the freshest `ask_source='pinnacle_direct'` ask is frozen (last advanced ~04:39Z 06-09). This is a Pinnacle pricing-path pipeline (off-limits to auto-ship + NO-PUSH for the route side). No new action from this sweep — the queued PINNACLE-RECONCILE-TIMEOUT item already carries the three options (statement_timeout bump w/ contention caveat / make reconcile incremental / widen SLA as last resort). **Datapoint for that item: still breaching, 11.9h, ~31h after first escalation.**

Note for context: `pinnacle_catalog.floor_ask` (the daily catalog floor, a separate column) is fresh-for-cadence at 6.9h (ran 09:37Z). The breach is specifically the on-chain `pinnacle_direct` ask path, which became load-bearing after the 06-09 Flowty-cache retirement.

### 2. UFC-WMC-NULLKEY — new: chronic UFC wmc metadata-backfill gap
3,387 of UFC's 4,495 `wallet_moments_cache` rows (**75%**) have `edition_key IS NULL` — and on those same rows `tier` and `set_name` are also null (full metadata gap, not just the key). Spread across 99 wallets; oldest `last_seen_at` 2026-05-08 (UFC launch), newest 2026-06-09 (today) → **chronic since onboarding, continuously refreshed**, not a fresh spike.

Important: this is **not** the drain regression the wmc contract guards against — that would show as int_pair keys overwritten to UUIDs, and there are only 2 int_pair orphans platform-wide. UFC's rows simply never had `edition_key`/metadata populated. The likely cause is the UFC wallet-backfill path not writing `edition_key` (so the `backfill_wmc_metadata_from_editions` JOIN, which keys on `edition_key`, can never fill tier/set either). UFC is PUBLISHED + BETA, so impact is limited to degraded UFC portfolio/FMV/metadata joins for those 99 wallets. Worth a CC look at the UFC leg of the wallet-backfill + a one-time denorm once the key is populated. **Queued as UFC-WMC-NULLKEY (LOW, CC).**

(TS, for contrast: 1,743 orphans / 1.23M = 0.14%, of which 1,709 are the known legacy `uuid_like` DUPE residual + 32 null + 2 int_pair — nothing new. AllDay 80 null / 325k = 0.02%. Golazos 0.)

### 3. Offer-sanity recon (174) — recommend the durable GREATEST raise
174 flags, composition stable and structural: 138 (79%) are `chain_exceeds_gql` + `has_sub_serial=true` (GQL aggregate collapses subedition/serial offers; max gap $658), and 21 are `gql_blank_chain_has` where GQL shows no offer at all — the 12 non-subedition ones carry the headline gaps (SGA Kingmaker $5,222; LeBron Supernova $5,000; Wilt $1,501). Growth 132→174 over ~2 days is consistent with the on-chain offers indexer accruing more offers that the GQL aggregate can't represent, not a data fault.

Recommendation (do **not** apply from this sweep — edition_offers writes are off-limits to this task): this is the right time for the documented durable fix — raise `edition_offers.highest_offer` via **GREATEST(existing, chain_max)** (never clobber down) keyed off the on-chain `offers` open-max, run by a CC-owned job. The composition is stable enough to schedule. Because it's slowly growing it's a recurring raise, not a one-time backfill. Optional companion: add an `offer_sanity_max_gap` line to `v_rpc_trust_health` so the gap is monitored the way `fmv_sanity_flags` is (CREATE OR REPLACE on the live monitoring view — leave for CC, not a watchlist row).

## Shipped this run
Nothing. Read-only sweep. No additive monitoring shipped — everything material is already monitored (trust-health view + sentinel + cadence watchlist); the one live breach is already queued.

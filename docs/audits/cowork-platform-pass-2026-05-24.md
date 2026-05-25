# Cowork Autonomous Platform Pass — 2026-05-24

**Author:** Claude (Cowork session, autonomous run while Trevor was away)
**Scope:** Verify the three big fixes from earlier 2026-05-24 sessions held; FMV quality deep-dive; pipeline/cron hygiene; Pinnacle FMV; advisors. Full autonomy granted, including live DB changes.
**Method:** Supabase MCP (`bxcqstmqfzmuolpuynti`), repo file inspection. Git is corrupt in the sandbox (see "What needs Trevor"), so no code was pushed — code-side items are bundled into a Claude Code handoff.

---

## TL;DR

Three migrations shipped **live** to the database. Two were real bug fixes the earlier sessions thought were done but weren't:

1. **FMV `1.1.0` clobber — residue purged.** The trigger blocked *new* `1.1.0` rows but 613 editions were still *winning* on stale `1.1.0`/`1.1.0_haircut` snapshots. Trigger extended to block the haircut variant; 15,922 clobber rows purged; 549 editions restored to their canonical FMV.
2. **Pack EV queue poison — actually fixed.** The v17 "sentinel" fix did not work: sentinels are written with `pack_price = 0`, but `pack_ev_latest` filters `pack_price > 0`, so they never reached the targets view. 1,105 of 1,114 TS packs were stuck >7 days stale. Fixed by pointing `topshot_pack_ev_targets` at `pack_ev_history` directly. Queue now drains (~2 days, self-healing).
3. **`migrate-wmc-edition-keys`** deactivated in the alert watchlist (it was already retired; the watchlist entry would have false-alarmed).

Everything else verified **clean or already-working** — including two items the roadmap still lists as open (Pinnacle FMV, the STALE spike). Several CLAUDE.md known-issues are stale and are corrected below.

---

## Shipped live (database)

| Migration | Effect |
|---|---|
| `audit_20260524_block_stale_ingest_fmv_algo_haircut` | Extended `fmv_snapshots_block_stale_ingest_algo` to block `algo_version LIKE '1.1.0%'` (was exact `'1.1.0'` only — the `_haircut` variant slipped through). |
| `audit_20260524_purge_fmv_1_1_0_clobber_residue` | Deleted 15,922 `1.1.0`/`1.1.0_haircut` snapshot rows for editions that have a canonical snapshot underneath. 549 editions restored to canonical FMV; 64 editions with *only* a `1.1.0*` row left intact (would otherwise orphan to no FMV). |
| `audit_20260524_pack_ev_targets_unpoison_via_history` | `topshot_pack_ev_targets.last_ev_at` now reads `max(snapshotted_at)` from `pack_ev_history` directly instead of the `pack_price > 0`-filtered `pack_ev_latest` view. Sentinel rows (pack_price 0) now advance the queue. |

Plus one config write (not a migration): `pipeline_cadence_watchlist` — `migrate-wmc-edition-keys` set `is_active = false`.

---

## Verified clean — no action needed

- **wmc `edition_key` corruption** — 0 rows match the corruption signature (`edition_key = editions.id` instead of `external_id`). The `wmc_edition_key_drain_v3` function is fully dropped. 97.3% of 1.55M wmc rows resolve to `editions.external_id` (`setUUID:playUUID` format), 2.3% to `pinnacle_editions`, 0.24% orphan tail. The invariant holds. The 2026-05-24 repair held.
- **FMV ingest-clobber trigger** — present and enabled on `fmv_snapshots` + all three partitions. Last `1.1.0` insert was 2026-05-23 22:53, before the trigger; no leaks.
- **`migrate-wmc-edition-keys`** — cron already deleted (last run 13:37 UTC, ~6h before this pass); route already deleted from the repo; drain function dropped. Only the watchlist entry remained — now deactivated.

---

## Investigated — premise outdated or working as intended

- **FMV STALE spike (597 → 1,739)** — *not a regression.* A new pipeline, `cold-tail-stale-repair-1.0`, ran today 19:17 and converted ~1,006 previously-`NO_DATA` editions into STALE-confidence editions (a real-but-old FMV beats no value). `NO_DATA` fell ~1,187 over the same window. 96.5% of STALE editions haven't traded in 30 days — STALE is the honest label. Only 58 STALE editions traded in the last 14 days.
- **`fmv-recalc` throughput** — cursor advances cleanly (+1,000 sales/run, no wrap stall), ~25–32 runs/day. Adequate for keeping *newly-traded* editions fresh. See the FMV opportunity section for the one real limitation (first full sweep).
- **Pinnacle FMV** — CLAUDE.md known-issue #4 ("0 FMV editions") is **stale**. `pinnacle_fmv_snapshots` has 425 rows — every Pinnacle edition traded in 90 days — freshly recomputed today 19:40 via algo `pinnacle-1.0.0`. Confidence mix: 241 HIGH / 117 MEDIUM / 46 LOW / 21 NO_DATA (84% HIGH+MEDIUM — far better than the main collections). Propagated to `wmc` hourly by `populate-pinnacle-wmc-fmv`. Pinnacle ASK now comes from `pinnacle-listings-indexer` (direct-chain), not Flowty. The subsystem works end-to-end.
- **Storefront audit pipeline** — CLAUDE.md known-issue #9. It is a *manual script* (`scripts/scan-historical-storefront.mjs`), not a deployed cron or route. Not monitored, not read by any frontend code. Cold since 2026-04-28 because nobody runs the script. De facto retired already; no operational action needed. `storefront_audit_wallets` (5,365 rows, tiny) is harmless — optional drop candidate.
- **Pipeline failures (48h)** — all transient infrastructure contention: connection-pool timeouts, lock timeouts, upstream timeouts. No logic bugs. The 19 `cadence-payer-balance-check` "failures" were the low-balance alarm working correctly (payer hit 0 FLOW on 05-23; since topped up, now ~2.0 FLOW). `allday-unmapped-resolver` statement timeouts on `resolve_unmapped_sales_for_collection` recur (~4/48h, 96% success) — worth a future look, not urgent.
- **Anon-executable SECDEF functions** — 17, matching the May 20 audit. All accounted for: 16 are read-only public-page/concierge RPCs (moment detail, pack simulator, sniper deals, trophy slab, `mcp_*` concierge tools) that are *intentionally* anon-callable; `submit_allow_list_request` is the intentional public signup write; `pack_purchases_set_is_primary_drop` is a trigger function (harmless). **None are a regression of the May 3 anon-revoke** (which targeted mutation/admin functions). No REVOKE migrations needed.

---

## The HIGH-confidence FMV opportunity (the real lever)

FMV confidence today (24,717 editions): NO_DATA 10,801 · LOW 9,352 · STALE 1,675 · SALES_ONLY 826 · HIGH 817 · MEDIUM 714 · ASK_ONLY 532.

The roadmap calls HIGH-confidence coverage "the product." Here is the concrete, sized picture:

- **`fmv-recalc` has priced only 5,105 editions ever, vs 9,273 traded in the last 30 days.** ~4,168 recently-traded editions have *never* received a canonical `1.7.0` snapshot.
- Why: `fmv-recalc`'s pagination was only fixed 2026-05-23. It is mid its **first real full sweep** — cursor at 34,500 of 262,733 total sales (~13%). At the current rate the first sweep finishes in **~9 days**.
- The **825 SALES_ONLY editions with ≥3 sales/30d** are well-traded editions that `fmv-recalc` simply hasn't reached yet — `cold-tail-1.0` filled them with a `SALES_ONLY` placeholder in the meantime. None have a `1.7.0` snapshot.
- The **1,513 LOW editions with ≥3 sales/30d** are volume-eligible for HIGH/MEDIUM — they will escalate as `fmv-recalc` reaches them (and as the serial-residual dispersion gate is tuned).
- Structural floor: ~13,000 editions (NO_DATA + ASK_ONLY + STALE) have zero recent sales and cannot reach HIGH without a primary listings feed.

**Recommended actions (FMV throughput):**
1. **Shipped 2026-05-24 (commit `43c8d9c`):** `fmv-recalc` `DEFAULT_LIMIT` raised 1,000 → 2,500, and the `body.limit` override cap 2,000 → 5,000 so the new default isn't silently clamped. ~2.5x faster first sweep (~9 days → ~3.5 days).
2. **Follow-up — recent-edition-first prioritization (NOT a sales-scan reorder).** The naive "`ORDER BY sold_at DESC`" idea is a *correctness regression*: `fmv-recalc` paginates by `edition_id` and does delete-then-insert per chunk, so all of an edition's sales must land in one chunk; ordering the scan by `sold_at` scatters them and a later partial chunk overwrites a more-complete snapshot. Correct shape: paginate distinct `edition_id`s ordered by `max(sold_at) DESC`, then per chunk fetch all in-window sales for that edition set. Captured in commit `43c8d9c`'s body.
3. Increase `fmv-recalc` cron frequency to accelerate the first full sweep.
4. Tune the serial-residual dispersion gate in `lib/fmv-confidence.ts` against the dispersion buckets in the Parallel-work round below — ~1,737 editions clear a residual-SD < 0.20 gate.

Realistic HIGH+MEDIUM ceiling via sales alone once the sweep completes and the gate is tuned: ~3,500–4,000 editions (from 1,531 today).

---

## Connection-pool / cron-stagger recommendation

Connection-pool exhaustion ("Timed out acquiring connection from connection pool") appears across `wmc-fmv-populate`, `compute-topshot-pack-ev`, `topshot-listings-indexer`, `allday-unmapped-resolver` and others — it is the single common root of the transient failures. ~76 pipelines, many on `*/20` and `*/30` cadences, pile up at `:00 / :20 / :30 / :40`, and the four-times-daily wallet-backfill wave fires 7 related pipelines simultaneously at `00/06/12/18`.

Recommendations (cron-job.org — Trevor):
- Spread `*/20` and `*/30` pipelines across distinct minute offsets — many already do this in their watchlist notes (`:8,23,38,53` etc.); apply the same to the ones still on `:00`.
- Stagger the wallet-backfill wave children by 2–3 minutes each rather than all at `:00`.
- Consider Supabase transaction-mode pooling (PgBouncer) for the edge-function pipelines — the deeper fix beyond cron staggering.

---

## Unused-index report (review only — nothing dropped)

512 indexes have `idx_scan = 0`, totaling **375 MB** on a Pro Micro. Largest candidates:

| Table | Index | Size |
|---|---|---|
| evm_nft_transfers_2026_02 | `..._chain_id_contract_address_token__idx1` | 46 MB |
| marketplace_offers_2025 | `..._listing_resource_id_offeror_address_idx` | 29 MB |
| marketplace_offers_2024 | `..._listing_resource_id_offeror_address_idx` | 21 MB |
| evm_nft_transfers_2026_01 | `..._chain_id_contract_address_token__idx1` | 18 MB |
| marketplace_offers_2025 | `..._offeror_address_event_timestamp_idx` | 18 MB |
| marketplace_offers_2025 | `..._collection_id_event_timestamp_idx` | 14 MB |

The `marketplace_offers_2024/2025` indexes (~104 MB across 6) are strong drop candidates — the Flowty offers ingest that populated them is dead. **Not dropped** — `idx_scan` counters reset with stats, and some may back FK/constraint enforcement. Recommend a deliberate `DROP INDEX CONCURRENTLY` pass after confirming each is neither a unique constraint nor FK-supporting.

---

## What needs Trevor

1. **Git index is corrupt** in the working tree (`.git/index: index file smaller than expected`) and the stale `.git/index.lock` cannot be cleared from the sandbox. On Windows Git Bash:
   ```
   cd /c/Users/TDill/rip-packs-city
   del .git\index.lock
   del .git\index
   git reset
   ```
2. **Run the Claude Code handoff** — see `docs/handoff-2026-05-24.md`. It bundles: the still-uncommitted May 20 audit fixes, the dead Flowty ingest-route cleanup, repo-hygiene `git rm`, and the `fmv-recalc` acceleration changes.
3. **cron-job.org** — delete the `RPC Listing Divergence AllDay` cron if not already gone (last ran 05-23 18:07).

---

## CLAUDE.md corrections (applied this session)

- Known-issue #4 (Pinnacle FMV) — corrected: Pinnacle FMV works (`pinnacle_fmv_snapshots`, 425 editions, 84% HIGH+MED).
- Known-issue #9 (storefront audit) — corrected: it is a dormant manual script, de facto retired.
- Recent-sessions entry added for this pass.

---

## Parallel-work round (while Claude Code ran the handoff)

Two more migrations shipped live, plus an analysis and a live dashboard.

### `allday-unmapped-resolver` timeout — fixed (migration `audit_20260524_resolve_unmapped_sales_timeout_fix`)

Root cause was a **retroactive `statement_timeout` fire**. `resolve_unmapped_sales_for_collection` set `statement_timeout = 60s` but delegates to `promote_unmapped_sales`, which sets `300s`. When `promote` legitimately ran ~60–70s (well inside its own budget) and returned, the wrapper's 60s was restored; PostgreSQL re-armed the timer at `statement_start + 60s`, found it already exceeded, and cancelled immediately — attributed to the wrapper, rolling back the whole transaction and **discarding the promotion**. Raised the wrapper's timeout to `300s` to match the inner budget. Body unchanged.

### FMV escalation model (sharpens the HIGH-confidence plan)

Modelled the serial-residual price dispersion (`ln(price) ~ ln(serial)` OLS, residual stddev) for the **2,997 well-traded LOW / SALES_ONLY editions** (≥3 sales/30d):

| Residual dispersion | Editions | Read as |
|---|---:|---|
| < 0.20 | 1,737 (58%) | tight market — HIGH-grade |
| 0.20 – 0.35 | 739 (25%) | MEDIUM-grade |
| 0.35 – 0.50 | 297 (10%) | LOW |
| ≥ 0.50 | 224 (7%) | genuinely noisy |

Median dispersion 0.159. **The data quality for HIGH confidence is already there** — ~1,737 editions (gate at residual SD < 0.20) to ~2,476 (< 0.35) should escalate to HIGH/MEDIUM once `fmv-recalc` reaches them. This confirms the lever is purely throughput, not algorithm: today's HIGH+MEDIUM of 1,531 has a realistic path to ~3,200–4,000. Use these buckets as the concrete target when tuning the dispersion gate in `lib/fmv-confidence.ts`.

### Dead index drop (migration `audit_20260524_drop_dead_marketplace_offers_indexes`)

Dropped two unused partitioned indexes on `marketplace_offers` (`marketplace_offers_collection_ts_idx`, `marketplace_offers_offeror_ts_idx`) — **66 MB reclaimed** across 32 partition child indexes. The offers feature is dead (Flowty offers ingest retired). The two UNIQUE `listing_resource_id_offeror_address` indexes were deliberately **kept** — they are a uniqueness guarantee / upsert conflict target, not dead weight. Unused-index total: 512 → 480, 375 MB → 309 MB.

### Live tracking dashboard

Created the `rpc-platform-tracker` Cowork artifact — three panels (pack-EV queue drain, FMV confidence mix, 24h pipeline health) that pull fresh from Supabase on each open. Built so the pack-EV drain and FMV-confidence climb from today's fixes can be watched over the coming days.

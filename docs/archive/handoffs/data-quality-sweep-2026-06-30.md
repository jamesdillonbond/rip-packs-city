# RPC weekly data-quality + reconciliation sweep — 2026-06-30

Read-only sweep (scheduled `rpc-data-quality-sweep`). Supabase project `bxcqstmqfzmuolpuynti`, DB clock 16:2x–16:32Z. Shipped nothing (no fix warranted; no new monitoring config needed — everything flaggable is already monitored). A quiet, healthy week with **one watch item**: the AllDay `unmapped_sales` backlog is climbing as the historical-sales-capture backfill runs — known, quarantined classes, not corrupting `sales`/FMV.

## Status: HEALTHY — 1 watch item (already covered by existing ledger items)

All eight integrity/freshness checks pass. The only moving number worth attention (AllDay unmapped backlog) is two known classes held *out* of `sales`, so there is no live mispricing or integrity breakage.

## Per-check results

| # | Check | Result | Verdict |
|---|---|---|---|
| 1 | `v_fmv_sanity_flags` | 0 rows | ✅ clean |
| 2 | `v_offer_sanity_flags` | 411 flags (all `has_sub_serial`); **actionable edition-grain gap = 0** | ✅ structural-only, see below (was 174 / 30-actionable) |
| 3a | editions w/o any fmv_snapshot | AllDay 0, Golazos 0, TS 53 (inert UUID stubs), UFC 53 (zero-sale, seeded 06-22) | ✅ every *canonical* edition priced |
| 3b | wmc edition_key ↔ editions.external_id | TS 4 orphan / 42 null of 1.54M; AllDay 0/103; UFC 0/2; Golazos 0/0 | ✅ trending ~0 (healed from ~1,743 / UFC 3,150+) |
| 3c | sales (7d) with null/orphan edition | 0 across TS / AllDay / Golazos | ✅ clean |
| 4 | unmapped_sales unresolved | AllDay 1,125 · TS 170 · Golazos 26 · UFC 23 | ⚠️ AllDay growing — see Flags |
| 5 | Sentinel TS UUID-keyed (48h) | 17 (all true UUID stubs, 0 `::` parallels) | ✅ ok (<250) |
| 6 | FMV freshness + coverage | all fresh; TS HIGH+MED 4,705 (HIGH 1,318) | ✅ see below |
| 7 | Pack-EV staleness (>3d) | TS 438/1,180 (393 are >30d retired), AllDay 4/521 | ✅ board fresh (freshest = now), tail-only |
| 8 | Offer-indexer liveness (24h) | topshot 100% (71/71), allday 98.6% (69/70) | ✅ both live + writing real data |

### Check 2 detail — offer reconciliation (structural, edition raise fully caught up)
411 flags, **every one `has_sub_serial=true`** (347 `chain_exceeds_gql` + 64 `gql_blank_chain_has`); largest gap $1,577 (a serial-locked offer, OG Anunoby/Kon Knueppel/Ray Allen signature/finals editions), avg $46. The headline count grew 174 (06-09) → 411 because open on-chain offers ~doubled (TS open: edition 5,284→10,477, subedition 1,541→3,220, serial 535→1,121) — healthy accrual, exactly as predicted.

The number that actually matters — editions where a genuine **edition-level** open offer (`offer_type='edition'`) beats the stored `edition_offers.highest_offer` — is now **0** (was 30 on 06-12). The offers-sweep's `raise_edition_offers_from_chain` (GREATEST-raise) has fully closed the edition-grain gap. The remaining 411 are subedition/serial-locked bids that the edition-level GQL aggregate correctly collapses and that must NOT raise the edition "Best offer" cell. **The standing OFFER-SANITY-RAISE recommendation is effectively moot at the edition grain.** (The optional `offer_sanity_max_gap` trust-health monitor, if ever added, would now sit at 0/ok — no chronic paging.)

### Check 3 detail — integrity (clean; wmc fully healed)
- **3a coverage:** all 4 fmv-snapshot collections have full coverage on canonical editions. TS 53 unpriced = inert non-canonical UUID-dupe stubs (0 canonical, 0 sales, 51 created <7d — expected new-drop residual). UFC 53 unpriced = zero-sale editions from the 06-22 446→518 seed (honest cold tail — nothing to price until they trade).
- **3b wmc contract:** TS 4 orphan + 42 null of 1,537,713 (0.003%) — the historical ~1,743 fossil orphans are gone (the 06-27/28 on-chain re-key held). UFC null-key 2 (was 3,150+ pre-`b28a22f`). AllDay 0 orphan. Golazos 0. Drain has not regressed.
- **3c sales mapping:** TS 24,638 / AllDay 2,881 / Golazos 90 sales in 7d, all with a valid resolvable `edition_id`. Unmappable sales are quarantined to `unmapped_sales` before landing — consistent with 3c=0.

### Check 6 detail — FMV freshness + coverage (all healthy)
- Latest snapshot per collection: TS 2.9 min, AllDay 4.0 min, Golazos 6.3 min, UFC 14.5 min — all ≪ 60 min.
- TS coverage (latest-per-edition): 17,436 priced, HIGH+MED **4,705** (HIGH 1,318) — well above the ~400 floor and up from 4,685 (06-30 overnight) / HIGH 552 (06-09). AllDay 909, Golazos 5, UFC 15 (thin high-tier markets — honest).
- **Pinnacle** lives on `pinnacle_fmv_history` (render-keyed; the task's `pinnacle_fmv_snapshots` was dropped 06-08 and 42P01-errors — do not query it). 2,179 renders priced, 1,265 HIGH+MED, last compute 6.4h ago = fresh for its daily cadence (breach 30h).

### Check 8 detail — offer-indexers (both doing real work)
- topshot-offers-indexer 71/71 ok, allday-offers-indexer 69/70 (1 transient), both latest-ok within ~5 min.
- The per-offer `offers` table is **TS-only by design** (45,378 total / 14,798 open — the rich edition/subedition/serial-grain model). AllDay offers are edition-grain and land in `edition_offers` (1,514 rows, all live); allday-offers-indexer pages 6–7 pages/run and writes when it sees offers (0–2/run — thin AllDay offer market), so it is **not** a silent no-op. `edition_offers`: TS 9,078 (5,684 live) + AllDay 1,514 (1,514 live).

## Flags

### 1. AllDay `unmapped_sales` backlog climbing — WATCH (known classes, quarantined, not corrupting data)
AllDay unresolved `unmapped_sales` = **1,125** (1,068 added in 7d, 171 in 24h), up from ~183 (06-09) / ~475 (06-27). Composition:
- **737** `source=onchain` / `marketplace=flowty` — the AllDay arm of the historical-sales-capture backfill ingesting Flowty-marketplace AllDay sales that don't resolve to a tracked edition. Direct analogue of the queued TS **HISTORY-BACKFILL-UNMAPPED-SPIKE**.
- **387** `source=onchain_dapper_v1` / `nflallday` — the owned **ALLDAY-V1-UNMAPPED-DRIFT** (unresolvable AllDay V1 Dapper tail; Trevor decision).
- 1 `onchain_dapper_v2` (negligible).

**Not corruption, not user-facing:** these rows are held *out* of `sales` (check 3c confirmed 0 null/orphan in AllDay `sales`), so FMV/deal boards are unaffected. The growth tracks the deliberate 06-23/24 backfill program, not a fault. Trust-health `unmapped_resolution_backlog_max` already monitors this, and the night pass/monitor track both parent items — so this is **already covered**; not separately re-logged to the ledger (and the ledger is not edited from Cowork per the truncation rule).

TS unmapped (170, all one 15:28Z batch today), Golazos (26), UFC (23) are small/normal residuals.

## Suggested actions
1. **AllDay unmapped (operator/CC, off-limits to this sweep — ingest/resolver logic):** when convenient, give the 737 backfill-era Flowty-AllDay rows the same treatment already queued for the TS Flowty spike — a drain/resolver for resolvable rows, or a **retire mechanism** mirroring the AllDay `flowty_no_edition_id` class for the genuinely-unresolvable Flowty-marketplace tail (Flowty's market shut ~05-13, so many will never map), or pace the AllDay backfill cron. No urgency — quarantined.
2. **Everything else:** no action. FMV sanity 0, offer edition-grain gap 0, wmc contract healed, sales mapping clean, freshness green, pack-EV board fresh, both offer-indexers live. No new monitoring config needed this week (all flaggable surfaces already watched).

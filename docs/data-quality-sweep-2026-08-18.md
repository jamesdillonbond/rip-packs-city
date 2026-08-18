# RPC data-quality + reconciliation sweep — 2026-08-18 (PT)

**Status: HEALTHY** — no alert-grade issues, no schema drift, security posture clean. Two standing WATCH items (both known/quarantined), and one operational caveat: the DB was in a **disk-IO saturation spell** during the sweep (autovacuum `VACUUM ANALYZE wallet_moments_cache` running 1h+ alongside several concurrent crons), so the heavy `wmc`/`sales` full-scans were run as bounded/sampled queries instead.

## This week

| # | Check | Result | Verdict |
|---|---|---|---|
| 1 | `v_fmv_sanity_flags` | 0 rows | ✅ clean |
| 2 | `v_offer_sanity_flags` | 1,118 flags, **100% `has_sub_serial`** (704 `gql_blank_chain_has` + 414 `chain_exceeds_gql`); median gap $8/$14, max $2,000 | ✅ structural-only; `raise_edition_offers_from_chain()` observed running (durable fix live) |
| 3a | canonical editions w/o any `fmv_snapshot` | 0 across TS/AllDay/Golazos/UFC | ✅ every canonical edition priced |
| 3b | wmc `edition_key` ↔ `editions.external_id` | recent-6h slice (20k sampled): TS 0/10,857, AllDay 0/8,326, UFC 0/173, Golazos 0/1 orphan | ✅ contract intact, drain not regressed |
| 3c | sales (24h) null/orphan edition | 4,197 sales, 0 null edition (current partition) | ✅ live mapping clean |
| 4 | `unmapped_sales` unresolved | AllDay **106,044** · UFC 1,056 · Golazos 8 · TS 0 | ⚠️ WATCH — see Flags |
| 5 | Sentinel TS UUID-keyed (48h) | 37 | ✅ ok (<250) |
| 6 | FMV freshness | AllDay 5m ✅ · Golazos 25m ✅ · TS 70m ⚠️ · UFC 1,042m ⚠️ · Pinnacle FMV 406m / floor_ask 188m | ⚠️ see Flags (TS marginal/saturation, UFC low-activity) |
| 6 | FMV coverage (precompute @ 07:48Z) | HIGH+MED share: TS 53.5%, AllDay 25.8%, Pinnacle 42.4%, Golazos 0.7%, UFC 0.0%; **`fmv_pct_stale_30d` = 0.0% all collections** | ✅ healthy, nothing stale |
| 7 | Pack-EV staleness (>3d) | freshest = today for all 4 (TS 10:25Z, AllDay 05:38Z, Golazos 08-17, Pinnacle 12:17Z); stale rows are the retired/depleted tail (TS 414/1,208, AllDay 1,254/3,111) | ✅ active boards fresh, tail-only |
| 8 | Offer-indexer liveness (24h) | topshot 97.1% (66/68, 2 fails) · allday 100% (69/69); offers 137,096 total / 24,314 open (5,579 sub, 1,529 serial) | ✅ both live + writing; open-offer accrual healthy |
| 9 | Schema-truth drift | `pinnacle_fmv_snapshots` correctly ABSENT; all named tables present; enums `fmv_confidence`/`tier_type`/`chain_type` byte-for-byte vs schema-truth.md; RLS-off public tables **0 of 367** | ✅ no drift |

## Flags

**1. AllDay `unmapped_sales` = 106,044 — WATCH (known quarantined classes, not corrupting live data).**
Up from 1,125 (06-30) because the AllDay V1 Dapper historical backfill has since ingested its full unresolvable tail. Composition: **97,176** `onchain_dapper_v1`/`nflallday` (the owned ALLDAY-V1-UNMAPPED-DRIFT — unresolvable V1 tail, prior Trevor decision), **8,716** `onchain`/`flowty` (history-backfill class), 152 `onchain_dapper_v2`. Recent inflow is small (185 added in 7d, 72 in 24h), so the flow rate is normal — the headline is accumulated backlog, quarantined in `unmapped_sales`, not corrupting `sales`/`editions`. No action; same disposition as prior sweeps.

**2. `v_offer_sanity_flags` = 1,118 — WATCH (structural GQL-collapse pattern).**
Every flag is `has_sub_serial=true` — the known footgun where the GQL `edition_offers` aggregate collapses subedition/serial offers that on-chain tracks per-printing. Count grew 411 (06-30) → 1,118 proportional to open-offer accrual (open subedition offers 3,220 → 5,579, serial 1,121 → 1,529). The durable fix — the GREATEST-based `raise_edition_offers_from_chain()` — was observed actively running during the sweep, so the blank/`offers_refreshed_at IS NULL` rows are reconcile lag, not a defect. No manual `edition_offers` write (per task rule).

**3. FMV freshness — TS 70min, UFC 17h (minor, likely benign).**
TS at 70min is marginally over the 60min threshold and coincides with the active saturation spell (the TS recompute is IO-delayed) — `topshot_fmv_pct_stale_30d` is 0.0%, so no real staleness. UFC at 1,042min: UFC FMV recompute is sporadic (only 4 batches in the last 5 days, clustered 08-17 evening) — consistent with a near-dormant, mostly zero-sale collection (1 unmapped sale in 24h), so nothing to recompute. Both worth a glance next sweep but neither is alert-grade.

**4. `topshot_impossible_parallel_serials` = 1 (precompute @ 06:48Z).**
One TS parallel-serial impossibility flagged by the trust board. Small; the trust board already watches it. Note for awareness.

**Operational note:** the wmc full-population orphan/null anti-join and the 7-day sales-mapping scan could not complete under the saturation spell (repeated `57014` statement timeouts). Both were substituted with bounded/sampled equivalents (recent-6h wmc slice; 24h current-partition sales) that returned clean. If a future sweep needs the exact full-population `wmc` orphan count, run it at a quiet hour.

## Suggested actions

Nothing shippable/actionable this cycle — a quiet, healthy week.

- No mispricing (FMV sanity 0), no integrity regression, no schema drift, RLS clean.
- Continue to hold the manual `edition_offers` raise (the automated GREATEST raise is live and working the residual).
- Next sweep: re-confirm TS/UFC FMV freshness outside a saturation window, and re-run the full-population `wmc` orphan count once IO is quiet to corroborate the sampled 0.
- No ledger entry (no code/pricing/auth/wallet change and no off-limits issue to flag).

# Handoff — AllDay `unmapped_sales` backlog regression (`allday_v1_history` backfill)

**Found by:** weekly `rpc-data-quality-sweep` (automated), 2026-07-24 ~19:49 PDT (2026-07-25 02:49 UTC).
**Severity:** MEDIUM — data-plane staging issue, NOT a live user-facing pricing incident.
**Owner:** Claude Code / operator. The sweep is read-only and ingest/backfill logic is off-limits to it, so nothing was fixed or shipped.

---

## Summary

The AllDay `unmapped_sales` unresolved backlog jumped from the ~2,466 residual noted 2026-07-17 to **44,021**, with **39,935 of those ingested in the last 7 days**. A historical backfill lane tagged `allday_v1_history` is dumping V1-Dapper (and some V2-Flowty) sales into `unmapped_sales`, and the V1-Dapper price-extraction step fails with `v1_tx_decode_budget_exhausted`, so those rows can never be priced and promoted to `sales`. The `allday-unmapped-resolver` runs green but resolves ~0.4% of what it sees.

It went unseen because the spike (07-22/07-23) landed exactly while the daytime monitor + night pass were dormant (app closed 07-22→07-24). This sweep was the first automated eye on it.

## Evidence (all read-only, project `bxcqstmqfzmuolpuynti`)

Backlog by source (AllDay `dee28451-5d62-409e-a1ad-a83f763ac070`, `resolved_at IS NULL`):

| source | unresolved | new 7d | newest sale |
|---|---|---|---|
| `onchain_dapper_v1` | 35,110 | 32,758 | now (live) |
| `onchain` | 8,906 | 7,175 | 2026-04-16 |
| `onchain_dapper_v2` | 5 | 2 | 2026-07-23 |

Daily inflow (by `ingested_at`) is **tapering** — a bounded historical backfill winding down, not an unbounded live leak:

```
07-22 ingested 15,312  resolved    50
07-23 ingested 11,520  resolved   220
07-24 ingested  2,051  resolved    83
07-25 ingested    163  resolved    11   (partial day)
```
(Before 07-16 the inflow was ~15–25/day.)

Resolver health (`pipeline_runs`, 24h): `allday-unmapped-resolver` = 93 runs, 92 ok, **rows_found 35,176 but rows_written 143** (~0.4% resolve rate) — silent under-resolution while reporting ok=true.

Root-cause signal (`resolution_hint` on recent unresolved rows):
```json
{"nft_id":"10519156","backfill":"allday_v1_history","sale_source":"v1_dapper",
 "price_extraction":"v1_tx_decode_budget_exhausted","sample_duc_amounts":[]}
```
Every V1-Dapper row shows `v1_tx_decode_budget_exhausted` + empty DUC amounts. Each `nft_id` appears ~2× (duplicate ingestion), so distinct events ≈ half the row count.

## Why this is NOT a live incident

- Last-7d `sales` mapping is **0-null** across all collections (AllDay included) — the live indexer's mapped sales are clean.
- AllDay FMV is **fresh**: 1.1 min stale, HIGH=103 / MEDIUM=383 at sweep time.
- The problem is confined to the `unmapped_sales` staging table. The only real loss is that this V1 historical-coverage backfill isn't achieving its goal (prices unextractable) and leaves a large stuck unpriced residual.

## Suggested investigation (do NOT blind-fix)

1. **Inspect the V1 tx-decode budget.** The failure is `v1_tx_decode_budget_exhausted` from the `allday_v1_history` backfill — look at the V1 Dapper decode path (`lib/chains/flow/dapper-v1-tx-decode.ts` and whatever backfill route/worker sets `backfill=allday_v1_history`). Either the per-tx compute budget is too tight for these V1 sale txns, or these txns genuinely can't yield a DUC amount and should be classified/skipped rather than parked as unresolved.
2. **Decide the residual's fate.** ~44k stuck rows: retry after a budget change, or accept as a frozen unpriced tail. If pruning, remember `unmapped_sales` is staging (not circuit-breaker-guarded like `wmc`/`editions`), but still scope any delete.
3. **Close the monitoring gap.** Nothing alerts on `unmapped_sales` backlog growth or the resolver's `rows_found ≫ rows_written` divergence. A `pipeline_cadence_watchlist` row is the WRONG instrument here (the resolver meets its cadence — 93×/24h green — so a cadence row stays green while the backlog explodes). The right detector is a **backlog-size threshold** (e.g. `count(*) unmapped_sales WHERE resolved_at IS NULL > N per collection`) or a **resolve-ratio** check (rows_written/rows_found over 24h). The sweep deliberately did not ship this — it's new alert logic, beyond additive-monitoring scope.

## Guardrails

- This is ingest/backfill territory — off-limits to the weekly sweep and to any autonomous night-pass auto-ship (FMV/ingest/pricing is queued-never-shipped).
- Do not "fix" it by widening the resolver batch size alone — the resolver isn't the bottleneck; the upstream price extraction is failing, so more throughput just re-reads the same unpriceable rows.

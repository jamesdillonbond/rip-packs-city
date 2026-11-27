# candy-wallet-refresh: on-demand whale-wallet walk hits time budget + 20k-asset cap (not a break)

- **Filed:** 2026-11-27 ~7:32 AM PT (rpc-daytime-monitor, cloud, laptop-VM sparse clone)
- **Priority:** LOW — evaluate; may be working as designed. Not user-facing broken.
- **Source:** `rpc_ops_snapshot()` pipeline_alerts flagged `candy-wallet-refresh` failure_rate HIGH (5/6 runs failed). `pipeline_runs` last 48 h.

## What the instrument saw

The snapshot's `pipeline_alerts` listed `candy-wallet-refresh` at `high` severity: "5/6 runs failed (83.3%) over the last 3 calendar days. Last error: time budget reached before the last page." The 83.3% rate is over a tiny sample.

## What it actually is (characterized before filing)

`candy-wallet-refresh` is NOT a scheduled cron — it is an **on-demand wallet walk**. All 6 runs in the window are clustered in a single 85-minute burst on 11-26 evening (23:23Z → 00:48Z), then nothing for ~14 h. It is **not on `pipeline_cadence_watchlist`** (`max_silent_minutes` NULL), which is why `detect_stalled_pipelines()` correctly does not flag it — there is no stall.

Run tail (UTC):
- 00:48 ok=false 58s — time budget reached before the last page
- 00:46 ok=false 56s — time budget reached before the last page
- 23:58 ok=true  24s — (small/fast wallet, completed)
- 23:47 ok=false 44s — **more than 20000 assets — walk stopped**
- 23:45 ok=false 52s — time budget reached before the last page
- 23:23 ok=false 47s — time budget reached before the last page

So: one large candy wallet (>20,000 assets) could not finish its refresh inside the per-run time budget / hard 20k-asset cap. The walk soft-stops and writes partial progress.

## Why this is not breakage

Every downstream candy trust metric is healthy at the same moment: `candy_fmv_stale_hours` 0.2, `candy_sales_stale_hours` 2, `candy_offers_oldest_active_hours` 2.5, `candy_offers_unverified_pct` 0, `candy_ask_book_drop_pct` 4.7 — all `ok`. Nothing user-facing is stale or missing; the only effect is a partial refresh for one candy whale wallet on demand.

## Suggested action (night pass to weigh — LOW)

Decide whether a candy whale wallet deserves a complete refresh. Options, in order of least risk:
1. Give the walk **resume pagination** (persist a cursor so a subsequent on-demand run continues from the last page instead of restarting), so a >20k-asset wallet completes across a few invocations.
2. Or raise the per-run time budget / the 20,000-asset hard cap for this lane specifically.
3. Or, if a partial refresh of a whale candy wallet is acceptable, **add `candy-wallet-refresh` to the no-ledger "expected soft-stop" list** so this snapshot alert is understood as working-as-designed and not re-surfaced.

Not in the ledger or on the Declined list as of this run. Not a spell (no saturation; `rpc_ops_snapshot()` returned normally, `pg_stat_activity` not probed because no timeout signal).

## Risk read
Any of the three options is low-risk (one lane; a cursor/budget change is additive and reversible). Pure sensing by the monitor — no change made.

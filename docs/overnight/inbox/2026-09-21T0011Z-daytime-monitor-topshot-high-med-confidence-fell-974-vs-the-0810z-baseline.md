# Daytime monitor — Top Shot HIGH+MED confidence count fell ~974 vs the 08:10Z baseline

**Filed:** 2026-09-20 ~5:10 PM PT (rpc-daytime-monitor, read-only pass) · **Priority:** low-medium · **Type:** drift observation → quiet-window RE-MEASURE (not a conclusion)

## Signal
Comparing `rpc_ops_snapshot().fmv_by_collection` against `docs/overnight/metrics-latest.json` (the night pass's 08:10Z baseline, TS FMV computed_at 05:46Z; current computed_at 13:35Z):

| collection | baseline HIGH+MED | now HIGH+MED | delta |
|---|---|---|---|
| nba_top_shot | 1341 + 5900 = **7241** | 1340 + 4926 = **6266** | **-975** (MEDIUM -974) |
| nfl_all_day | 61 + 1573 = 1634 | 63 + 1522 = 1585 | -49 |
| disney_pinnacle | 166 + 549 = 715 | 166 + 549 = 715 | 0 |
| candy_mlb | 9 + 69 = 78 | 6 + 62 = 68 | -10 |
| laliga_golazos | 0 + 4 = 4 | 0 + 4 = 4 | 0 |

Only Top Shot moved materially. Current TS full mix: LOW 4692, HIGH 1340, MEDIUM 4926, STALE 274, NO_DATA 326, ASK_ONLY 2453, SALES_ONLY 5.

## Why this is a re-measure, not an alarm
- All trust-health arms are OK: `topshot_fmv_pct_stale_30d=0`, `topshot_fmv_stale_hours=0.2`, `fmv_sanity_flags=0`, `fmv_sweep_stall_pct_24h=18.1` (breach 50). FMV is FRESH, so this is a confidence-tier RECLASSIFICATION (MEDIUM editions moved to LOW/ASK_ONLY), or the 05:46Z baseline MEDIUM was transiently high.
- The baseline was taken DURING this morning's pre-resize saturation spell (fmv-recalc / fmv-backfill were failing on statement timeout, >=50%), so the 05:46Z MEDIUM figure itself may be the anomaly, not the current one.
- The headline accuracy-gate KPI (roadmap-2026-08-03) is "share of prices at HIGH/MEDIUM confidence," so a ~13% swing in TS HIGH+MED is worth confirming even if benign.

## Suggested action (night pass, quiet window)
Re-derive the full TS confidence mix (LOW/MEDIUM/HIGH/ASK_ONLY/STALE/NO_DATA) at two clean points and decide whether TS MEDIUM coverage genuinely fell or simply reclassified into LOW/ASK_ONLY as recent-sale support aged out. metrics-latest.json only stored HIGH/MEDIUM, so the LOW/ASK baseline needed to settle this is not on disk. Capture the per-edition tier SET, not just the aggregate ("diff the SET, not the count"). If it reclassified (total priced coverage roughly conserved), spend nothing; if total priced coverage actually dropped, that is a real accuracy regression to chase.

## Source
`rpc_ops_snapshot()` @ 2026-09-21T00:05Z vs `docs/overnight/metrics-latest.json` (08:10Z). Not in a spell at read time (pg_stat_activity io_wait=1, active=1; postmaster start 17:39Z = the 10:39 AM PT Small->LARGE resize, no new restart).

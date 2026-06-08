# I1 — wmc write-amplification + rush-window saturation: findings & stagger plan (2026-06-07)

Analysis complete. **No DB change shipped — none is warranted.** The two code-side suspects are already fixed in place:
- `refresh_wmc_fmv_changed` already carries the idle-update guard (`wmc.fmv_usd IS DISTINCT FROM lf.fmv_usd`), chunked 150-edition statements, 60s internal budget. Verified by reading the live function body.
- wmc autovacuum is already tuned (`autovacuum_vacuum_scale_factor=0.05, autovacuum_analyze_scale_factor=0.02` reloptions) and KEEPING UP: n_dead_tup was 58 (!) at measurement, 147 autovacuums, last run minutes prior. Do not re-propose autovacuum tuning.

## What the data says (48h window, measured 2026-06-07)

wmc churn is real work, not waste: n_tup_upd 22.16M lifetime vs n_tup_ins 38.9k — wmc is an update-heavy denorm cache by design. `wmc-fmv-populate` wrote 2.06M rows/48h across 666 runs (~14/hr) — that's genuine FMV drift propagating to ~1.58M wmc rows via the guarded refresh; repeats are no-ops.

The actual I1 problem is START-TIME CLUSTERING. Pipeline starts per 5-minute bucket (48h, all pipelines):
- :00–:04 → 6,825 starts (10–45x the baseline of other buckets; baseline ~150–600)
- :05–:09 → 2,304 (23 fails — worst fail bucket with :20)
- :20–:24 → 1,543 (30 fails)
- everything else ≤ 1,453, near-zero fails after :40.

Five heavy pipelines all anchor at offset 0 (mod 20): wallet-backfill-multicollection-dispatch (1,920 runs/48h — and its child trains allday 2,439 + pinnacle 2,262 fire at +2), wmc-fmv-populate (666), pinnacle-nft-resolver (592, 13 fails), wallet-backfill TS (577), promote_unmapped_sales (467, chained). The :00 spike IS the connection-pool/statement-timeout fail class (pack-ev "targets:" timeouts, hydrator candidate_read, smoke mass-fails).

## The fix: cron-job.org offset stagger (operator, ~10 min, zero code)

cron-job.org rejects range-step syntax — use explicit comma lists. Proposed offsets (keep relative cadence, shift the anchor):

| cron-job.org entry | today | move to |
|---|---|---|
| wallet-backfill-multicollection-dispatch | :00 anchor, ~90s cadence | base :09 (shifts the whole child train off :00) |
| wmc-fmv-populate | :00 anchor, ~4–5 min cadence | 3,8,13,18,23,28,33,38,43,48,53,58 |
| pinnacle-nft-resolver | :00 anchor | 6,26,46 (or 6,16,26,36,46,56 if 10-min) |
| wallet-backfill (TS) | :00 anchor, ~5 min | 4,9,14,19,24,29,34,39,44,49,54,59 |
| snapshot-institutional-wallets | 06:00Z daily | 06:37Z (also fixes the recurring N1 stall) |
| GHA smoke schedule | :00/:15 | :11/:41 (GitHub workflow cron, repo-side — CC one-liner if desired) |

Keep as-is: compute-topshot-pack-ev (1,7,...,55 — already spread), topshot-fmv-populate (:50, just moved), everything already off :00.

Verify after applying: the :00–:04 bucket drops toward ~2,000; the rush-window fail classes (pack-ev `targets:` timeouts, hydrator candidate_read, pinnacle-nft-resolver) drop to near-zero; no new `detect_stalled_pipelines()` entries (watchlist thresholds all tolerate a few minutes of offset shift).

Optional CC follow-up (LOW, only if scan cost ever matters): `app/api/wmc-fmv-populate/route.ts` REFRESH_SINCE_MINUTES 30 → 12 — at ~4.3-min cadence the 30-min window re-scans the same drifted editions ~7x (writes are no-op'd by the guard; only scan cost). Not urgent; skip unless DB CPU becomes a complaint.

# Daytime monitor candidate — 2026-10-27 ~03:09Z

**Run:** rpc-daytime-health-monitor (cloud, laptop-VM clone push). Infra GREEN — not in a saturation spell (rpc_ops_snapshot() returned fast; no IO-wait majority). This is a normal candidate, NOT a spell symptom.

## Candidate (LOW — recent-ship performance watch)

**Title:** hot-floors board reads exceed the 8000ms read-bound on today's all-day / Panini Top Shot-parity deploy.

**Source:** Vercel runtime errors, route `/[collection]/hot-floors`:
- `[allday-hot-floors] read bound: [collection/allday-hot-floors] read exceeded 8000ms` — first=last `2026-10-27T02:34:43Z`, count 1, on `dpl_5gW6jqNC1yk8GQvqiGiogMBFzCns` = `feat(allday): Top Shot parity pass 1 — Hot Floors` (`a33bf9e8`, shipped today).
- `[panini-hot-floors] read bound: [collection/panini-hot-floors] read exceeded 8000ms` — first=last `2026-10-27T02:36:04Z`, count 1, same deploy.
- generic `[hot-floors] read bound` also tripped `2026-10-27T02:34:51Z` (the base route; first-seen for that group is old, 2026-08-29, but this occurrence is on the new deploy).

**Risk read:** LOW. The 8s read-bound degrades the board to EMPTY rather than 500ing, so no hard user error, and each key is count 1 so far (first signal, ~90 min after the parity deploy). But these are brand-new user-facing boards already touching the ceiling on first traffic, so under real load users may see an empty Hot Floors board on all-day and Panini collection pages.

**Suggested action (night pass):** `EXPLAIN (ANALYZE, BUFFERS)` the all-day and Panini hot-floors board queries (the `get_allday_hot_floors` lane shipped in `a33bf9e8` and the Panini equivalent) against the live DB in a quiet window; confirm the intended index is used and that any `LIMIT` can actually bind (acceptance test = `EXPLAIN` row-estimate ≤ LIMIT, not a fast wall-clock). If it is a structural full sweep, add a supporting index or move the board to a precompute like the other `*_board` tables. Do NOT conclude from a single fast/slow wall-clock read.

**Secondary observation (lower priority, pre-existing — not a new finding):** `panini_deal_board` / `panini_deal_board_all` throw `canceling statement due to statement timeout` on `/api/cron/refresh-insights-cache` (count 2 each, `panini_deal_board` first-seen 2026-10-04, last `2026-10-27T00:07:12Z`). Same insights-board read-perf family; folded in here so the night pass has the full picture of slow board reads, but it has been low-count and recurring for 3+ weeks.

## What was clean this run
security/structure/anon-write/secdef all `[]`; stalled_pipelines `[]`; `check_pgcron_recent_failures()` `[]`; sentinel_ts_uuid_editions_48h 0; latest prod deploy READY (no ERROR); all dashboard-referenced relations+functions present (0 missing); trust health 36/37 ok — sole breach `candy_sales_stale_hours` (359.7h) is the KNOWN Candy MLB market freeze (secondary trading stopped ~10-11), already run to ground with Trevor, not re-raised.

---

## ✅ RESOLVED 2026-10-27 ~7:45 AM PT (Claude Code cloud)

All three Hot Floors boards now read a precomputed row instead of the live sessionizing sweep:
- **All Day** — already on `allday_hot_floors_snapshot` since 10-26 ~8:45 PM PT (`20261027031715`, pg_cron 802).
- **Top Shot + Panini** — `20261027140941`: `hot_floors_snapshot` (row per board), `refresh_hot_floors_snapshot(p_board)`, pg_cron `topshot-hot-floors-snapshot` (13,28,43,58) and `panini-hot-floors-snapshot` (29,59). Code: `lib/hot-floors/snapshot.ts` (row / no row → compute live / failed read → failed). Measured before: `get_topshot_hot_floors(3)` 2,263 ms / 26.3k buffers, `get_panini_hot_floors(7)` 2,088 ms / 16.6k buffers.
- Verified live on deploy `9f5cb7912`: both boards render a table with "Board updated N ago"; the cron's own ticks are ok in `pipeline_runs`.
- Correction to the filing: the failure mode degrades to the honest "Couldn't load" copy, not to an empty board.

The secondary `panini_deal_board*` timeout stays a watch (hourly cache warmer, falls back to the last good snapshot, ≤ 2/day; a rewrite measured no buffer win — ledger 10-27).

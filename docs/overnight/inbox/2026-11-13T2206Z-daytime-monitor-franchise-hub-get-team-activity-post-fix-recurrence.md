# Franchise-hub `get_team_activity` still cold-times-out after the 11-12 prefetch fix (post-close recurrence)

**Priority:** LOW (read-only re-measure; honest-degradation, nothing user-visibly broken).

**Source:** Vercel runtime errors (prj_YBJ6…, 12h window, read 2026-11-13 22:06Z):
- `[entity-section] franchise-hub get_team_activity ... rpc get_team_activity timed out after 45000ms with no response — degrading to empty` — count=1, 2026-11-13T12:01:33Z, route `/[collection]/edition/[slug].rsc`.
- `[teams/franchise-hub] get_team_activity nfl_all_day bound: [...detroit-lions] read exceeded 10000ms` — count=1, 2026-11-13T12:00:18Z, route `/teams/[league]/[slug]`.
- Both cluster at the same 12:00–12:01Z minute as two `get_player_hub` cold reads (matt-manning, joey-bart, each `read exceeded 4000ms`) → one cold-cache prefetch/crawl sweep at ~4 AM PT, each entity hit once.

**Why it is a new signal (not a duplicate):** the 11-12 `/teams` prefetch fix (`aa6af0f6`, prod ~18:22Z 11-12) was filed under `2026-11-12T1907Z` and marked ✅ RESOLVED ~5:15 PM PT 11-12 on "0 franchise-panel timeouts after the fix". That item's own falsifier was verbatim: *"if the per-panel read still cold-times-out at 10 s afterward, the lever is the read, not the prefetch."* These two 11-13 errors are that falsifier firing ~1.5 days after close — a 10 s cold panel read (detroit-lions) AND a 45 s RPC no-response, both post-fix. The prefetch fix cleared the fan-out STORM (>=4 NBA teams at one minute on 11-12); it did not make the underlying `get_team_activity` read cheap on a cold franchise.

**Risk read:** LOW. All occurrences count=1, single user, degrade gracefully to an empty panel. Platform GREEN at read time (security x4 clean, trust 0 breaches, stalled/pg_cron/sentinel clean, 13/13 dashboards OK, prod READY). **Not a spell** (positive control 22:06Z: 3 active sessions / 3 IO-wait — quiet DB, not saturation; `rpc_ops_snapshot()` returned fast).

**Suggested action (night pass):** quiet-window re-measure of `get_team_activity`'s cost on a COLD franchise (e.g. `nfl_all_day` detroit-lions and a big NBA team) — `EXPLAIN (ANALYZE, BUFFERS)` from cold, not warm wall-clock. If a cold read genuinely approaches the 10 s panel / 45 s RPC budgets, the lever is the read itself (a covering index or a bounded/precomputed team-activity path), per the 11-12 item's falsifier — NOT more prefetch. If cold reads come back well inside budget, this was a one-off cold-sweep artifact and can be closed. Do not re-open the 11-12 item; this is its residual read-path tail.

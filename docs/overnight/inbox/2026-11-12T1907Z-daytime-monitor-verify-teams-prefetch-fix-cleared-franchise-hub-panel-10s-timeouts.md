# Verify today's `/teams` prefetch fix (`aa6af0f6`) cleared the franchise-hub panel 10s read-timeout cluster

**Filed:** 2026-11-12 ~11:07 AM PT (daytime health monitor, Cowork cloud)
**Type:** low-risk WATCH / post-ship verification (read-only; the monitor proposes no change)

## One-line
Confirm the franchise-hub panel `read exceeded 10000ms` cluster stops after `aa6af0f6` reached prod (~18:22Z / ~10:22 AM PT 11-12); if the per-panel read still cold-times-out at 10 s afterward, the lever is the read, not the prefetch.

## Source
- Vercel runtime errors (prj_YBJ6…, 24h window, read 2026-11-12 19:05Z): a cluster of `[teams/franchise-hub] panel nba_top_shot bound: [...] read exceeded 10000ms` at **2026-11-12T15:53:00Z** across >=4 NBA teams (boston-celtics, atlanta-hawks, brooklyn-nets, charlotte-hornets), plus single hits oklahoma-city-thunder 04:15Z and milwaukee-bucks 10:34Z; and `get_team_activity failed after retries: ... statement timeout -- degrading to empty` (chronic, first 2026-10-19, last 2026-11-12T10:31Z). Each is count=1, honest-degradation (empty panel), single user.
- Same-day ship: deploy `aa6af0f6` -- "teams: franchise-hub links do not prefetch" (prod, created ~18:22Z / ~10:22 AM PT 11-12). Its commit message names this exact symptom ("their cold regenerations timed out panels together (4 in one second, 7:53 AM PT)").

## Risk read
Investigation only. The monitor proposes no code/DB change. The fix is already live; this is a post-ship verification plus a conditional sizing lead. Any eventual action (an index/budget change) is the night pass's or Trevor's call.

## Suggested action (night pass)
1. The 15:53Z cluster **predates** the ~18:22Z `aa6af0f6` deploy, so it is the pre-fix tail. Re-read Vercel runtime errors for `/teams/[league]/[slug]` franchise-panel 10000ms timeouts with `since` after ~18:30Z 11-12 -- expect the cluster to stop (prefetch={false} removes the ~100-hub prefetch storm per /teams visit).
2. **Not a spell:** the monitor's positive control at sweep time read io_wait 0 / active 0, so a cold 10 s read is interpretable, not saturation collateral. If franchise-panel `nba_top_shot` reads still cold-exceed 10 s AFTER the fix, the lever is the per-panel read itself (`get_team_activity` / the franchise-panel bound query), not the prefetch -- size it with BUFFERS in a quiet window and consider a covering index, mirroring the 2026-11-10 `idx_editions_collection_set_slug` set-slug index pattern (ledger 11-10).
3. If the cluster is gone post-fix and no cold 10 s read remains, close this as a confirmed post-ship watch -- no index needed.

## What is NOT this
The `/teams` prefetch storm cause is addressed by `aa6af0f6`; this filing only asks that it be confirmed and that the residual per-panel cold read be sized if it survives. Not the `get_set_activity` set-slug timeout (indexed 11-10) and not the insights 8 s reads (separate chronic class).

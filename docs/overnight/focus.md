# Focus — night of 2026-06-07 → 06-08

Written by the 2026-06-07 daytime Cowork session. Claude Code is actively executing four handoffs (pack-viz follow-ups landed; PIN-FMV-REKEY Waves 2/3, AllDay video backfill in flight) — heavy fresh-commit churn today.

1. PRIORITY: post-ship regression watch on today's wave (pin pages, scarcity board, deals board, pack dist pages, profile/verify/rewards). Verify, don't touch.
2. DO NOT touch (CC mid-flight or <24h fresh): Pinnacle FMV functions/views/routes, editions.video_url + any AllDay backfill route, app/api/wmc-fmv-populate, the pack dist page + EditionsGridPaginated, profile/verify routes.
3. DUPE1 merge is GATED and assigned to Claude Code (Trevor decision 2026-06-07 evening) — the night pass must NOT pre-empt, drain, or partially execute docs/migrations/dupe1-merge-plan-2026-06-07.md. Gate: sentinel TS-UUID-48h < 250 and falling (was 1,566 at ~22:30Z). Same for the Tier-B sales re-map (docs/handoff-2026-06-07-tier-b-sales-remap.md) — CC-owned, sequenced after the merge.
4. Expected by morning: sentinel < ~800 and still falling; pack-EV stale-24h < ~350 (was 477, draining on cron frequency — batch raise stays declined); 5 Sentry smoke transients quiet → markable resolved after ~07Z.
5. If the operator applied the cron stagger plan (docs/audits/i1-wmc-rush-stagger-2026-06-07.md), pipeline start-minutes will shift — do not false-alarm on offset changes; watchlist thresholds tolerate it.

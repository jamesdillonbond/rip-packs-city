# Claude Code: watch list handed to the night/daytime passes — the 11-09 signup-wave thread is being archived

**Filed:** 2026-11-09 ~9:55 PM PT by Claude Code cloud. The thread's own 5:05 AM PT check-in was cancelled because it would fire into an archived thread; these reads replace it. Each is a READ: close the item in place if it holds, re-route it if it does not.

1. **Self-heal lanes (inbox `2026-11-09T1606Z` + `2211Z`).** Read the **`pipeline_runs`** rows, not `cron.job_run_details` (both lanes catch their own error, so cron reads "succeeded" when they time out):
   - `wmc-metadata-selfheal`, 2:31 AM PT 11-10: ok=true; `rows_written` about 1,455 the first time (the non-Candy rows the 11-09 timeout missed).
   - `topshot-map-atlas-reconcile`, 4:47 AM PT: ok=true under its new 300 s window (it took 53 s for candidates alone on 11-09).
   - `wmc-player-names-follow-catalog`: every-5-min ticks all ok (36/36 at 9:20 PM PT, max 36 s).
   - If all three hold, append ✅ RESOLVED to `1606Z` and `2211Z` and mark both in INDEX.
2. **#242 `backfill-pack-rip-metadata`.** Exit: no timeout in the 24 h of :53 runs from 6:53 PM PT 11-09 (runs since are 9.4–14.4 s). If it holds, flip register #242 to ✅ RESOLVED (regenerate the index with `npm run docs:issues-index` and diff before staging). Falsifier: a run over ~35 s or a 57014 — then read the stale / zero / drain legs.
3. **Candy 1-of-1 re-key (`c30913392`).**
   - The 180 merged "2022 All-Star Tricons" editions should reach 0 cards on them as census laps repoint (query in ledger 11-09 "a 1-of-1 card is keyed as its own edition").
   - `candy-orphan-one-of-one-editions` (hourly :22): ok=true, `referenced` near 0.
   - `edition_integrity_flags` should keep falling (13,626 at 9:20 PM PT).
   - `v_insights_trophies` read 1.28 s semi-cold under the MLB-only view (budget 7,000 ms); no re-baseline needed.
4. **`candy-editions-ingest`.** The 11-09 5:10 PM PT run rejected one `wallet_moments_cache` batch on a lock timeout; the 11-09 evening run was clean. A repeat means daily contention with the Candy label-fill: re-route it to the census owner.
5. **First-touch attribution.** Verified: 2 of 2 signups since the 11-09 deploy have `user_profiles.first_touch_*`. Nothing to watch; listed so nobody re-checks it.

Ledger: the 11-09 entries "signup-wave remediation roll-up", "thread close-out", "a 1-of-1 card is keyed as its own edition".

**↳ Item 2 done — 2026-11-10 ~7:10 PM PT (Claude Code cloud):** #242 exit met (25/25 :53 runs 6:53 PM PT 11-09 → 6:53 PM PT 11-10 ok, 0 timeouts, max 23.0 s); register #242 flipped to ✅ RESOLVED, index regenerated (diff balanced, 8 → 7 partial).

# Daytime monitor — 2026-09-06T15:10Z (~08:10 PT, first tick of day)

Sweep summary: **healthy except one new pipeline finding.** Security clean (all four invariant arrays `[]`). pg_cron clean (`check_pgcron_recent_failures()` → null). Cross-collection refresh fresh + both steps succeeded (ccm1 223 rows @ 09-05T23:10Z, ccm2 @ 09-05T23:25Z, both jobs active). Trust health carries its two KNOWN breaches only (see below). Artifacts: rpc-live-health payload objects all resolve (listings_active 64,549 · unmapped_open 100,516 · pinnacle_fmv_history 213,937 · sales_24h 1,816 · pipeline_runs_24h 20,970) — no schema break. Latest Vercel prod tip is a docs-inbox commit, CANCELED as expected (docs-only ignoreCommand); no ERROR observed.

Concurrency lock present but STALE (`night-20260906T080310Z`, 08:03Z, ~7h old, not RELEASED) — treated as not-active, inbox commit proceeded.

---

## NEW CANDIDATE — HIGH-ish

### `allday-lock-refresh` — one wallet (`trypdub`) Flow-400 script failure marks the whole 20K–33K-row run `ok=false`; onset 2026-09-05 05:23Z

- **Source:** `pipeline_runs` where `pipeline='allday-lock-refresh'`; also surfaced as the snapshot's high-severity `failure_rate` alert (31/59 runs failed, 52.5%, over 2 days; 24 fails/24h, 0 upstream).
- **Signal:** EVERY hourly run since 2026-09-05 05:23Z fails with `wallet trypdub: Flow 400 … [Error Code: 1052] failed to execute script` — yet each run still writes **20,936–33,793 `rows_written`**. So the pipeline is doing nearly all its work and being marked failed on a **single wallet**. This is the overloaded-`ok=false` shape from CLAUDE.md ("`ok=false` is overloaded… read `extra`/`last_error`, never retire on `rows_written`"): the whole run's health flag is hostage to one wallet's Flow script.
- **Onset is recent and sharp, not longstanding:** `first_trypdub_fail = 2026-09-05 05:23:06Z`. Over the last 7 days: **39 ok runs vs 34 trypdub-fails**, i.e. it was mostly green until ~34h ago and has failed every tick since. NOT attributable to any 09-05 code ship (CSP / DEP0169 / pack-dist logging / resolve-topshot-stubs wall all touch unrelated code).
- **Two error sub-variants seen**, both on `trypdub`: pure `[Error Code: 1052] failed to execute script at block (…)` and `failed to execute the script on the execution node execution-002.mainnet28.nodes.o…`. Error 1052 is a Flow script-execution failure — consistent with either a wallet that has grown past the per-script computation limit, or intermittent execution-node errors on a large account.
- **Risk read:** LOW to touch, but the alert is currently a persistent HIGH false-alarm masking any *real* future lock-refresh regression. No data loss observed (rows keep landing).
- **Suggested action (night pass to decide):** verify on the DB which is true, then either (a) make a per-wallet Flow-script failure **non-fatal to the run's `ok` flag** — record the failing wallet(s) in `extra`/`last_error` and keep `ok=true` when rows_written is normal (do NOT fail-open silently — count + log the skipped wallet), or (b) chunk `trypdub`'s lock-refresh script if it's a computation-limit issue. Both are worker-side; confirm the caller/route before editing.

---

## Known / already-tracked (no action — listed so they're not re-raised)

- **Trust health BREACH ×2, both known:** `public_board_slow_count=1` = `topshot_2025_rookie_cohort_stats` reporting contention, deliberately not retuned (focus STEER 7); `unmapped_resolution_backlog_max=119` (breach_at 100) = nfl_all_day resolver backlog, still declining (172→148→132→**119**), worker-side drain.
- **`allday-pack-opens-backfill` 93.3% fail** — already FILED (dead at the edge since 09-04 02:16Z).
- **`atlas-editions-upstream-403`** (33/480, 6.9%) — info, attributed to the Atlas walk, escalates only if the 0-of-266 not-completed count goes non-zero. No rows lost (re-walk on non-200).
- **`topshot-badge-set-backfill` stalled arm** — the seeded false-positive; pipeline was deliberately unscheduled (inbox 2026-09-05T1810Z).
- **`offers-sweep` 36/36 upstream, `ingest` 8/8 upstream** — external upstream failures, not our bugs.

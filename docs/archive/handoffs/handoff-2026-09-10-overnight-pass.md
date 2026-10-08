# RPC overnight pass handoff — 2026-09-10 (PT)

> ⚠ **COMMITTED LATE, AND TWO OF ITS HEADLINE CLAIMS WERE ALREADY REFUTED BY THE TIME IT REACHED THE REPO.** This pass had no push, so it sat on the mount until 2026-09-10 ~20:45 PT. **The body below is kept VERBATIM as the pass's own record — do not read it as current state.** Corrections, each re-derived live before being written here:
>
> 1. ⛔ **The HIGH item's hedged CAUSE is wrong.** It proposes a GitHub Actions scheduled workflow *disabled or out of minutes*. Every workflow in fact reads `active` and GHA schedules are still delivering. **The real cause was the Vercel spend-cap pause (register #76)**, which 503'd every HTTP-triggered lane for ~10 h; **cron-job.org then auto-disabled the high-frequency jobs** after banking hundreds of consecutive failures. That is why the freeze split along **cadence** — 4–6-hourly lanes recovered on their first slot, 1–15-minute lanes did not. ✅ **Its DETECTION was sound and well-controlled** (frozen `-heartbeat` markers proved the lanes were never invoked), which is why it is preserved.
> 2. ⛔ **The M1 flag ("54.2% → 49.8%, below the 50% bar") does not hold.** Re-derived from `fmv_current`: **52.5%** (1,496 HIGH + 5,863 MEDIUM of 14,015). A single reading, correctly labelled as such at the time and correctly not diagnosed.
> 3. ⚠ **"User alerts have been down ~11h" was an OVERCLAIM**, corrected by a concurrent session — `alert_deliveries` holds 3 rows in 36 h, all `sent`.
>
> ⚠ **What IS still open from this pass**, and it is the part nobody had acted on: the ten lanes run **only** on manual `workflow_dispatch`, and the `Dead Lane Backstop` GHA `schedule` has never self-fired. **The durable fix is re-enabling the cron-job.org jobs — an operator action.** See the 2026-09-10 "TREE RECONCILED" ledger entry.

**Run:** rpc-nightly-autonomous-pass · cloud · **OFF-HOURS MONITOR + NO-PUSH**
**Clock:** DB `now()` = 2026-09-11 00:43Z at start ≈ **17:42 PT 09-10** (established via DB `now()` + `max(ingested_at)`/`max(computed_at)`, since sandbox bash was unavailable).
**Shipped:** 0 · **Reverted:** 0 · **Health:** green except one HIGH external-scheduler freeze + one M1 metric-delta flag.

## Mode & environment constraints

- **OFF-HOURS (monitor-mode):** the run fired at 17:42 PT, outside the 00:00–06:00 overnight window → per the SKILL, queue everything, ship nothing except an auto-revert of a regressing recent ship (none was needed). No DB migrations, no code, no deploys.
- **NO-PUSH:** the sandbox `bash` tool could not mount the Windows share (Plan9 share `c` not mounted; failed identically on 3 retries). No git clone/fetch/push was possible. All repo reads used the Read tool against the mount; all outputs were written to the mount **uncommitted** and must be committed from the desktop / Claude Code.
- **Concurrent session active:** the latest Vercel production deploy `dpl_CErXn2hNCDVU4Lo4msNFtdTro2mY` (Claude-authored, a `sentinel` notifications-record commit) was **BUILDING** at 00:42Z, and several deploys landed tonight (00:01Z, 00:18Z). origin/main is moving → queue-only regardless of mode.
- **Ledger guards NOT run** (bash down). Run the three ledger guards on the desktop commit.

## What was reviewed

- `rpc_ops_snapshot()` full health vector; `pipeline_runs` last-run buckets (13h + 45m windows); `cron.job` + `cron.job_run_details` for the suspect lanes; Vercel `list_deployments` + `get_runtime_errors` (13h); ledger + `metrics-latest.json` + focus.md + the fresh daytime-monitor inbox file `2026-09-11T0045Z.md`.
- Inbox: 420 files present, but the 08-09→09-09 bulk is the un-archived backlog blocked on a push (not fresh candidates). The one genuinely-new filing (`2026-09-11T0045Z`) is the daytime monitor's report of tonight's freeze — folded below.
- Sentry: not separately deep-triaged; per the 09-08 audit the browser SDK is off and client errors route to the `usage_events` beacon. Vercel runtime errors were swept instead (below).
- Artifacts: none flagged broken/stale in the fresh inbox; none repaired (monitor-mode).

## 🚨 HIGH — 13-pipeline external-scheduler cluster stopped firing ~14:03Z 09-10 (QUEUED — operator/interactive)

A coherent cluster of 13 pipelines (20 rows incl. `-heartbeat`) froze inside a ~33-min window on 09-10 and has produced **zero runs since** (~11h at close, 00:53Z):

| pipeline | last run (UTC) | user-facing role |
|---|---|---|
| `wmc-fmv-populate` | 14:03 | fmv→wmc propagation (/share, portfolio) |
| `refresh_wmc_fmv_changed` / `_drift_active` | 14:03 | wmc FMV refresh (HTTP lane) |
| `snapshot-pack-asks` | 14:03 | **Pack Sniper** live-ask recency (NEW / price-drop) |
| `pinnacle-listings-retry` | 14:03 | Pinnacle listings |
| `allday-listings-indexer` | 14:02 | AllDay on-chain listings |
| `alerts-dispatch` | 13:59 | **user alert delivery** |
| `alerts-send` | 13:54 | **user alert delivery** |
| `allday-listings-retry` | 13:53 | AllDay listings retry drain |
| `golazos-listings-indexer` | 13:52 | Golazos on-chain listings |
| `pinnacle-events-ingest` | 13:49 | Pinnacle chain-event ingest |
| `pinnacle-catalog-floor-refresh` | 13:45 | Pinnacle render-floor → ASK_ONLY FMV |
| `ownership-onchain-walk` | 13:30 | ownership walk |

**Diagnosis (independently confirmed this run — it is a scheduler-not-firing event, NOT app/DB/pg_cron):**
- Every last run before the cutoff was `ok=true` with empty `error` — a **clean stop**, not failures.
- The `-heartbeat` markers (written *before* the work) froze at the same timestamps as the terminal rows → the routes are **not being invoked at all**.
- **pg_cron is fully healthy:** `cron.job` jobids 302/303/408/446 are `active` and **succeeding through 00:47Z**. The `wmc-fmv-populate`/`refresh_wmc_fmv_changed` pipeline_runs "silence" is a **logging artifact** — the pg_cron path backstops the FMV work, and `topshot_fmv_stale_hours` reads 0.1, `board_mv_refresh_stale_hours` 0.94, all 38 trust arms OK. So FMV freshness is fine.
- **Web tier is up:** functions executing at 00:45Z (Vercel `url.parse` warning), pack pages served 00:18Z. Security invariants 4/4 `[]`.
- None of the frozen 13 are pg_cron jobs (absent from `cron.job`) → they are **external HTTP-triggered** (cron-job.org / GitHub Actions).
- The short-cadence lanes all stop at ~14:03Z; longer-cadence ones show their last scheduled fire proportionally earlier → consistent with a **single ~14:03Z event** killing external invocations for one lane set. `analytics-smoke` (cron-job.org ":13,:43") is still firing (00:43Z), so it is **not a blanket cron-job.org outage** — a subset.

**Blast radius (why HIGH, still pre-breach):**
- **User alerts have not been delivered ~11h** — `check-alerts` still *detects* (00:35Z) but `alerts-send`/`alerts-dispatch` don't *send*. Most user-facing consequence.
- Pack Sniper NEW/price-drop recency stale ~11h; AllDay/Golazos on-chain listings + Pinnacle events stale.
- **`pinnacle_render_floor_stale_hours` = 11 vs breach_at 30 → breaches ~09:00Z 09-11** (public Pinnacle ASK_ONLY FMV goes stale) if `pinnacle-catalog-floor-refresh` is not restored.
- FMV propagation to wmc is partially backstopped by pg_cron (jobids 303/408), so /share & portfolio are not stale.

**Most-likely cause (hedged, not confirmable from this seat):** one shared external trigger fanning out to these HTTP endpoints stopped ~14:03Z — a **GitHub Actions scheduled workflow** disabled / failing / out-of-minutes (fits the mixed alerts+wmc+listings matrix), or a **cron-job.org group** going inactive (`snapshot-pack-asks` = job 7878615).

**Why not fixed this run:** github MCP failed to connect this session (can't check/re-enable Actions via MCP); cron-job.org requires the Chrome console (a recorded secret-leak hazard); off-hours monitor-mode; a concurrent session is actively deploying. Restoring a scheduler is not a git/DB revert and is not in the autonomous SHIP set.

**Ready-to-run remediation (Trevor / next interactive or on-hours pass):**
1. GitHub Actions tab → find a scheduled workflow last-green ~14:00Z 09-10 now disabled / failing / blocked on Actions-minutes/billing; check org Actions usage. Re-enable / re-dispatch.
2. cron-job.org console → confirm job 7878615 (`snapshot-pack-asks`) + siblings executed after 14:03Z; re-activate any inactive job/group.
3. Confirm recovery: per-pipeline `max(started_at)` moves within cadence for every row above; watch `pinnacle_render_floor_stale_hours` back < 30 before ~09:00Z.

**Verify-before-acting:** re-read `now()` and per-pipeline `max(started_at)` at fix time; do not trust `detect_stalled_pipelines()` elapsed labels in isolation (they render the freeze but read like an estate-wide outage — the estate is fine).

## Metric flag — Top Shot M1 dropped below its bar (QUEUED, not diagnosed)

Top Shot HIGH+MED confidence: **54.2% (09-09) → 49.8%** (6,976 / 14,015 canonical editions; HIGH flat 1495→1486, MEDIUM 6094→5490). Now marginally **below the 50% M1 go-live bar**. `topshot_fmv_pct_stale_30d` = 0.0, so not a staleness artifact. Single reading — most likely the 30-day rolling-window roll-off of the 09-08 atlas-backfill boost (which had pushed it to 51–54%). **Verify next real pass** whether this is ordinary window churn or a real regression; per CLAUDE.md, M1 is "right-and-misleading" and one reading is not a trend.

## Health-drift triage (deltas vs 09-09 metrics)

- **Security:** invariants / anon_write_holes / rls_off_base / secdef_anon all `[]`. Clean.
- **Trust:** 38/38 arms ok, breaches `[]`, precompute max age 5.93h (was 5.29h). The `pinnacle_render_floor_stale_hours`=11 arm is the one trending toward a breach (downstream of the headline).
- **Sentinel:** `sentinel_ts_uuid_editions_48h` = 0; `ts_uuid_dupes_created_24h` = 0.
- **DB size:** **26,078 MB** (22,834 on 09-09, 18,191 on 09-07) — +3.2 GB in 2 days, Atlas-events growth (~90k rows/day, no retention). Retention decision is destructive → off-limits/queued.
- **Pipeline fails 24h (chronic/known, not new):** `fmv-backfill` 54.5% (statement timeout — wasteful-not-broken); `price-snapshots` 36.4% (statement timeout); `sales-counterparty-backfill` 43 fails (rescanning a dead range, filed `2026-09-05T0510Z`); wallet-backfill Flow "computation limit exceeded" 400s (chronic upstream). All `upstream:0` or known.
- **Post-ship watch:** 09-09 retire-`ingest`-row **held** (`ingest` absent from `detect_stalled_pipelines()`); 09-08 #68 dedup **holding**.
- **Vercel runtime errors (13h):** dominated by the chronic statement-timeout / read-exceeded degradations on `/[collection]/edition|team|series` and `/[collection]/pack/dist/[distId]`, and the DEP0169 `url.parse` warning. One new-ish: `Telegram send non-OK: 400 message is too long` on `/api/sentinel` at 00:01:09Z (the sentinel's CRITICAL alert exceeded Telegram's length cap — the concurrent session's BUILDING commit appears to address the delivery-record read; watch that it also bounds message length). No ERROR-state deploy observed.

## Shipped

None (off-hours monitor-mode + no-push).

## Queued / needs decision

- **HIGH — restore the frozen external-scheduler cluster** (this run's headline). Before ~09:00Z 09-11 to avoid the Pinnacle floor breach.
- **Top Shot M1 54.2%→49.8%** — verify window roll-off vs regression next real pass.
- atlas-events retention / DB +3.2 GB/2d (destructive — policy call).
- best-offers break-on-error (needs push; 0 warns 24h).
- ~19 anon-public soft-404 tabs (product + proxy.ts).
- sync-nba-projections dry (#8, NBA offseason).
- inbox archival (420 files) + metrics/ledger commit — blocked on a push run.
- **Needs Trevor (carried):** #55 two 2-hourly Routines `enabled:false`; #22 purge GC + rotate; M2/All Day slide upstream probe.

## Failed / blocked / reverted

None reverted. Blocked: all git operations (bash/clone mount failure) and therefore all commits/pushes/deploys; the scheduler restore (external infra, github MCP down, off-hours). Nothing errored.

# Daytime monitor — 2026-09-07 06:11Z (2026-09-06 ~23:06 PT)

Read-only sweep. Estate healthy: `rpc_ops_snapshot()` clean (security all `[]`, trust-health 39/39 ok, `trust_health_breaches` `[]`, sentinel TS-UUID-editions-48h = 0); `check_pgcron_recent_failures()` `[]`; NOT in a saturation spell (3 IO-wait / 3 active). Merged `rpc-live-health` dashboard payload runs clean — all 12 insights views resolve, freshness current (FMV 06:09Z, Pack EV 06:07Z, Atlas `edition_offers` sweep 06:10Z = live positive control on today's ships). This is the ~23:00 PT tick, not ~08:00, so 1a first-tick extras skipped.

Lock note: `docs/overnight/.lock` on the mount is STALE (`LOCKED 2026-09-06T08:03Z ... (CLOUD)`, ~22 h old, never RELEASED) — the same unreleased night-pass lock the 03:11Z tick flagged. Not treated as a live run (fresh = <45 min), so the inbox commit proceeded.

---

## Candidate 1 — `detect_stalled_pipelines()` false-positive MEDIUM on `wmc-metadata-reconcile`: the watchlist keys on `pipeline_runs` recency, but the job legitimately writes no row on no-op ticks · LOW

- **Source:** `rpc_ops_snapshot().stalled_pipelines` + `detect_stalled_pipelines()` → `wmc-metadata-reconcile` silent 113 min vs `max_silent_minutes = 100` (severity `medium`). NEW since the 03:11Z tick, which saw no stalled pipelines.
- **This is a FALSE POSITIVE — positive control in hand.** pg_cron jobid **456** `rpc-wmc-metadata-reconcile` (schedule `15,45 * * * *`, active) ran and **succeeded** at 05:45 / 05:15 / 04:45Z (`cron.job_run_details.status = 'succeeded'`, return "1 row") — the job is firing on cadence and not erroring. The stall detector reads `pipeline_runs` recency, whose newest row is 04:15Z, because this pipeline writes a `pipeline_runs` row only on ticks that reconcile ≥1 row: post-drain (the WMC drain converged 09-04 ~21:00Z, inbox `2026-09-05T1630Z`) many 30-min ticks find nothing to reconcile and so write nothing. Verified against 12 recent runs — every logged row is `ok=true` with `rows_written` 1–78; there are no `rows_written=0` rows, i.e. no-op ticks are simply absent from `pipeline_runs`. Health here is pg_cron success, not `pipeline_runs` recency — exactly as the alert's own `notes` field states ("Health is SILENCE, not rows_written").
- **Why it will RECUR:** the cadence moved to `:15/:45` (30 min) today and the drain has converged, so quiet stretches ≥100 min are now normal; each one re-trips this medium arm. It is not a one-off.
- **Risk read:** LOW / read-only. No user-facing surface is affected. The only exposure is alert-fatigue — a recurring false `medium` can bury a real stall on this pipeline.
- **Suggested action (night pass):** reconcile the instrument with the job's real liveness, pick one — (a) have `wmc-metadata-reconcile` write a `pipeline_runs` heartbeat every tick (a marker row with `rows_*` NULL, per the `after()`-heartbeat convention) so recency tracks the job rather than the workload; or (b) raise this pipeline's `pipeline_cadence_watchlist.max_silent_minutes` to cover a post-drain quiet gap on the new 30-min cadence; or (c) validate this specific watched pipeline via `cron.job_run_details` success rather than `pipeline_runs` recency. Do NOT treat the `medium` as a real outage — jobid 456 is verifiably running and succeeding.

- ✅ **MEASURED 2026-09-07 ~09:0x PT (Claude Code, cloud) — the three options are now ONE. Evidence, then the two refutations.**

  **The control that settles the mechanism.** Over the window since the cadence change (`*/10` → `15,45`, 2026-09-07 01:49Z), the two instruments disagree:

  | instrument | question it answers | result |
  |---|---|---|
  | `cron.job_run_details` (jobid 456) | did it **RUN**? | **28 executions, 28 `succeeded`, 0 not-succeeded** |
  | `pipeline_runs` recency | did it **WRITE**? | **12 rows**, `min(rows_written) = 1` |

  ⭐ **16 of 28 healthy, successful executions leave NO ROW**, because the function only logs a tick that wrote ≥1. `detect_stalled_pipelines()` keys on `pipeline_runs` recency, so **it is measuring WORKLOAD and reporting it as LIVENESS.** The job is verifiably 100% healthy while the arm fires. ⚠ This is not transient: **max observed silence 180 min, 2 gaps over the 100-min threshold in ~13 h ≈ 3.7 false positives/day.**

  ⚠ **I nearly mis-sized it by pooling across the cadence change.** Over a 36 h window the same query reads 84 logged ticks / 2 gaps — which understates the rate, because most of that window ran at `*/10`. **A rate pooled across a change measures the change's absence** (CLAUDE.md); split on 01:49Z and it is 12 of 26 expected, not 84 of 216.

  ⛔ **(b) "raise `max_silent_minutes`" is REFUTED BY MEASUREMENT, not by preference.** The observed max silence is **180 min**, so suppressing the false positive needs a threshold above that — **6 missed ticks** — at which point a genuine three-hour outage of this job goes unreported. Widening it does not trade precision for recall; it removes the arm.

  ⛔ **(a) "write a `pipeline_runs` heartbeat every tick" under the REAL pipeline name is refuted by this repo's own recorded trap** — CLAUDE.md: *"A marker under the REAL name would refresh `last_run` every tick and silence `detect_stalled_pipelines()` on exactly the outage it exists to expose."* That is why the `after()` convention suffixes `-heartbeat`; but a suffixed marker is invisible to an arm keyed on the real name, so (a) either defeats the arm or does nothing.
  ⓘ **One variant of (a) survives and is worth considering beside (c):** have the reconciler log EVERY completed tick, zero-write included. For a **pg_cron SQL function** that is honest liveness — the row is written at tick END inside the same transaction, so it cannot claim a tick that died, which is the specific failure the `after()`-route trap is about.

  ⭐ **(c) is the survivor, and the control above IS (c) running:** `cron.job_run_details` answers "did this job execute and succeed" directly, with **28/28** in hand. ⛔ **Not shipped from here:** it is a migration to the PINNED `detect_stalled_pipelines()`, and jobid 456's cadence was changed **14 h ago** by the session that owns this lane — inside the 24–48 h collision window. **The decision is made and evidenced; the migration is that lane's.**

---

Known / attributed items seen this sweep, logged only so they are not re-raised (all already in ledger or inbox):

- **pack-reality empty board** — already Candidate 1 of the `2026-09-07T0311Z` tick, re-confirmed identical today: `mv_topshot_pack_reality_top_ev` = 0 is a genuinely-empty (not broken) state. Refresh job 241 `rpc-refresh-pack-reality-top-ev` succeeds every 2 h and `topshot-atlas-pack-ev` is 24/24 ok (last 05:25Z); of the fresh-48h positive-EV Top Shot packs none clear the MV's `depletion_pct<90` AND `fmv_coverage_pct>=40` gates. No action beyond the 03:11Z tick's open ask (verify the public page's honest empty state).
- **`sync-nba-projections`** — `all_upstreams_failed` on every 3-hourly run, 0 ok / 24h. The KNOWN dead ESPN / sports-proxy 403 (issue #8; inbox `2026-08-22T1450Z`, `2026-08-18T0120Z`). Not new; not a fresh regression.
- **`offers-sweep`** 31/31 upstream fails (24h window) — disabled today (cron-job.org entry 7712610 set INACTIVE, migration `20260907024754`, in the ledger). Residual pre-disable count.
- **`atlas-editions-refresh` / `atlas-market-feed`** internal-flagged fails — the `atlas-*-upstream-403` `info` alerts: Cloudflare base-rate challenges, attributed (net._http_response joined to the dispatch request-id), self-healing re-walk with no row loss; freshness OK (market last drain 06:05Z, newest event 06:03Z). Do not re-investigate (memory: pg-net-403 is attributed to the Atlas walk).
- **`unmapped-sales-nfl_all_day`** backlog (info) — declining, worker-side drain; known.
- one-off **`topshot-pack-supply-backfill`** fail (09-06 08:15Z, upstream) and scattered **`wallet-backfill*`** Flow Access API 400 / computation-limit errors — transient background rate, no stall.

Artifact validation: focused on the merged `rpc-live-health` dashboard (single consolidated payload ran clean, every key sensible, all 12 insights backing views resolve). The 03:11Z tick validated the same dashboard 3 h ago and today's schema churn (Atlas sniper: `ts_listings`, `cached_listings`, `edition_offers`) was additive — new columns / rebuilt contents, no renames or drops — so read-breakage risk to the other artifacts is low this tick.

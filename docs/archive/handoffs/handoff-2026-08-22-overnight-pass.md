# Overnight autonomous pass — 2026-08-22 (~01:03–01:12 PT)

> ⚠ **SCOPE OF THE GIT BLOCKER:** the NO-PUSH state below is specific to **this cloud/desktop-Cowork session** — `remote.origin.pushurl` is empty here, so `git push --dry-run` returns `fatal: could not read Username`. **Trevor's machine and Claude Code push normally via the PAT in `remote.origin.pushurl`. Commit these output files as usual.** An environment limitation is a fact about the environment, not the artifact.

**Mode:** genuine overnight (DB `now()` = 08:02Z = 01:02 PT, no clock skew — shell/DB/app-row times agree). NO-PUSH. Ship budget unused.

## Verdict — quiet honest pass, nothing shipped

Security clean, no new error class, demand flat, everything red is the known disk-IO saturation. Nothing met the clearly-safe-and-net-positive bar for autonomous DB shipping tonight. That is a valid outcome, not a skipped one.

## Health sweep

- **Security 3/3 clean** — `check_secdef_anon_exec_drift()` `[]`; zero public tables with RLS off; zero anon/authenticated write grants on RLS-off tables.
- **Saturation PRESENT but MODERATE** — `pg_stat_activity` sampled 4× over ~8 min: io-wait 4–5 of 5–6 active sessions, all `DataFileRead`, zero lock-waits. Low absolute concurrency, not the severe 24/27 spell of 08-20. `rpc_ops_snapshot()` itself timed out on its `sentinel_fmv_confidence_rows` leg — ran the checks individually instead.
- **Pipelines** — many high-sev failure-rate arms (allday-buyer-backfill 81%, topshot-fmv-populate 89%, wallet-username-resolver 83%, fmv-recalc 57%, populate-pinnacle-wmc-fmv 74%, refresh_wmc_fmv_drift_active 59%, run-insider-detectors 63%, compute-allday-pack-ev 68%). **All saturation-class** (statement timeout / upstream request timeout / connection-pool). No new class. `topshot-active-listings-ingest` 67% is the atlas-proxy `egress_blocked` operator item, not saturation.
- **pg_cron failures** — `rpc-ccm-step1/step2` (cross-collection mats) timing out on the `INSERT…SELECT`; several MV refreshes timing out; a handful of `job startup timeout` (worker-slot exhaustion, saturation). All known-class.
- **Sentry** — **0 new unresolved issues in 24h.**
- **Vercel runtime** — all saturation-class; honest-degradation ("degrading to empty") working across edition/player/team/pack detail and the candy/panini boards. `DEP0169 url.parse` warning benign.
- **Demand gate — 21 users / 0 WAU / 0 new, UNCHANGED since 08-18.** The gate that matters; not a night-pass lever.
- **Deltas:** DB 13,638 → 13,679 MB (+41, normal). Editions 27,242 → 27,246 (+4).

## Post-ship watch (previous passes)

- Previous **nightly** (08-20) shipped nothing; the 08-21 interactive Claude Code sessions were read-only (all filings, no prod-state change). **Nothing to regression-watch, nothing to auto-revert.**
- The 08-20 "reconcile fix regressing (oldest_cache_h 212h→267h)" concern is **resolved as a measurement artifact** by the 08-22T0130Z filing: `oldest_cache_h` measures a population the sweep excludes by construction. No revert needed.

## QUEUED — needs Trevor / desktop / Claude Code (not autonomously shippable)

1. **Cross-collection mats 124h stale (OPEN ESCALATION, night 3).** `cross_collection_cohort_mat` (179 rows) and `cross_collection_ts_set_overlap_mat` (260 rows) last refreshed 2026-08-17 04:10/04:25Z; `rpc-ccm-step1/step2` have failed every daily cycle since 08-18 with `canceling statement due to statement timeout` on the `INSERT…SELECT`. Now 124h, up from ~76h at 08-20. **Why not shipped:** the fix is cost reduction on an expensive refresh + a quiet window; a manual re-run via MCP mid-saturation is the documented anti-pattern (60s client cap abandons the result while the query keeps running, stacking load). Powers a low-traffic insights surface serving honestly-stale (not corrupt) data. **Do on desktop/Claude Code:** measure the two INSERT bodies' buffers in a genuinely idle window, then scope/cut the work (page size or fan-out), not raise a timeout.
2. **All saturation "cut-work" levers remain decision- or off-limits-gated:** `refresh_wmc_fmv_changed` 120× temp-build cost (08-22T0010Z), pack-EV `fmv_current` lateral (~3,100× buffers, forces pinned-fixture re-seed — Trevor's call), `drain_fmv_cold_tail` unscoped aggregate, ask-corroboration worth 320 All Day editions (FMV route logic, goes live on push — no staged state). All fully diagnosed in `docs/overnight/inbox/`.
3. **Standing operator blockers (unchanged):** git-push creds in Cowork sessions, atlas-proxy `wrangler deploy`, sports-proxy 403 (ESPN slate-gated until ~Oct), spork-proxy health probe.

## Failed / reverted

None. No ship attempted.

## Outputs (NO-PUSH — written to clone + mirrored to mount)

`docs/handoff-2026-08-22-overnight-pass.md` (this file), `docs/overnight/metrics-latest.json`, ledger entry, `docs/sessions/2026-08.md` entry. Inbox NOT archived (permanent citation targets per focus.md). Lock released.

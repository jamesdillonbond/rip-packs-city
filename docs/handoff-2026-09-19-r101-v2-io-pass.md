# Handoff — 2026-09-19 morning pass (8:00–11:00 AM PT): health check, audit, IO saturation, housekeeping

**Cowork, cloud container + laptop VM (push-capable). All times PT.** `main` at `4b81018` + the docs commit that closes the thread. CI + Smoke Tests green on every commit of this pass.

> ⚠ Scope line: the cloud container in this session was **not repo-attached** (push 403 at the repo-authorization layer). That is a fact about this cloud session only — Trevor's machine, Claude Code and the laptop VM push normally. **Commit these files as usual.** This pass pushed through the laptop VM (`device_bash` is back after the 09-08 Windows-update outage; the 08-29 `.rpc-git-cred` recipe works unchanged).

## Health verdict

**HEALTHY-UNDER-LOAD, in a daytime IO spell.** Security invariants 0 · `secdef_anon_exec_drift` 0 · stalled pipelines 0 · 0 invalid indexes · 150/152 cron jobs active (baseline) · the three Atlas lanes restored · 63/63 public pages + 8/8 entity pages pass the rendered-DOM smoke (`e2e/smoke.spec.ts`, `e2e/entity-smoke.spec.ts` run from the sandbox against production) · full vitest 1,556 files / 17,507 tests green · `tsc` clean. Vercel 24 h: 50 error groups, **all chronic read-timeout classes** (pack-detail / edition / player / popular-on-collection) plus the 09-18 DNS-outage `<!DOCTYPE html>` groups — nothing new. Sentry is dark (SDK out of tree, #34) so its zero is not health; the Vercel number is the reading.

**The spell:** `io_wait` 7–14 of 8–15 active backends all morning, `refresh_wmc_fmv_changed` (jobid 303, cron_heavy) at 150–390 s per run and **#1 reader since the 08-12 reset (2,096 GB, 411 MB physical per call, 239.6 h of exec time)**, `mv_topshot_market_index_daily` refresh at ~500 s, and the pipelines that read as failing (`backfill-pack-rip-metadata` 43 %, `fmv-backfill` 43 %, `lock-check-batch` 34 %, `price-snapshots` 30 %) all fail on `statement timeout` — victims, not causes. Both of those hogs carry recorded dead ends (FMV path; `median_px` blocks the incremental MV) and were not touched.

## Shipped (2 migrations, 1 config row, 4 commits)

### R101 v2 — `20260919152824`, 8:28 AM (commit `6ba6b3c`)

The Atlas listing tick (`rpc-ts-listings-atlas-sync`, jobid 466, every 2 min) was the **largest job on the instance by worker time (31,318 s/day, 191/580 failed)** and the #3 physical reader (1,402 GB). Measured before touching it: **927,297 shared buffers per call**. The 09-18 R101 v1 found the three open-book builds (~160k); v2 found where the other ~700k went — **both `INSERT … ON CONFLICT DO UPDATE … WHERE (row) IS DISTINCT FROM (EXCLUDED row)` upserts push the whole ~55k-row wanted set, and ON CONFLICT probes every offered row to write ~60.**

Changes, behaviour-preserving by construction: slim `_open24` built once (ev+map core; each consumer re-applies its own editions join / DISTINCT ON exactly as before), the two 65k-buffer diagnostic counts sampled twice an hour (unsampled ticks publish NULL + `diag_sampled=false`, never 0 — pinned), and **delta-first upserts**: a LEFT JOIN against the target offers ON CONFLICT only new/changed rows; the guard is kept verbatim so the pre-filter can only narrow. No memory grants. Equivalence **proven on prod read-only before the apply**: same 55,655-row wanted set (EXCEPT = 0), 725 rows offered instead of 55,655, cast/uncast agree.

Repo side: migration file, both DB-invariant pins re-pointed (+2 assertions on the sampled-NULL contract), PINS re-pointed, register R101 row updated. Pins green on a throwaway Postgres 16; drift guard 216/216.

### R101 v2b — `20260919160033`, 9:00 AM (commit `b2ae593`)

The first v2 reading showed blocks/call down 55 % but **temp blocks written up 94 %** (three temp tables + sorts + hash tables all spilling at `work_mem 5 MB` / `temp_buffers 8 MB`; sized: 10 + 10 + 25 MB tables). ~60 MB of temp file write+read per tick on the same 22 MB/s disk. Shipped `temp_buffers = '48MB'` on the tick and `work_mem = '16MB'` on the three syncs — function-attached SETs, one pg_cron backend, ≤ ~64 MB for ≤ 60 s every 2 min. Only caller is cron 466 (verified). Independently revertible (`RESET` lines in the header).

### Sentinel `Cadence Collapse` ack — config row, 9:13 AM

The arm was the one CRITICAL in the 9:04 AM sentinel. Re-derived: 6 of its 7 "degraded" lanes are the `wallet-backfill*` family reading the **deliberate 09-13 backstop-drift fix** (~403 redundant re-refreshes/day removed; `pipeline_runs_daily` shows 520–620/day → 310–320/day from 09-14) against a 14-day baseline that is still mostly pre-fix. The 7th is `ts-listings-atlas-sync`, whose killed ticks write no row (R101). Ack set to expire **2026-10-01** with the mechanism and a falsifier in `ack_reason`. Revert: restore the previous ack text (09-13, expired 2026-09-13 19:00Z) — it is in the ledger entry.

## Measurement — READ THIS BEFORE JUDGING R101 v2 (final numbers in the ledger addendum)

⛔ **Not cron durations.** The estate was in a spell throughout; a concurrent Cowork cloud session filed the wall-clock reading (83 % failure over 12 ticks) honestly labelled "suggestive, not conclusive". The 09-18 v1 was reverted on exactly that instrument and exonerated 26 minutes later.

✅ **The instrument:** `pg_stat_statements` for queryid `-3354316985779850203` (userid = postgres): `(shared_blks_hit+shared_blks_read)/calls` and `temp_blks_written/calls` on wholly-post windows. Change points: **v2 15:28:24Z** (pre: 6,951 calls · hit+read 6,445,645,593 · temp_w 27,787,452) and **v2b 16:00:33Z** (6,957 · 6,448,130,088 · 27,833,889). Controls: jobids 463 / 464 on `cron.job_run_details`. A cancelled tick is not recorded, so the counters only move on completed ticks.

## Open — in the order I would take them

1. ~~Re-read the two pgss contracts at n ≥ 30~~ **DONE at n=35 / n=21 (11:08 AM): −79 % blocks/call, temp_w 0 — both falsifiers cleared; the n ≥ 30 contract is met.** Falsifiers stay on record: v2 blocks/call not down ≥ 40 % → revert to `20260919021449`; temp_w/call not down ≥ 80 % → `RESET` the four SETs. Then the calm-hour `pipeline_runs.extra` durations against the 09-18 calm baseline (tick p50 13.4 s / sync 9.3 s).
2. **The lane's remaining structural lever is read-side incrementality** (only rows whose `last_seen_at` moved since the previous tick) — a design item on a public-board feeder; the register R101/R108 rows carry the method notes. ~~The 25 MB `_cl_want` sort still spills at 16 MB; dropping `buy_url` from the temp table would roughly halve it.~~ **MOOT after v2c (10:2x AM):** `work_mem 32MB` on that one sync took temp written/call to **0 over 9 ticks** — there is no spill left for the `buy_url` change to buy. Do not chase it.
3. **`refresh_wmc_fmv_changed` (jobid 303)** is the #1 reader and the spell's main engine: 411 MB physical per call, per-holder UPDATE of `wallet_moments_cache` behind **17 indexes (2.2 GB) on a 939 MB heap** — every non-HOT update writes all of them. FMV path; needs Trevor's call. The memory note `two-callers-one-pipeline-name` has the two-caller (200000 vs 50000 limit) question still open.
4. `match-topshot-players` weekly full run (Sat 08:00Z) died at the 120 s upstream timeout in the night spell; the gate will retry next Saturday. Not urgent.
5. `backfill-pack-rip-metadata` hourly: 2/13 ok today, all failures `statement timeout` at the 30 s service-role budget under load; succeeds in ~7 s when warm. Victim; do not raise the timeout.
6. Needs Trevor, unchanged: #22 purge residue GC + rotate · #55 both 2-hourly Routines disabled since 09-01 · #75 pg_net response store 10.2 GB (VACUUM FULL) · Dune sunset fires 09-23 12:00Z (one-tick loss risk; manual `update dune_budget_state set paused=true where id=1`).

## Coordination note

Two sessions worked this lane in the same hour again (the concurrent Cowork cloud session read my un-pushed v2 body 8 minutes after the apply and correctly concluded "already deduplicated"). The register's claim line exists for this; I updated the R101 row rather than claiming a new one. If you touch these four functions, **re-read `prosrc` md5 first** — v2's guard block shows the pattern.

## Closing reading (10:08 AM PT)

v2 pooled over 20 completed ticks: blocks/call **927,297 → 235,065 (−75 %)**, physical reads/call **26,438 → 17,574 (−34 %)**. v2c over 6 ticks: **temp written/call 0** (from 3,998 / 7,740). Both contracts met. Completion rate still set by the estate (6/18 in the v2c window at io_wait 11–20; control 464 3/7, 463 19/19) — per the concurrent session's retraction entry and this one, **the next lever is the next big estate reader, not this function.** 10:04 AM Sentinel: WARN, no critical arm.

## Thread close (11:1x AM PT)

Final: v2 **−79 % blocks/call at n=35**, v2c **temp_w 0 at n=21** — both contracts met at n ≥ 30. 11:04 Sentinel WARN / no critical; the Cadence Collapse ack is in the config row but the arm has timed out (INCONCLUSIVE) on both runs since, so it has not rendered yet — nothing to do, it renders on the first conclusive run. Promoted to CLAUDE.md (Database traps: the differential-upsert probe; Measurement: durations under a spell measure the estate; Pushing: the VM `git am` route), database.md, tooling-gotchas.md, sessions/2026-09.md. **Nothing in this thread is left open that code can close.** What remains needs Trevor (item 6) or a design pass (item 2, incrementality — and not before jobid 303).

**Post-close (11:2x–11:4x AM):** main went red at `14f38e5` (10:5x) for two independent causes in one red — a concurrent commit wrote `db-invariants-drift-guard.test.ts` from a stale copy and reverted both R101 v2 PINS entries (re-pointed by `68c5aa2`, ledger entry), and its own `get_pack_market_row` migration lacked the anon-exec marker (fixed by that session, `7106eff`). **Green again from `7106eff`.** ⚠ The PINS file is now a three-session file: `git fetch && git rebase origin/main` immediately before committing it, and read its whole diff.

**Second post-close (12:0x–12:2x PM):** the deploy smoke on `985ae50` went HARD-red on `mv_anon_readable:mv_cross_collection_deals` — the concurrent session's Candy-arm migration (`20260919184828`, 11:48) recreated the MV and default privileges handed anon SELECT back. Revoked at 12:04 (`20260919190415`, mine) and again 76 s later by that session (`20260919190531`); both are applied and both files are committed, invariants back to **0**, board intact (its readers are all `supabaseAdmin`). CI + Smoke green on `df88e18`. ⭐ Rule promoted to the ledger: **every DROP+CREATE of an MV in `public` must carry its own REVOKE.**

## Afternoon continuation (12:2x–14:0x PM PT): cron-job.org, Chrome — "do it all"

- **#124 CLOSED.** `ops-monitor`'s two routes now have cron-job.org primaries — `RPC Data Integrity` (8474268, `13,28,43,58`) and `RPC Stale FMV Monitor` (8474496, `19,49`, **`?ack=1`**); the other five workflows decided on measurement (none of `rpc-pipeline`'s four caller-less steps is backlog-bound; `site-availability-alarm` cannot move; backstops are backstops; the sentinel already had its console lane). Both entries verified on first real ticks (`X-Matched-Path`, JSON bodies; the ack lane: `202` → `cron-ack` heartbeat → terminal row, 13:49).
- **Code:** `stale-fmv-monitor` gained `?ack=1` (`b43530a`, 7 tests) — sentinel pattern.
- **Console lesson (in the skill source + `.skill` bundle):** a query string added by EDITING an existing job's URL does not persist; clone with the full URL instead. Also the `DETAILS` positive-control recipe and the query-string block on JS results.
- **Sentinel:** Cadence Collapse ack rendered (done). New CRITICAL `Pipeline Silence`: `snapshot-institutional-wallets` (two runs died mid-work in the night spell) — **hand-dispatched 13:09, ok**; `topshot-active-listings-ingest` → **NEW #125: dead on BOTH arms since 09-18 21:13 PT because Atlas now serves curl a Cloudflare JS challenge from GitHub AND the residential IP (reproduced from the VM). Needs a new transport (pg_net-driven bounded lane, or a browser-driven residential fetch) — a design item, not a restart.** #30 re-opened.
- Read, no change: `Smoke Concierge Daily` (30 s cap in the night spell, n=2), the Dune entry (harmless past the sunset), 17 inactive entries all deliberate (schedule doc now says which and why).

**Needs you (new):** #125's transport decision. **Unchanged:** #22, #55, #75, jobid 303, Dune sunset one-tick risk.

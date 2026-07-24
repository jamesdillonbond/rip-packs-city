# Overnight autonomous pass — 2026-07-15 (OFF-HOURS / MONITOR-MODE)

**Mode:** OFF-HOURS MONITOR-MODE. This run fired ~22:01 PDT Jul 15 (real local time), i.e. **outside the ~00:00–06:00 overnight window** — it launched early (on app open, not the ~01:03 scheduled tick). Per the quiet-hours guard, this means: full review + Section 2 health triage + post-ship watch, but **queue everything instead of shipping**, docs-only commit. **No clock skew** — shell `date -u` 05:01:15Z ≈ DB `now()` 05:01:28Z ≈ newest sale 04:56Z ≈ newest fmv 04:50Z (all within ~11 min). Push AVAILABLE, no FREEZE.

**Outcome:** Shipped **0** (correct — off-hours monitor-mode; nothing was auto-revert-eligible either), reverted 0, repaired 0, closed 0. Drained 1 inbox file (`2026-07-16T0501Z.md`, the daytime monitor's own late-evening tick → archive). Independent post-ship watch of the standing 07-14 wave = ALL PASS. origin/main advanced during setup (`b673db49` → `e5e79539` weekly-sweep rescue → `9d9d307e` monitor 0501Z) — a concurrent monitor + Cowork push, not a collision with my work; queue-only anyway.

---

## Setup / gates
- **Lock:** prior `.lock` was RELEASED (07-14) + stale (~2 days). Took over; overwrote with this run's marker. Will be marked RELEASED at exit.
- **Freeze:** none.
- **Clock/quiet-hours:** DB/app time authoritative, no skew; 22:01 PDT local = off-hours → MONITOR-MODE.
- **Clone:** `$HOME/rpcwork` on `main`, pushurl wired. Initial clone raced the monitor's 05:01Z push (came up at `b673db49`); re-fetched and reset to `origin/main` = `9d9d307e` before writing.
- **Continuity read:** CLAUDE.md, ledger (full incl. Declined), focus.md (2026-06-24 studio steer, still current), metrics-latest.json (07-14), latest handoff (07-14), and the 3 new-since-clone commits (weekly data-quality-sweep rescue + monitor 0501Z inbox).

## Health-drift triage — GREEN (1 known self-healing breach)
Baseline via `rpc_ops_snapshot()` (05:03Z):
- **Security 0/0/0/0** — invariants / secdef_anon [] / rls_off_base [] / anon_write_holes [] clean.
- **Trust health:** 16 metrics, **1 BREACH: `topshot_impossible_parallel_serials` = 16 (breach_at 3)** — see triage below. All 15 others ok (topshot_fmv_stale 0.2h fresh, allday 0.2h, pinnacle_fmv 18.9h, pinnacle_ask 0.1h, edition_integrity 4/50, fmv_sanity 0, unmapped_resolution_backlog 29/100).
- **stalled_pipelines []**; **pg_cron `check_pgcron_recent_failures()` []** (clean — better than 07-14's 4).
- **pipeline_alerts:** (a) `pinnacle_sales_backfill` cursor_stalled **HIGH** — see triage; (b) `ufc_sales` resolving_editions INFO (benign, known).
- **sentinel_ts_uuid_editions_48h = 27** (was 0 on 07-14) — investigated: these are inert `UUID:UUID` GQL-catalog fossils (name/circ/onchain-ids all NULL, blocked by the dupe trigger) from the active `::` cataloging wave. `ts_uuid_dupes_created_24h` = 27 (breach_at 200, ok). **NOT a hyphen-UUID writer leak** — pure `::` catalog growth.
- **Editions:** TS **19,408** (+124 vs 19,284 on 07-14 = ongoing `::` subedition + fossil cataloging) / AllDay 6,190 / Golazos 575 / UFC 518.
- **FMV latest-per-edition:** TS HIGH 1,425 + MED 3,809 = **5,234 H+M** (+13 vs 5,221, improving) / AllDay HIGH 214 + MED 613 = **827** (+14) / UFC 15 / Golazos 4.
- **pipeline_fails_24h:** analytics-smoke 18 (top), wallet-username-resolver 12, fmv-recalc 9, lock-check-batch 9, compute-topshot-pack-ev 7 — all known contention family, all lower than 07-14; stalled_pipelines [] confirms none silently stalled.
- **DB size 9,075 MB** (+909 vs 8,166 on 07-14). Still well under the 07-13 11 GB peak; the `::`/fossil cataloging + normal churn. Watch, not alarming.
- **Sentry:** **0 new unresolved** (is:new, production, 24h).
- **Vercel:** prod code `b673db49` (dpl_Hmk95FRMN18F3TArbqo2DAknAg84) READY. The two 05:01Z commits (weekly-sweep rescue, monitor) are docs-only → CANCELED builds (correct).

### Triage — the two elevated signals both trace to ONE event (WNBA `::` cataloging wave)
1. **`topshot_impossible_parallel_serials` = 16 (BREACH, was 1).** Isolated the offending set: 13 freshly-cataloged WNBA `::` subeditions (`257:88xx::17/18` Rookie Debut, `258:88xx::16` Base Set) carrying floor-seed `circulation_count = 1` (a few 9/46) while a real observed sale exists at a higher serial (max_serial 13–82). This is the **documented self-healing `::`-cataloging straggler class** (waves 1–3 on 07-10/07-11/07-13 were 4/11/18). The daytime monitor independently flagged this as "wave 4, GREEN" and marked it a **Trevor/interactive** evidence-based circ floor-raise (NOT night-pass autonomous). Classified: known class, larger WNBA batch, needs the interactive floor-raise (queued below).
2. **sentinel 27 + editions +124** = the same wave (`::` real subeditions + inert `UUID:UUID` fossils). Both under their own thresholds; no leak.

## Post-ship watch — ALL PASS, 0 reverts
Nothing has shipped since the 07-14 night pass; current prod code = `b673db49` (pinnacle self-serve render-cache-fill route + home-machine scheduler), live ~39h.
- **`b673db49` (pinnacle render-cache-fill route) — PASS.** Deploy READY; 0 new Sentry issue / 0 new runtime-error signature in 24h; the forward `pinnacle_sales` + `pinnacle_listings` cursors are fresh (05:04Z / 05:05Z) — live Pinnacle ingest unaffected. (The home-machine Task Scheduler script that POSTs cached renders logs `pipeline_runs` only when it runs on Trevor's machine — no rows yet is operator-dependent, not a prod regression.)
- **`034e7cdd` (`get_pack_market_row` per-dist RPC + contention-404) — PASS.** The monitor observed the "pack dist page has Sales History" smoke class fire twice on 07-15 post-deploy then go quiet; `analytics-smoke` last 6 runs ok=true, Sentry `JAVASCRIPT-NEXTJS-1J` 0 events in 14h. LOW/watch (intermittent contention-window flap), not a regression → no revert.
- **Security 0/0/0/0** after everything.

## Shipped
None (off-hours monitor-mode).

## Queued
### NEW — TOPSHOT-IMPOSSIBLE-PARALLEL-SERIALS wave 4 (16/3) — interactive/Trevor circ floor-raise (night-count 1)
- Known self-healing `::` class, but the largest wave yet and not reconciling under threshold on its own. Same class + fix as waves 1–3 (which were cleared by interactive circ floor-raises, e.g. `audit_20260710_circ_floor_raise`).
- **Ready fix (interactive, audited + reversible):**
  ```sql
  CREATE TABLE audit_20260715_circ_floor_raise_wave4 AS
  SELECT e.id AS edition_id, e.external_id, e.circulation_count AS old_circ, s.max_serial AS new_circ
  FROM editions e
  JOIN LATERAL (SELECT max(sa.serial_number) AS max_serial FROM sales sa WHERE sa.edition_id=e.id) s ON true
  WHERE e.collection_id='95f28a17-224a-4025-96ad-adf8a4c63bfd' AND e.external_id LIKE '%::%'
    AND e.circulation_count>0 AND s.max_serial>e.circulation_count;
  UPDATE editions e SET circulation_count=a.new_circ
  FROM audit_20260715_circ_floor_raise_wave4 a WHERE e.id=a.edition_id;
  ```
  (a real sale at serial N proves circ >= N). **Revert:** `UPDATE editions e SET circulation_count=a.old_circ FROM audit_20260715_circ_floor_raise_wave4 a WHERE e.id=a.edition_id;` **Target metric:** `topshot_impossible_parallel_serials` → 0.
- **WHY not auto-shipped:** off-hours monitor-mode AND the ledger/monitor both class this as a sanctioned *interactive* action, explicitly NOT the blind-autonomous hand-edit class.

### NEW — PINNACLE-SALES-BACKFILL-SPORK-FLOOR (HIGH alert is false-severity; CC/operator; night-count 1)
- `pinnacle_sales_backfill` event_cursor parked at block **137390146** = the documented `SPORK_FLOOR_HINT` (current-spork reachable floor), updated 07-15 18:13Z (~10.9h). Below it = pruned pre-spork blocks → cannot advance. Same permanent-floor structural class as ALLDAY-PACK-OPENS-BACKFILL-404. **Forward `pinnacle_sales` ingest is healthy** (cursor fresh 05:04Z) — no live-data gap; the HIGH `cursor_stalled` severity is the alert not knowing about the floor.
- **Ready fix (CC/operator, two options):** (a) park the backfill cursor as `done` once it reaches the spork floor so it stops re-alerting; or (b) pass a floor override / lower `DEFAULT_FLOOR` toward the reachable floor and let it terminate. Both touch ingest-route/edge-fn config (off-limits for autonomous). Not user-facing (historical deep-tail).

### CARRIED
- **ALLDAY-UNMAPPED-SALES-BACKLOG-GROWTH** (CC/operator; night-count 1, first raised by the 07-15 weekly data-quality-sweep). Verified live: `unmapped_sales` unresolved = **8,540** AllDay (+323/24h, oldest 2026-05-21), 333 UFC, 44 Golazos. The AllDay resolver drains only ~18% of inflow (marketplace GQL leg WAF-403s from Vercel egress → route through the proxy worker or a structural ingest change). Distinct from the `unmapped_resolution_backlog_max` trust metric (29, the TS-Flowty drain). Ingest/egress class → not autonomous.
- **`get_active_challenges` ends_at display filter** (LOW cosmetic; night-count 2). Add `AND (ends_at IS NULL OR ends_at > now())` to the `ch` CTE in `get_active_challenges` + `get_challenge_plan`. Self-heals daily at the 08:10Z status re-sync. Still deferred: challenge RPCs are an actively-iterated surface.
- **Operator / CC / gated (unchanged):** TOPSHOT-ACTIVE-LISTINGS-ATLAS-BLOCK (GHA active-listings ingest 403'd since 07-13); ownership-sync-dune weekly tick failed 07-13 (retrigger for fresh `topshot_ownership`); wmc index drop candidates (deliberate CC pass); TS 82 art-less base thumbnails (deferred during IOPS pressure); DISK-IOPS-THROTTLE overnight family (systemic/operator — compute bump if >=48h; `populate_wmc_fmv_from_snapshots` named the #1 IOPS hog on 07-14, delta-rewrite + cadence cut is the lever); TOPSHOT-MOMENTS-HYDRATOR getMintedMoment errors; ALLDAY-PACK-OPENS-BACKFILL-404; cron-job.org dropout family; BUYERBF; standing owned/CC full-audit follow-ups.

## Failed / blocked / reverted
None.

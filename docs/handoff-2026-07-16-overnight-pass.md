# RPC nightly autonomous pass — 2026-07-16 (GENUINE OVERNIGHT)

**Fired in-window (~01:02 PDT / 08:02Z), no clock skew.** Shell `date` 08:01:51Z ≈ DB `now()` 08:02:31Z ≈ newest sale 07:43Z ≈ newest fmv 07:50Z. Push AVAILABLE (`git push --dry-run` = up-to-date), no FREEZE. Full tooling live: Supabase + Vercel + Sentry MCP, bash/git/clone/push, Cowork artifacts, `rpc_ops_snapshot()`.

**Result: shipped 1** (DB-only, additive, independently verified PASS), reverted 0, repaired 0, closed 0. Drained 1 inbox file. Health GREEN apart from one known self-healing breach.

- **Clone:** `$HOME/rpcwork` on `main`, pushurl wired. origin/main `666b774e` unchanged start->end (re-fetched before commit — no collision).
- **Lock:** prior lock RELEASED by night-20260715 (05:14Z); took over, wrote OWNED marker, released at end.
- **Continuity read:** CLAUDE.md (full), ledger (full incl. Declined), focus.md (2026-06-24 studio steer + its STANDING pg_cron-failure-check note, honored), metrics-latest.json (07-15), latest handoff (07-15). Mount inbox held 6 stale files — all confirmed already in the clone's `inbox/archive/` (mount isn't synced to origin), so only the clone's 1 unprocessed file was live.

## Health-drift triage — GREEN (1 known self-healing breach)
Baseline via `rpc_ops_snapshot()` (08:03Z):
- **Security 0/0/0/0** — invariants / secdef_anon_violations / rls_off_base_tables / anon_write_holes all `[]`.
- **Trust health:** 16 metrics, **1 BREACH: `topshot_impossible_parallel_serials` = 16 (breach_at 3)** — known self-healing WNBA `::`-cataloging straggler wave 4 (unchanged from 07-15; monitor + ledger both class it interactive/Trevor, see Queued). All 15 others ok: topshot_fmv_stale 0.2h, allday 0.2h, golazos 0.3h, ufc 14.9h, pinnacle_fmv 21.9h, pinnacle_ask 0.1h, pinnacle_render_floor 0.3h, edition_integrity 4/50, fmv_sanity 0, offer_edition_gap 0, unmapped_resolution_backlog 29/100, ts_uuid_dupes_24h 39/200.
- **stalled_pipelines []**; **`check_pgcron_recent_failures()` []** (the 05:34Z offers-backstop fail aged out; see Shipped).
- **pipeline_alerts:** (a) `pinnacle_sales_backfill` cursor_stalled HIGH — false-severity, cursor parked at spork floor block 137390146 (forward ingest healthy); carried CC/operator. (b) `ufc_sales` resolving_editions INFO (benign, known).
- **sentinel_ts_uuid_editions_48h = 39** (was 27 on 07-15) — inert `UUID:UUID` GQL-catalog fossils + `::` growth, well under breach_at 200. NOT a hyphen-UUID writer leak.
- **Editions:** TS **19,420** (+12 vs 19,408) / AllDay 6,190 / Golazos 575 / UFC 518.
- **FMV latest-per-edition:** TS HIGH 1,432 + MED 3,806 = **5,238 H+M** / AllDay HIGH 215 + MED 613 = **828** / UFC 15 / Golazos 4.
- **pipeline_fails_24h:** analytics-smoke 18, wallet-username-resolver 13, fmv-recalc 10, lock-check-batch 9, compute-topshot-pack-ev 7 — verified each is the known overnight-contention `statement timeout` family: every one recovers on its next tick (analytics-smoke 07:13Z fail->07:43Z ok; fmv-recalc 07:28Z fail->07:48Z ok; wallet-username-resolver 05:38Z fail->ok; compute-topshot-pack-ev 05:31Z fail->ok). `stalled_pipelines []` confirms none silently stalled.
- **DB size 9,127 MB** (+52 vs 9,075). Well under the 07-13 ~11 GB peak; normal `::`/fossil cataloging + churn.
- **Sentry:** **0 new unresolved** production issues (is:new firstSeen:-24h, 24h period).
- **Vercel:** prod code `48991fc4` (dpl_An6WGYcMwKPpeehQoWYYoXFkm9Pf) READY. The 666b774e monitor commit is docs-only -> CANCELED build (correct).

## Post-ship regression watch — ALL PASS, 0 reverts
Current prod code = `48991fc4` (07-16 interactive Cowork: sentinel false-CRITICAL fix + TS pack lifecycle/realized per-dist RPCs + set/player soft-404 hardening), the newest change since the 07-15 pass.
- **`48991fc4` sentinel hunk — PASS.** Empty-error false-CRITICAL fix targets the Pipeline Sentinel GHA. sentinel_ts_uuid_editions_48h 39 (ok); no anomaly; no new Sentry issue traces to it.
- **`48991fc4` pack-perf RPCs — PASS.** `get_pack_lifecycle_row` + `get_pack_realized_ev_row` both live (SECDEF) alongside `get_pack_market_row` (034e7cdd). Residual `analytics-smoke` failures are generic contention `statement timeout`s recovering next tick — NOT the specific pack-dist sales-history assertion that failed pre-fix. 0 new Sentry.
- **`48991fc4` set/player soft-404 hardening — PASS.** 0 new Sentry issue / runtime-error signature.
- **`b673db49` (pinnacle render-cache-fill, live ~63h) — PASS.** 0 new Sentry/error signature.
- **Security 0/0/0/0** after everything.

## Shipped (1)
### `audit_20260716_raise_edition_offers_statement_timeout_600s` — offers-raise backstop statement_timeout 600s
- **What:** `ALTER FUNCTION public.raise_edition_offers_from_chain() SET statement_timeout = '600s';`
- **Why:** the offers-sanity durable-raise backstop (pg_cron **jobid 48**, `34 * * * *`, pure in-DB `SELECT public.raise_edition_offers_from_chain()`) flapped 2/24 ticks (latest 05:34Z 07-16) on `canceling statement due to statement timeout`. The SECDEF fn carried `proconfig = [search_path=public]` only -> inherited the 120s cluster default; it succeeds ~11.5s avg on 22/24 runs, the fails are contention-window ticks where the growing offer-set scan (~73.8k offers / ~19k open) crosses 120s. Because it's a pure pg_cron `SELECT` (no HTTP route / `after()`-lambda kill-trap), a per-function timeout raise is the correct + complete fix — the same class + remedy as the serial-FMV weekly fits (600s proconfig).
- **Risk:** LOW / additive. Behavior-identical when the tick already completes; only lets a heavy contention-window tick finish. No anon/authenticated grant; SECDEF + `search_path=public` posture intact. No user-facing surface today (offer_edition_gap currently 0).
- **Verification — independent subagent PASS (all 5 checks):** (1) proconfig now `[search_path=public, statement_timeout=600s]`, prosecdef true; (2) no anon/authenticated EXECUTE grant (null); (3) `check_public_security_invariants()` [] + `check_secdef_anon_execute_violations()` []; (4) functional — `SELECT public.raise_edition_offers_from_chain()` invoked once, completed without error (returned 0 rows, expected outside a contention window); (5) `check_pgcron_recent_failures()` [] (jobid 48 absent).
- **Revert:** `ALTER FUNCTION public.raise_edition_offers_from_chain() RESET statement_timeout;`
- **Target metric (re-check tomorrow):** `check_pgcron_recent_failures()` no longer lists `rpc-raise-edition-offers-backstop`; jobid 48 `:34` ticks all ok=true.

## Queued
### CARRIED — IMPOSSIBLE-PARALLEL wave 4 (16/3) — interactive/Trevor circ floor-raise (night-count 2)
Known self-healing WNBA `::`-cataloging straggler class, unchanged at 16. Monitor + ledger both designate it a *sanctioned interactive* circ floor-raise, NOT the blind-autonomous hand-edit class -> not night-pass autonomous. Ready audited+reversible migration (from the 07-15 handoff):
```sql
CREATE TABLE audit_20260716_circ_floor_raise_wave4 AS
SELECT e.id AS edition_id, e.external_id, e.circulation_count AS old_circ, s.max_serial AS new_circ
FROM editions e
JOIN LATERAL (SELECT max(sa.serial_number) AS max_serial FROM sales sa WHERE sa.edition_id=e.id) s ON true
WHERE e.collection_id='95f28a17-224a-4025-96ad-adf8a4c63bfd' AND e.external_id LIKE '%::%'
  AND e.circulation_count>0 AND s.max_serial>e.circulation_count;
UPDATE editions e SET circulation_count=a.new_circ
FROM audit_20260716_circ_floor_raise_wave4 a WHERE e.id=a.edition_id;
```
Revert: `UPDATE editions e SET circulation_count=a.old_circ FROM audit_20260716_circ_floor_raise_wave4 a WHERE e.id=a.edition_id;` Target: `topshot_impossible_parallel_serials` -> 0.

### CARRIED — PINNACLE-SALES-BACKFILL-SPORK-FLOOR (CC/operator; night-count 2)
`pinnacle_sales_backfill` cursor parked at block 137390146 = `SPORK_FLOOR_HINT`. Below it = pruned pre-spork blocks -> cannot advance; the HIGH `cursor_stalled` alert is false-severity (forward `pinnacle_sales` ingest healthy). Same permanent-floor class as ALLDAY-PACK-OPENS-BACKFILL-404. Fix (CC/operator): park cursor `done` at the floor, or lower `DEFAULT_FLOOR` / pass a floor override to terminate. Ingest-route/edge-fn config -> off-limits for autonomous.

### CARRIED — ALLDAY-UNMAPPED-SALES-BACKLOG-GROWTH (CC/operator; night-count 2)
`unmapped_sales` unresolved ~8,540 AllDay (growing, drain ~18% of inflow; marketplace GQL resolver leg WAF-403s from Vercel egress). Distinct from `unmapped_resolution_backlog_max` (29, the TS-Flowty drain, healthy). Needs the resolver routed through the proxy worker or a structural ingest change -> not autonomous.

### CARRIED — `get_active_challenges` ends_at display filter (LOW cosmetic; night-count 3)
Add `AND (ends_at IS NULL OR ends_at > now())` to the `ch` CTE in `get_active_challenges` + `get_challenge_plan`. Self-heals daily at the 08:10Z status re-sync. Deferred: challenge RPCs are an actively-iterated surface.

### CARRIED — standing operator / CC / gated queue (unchanged)
TOPSHOT-ACTIVE-LISTINGS-ATLAS-BLOCK; ownership-sync-dune weekly retrigger; wmc index drop candidates (CC/Trevor deliberate); TS ~82 art-less base thumbnails (deferred during IOPS pressure); DISK-IOPS-THROTTLE overnight family (operator compute-bump lever if >=48h; `populate_wmc_fmv_from_snapshots` = named #1 IOPS hog, delta-rewrite + cadence cut is the lever); TOPSHOT-MOMENTS-HYDRATOR getMintedMoment errors; ALLDAY-PACK-OPENS-BACKFILL-404; cron-job.org dropout family; BUYERBF; standing owned/CC full-audit follow-ups.

## Failed / blocked / reverted
None.

## Artifacts
16 enumerated via `list_artifacts`; none flagged broken by the monitor and the shipped proconfig change touches no artifact query (artifact data is fresh-on-open regardless). No repair/refresh warranted.

# RPC nightly autonomous pass — 2026-07-04 (overnight)

**Mode:** GENUINE OVERNIGHT. Fired in-window 08:02Z / 01:02 PDT. **No clock skew** (shell 08:02:20Z ≈ DB `now()` 08:02:35Z ≈ app-stamped sales 08:01Z / fmv 07:58Z — production rows can't be future-stamped). Push AVAILABLE (`git push --dry-run` = up-to-date). No FREEZE. Lock taken (run-8632eb92); prior lock was RELEASED.

**Result:** Shipped **0** production changes (correct — every candidate is resolved / self-healed / ingest-adjacent-queue / contention-watch; nothing both warranted and fully-gated-low-risk). Reverted 0. Repaired 0 artifacts. **Closed 2**, **queued 1 new**. Drained 3 inbox files. origin/main `8cf55abc` unchanged start→end (+ this docs commit). Value = the independent post-ship watch on the heavy 07-03/04 daytime CC/QA wave (ALL PASS) + closing 2 items that were already resolved but still being carried.

---

## Section 2 — Health-drift triage (GREEN)

Baseline via `rpc_ops_snapshot()` @ 08:05Z + individual drill-downs.

- **security 0/0/0/0** — invariants [], anon_write_holes [], rls_off_base_tables [], secdef_anon_violations [].
- **trust_health 16/16 ok, breaches []** — the 06:06Z monitor's lone `offer_edition_gap $70` BREACH **self-cleared to 0** (the documented OFFER-SANITY self-clearing transient — offers-sweep ratcheted `edition_offers` up on the next tick, exactly as designed).
- **`detect_stalled_pipelines()` []** — the 06:06Z `topshot-fmv-populate` single missed 01:38Z tick **SELF-HEALED**: the 07:38Z tick ran ok=true (11.1s, sets_mapped 243). Perfect 6h cadence otherwise; the miss was one-off overnight-contention. (Closed — see below.)
- **`check_pgcron_recent_failures()` []** — all pg_cron healthy.
- **`get_pipeline_alerts()`** 2 INFO (golazos_sales + ufc_sales resolving_editions, benign known bridge-pending).
- **sentinel TS-UUID-editions-48h 0**; `topshot_impossible_parallel_serials` 1/3; `fmv_sanity_flags` 0.
- **editions FLAT** — TS 17,490 / AllDay 6,191 / Golazos 581 / UFC 518 (TS +1 vs 07-03 17,489 = benign; no writer leak — sentinel 0, offer_fill + moments-batch guards holding).
- **FMV** — TS HIGH 1335 + MED 3450 = **H+M 4785** (improving from 4756 baseline). AllDay 236+621=857. UFC 15. Golazos 4. All per-collection freshness green (topshot_fmv_stale 0.2h). Pinnacle FMV in `pinnacle_fmv_history` (snapshot `{}`; pinnacle sentinels ok, pinnacle_fmv_stale 22/30).
- **DB 7,817 MB** — +393 vs 07-03 night (7,424). Primary driver is now **`ts_history_backfill_v1`** (~88k sales/24h during active windows), NOT `allday_studio_history_v1` (the 07-03 metrics note is stale — the 03:06Z monitor caught this; metrics-latest.json updated this run). Benign backfill drain; editions FLAT, sentinel 0, fmv_sanity 0, no unmapped spill. Growth decelerating (+37/3h at the 06:06Z tick). Passive disk-headroom eye until the drain finishes.
- **pipeline_runs 24h fails** — allday-pack-opens-backfill **25** (the queued stuck backfill — below), wmc-fmv-populate 15, pinnacle-nft-resolver 15, fmv-recalc 13, compute-topshot-pack-ev 11, classify-acq 6, +11 fewer. All except allday-pack-opens confined to the 01:0xZ / 06:0xZ overnight DB-contention windows with latest-run ok=true (transient pool contention, retry next tick).
- **Sentry 0 unresolved / 24h.** **Vercel** prod `dpl_GbCmDYo…` (`7fb01a60`) READY & serving; the two newer commits (`8cf55abc`, `7a8c439f`) are docs-only → correctly CANCELED (ignoreCommand). No ERROR-state prod deploy.

## Post-ship regression watch — ALL PASS, 0 reverts

Re-measured the heavy 07-03→07-04 daytime CC/Trevor QA + perf wave (`fdf35b65`→`7fb01a60`, ~15 commits; prod `7fb01a60` READY):

- **def899f1 perf wave (packs 500 / market 504 / team-hub 404):** `mv_pack_ev_latest` **1705 == `pack_ev_latest` 1705** (exact parity, refresh cron active); `mv_topshot_set_play_catalog` 9182 rows present. The pack/market/team DBSAT-timeout classes that dominated Sentry now last-appear either on **superseded** deploys or in the 06:0xZ overnight-contention window on current prod — NOT daytime regressions (the perf fixes reduced the daytime path; the residual is the ts_history_backfill_v1 connection-pool contention, tracked separately).
- **eb44ac04 (pinnacle-nft-resolver 30s covering-index + wmc-fmv-populate SKIP LOCKED):** HOLDING. pinnacle-nft-resolver 126 ok / 11 fail /12h, last_fail **01:16Z** (clean ~7h since); wmc-fmv-populate 673 ok / 12 fail /12h, last_fail **01:13Z** (clean ~7h). Both fail cohorts are entirely in the 01:1xZ overnight window that hit their neighbors — neither reappeared in the 06:0xZ window. Confirms the monitor's positive signal.
- **7fb01a60 (LISTED collection_id scope — cross-collection bleed):** prod READY & serving; no new error class attributable to it; no cross-collection-bleed error class in Vercel runtime errors.
- **topshot-sales-history-backfill 429-resilience (`2a5790a9`/`921f5fcf`):** DRAINING as intended — pending_remaining 5684→5679→5647→5609→5571 (declining), gql_errors dropped from ~96–115/tick (pre-fix 07-03 22-23Z) to **2**/tick, editions_maxed_out 0, runs 111–189s (under maxDuration=300).
- **def899f1 residuals the monitor flagged (`[api/packs] calibrated merge`, ipfs-media 25s/504):** both last-seen ONLY on the **superseded** `dpl_Gvtsnni6` at 00:16–00:51Z — they did NOT climb onto current prod (`dpl_GbCmDYo`). Watch-only; no action.
- **badge backfill / sets-tracker matview / overview resilience (15e24c27 / b8e2115f / 71b1e5b8):** no regression signal (editions flat, security 0 after all wave migrations, no new Sentry/Vercel class).

**Overnight deltas vs 07-03 metrics-latest.json:** TS FMV H+M 4756→**4785** (+29, improving); editions FLAT; DB 7,424→**7,817 MB** (+393, ts_history_backfill_v1 drain); trust 16/16 (offer_gap breach self-cleared); unmapped backlog 29→30 (flat); corrupt-moments P8 residual carried (operator drain). No regressions.

---

## Closed this run (2)

1. **SERIAL-FMV-POWER-MODEL-WEEKLY-TIMEOUT (was night-count 4) — RESOLVED; fix already applied 2026-06-30.** All three weekly serial-FMV fit functions now carry `statement_timeout=600s` in proconfig — `compute_serial_fmv_power_model`, `compute_serial_fmv_multipliers`, AND the new `compute_serial_fmv_jersey_model` (jobid 30, added ~06-30, fires this Sunday too). Applied by CC in migration `20260630235957 audit_20260630_serial_fmv_fits_statement_timeout_600s` (an earlier 06-29 attempt was reverted then re-landed 06-30). All three weekly jobs (jobids 5/6/30, `0/5 11 * * 0`) are confirmed **pure pg_cron** (`SELECT public.compute_…()`, in-DB — no HTTP route / after()-lambda kill trap, so the timeout raise is the correct + complete fix, unlike the special-serial-MV HTTP-route case). jobid 6 last failed 06-28 at exactly 120.04s (the item's origin); next fire 2026-07-05 11:00Z will validate. **No ship needed.** The prior 4 nights carried it as "unverifiable-in-run" but the fix was already live — the proconfig is verifiable in-run regardless of the Sunday cron. Revert (if ever): `ALTER FUNCTION … RESET statement_timeout` on the three fns.
2. **TOPSHOT-FMV-POPULATE-MISSED-TICK (was night-count 1) — SELF-HEALED.** The single missed 01:38Z Jul-4 tick (overnight-contention non-fire) recovered on the very next tick: 07:38Z ran ok=true (11.1s, sets_mapped 243). Perfect 6h cadence resumed. Supplementary GQL-catalog FMV populate; TS FMV was fresh throughout (topshot_fmv_stale ≤0.4h). No action.

## Queued this run (1 new) — for Trevor / Claude Code

**ALLDAY-PACK-OPENS-BACKFILL-404 (LOW; night-count 1; CC / operator — ingest edge fn + cron).**
The historical pack-opens gap-fill `allday-pack-opens-backfill` is **stuck**, not merely flapping: every tick since ~03:52Z (≥25 fails/24h) re-attempts the identical event-height range `137378483-137378732` → HTTP 404, never advancing. Root cause is precise and benign:
- The edge function `supabase/functions/ingest-allday-pack-opens/index.ts` `mode=backfill` walks the cursor DOWN (`end = cur-1`, `start = max(FLOOR, end - maxBlocks + 1)`) toward `DEFAULT_FLOOR = 30000000` (~mid-2022). The cursor `event_cursor.id='allday_pack_opens_backfill'` sits at `last_processed_block=137408483`; the next window [137378483, 137408482] **straddles the current access node's spork floor ~137390146** (focus.md `SPORK_FLOOR_HINT=137_390_146`). The sub-chunk below the floor (137378483-137378732) is in a **pruned previous spork** → permanent 404 on the current node. The scan marks `fatal`, does NOT advance the cursor, and re-tries the same range forever.
- Impact LOW: historical pack-opens enrichment only; the FORWARD path `allday-pack-opens-forward` is healthy (cursor block 156925690, live capture unaffected). Not user-facing, not FMV. The 144 failed pipeline_runs/day are pruned by the daily `prune-pipeline-runs` cron (no unbounded growth) and `detect_stalled_pipelines()` doesn't flag it (it logs a run each tick).

**Why not auto-shipped:** the only correct fixes touch the ingest path (off-limits for the autonomous pass) or the cron console (operator/secret-adjacent). No clean DB-only park exists — setting the cursor ≤ FLOOR would falsely mark it "done" AND skip the still-reachable [137390146, 137408483] window (real recent opens). **Ready fixes (pick one):**
- (a) **Cleanest, no deploy — operator:** edit the cron-job.org `allday-pack-opens-backfill` entry to pass `?floor=137390146`. Next tick scans [137390146, 137408482] (all served, captures those opens), advances the cursor to 137390146, then logs `done:true` and no-ops thereafter. (The `?floor=` override is already supported: `const floor = Number(url.searchParams.get("floor") ?? DEFAULT_FLOOR)`.)
- (b) **Durable — CC:** raise `DEFAULT_FLOOR` in `supabase/functions/ingest-allday-pack-opens/index.ts` from `30000000` to the current spork floor (~`137390146`) and `deploy_edge_function`. Survives even if the cron omits `?floor=`. Ingest edge fn → CC.
- Parking loses nothing recoverable: the sub-spork-floor pack-opens are unreachable via public Flow REST anyway (that's what the 404 IS).

## Carried queued (unchanged) — one-line

- **CLASSIFY-ACQ-ALLDAY-STATEMENT-TIMEOUT** (night-count 4; CC/operator; still flapping ~6 fails/24h, latest ok; `nfl_all_day` leg vs the fn's 90s cap as `allday_studio_history_v1` fills; do NOT close).
- **FMV-RECALC-EDITION-FETCH-TIMEOUT-CREEP + OVERNIGHT-CONTENTION-CLUSTER** (LOW-MED; one DB-growth-contention watch; fmv-recalc partial edition_page_fetch 30s flap ~8%/day, topshot_fmv_stale 0.2h GREEN, retries next tick; escalate only past ~15%/day or a freshness breach; do NOT auto-ship a core-FMV-route timeout bump; relieves when the ts_history_backfill_v1 / allday_studio_history_v1 tails finish).
- **Operator P8 finite-drain residual** (corrupt-moments; writer guarded).
- Standing owned/operator/gated queue: REFRESH-SPECIAL-SERIAL-OWNERS-MV-TIMEOUT; BUYERBF-PERINVOCATION-WORK; ALLDAY-V1-UNMAPPED-DRIFT (owned); WEEKLY-SURFACE-QA-PROSE; THIN-FMV-GUARD-CONTENTION; refresh-conflated-editions cron (operator); topshot-sales-history-backfill watchlist; VERCEL cost family; A1-WORKER-PASSTHROUGH-CLEANUP; PIN-FMV-REKEY-WAVES 2/3; PIN-SYNC-CRON; P3-BUYERS; DUPE1 (gated/CC); Q2/Q5/Q6; N1; ANALYTICS-SMOKE-RESIDUAL; IPFS ×2; SMOKE-SECURITY-GUARD-TRANSIENT-API-PROBE-DEBUG. STEER honored: SERIAL-FMV weekly by design (now also timeout-guarded), evm-429 benign, studio/ts-history backfill volume expected.

## Failed / blocked / reverted
None. No production shipping attempted (0 SHIP-eligible), so no verification gate engaged and no hard-stop.

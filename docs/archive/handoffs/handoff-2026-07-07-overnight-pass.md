# Overnight pass — 2026-07-07 (GENUINE OVERNIGHT ~01:03 PDT, no clock skew)

**Mode:** genuine overnight (shell 08:02:50Z ≈ DB now() 08:03:14Z ≈ newest sale 06:43Z / fmv 06:48Z — note the sale/fmv lag is a SYMPTOM of the cron dropout below, not skew; shell==DB within ~25s confirms no skew). Push AVAILABLE. No FREEZE. Lock acquired (prior run RELEASED 08:21Z 07-06).
**Shipped:** 0 (correct). **Reverted:** 0. **Repaired:** 0. **Closed:** 1 (PACK-EV-HISTORICAL-BACKFILL-CRON-120s-TIMEOUT self-resolved).
**origin/main:** 5c45977e at start (unchanged start→end; heavy 07-06 daytime CC/Trevor wave: collection refactor Steps 1/2/3a, pack-EV secondary-ask reframe + survivor-bias + varied-pool guards, Golazos + Pinnacle pack-EV pipelines, Dune ownership incremental backfill, parallel-premiums/market-pulse insights, special-serial-owners→AllDay).
**Prod:** dpl_HYjoZDwWDgThh831gNPVTYyY5Maj (5c45977e) READY. One intermediate ERROR deploy dpl_8ePC1uvZRD (f6cd1ef0 Step 2 useReducer) was SUPERSEDED by later READY builds (852393 Step 3a → 5c45977e) — not current, no action.

## TOP FINDING (operator escalation) — CRON-JOB.ORG BROAD TRIGGER DROPOUT since ~06:37–06:50Z

`detect_stalled_pipelines()` returned 14 entries and a wider `pipeline_runs` sweep shows **~35 cron-job.org-triggered pipelines frozen at their last run ~06:34–06:50Z** (~90 min silent as of 08:10Z, still not recovered). Affected set includes core data pipelines: **topshot-sales-indexer** (06:43Z — so `sales.max(ingested_at)`=06:43Z), **wmc-fmv-populate** (06:48Z), **fmv-recalc** (06:48Z), **snapshot-pack-asks** (06:48Z), **wallet-backfill\*** (06:46Z), **offers-sweep** (06:42Z), **alerts-dispatch/send** (06:44Z), **topshot-buyer-backfill** (06:34Z), plus the golazos/ufc/pinnacle listing indexers, retry queues, and stub resolvers.

- **NOT ours.** Pipelines on OTHER schedulers (GHA / Vercel crons / pg_cron) run normally through 08:0xZ: compute-topshot-pack-ev (08:07Z), compute-allday-pack-ev (08:07Z), pinnacle-nft-resolver (08:06Z), topshot-moments-hydrator (08:02Z), match-topshot-players (08:00Z). Vercel prod READY; the stopped pipelines log NO failures (they simply aren't being invoked) → external trigger not firing, not an auth/route/deploy problem. Site health-endpoint curl returned 503 but that is a Cloudflare edge bot-block of the sandbox IP (curl is unreliable for this host per CLAUDE.md; Vercel cron routes execute + log ok=true, so the app is not down).
- **Known recurring class.** This is the same external cron-job.org dropout as Q3 (2026-05-31, topshot-sales-indexer silent ~7.9h then self-recovered), CRON-DROP-WAVE (06-09), LISTCACHE-CRON-DROP (06-08). Mechanism: cron-job.org auto-disables entries after failure streaks in a saturation window, or an account/dispatch dip stops a batch of jobs.
- **No data loss.** All affected pipelines are cursor-based (sales-indexer walks from its event cursor; wallet-backfills UPSERT idempotently). They catch up automatically once cron-job.org resumes. Bounded + self-healing.
- **Operator action (secret-bearing console = off-limits to this pass):** open cron-job.org execution history for ~06:40Z onward; re-enable / re-fire any entries auto-disabled during the window (start with "RPC FMV Recalc Force Stale", the sales-indexer entry, and snapshot-pack-asks). If it hasn't self-recovered by morning, this is the CRON-DROP-WAVE recovery recipe. GHA backstops exist for the wallet-backfill + sales-indexer families (wallet-backfill-backstop.yml etc.) but did not cover this window.
- Re-check at end of run (08:10Z): still frozen; NOT recovered yet.

## Post-ship watch — 07-06 daytime CC/Trevor wave: ALL PASS, 0 reverts

- **Pinnacle pack-EV pipeline (compute-pinnacle-pack-ev, pg_cron 17 */6):** both GENUINE scheduled ticks green — 00:17Z ok=true (1277ms) + 06:17Z ok=true (1190ms). The 20:07Z ship-day `total_sealed` generated-column upsert error stays gone (the inbox 21:17Z post-ship target). `check_pgcron_recent_failures()` [].
- **PACK-EV-HISTORICAL-BACKFILL-CRON-120s-TIMEOUT (jobid 43, the 03:08Z HIGH) — CLOSED, self-resolved.** The 06:06Z monitor already saw it green (05:13→06:03Z all succeeded); re-confirmed this run: `check_pgcron_recent_failures()` []. Whatever batch/cron-level timeout adjustment landed took effect. No fix needed.
- **Golazos pack-EV (compute-golazos-pack-ev):** prior ticks 05:45Z/05:52Z ok=true; latest 06:37Z ok=false "editions chunk: Timed out acquiring connection from connection pool" = single overnight-contention pool timeout on a brand-new low-priority pipeline (thinnest market), not a regression from a working surface. Watch.
- **AllDay / TS pack-EV:** healthy through 08:07Z; the handful of `targets: canceling statement due to statement timeout` fails on compute-topshot-pack-ev (06:37/01:31/01:13/01:01/22:07Z) are the carried DAYTIME-CONTENTION / DBSAT statement-timeout class, each bracketed by ok=true — not new.
- **Security after the whole wave:** 0/0/0/0 (invariants / secdef_anon [] / rls_off_base [] / anon_write_holes []) — covers all 07-06 migrations (pack-EV guards, Golazos/Pinnacle pack-EV, Dune ownership `topshot_ownership` + `get_edition_top_owners`, special-serial-owners→AllDay). `fmv_sanity_flags` 0; `pinnacle_fmv_impossible_flags` 0.
- **Sentry:** only JAVASCRIPT-NEXTJS-1T (OG pipe-abort GET /api/og/insights/parallel-premiums), 1 event/1 user, 4h ago, no growth — benign client-abort on a freshly-shipped OG card. No new issues/12h.

## Health (GREEN apart from the cron dropout)
- security 0/0/0/0; trust 16/16 ok, breaches [] (topshot_impossible_parallel_serials 1/3, unmapped_resolution_backlog_max 30/100, edition_integrity 4/50, pinnacle_fmv_stale 22/30, fmv_sanity 0).
- sentinel TS-UUID-48h **0**; ts_uuid_dupes_24h 0.
- editions FLAT: TS 18,151 / AllDay 6,190 / Golazos 575 / UFC 518.
- FMV: TS H+M **4,948** (1318 HIGH + 3630 MED, improving from 4,934) / AllDay 820 / UFC 15 / Golazos 4. Pinnacle FMV in its own table (trust legs ok).
- DB **8,367 MB** (+162 vs 8,205 = benign ownership-MV + backfill growth; Pro-Micro at 8.3GB is the shared root of the DAYTIME-CONTENTION statement-timeout family).
- `check_pgcron_recent_failures()` [] — no pg_cron job's latest run failing.
- Vercel prod dpl_HYjoZDwWDgThh831gNPVTYyY5Maj (5c45977e) READY; no live ERROR deploy (the f6cd1ef0 intermediate was superseded).
- Artifacts: not deep-run (additive-only wave; the 06:06Z monitor validated rpc-live-health estate ~2h before this run; no schema drops/renames). None flagged broken.

## Carried / queued (unchanged unless noted)
- **ULTIMATE-FMV-RECALC-V1-MISSED-TICK (re-opened LOW):** last ran 07-06 06:35Z, missed the 07-07 06:35Z tick (1529m silent). 06:35Z sits right at the cron-dropout onset, so it may be a casualty of the same dropout. RPC_ADMIN_TOKEN daily cron = operator. Ultimate-tier FMV only; self-healed after the previous miss (07-06). Verify next 06:35Z tick.
- **SALES-SERIAL-BACKFILL-WATCHLIST (future-night):** gate still UNMET — sales-serial-backfill last logged 06:40Z (frozen by the cron dropout). Bank 2 clean ticks AFTER cron recovery, then add pipeline_cadence_watchlist row (400m/medium).
- **CROSS-SOURCE-DEDUP-STATEMENT-TIMEOUT** (nc2; CC/operator; folds into DAYTIME-CONTENTION); **BADGE-CATALOG-STALE-429** (nc3; GHA/operator); **DAYTIME-CONTENTION-CLUSTERS-BROADENING** (+ run-insider-detectors + daily-portfolio-snapshot gateway-timeout flaps from the 18:15Z inbox); **CLASSIFY-ACQ-ALLDAY-STATEMENT-TIMEOUT**; **FMV-RECALC-EDITION-FETCH-TIMEOUT-CREEP**; **REFRESH-SPECIAL-SERIAL-OWNERS-MV-TIMEOUT**; **BUYERBF-PERINVOCATION-WORK**; **ALLDAY-V1-UNMAPPED-DRIFT**; **WEEKLY-SURFACE-QA-PROSE**; **THIN-FMV-GUARD-CONTENTION**; refresh-conflated-editions cron (operator); topshot-sales-history-backfill watchlist; **VERCEL cost family**; A1-WORKER-PASSTHROUGH-CLEANUP; PIN-FMV-REKEY-WAVES 2/3; PIN-SYNC-CRON; P3-BUYERS; DUPE1 (gated/CC); Q2/Q5/Q6; N1; ANALYTICS-SMOKE-RESIDUAL; IPFS ×2; SMOKE-SECURITY-GUARD-TRANSIENT-API-PROBE-DEBUG.
- **DAILY-PORTFOLIO-SNAPSHOT-GATEWAY-TIMEOUT** (from 06:06Z inbox): the 07-06 07:05Z tick gateway-timed-out; the 07-07 07:05Z self-heal tick could not fire (inside the cron dropout window) → re-verify after cron recovery.
- **SENTRY-NEXTJS-1T-OG-PIPE-ABORT:** single-event, no growth; no action unless it climbs.

STEER honored: SERIAL-FMV weekly by design; evm-429 benign; studio-backfill volume expected.

# rpc-daytime-monitor — 2026-06-30T06:10Z (last tick of day, ~23:10 PDT, no clock skew)

Run context: shell/DB now() 06:06Z == app-stamped pipeline/fmv rows within ~5 min (no skew). Last tick of the day (not the ~8am first-tick) → 1a daily extras (cross-collection pg_cron verify + trust-health-as-daily-watch) skipped; trust read via rpc_ops_snapshot (15/15 ok). Lock RELEASED (overnight pass, ~22h stale) — inbox commit permitted.

Platform GREEN: security 0/0/0/0 · trust 15/15 ok (breaches []) · detect_stalled [] · pipeline_alerts 2 INFO (golazos_sales + ufc_sales resolving_editions, benign) · check_pgcron_recent_failures [] (SERIAL-FMV-POWER-MODEL-WEEKLY-TIMEOUT jobid-6 stays aged-out; resurfaces ~07-05, already queued — do not re-log) · sentinel TS-UUID-48h 17 (known inert DQ4 leak, 17 << WARN 250 / breach 200; ts_uuid_dupes_24h 17/200 ok; not escalating) · editions real-flat (TS 17,489 / AllDay 6,191 / Golazos 581 / UFC 518; TS == 03:11Z exactly) · FMV TS H+M 4,683 (improving from overnight 4,645) / AllDay 903 · fmv_sanity 0 · DB 6,748 MB (+104 since 03:11Z, benign backfill wave) · Vercel prod d23f5e66 (dpl_7gXyaD96) READY, 0 ERROR (all CANCELED = docs ignoreCommand, expected).

pipeline_fails_24h: 13 pipelines, but EVERY one's latest run is ok=true (verified per-pipeline via started_at, all within the last 67 min) — known transient connection-pool-saturation during the backfill wave, 0 genuine stalls.

Sentry: connector still not surfaced (4th consecutive tick blind — also 21:13Z / 00:13Z / 03:11Z). Substituted Vercel get_runtime_errors (3h) — no new crash classes; all known families (url.parse DEP0169 deprecation x179; [team] activity + /api/market heavy-query timeouts x1 each; a single smoke profile-401 transient = carried ANALYTICS-SMOKE-RESIDUAL class; plus the two now-fixed AllDay EV timeouts, last hit 04:03Z pre-fix). OPERATOR: reconnect the Sentry connector when convenient.

## RECONCILIATION (status change on 2 queued items — verify-quiet-and-CLOSE, NOT a new candidate to ship)

### ALLDAY-CORRECTED-EV + ALLDAY-PACK-REALIZED-EV-DIST-PAGE-TIMEOUT -> FIXED TODAY by Trevor/Cowork (commit 8b4b1872, fix deploy ~04:11Z)
Both were queued today (21:13Z + 00:13Z inboxes) and recorded as "no fix landed" at 03:11Z — that note is now STALE. The 06-29 evening Cowork wave shipped the fix: 8b4b1872 "dist-page EV timeout FIXED via matview precompute — v_allday_pack_ev_corrected now passthrough to mv_allday_pack_ev_corrected (indexed, 6h refresh cron); dist page 2660ms->145ms, realized-ev 0.2ms; same values (cache, not logic change); revert + night-pass note included." The two Vercel statement-timeout classes (allday_corrected_ev, allday_pack_realized_ev) last fired 04:03Z (pre-fix) and have been quiet since. NIGHT PASS: confirm both classes stay quiet on current prod, then CLOSE both queued items — do not re-queue, do not re-fix (the fix is shipped + READY; revert path is in the commit's own night-pass note + ledger).

## POST-SHIP WATCH POINTER (heavy 06-29 evening Cowork/Trevor wave — night pass's normal surface; no monitor action)

Prod walked through ~6 feat deploys (all READY; current prod d23f5e66): AllDay sealed-pack secondary-market surfacing + /insights/allday-pack-market (c653e23); TopShot sealed-pack secondary market + /insights/topshot-pack-market (de3531c0; v_topshot_pack_market backfilling to TS 2020 genesis); the AllDay EV matview fix above (8b4b1872); authoritative AllDay per-dist depletion via searchPackNft totalCount (60628758); SEO query-first value-led titles + a crawlable FMV valuation sentence on edition pages (ea5cb40f / d23f5e66); and additive/inert moment-FMV->pack-EV DB work (6d86b972: serial_fmv_jersey_model + compute_serial_fmv_jersey_model() + get_pack_ev_contributors(), not yet wired pending the LiveToken gate). Flagged here only so the wave is on record for post-ship watch.

## ARTIFACTS — 14 active; the 2 brand-new ones this evening VALIDATED HEALTHY this run

Two new Cowork artifacts appeared since the 03:11Z tick (13 -> 14), neither validated by a prior tick:
- rpc-moment-fmv-ev-dialin (created 05:22Z): ran its novel-object panels live — serial_fmv_jersey_model returns 10 sane fit rows (jersey ALL n=160/r=0.63 reliable; RARE/COMMON reliable; FANDOM n=16/r=0.00 + LEGENDARY n=8 thin -> unreliable, expected) and v_topshot_pack_ev_calibrated resolves (199 dists, calibrated 43.42 vs realized 16.92). Other panels read core tables already green via snapshot. OK, not broken.
- rpc-growth-funnel (created 04:21Z): ran its single json_build_object payload live — resolves clean (wau_7d 3, mau_30d 10, users_all 10, allowlist_active 25, outbound_30d 24, support_30d 13; weekly + top_destinations aggregates populate). OK. (Funnel shows RPC pre-traction at 3/50 WAU — known product state, not an anomaly.)
The other 12 artifacts are unchanged since prior validation; no RETIRED-tombstone false positives, none broken.

---

No NEW candidate tasks this run — the only actionable status change is the AllDay-EV fix reconciliation above. Carried/known left untouched (SERIAL-FMV-POWER-MODEL-WEEKLY-TIMEOUT queued ~07-05; SMOKE-SECURITY-GUARD-TRANSIENT-API-PROBE-DEBUG 03:11Z; WEEKLY-SURFACE-QA-PROSE; ALLDAY-V1-UNMAPPED-DRIFT; THIN-FMV-GUARD-CONTENTION; HISTORY-BACKFILL-UNMAPPED drain; TS-WMC-UUID-FOSSILS; PIN-FMV-REKEY-WAVES; PIN-FLOOR-REFRESH-WATCHLIST 07:45Z first-proof; etc. — see ledger). STEER honored: did not re-flag the DQ4 inert UUID leak (17/200, owned), the AllDay pack-mechanics crons / pack-OPEN ingestion (intentional), studio-backfill activity, alerts-dispatch/send activity, evm-429, or the SERIAL-FMV weekly cadence. Declined items not re-raised.

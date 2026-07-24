# RPC nightly autonomous pass — 2026-07-11 (GENUINE OVERNIGHT, ~01:03 PDT, no skew)

**Mode:** genuine overnight. NO clock skew (shell 08:02:06Z ≈ DB now() 08:02:45Z; newest sale 05:43Z / fmv 06:45Z lag is a SYMPTOM of the cron-job.org trigger dropout below, not skew). Push AVAILABLE, no FREEZE. Clone $HOME/rpcwork, origin/main 5ff22bf4 unchanged start→end.

**Outcome:** shipped **1** (DB-only monitoring-config relax), reverted 0, repaired 0, **closed 2**. Post-ship watch of the heavy 07-10/07-11 daytime + CC wave = ALL PASS, 0 reverts. Dominant finding is the recurring external **cron-job.org trigger dropout** (operator/self-healing).

---

## Health-drift triage

rpc_ops_snapshot() baseline (08:03Z):
- **security 0/0/0/0** — invariants [], anon_write_holes [], rls_off_base_tables [], secdef_anon_violations [].
- **trust_health 16 metrics, breaches []** — all ok. topshot_impossible_parallel_serials 2/3 (under threshold, known self-healing ::-cataloging class). fmv_sanity_flags 0, edition_integrity_flags 4/50, unmapped_resolution_backlog_max 34/100.
- **sentinel TS-UUID-48h 0**; ts_uuid_dupes_created_24h 0.
- **check_pgcron_recent_failures() []** — pg_cron clean.
- **editions:** TS **19,126** (+38 vs 19,088 last night = ongoing :: subedition cataloging, sentinel 0 confirms no hyphen-UUID leak), AllDay 6,190, Golazos 575, UFC 518.
- **FMV H+M:** TS **5,232** (1463 HIGH + 3769 MED; improving from 5,193), AllDay **819** (213+606; from 804), UFC 15, Golazos 4.
- **DB 9,094 MB** (+192 vs 8,902; benign growth).
- **Sentry:** 0 new unresolved issues firstSeen -24h. 3 regressed issues, all explained (below), none traceable to a ship.
- **Vercel:** prod ef2970c5 (badge v2-parity) READY; newest commit 5ff22bf4 (docs-only) correctly CANCELED via ignoreCommand; **no ERROR-state deploy in last 20**.

### DOMINANT FINDING (operator/external) — CRONJOB-ORG-TRIGGER-DROPOUT-20260711
detect_stalled_pipelines() lists ~24 pipelines frozen at their last cron-job.org tick ~**05:0x–05:43Z** (ufc-sales-indexer earlier at 04:28Z), still down ~2h20m at snapshot time. Frozen set is the cron-job.org-triggered subset: fmv-recalc (05:08Z), the sales indexers (allday/golazos/ufc), offers-sweep, snapshot-pack-asks, wmc-fmv-populate, topshot-buyer-backfill, topshot-flowty-unmapped-drain, pinnacle-listings-indexer/reconcile, pinnacle-events-ingest, allday-offers-indexer, lock-check-batch, etc.

**Not our failure:** 151 pipeline runs fired AFTER 06:00Z (last at 08:02Z) — the GHA / Vercel-cron / pg_cron pipelines (topshot-moments-hydrator, compute-*-pack-ev, pinnacle-nft-resolver, hybrid_custody_events, ultimate-fmv-recalc-v1 @06:45Z, etc.) all ran normally through 08:0xZ. The stalled pipelines log **NO failures** — the external trigger simply isn't firing. Same recurring class as 07-07, 06-09, 05-31 (each self-recovered). **Cursor-based ⇒ no data loss; self-heals on cron-job.org recovery.** NOT auto-actionable (external secret-bearing console = off-limits).
- **Operator:** check cron-job.org execution history from ~05:40Z and re-enable/re-fire any auto-disabled entries (prioritize sales-indexer, fmv-recalc, snapshot-pack-asks, wmc-fmv-populate).

### Post-ship regression watch — ALL PASS, 0 reverts
Heavy 07-10/07-11 daytime + CC wave, all verified clean on current prod:
- **Badge v2-parity** (ef2970c5, deploy dpl_FNx1y3QJEpNVe55h9TEMK4zLy2r3 READY) — security 0/0/0/0 after all 5 migrations; no new Sentry class.
- **fmv-recalc Step-1a SECDEF fn** (e2f39220 + 3 migrations) — fmv-recalc 14 fails/24h (within its honest-timeout band; no new class). Currently stalled by the cron dropout (05:08Z) so fresh throughput not measurable; re-check tomorrow.
- **AllDay jersey leg** (0823e217), **Trophy Case Auto-Arrange** (440d3840), **analytics-smoke per-collection freshness** (306471b7), **sniper AllDay serial-FMV badges** (03563b65), **recharts SSR warning fix** (bba40c2e), **UFC teardown** (a54cb600 / 235e6212, c70137cd), **UFC fabricated-date fix** (ab3ee8bf), **MarketplaceStatusBanner mount** (474c5910) — all prod READY, security invariants 0/0/0/0 cover every migration, trust breaches [], Sentry 0 new/24h.
- **3 regressed Sentry issues, none from a ship:** JAVASCRIPT-NEXTJS-1J = the smoke pack-dist false-fail (queued below; last seen 6h ago); JAVASCRIPT-NEXTJS-1E = smoke detecting the cron-job.org dropout (self-heals); JAVASCRIPT-NEXTJS-1R = single "Downtime detected" blip on the legacy rip-packs-city.vercel.app redirect host (1 event, 0 users, ~06:00Z, self-resolved — no corresponding ERROR deploy, prod READY).

---

## SHIPPED (1)

### UFC-SALES-INDEXER watchlist relaxed — 90→240 min, medium→info (DB-only, monitoring config)
- **Change:** UPDATE public.pipeline_cadence_watchlist SET max_silent_minutes=240, severity='info' WHERE pipeline='ufc-sales-indexer' (is_active kept **true**).
- **Why:** UFC Strike's Flow market is permanently frozen (migrating to Aptos); Flow UFC sales now trickle ~10/24h via the GHA sales-indexers-backstop.yml, so a 90-min absence threshold chronically false-trips detect_stalled_pipelines()/pipeline_alerts (pure monitor noise, not an outage). The sibling ufc-listings-indexer was already fully retired (is_active=false) by CC on 07-11 (a54cb600) — this is the sales-leg analogue, but kept ACTIVE at a loose 240-min/info threshold to preserve detection of a genuine >4h total stop (unlike the listings market, sales still flow).
- **Source:** daytime-monitor inbox 2026-07-11T03-08-00Z.md (UFC-SALES-INDEXER-WATCHLIST-STALE-FROZEN-MARKET, chose lever (b): relax rather than fully retire).
- **Verification:** row confirmed 240 / info / active; detect_stalled_pipelines() filtered to ufc-sales-indexer now returns **[]** (was 214 min silent, false-tripping medium). No ingest/route/FMV/deploy touch; monitoring-config only.
- **Revert:** UPDATE public.pipeline_cadence_watchlist SET max_silent_minutes=90, severity='medium' WHERE pipeline='ufc-sales-indexer';
- **Metric to re-check tomorrow:** ufc-sales-indexer no longer appears in detect_stalled_pipelines() under normal sparse cadence; a genuine multi-hour+ total stop still surfaces at info.

---

## CLOSED (2)

1. **PACK-REALITY-TOP-EV-EMPTY — GENUINE DEPLETION, not a regression** (inbox 2026-07-10T15-11-45Z.md). topshot_pack_reality_top_ev = 0 rows because of the pack board's real depletion, NOT the 07-10 4969aef stress-test-hiding change. Filter-chain drill-down: 1,189 TS pack_ev_latest rows → 101 positive-EV & priced → 75 with a dist_id → **only 1 survives depletion_pct<90** (74/75 buyable positive-EV TS packs are ≥90% depleted) → that 1 is a reward pack (correctly excluded by is_reward_pack=false) ⇒ 0. Sibling surfaces healthy (_dist=6, _stats=1; pack_ev_latest 1,189 TS rows fresh @08:03Z). Expected given current TS pack availability; documented so future ticks stop re-flagging. No action.
2. **ULTIMATE-FMV-RECALC-V1-MISSED-TICK — RESOLVED.** Now on durable pg_cron (job 51, 45 6 * * *, per a54cb600), immune to the external-trigger dropout; ran **06:45Z today**. No longer a missed-tick item.

---

## QUEUED

### CRONJOB-ORG-TRIGGER-DROPOUT-20260711 (operator/external, self-healing) — night-count 1 (recurring class)
See Dominant Finding above. ~24 cron-job.org pipelines frozen ~05:0x–05:43Z; cursor-based, no data loss, self-heals on console recovery. Operator: inspect cron-job.org execution history from ~05:40Z; re-enable any auto-disabled entries. Not auto-actionable (external secret-bearing console).

### SMOKE-PACK-DIST-SALES-HISTORY-FAIL (LOW — de-escalated from LOW-MED; determined FALSE-FAIL class) — night-count 1
- **Determination:** the "Sales History" section is **not** broken. PackSalesHistory (in app/(collections)/[collection]/pack/dist/[distId]/page.tsx, last touched 07-06) **always** emits the "Sales History" <h2> even in its empty state; get_pack_sales_history('95f28a17-…','7800',10) returns **20 rows** cleanly (dist 7800 has 19,494 pack_purchases / 7,427 secondary). Data path healthy, component intact. A Sales History=false smoke result therefore means the streamed PackDetailBody (a 4-way Promise.all — the documented [pack-detail] statement timeout contention class) didn't fully flush into the HTML the smoke captured. **Intermittent** (Sentry 1J 8 events, last seen 6h ago; analytics-smoke ~11 fails/6h — not constant), correlating with DB contention.
- **Why not auto-shipped:** the fix is either (a) smoke-side — assert a stable always-present element / add a short retry / tolerate Suspense streaming (test-code, but choosing the right assertion needs the streaming determination reproduced under load, which I can't do without authenticated repro), or (b) harden the pack-detail bundle Promise.all with per-fetch timeouts (pack-page data-fetch = off-limits invisible-failure class). Not a blind ship.
- **Ready levers (CC):** (a) in app/api/smoke-test/route.ts leg "pack dist page has Sales History", switch the assertion to a stable non-streamed element or add one retry; (b) wrap each fetch in fetchPackSalesHistory/fetchPackContents/fetchExhaustedCount/fetchTopPulls Promise.all in a per-call withTimeout fallback so one sibling timeout doesn't drop the whole streamed body.

### Carried (unchanged) — see ledger
TOPSHOT-MOMENTS-HYDRATOR-GETMINTEDMOMENT-ERRORS (72 fails/24h, upstream getMintedMoment GQL, alternating ok, stubs_created/edition_resolution_failures/graphql_failures 0 = no corruption, self-limiting; moment→edition enrichment, off-limits); FMV-CLAMP-DISCONNECTED-ASK-CONTENTION-TIMEOUT; cron-job.org dropout family; SALES-SERIAL-BACKFILL-WATCHLIST; CROSS-SOURCE-DEDUP; BADGE-CATALOG-STALE-429; DAYTIME-CONTENTION family; DAILY-PORTFOLIO-SNAPSHOT-GATEWAY-TIMEOUT; CLASSIFY-ACQ-ALLDAY; FMV-RECALC-EDITION-FETCH-TIMEOUT-CREEP (now hard-fixed by e2f39220, post-ship watching); REFRESH-SPECIAL-SERIAL-OWNERS-MV-TIMEOUT; BUYERBF; ALLDAY-V1-UNMAPPED-DRIFT; WEEKLY-SURFACE-QA-PROSE; THIN-FMV-GUARD-CONTENTION; VERCEL cost family; CC-owned full-audit follow-ups (2 home-machine Task Scheduler ingests, ALLDAY_PROXY_URL env, VERCEL-CRON-MISATTRIB-DRAIN-500, UFC-Aptos UI, soft-404 noindex); + the standing owned/operator/gated queue.

---

## FAILED / AUTO-REVERTED
None. No verification failures; production shipping not hard-stopped.

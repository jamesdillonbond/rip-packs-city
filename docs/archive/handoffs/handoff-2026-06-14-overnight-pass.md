# RPC nightly autonomous pass — handoff 2026-06-14 (GENUINE OVERNIGHT)

**Run:** rpc-nightly-autonomous-pass · fired 08:02Z / **01:02 PDT (in-window)** · genuine overnight · **push available** · no FREEZE · lock held (runid 3263417735).
**Result:** shipped **1** (UFC-DRAIN-WATCHLIST), reverted **0**, repaired **0** artifacts, closed **2**, queued **1 new**. Platform GREEN; second consecutive clean overnight on the Small tier + cohort pacing. Git via the sandbox-native clone flow (clone + pushurl harvest + push all worked).

---

## What was reviewed
- **Continuity:** CLAUDE.md (full), ledger.md (Declined + Queued), focus.md (06-12, mostly resolved), the 3 fresh inbox files (06-13T16-05Z, 06-13T18-17Z, 06-14T03-17Z), metrics-latest.json (06-13 baseline), git log -30.
- **Inbox candidates drained (3):** ALLDAY-V1-UNMAPPED-DRIFT (investigated → queued), MONITOR-ARTIFACT-ACCESS (closed), TROPHIES-INSIGHTS-QA (QA'd → closed). All 3 archived this run.
- **Artifacts:** 17 enumerated (12 active + 5 RETIRED tombstones). Ran rpc-live-health's self-contained `insights_counts` payload directly — all 11 insights boards return rows (squeeze 501, set_squeeze 235, pack_reality 8, rookies 61, market 501, first_mint 501, cross_collection 1, pinnacle_scarcity 501, offer_spread 501, deals 501, trophies 501). v_insights_trophies already wired into the payload (current, not drifted). None repaired (none drifted). 5 RETIRED tombstones (audit-followups, pipeline-reliability, security-drift, fmv-watch, insights-health) intentionally untouched.
- **MONITOR-ARTIFACT-ACCESS confirmed resolved this run too:** the Read/Grep tools reach the OneDrive artifact HTML (`C:\Users\TDill\OneDrive\Documents\Claude\Artifacts\<id>\index.html`); bash (sandbox mounts only) cannot. True per-payload validation is available to the night pass.

## Post-ship regression watch (last ~24-48h ships) — ALL PASS, 0 reverts
The 06-13 interactive Cowork+CC wave + the most recent code ship `45f52bb` (moment+trophy hero media, ~9h before run) were re-measured:
- `allday-listings-indexer` 96/0 — **bd8e05c holding** (NEXTJS-15 retry-churn exclusion): NEXTJS-15 last event ~10h ago, *before* the fix deployed (~8.5h ago); zero events since. Quiet, not spiking.
- `topshot-buyer-backfill` 144/0 (1d79539+83bb40f widen holding, draining).
- `fmv-recalc` 92/0; `analytics-smoke` 48/0 (60s restore holding); `offers-sweep` 71/1 (lone TS-GQL 429 transient); `pinnacle-listings-reconcile` 96/0.
- `f073ae0` smoke concierge-cost gate, `503b836` transaction-history (new SECDEF RPC) — no Sentry, security check clean (no new anon-SECDEF violation). 
- Vercel: prod `45f52bb` READY; all recent deploys READY/CANCELED (CANCELED = superseded or docs-only build-skips via `0e7e627`'s ignoreCommand), **0 ERROR**.
- Nothing regressed; no auto-revert warranted.

## Health-drift triage + overnight deltas (vs 06-13 08:14Z baseline)
- **Security 0/0 all four:** RLS-off base tables NONE; anon/auth write-on-RLS-off (relkind r/p) NONE; check_secdef_anon_execute_violations []; check_public_security_invariants 0 rows.
- **detect_stalled_pipelines() [] · get_pipeline_alerts() [].**
- **Pipeline fails 24h:** ~12, all transient/wave-coincident/known — wmc-fmv-populate x5 (lock timeout, 07Z wave), check-alerts x3 (:15-slot cohort collision), hybrid_custody/offers-sweep(429)/pack-events-backfill/TFP x1 each. No new failure class.
- **Cohort wave 06:45-07:35Z: 1955 runs / 2 fails = 0.1%** (cleaner than 06-13's 1507/3); post-wave 07:35-08:05Z 118/0. **DBSAT-IO-EXHAUSTION-0612 resolution decisively holding** on Small tier + cohort pacing.
- **Trust health 8/8 ok:** edition_integrity 4/50, fmv_sanity 0/1, offer_edition_gap **$0**/50 (improved from $45), pack_ev_stale **0.75d**/2, pack_ev_depleted 0/30, pinnacle_ask 0.2h/3, pinnacle_fmv 22.0h/30, ts_uuid_dupes_24h 0/200.
- **FMV improving:** TS HIGH 971 / MED 2379 / **H+M 3350** (↑ from 3282) / LOW 6671 / ASK_ONLY 945 / STALE 462 / SALES_ONLY 23 / **NO_DATA 4092** (↓ from 4264). AllDay **H+M 679** (↑ from 657) / 6190 priced. Pinnacle render priced 1836 / **H+M 797** (≈805).
- **Editions flat:** TS 15543 / AllDay 6191 / Golazos 581 / UFC 446 (no dupe growth).
- **Sentinel TS-UUID-keyed 48h = 0.** UFC wmc null edition_key **2/4584** (fossil floor — UFC-WMC-NULLKEY stays closed; the `0x6d1f8c18` pair).
- **weekly-db-maintenance self-fired 04:23Z 06-14** (the predicted 6-day-gated re-fire): deleted **7,198 pipeline_runs** + 152 usage_events + 90 unmapped_failures. pipeline_runs total 64,458, oldest 06-07 (7-day retention is the by-design steady state since the daily standalone prune was retired 06-10). 
- **DB 4561 MB** (+106/24h mild creep; prune caps row count, not file size without VACUUM FULL — benign).
- **Sentry:** 1 unresolved — NEXTJS-15 (allday-listings, listing_resolution_failures_inserted, 3 ev, last seen ~10h ago = pre-bd8e05c). Resolvable after 24h quiet (~22Z 06-14) with regression arming — left for the next pass.
- **unmapped_sales open:** AllDay 246 / total 247 (golazos 1). ALLDAY-V1-UNMAPPED-DRIFT continuing (see queued).

---

## SHIPPED (1)

### UFC-DRAIN-WATCHLIST — `audit_20260614_watchlist_ufc_enrichment_drain`
Added the load-bearing `ufc-enrichment-drain` cron to `pipeline_cadence_watchlist` @ **120m / medium**. This is the cron (cron-job.org 7804392, wired ~04:37Z 06-13 by the operator) that drains UFC wmc NULL `edition_key` directly and keeps UFC-WMC-NULLKEY closed; it had no stall coverage.
- **Gate met (the queued 24-48h-banked condition):** 56 runs / **0 fails** over 30h, clockwork ~30-min cadence, **max observed gap 30m**, banked since 04:37Z 06-13 (~27.5h). 120m = ~4× margin → cannot false-trip on the live cadence.
- **Verification — direct:** row landed (120m/medium/is_active=true, created 08:14Z); `detect_stalled_pipelines()` stays `[]`; the new entry does NOT list in detect_stalled (last run 7 min before check). **Fresh-subagent independent verification: VERDICT PASS** (1 row + correct attrs; detect_stalled []; runs_30h 56 / fails_30h 0 / max_gap 30m / mins_since_last 8; get_pipeline_alerts []).
- **Revert:** `DELETE FROM public.pipeline_cadence_watchlist WHERE pipeline='ufc-enrichment-drain';`
- **Re-check tomorrow:** the watchlist row stays silent (no spurious stall alert) AND UFC wmc null edition_key stays at the 2/4584 fossil floor.

## CLOSED (2)
- **TROPHIES-INSIGHTS-QA** — ran the rpc-insights-qa checklist against the fresh `/insights/trophies` surface (deploy 34b1543, READY). **Backing-view security sound:** v_insights_trophies is a VIEW, security_invoker=on, anon-SELECT, returns 501+ (683) rows. **SEO/UX correct (static source review of the READY build):** sitemap `trophies` entry present; canonical param-stripped to `/insights/trophies`; OG 1200×630 PNG (ImageResponse); WebApplication JSON-LD; per-tile drill-down `/<collection>/edition/<external_id>` raw-HTML links (encodeURIComponent, `/moment/<edition_id>` fallback) = crawlable; FMV honesty present ("Awaiting a comp" / NO COMP / never $0; confidence chip ASK/STALE); brand tokens; 1h edge cache + fmv DESC NULLS LAST so priced grails lead. **Caveat:** live HTTP-200 not fetched (web_fetch provenance restriction this run) — deploy READY + anon-public + 0 Sentry + live backing view = high confidence; the daytime monitor continuously validates the live page.
- **MONITOR-ARTIFACT-ACCESS** — confirmed resolved-in-practice again this run: the Read/Grep tools reach the OneDrive artifact HTML (bash cannot, sandbox mounts only). Future passes can Read each artifact's index.html, Grep its sql() payload, and run the self-contained sub-queries (templated ${TS}/${AD}/CTE payloads won't run verbatim — substitute UUIDs / run sub-queries).

## QUEUED — new this run (1)
### ALLDAY-V1-UNMAPPED-DRIFT · [LOW · operator cron-job.org] — wire the V1-budget recover drain
- **Diagnosis (this run):** all **246** open AllDay `unmapped_sales` are `source=onchain_dapper_v1`; **236 carry `resolution_hint.price_extraction = v1_tx_decode_budget_exhausted`** (the 10 others generic `v1_dapper`). Oldest 2026-05-21, newest 06-13 21:40Z, accumulating ~+23-32/day. Root cause: the V1 Dapper tx-decode budget (25 calls/tick) is exceeded on busy AllDay V1-sale ticks; the overflow rows are correctly held out of `sales` (price-uncertain — NO FMV/analytics corruption) but never re-decoded. The recover route exists (`app/api/admin/recover-v1-budget-exhausted/route.ts`, 6,969 bytes, auth Bearer INGEST_SECRET_TOKEN) but **`recover-v1-budget-exhausted` has 0 pipeline_runs ever — no cron drains it.**
- **Recommended action (operator):** wire a low-cadence cron-job.org GET/POST of `/api/admin/recover-v1-budget-exhausted` (e.g. every 2-4h, off the wave anchors) to re-decode the budget-exhausted tail and keep pace with the ~25/day inflow. Alternative (cheaper, no recovery): formally classify `v1_tx_decode_budget_exhausted` rows as a known permanent residual so they stop inflating the open-backlog signal.
- **Why not auto-shipped:** the durable lever is either an operator cron wiring (not DB/code) or a per-tick V1 decode-budget bump in the AllDay sales indexer (ingest route logic = OFF-LIMITS to the passes). LOW priority: no outage, no corruption, modest signal inflation only.

## QUEUED — carried (unchanged; see ledger for full text + revert/diffs)
TFP-SLOT-WAVE-COLLISION (operator — move topshot-fmv-populate off its :15 slot; gates TFP-480-RESTORE), TFP-480-RESTORE (gate unmet — TFP still fails its :15 wave slot), TEAM-MOMENT-DISPLAY (CC), ANALYTICS-SMOKE-RESIDUAL (CC), OFFER-SANITY-RAISE (CC, off-limits writer), IPFS-CIDSET-EVENT-LEG / IPFS-GATEWAY-FALLBACK (CC, deferred), PIN-FMV-REKEY-WAVES (Trevor review), PIN-SYNC-CRON (operator then night-pass-eligible — pinnacle_fmv 22.0h healthy, sync firing), PACKVIZ-GRID (CC review), P3-BUYERS, DUPE1 (quiet — sentinel 0), N1, Q2/Q5/Q6/Q8, SMOKE-EDITION-TIMEOUT, NEXTJS-15/Q4 (quiet since bd8e05c). VERCEL cost items (FLUID-RIGHTSIZE / CRON-CADENCE / OBSERVABILITY-SAMPLING / SPEND-PAUSE / FLUID-CONCURRENCY) — HELD by Trevor until cohort-split settles.

## FAILED / BLOCKED / AUTO-REVERTED
None. No verification failures; production shipping not hard-stopped.

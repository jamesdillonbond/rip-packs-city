# Overnight autonomous pass — 2026-06-10 (~01:02 PDT / 08:02Z)

GENUINE OVERNIGHT, in-window. Took over the released 06-09 `.lock`. No FREEZE. Shipped **1** DB migration (subagent-verified PASS), reverted 0, repaired 0 artifacts (none broken). Ship budget 1/4 used.

**Git status this run:** push CREDENTIALS worked for the first time since ~05-31 (`git push --dry-run` succeeded — Q7's credential half may be resolved), BUT an **orphaned `.git/index.lock`** (mtime Jun 9 23:33, pre-dating this run; sandbox `rm` → `Operation not permitted`, the documented Q7 mount behavior) blocked local commits at the end of the run — so doc outputs are **on disk uncommitted**: this handoff, `docs/overnight/ledger.md`, `docs/overnight/metrics-latest.json`, the CLAUDE.md session entry, and the 6 archived inbox files (moved to `docs/overnight/inbox/archive/` via plain `mv`). **Trevor: `Remove-Item .git\index.lock` on Windows, then commit these paths.** Also: the run was suspended mid-flight (clock jumped 08:2xZ → 13:5xZ during the output phase) and `origin/main` advanced to `e3aee28` (fmv-recalc / badge-sync / wmc-fmv-populate — an active daytime CC session), so the night pass correctly stood down from any further git activity. All DB-side work (the migration) and all measurements completed in-window before the suspension.

## Headline: the DBSAT/wmc-rewrite-storm fix wave is VERIFIED WORKING

Post-ship regression watch (focus items 1, 6, 7) — the decisive 06:00Z wallet-backfill wave on the new `upsert_wmc_batch` path (`f41caf4` + `a3c1a0c` + `acf85c0` + scan-pinnacle edge fn v20):

- **Wallet-backfill family: 0 fails / 9h across all 7 variants** (wave ran 06:45–06:57Z; wallet-backfill 175 ok, -allday 493, -pinnacle 379, -mc dispatch 518 / complete 351, -golazos 73, -ufc 38). No 5xx storm.
- **The legacy PostgREST wmc upsert entries are FROZEN** — the #1 DB-time consumer still reads exactly 37,615 calls (identical to the at-ship figure; no new accrual through a full 00Z + 06Z wave cycle, including the TS leg post-`a3c1a0c`). `upsert_wmc_batch`: 1,235 cumulative calls, wave-time mean ~1.4s, max 24.7s — above the aspirational <500ms (big TS batches) but **2.9× cheaper than the legacy 4.0s mean** and never near the 8s cap; zero resulting pipeline failures.
- **The per-wave `fmv_usd` wipe has STOPPED:** `wmc-fmv-populate` post-wave ticks log `rows_updated: 0` across all 5 collections (it used to re-fill thousands per wave). Hidden churn eliminated.
- **Write-volume collapse:** only ~49K wmc rows actually written in the 06Z wave (32,495 TS / 11,813 AllDay / 4,794 Pinnacle / 39 UFC) vs the old ~1.58M full rewrite. Change-detection is doing its job.
- **Integrity spot-check clean:** 0 NULL `edition_key` on TS/AllDay/Pinnacle wave-written rows; fmv_usd preserved (32,480/32,495 TS rows still priced). The 39 UFC null-key rows are the KNOWN chronic UFC-WMC-NULLKEY queued item, not a regression. **No revert warranted.**
- **Cross-pipeline saturation sharply down:** 05Z = 0 fails, 06Z wave hour = 6 fails (1,013 runs), 07Z = 14 fails / 8 pipelines, 08Z = 0 — vs the prior two nights' every-tick failure storms across 05:00–08:30Z. The 00Z midnight-anchor window recurred mildly (27 fails / 14 pipelines in the 00Z hour, mirroring last night) — that window is anchor-cluster + `topshot-buyer-backfill` load, not wmc. All remaining fails are dispersed single-digit statement-timeout/pool class, self-recovering.
- **202-wrap sweep (`c55d394`) verified logging:** all 11 wrapped routes (+ reconcile from `56ad4ff`) logged normally in the last 12h (offers-sweep 36 ok, check-alerts 35, drain-fmv-cold-tail 21, daily-portfolio-snapshot 1 ok, refresh-error-triage 12, etc.). No route went silent.
- **Pinnacle reconcile fix HOLDING:** `pinnacle_ask_stale_hours` **0.7h** (breach 3) despite 3 saturation-failed ticks in the 07Z hour — the re-enabled cron + 202 wrap absorb individual timeouts.

Other recent ships re-checked: `7b03815` fossil-404 — smoke uses hardcoded int-pair URLs (`124:4493`, dist 7800) so no smoke interaction; sitemap concern closed. `4138db6` drift-guard fix — NEXTJS-14 has had ZERO events on the fixed release (last event 05:43Z on pre-fix `586c231`) and is already marked resolved in Sentry with regression arming. `e05030b`/pin-list, light-mode `2d58b72`, pack-sniper wave: no attributable Sentry, deploys all READY.

## SHIPPED (1)

### `audit_20260610_trust_health_pinnacle_fmv_freshness` — render-FMV staleness tripwire (PIN-SYNC-FMV-WATCH item (b))

Added the `pinnacle_fmv_stale_hours` leg to `v_rpc_trust_health`: hours since `max(fmv_computed_at)` over priced `pinnacle_catalog` rows (COALESCE→999 so a total wipe also breaches), breach at **30h** (daily `pinnacle-sync` ~10:07Z + grace). Closes the monitoring gap that let the 2026-06-04→06 PIN-FMV2 render-FMV freeze go 2.4 days unseen; the ASK companion (`pinnacle_ask_stale_hours`) was added 06-09, render-FMV was still blind.

- Gate (a) confirmed first: `pinnacle-sync` 06-09 10:07Z `ok=true` (the `5880eeb` 120s statement-timeout fix is durable) + watchlisted @1560m since 06-09.
- Pre-flight: current viewdef captured via `pg_get_viewdef` (revert path), `security_invoker=on` + service_role/postgres-only grants confirmed before and preserved after (explicit `WITH (security_invoker = on)` in the CREATE OR REPLACE).
- Verification: view returns 7 rows, new metric 22.0h/30 ok (matches direct measure exactly), all 6 pre-existing metrics semantically unchanged (fmv_sanity cross-checked 0==0), runs in ~200ms. **Fresh-subagent verification: PASS** (7 rows, value cross-check 22.1==22.1, invoker on, 0 anon/auth grants, 203ms).
- **Revert:** re-CREATE the view without the `pinnacle_fmv_stale_hours` UNION ALL leg (prior viewdef in this run's transcript; it is the 06-09 `audit_20260609_trust_health_pinnacle_ask_freshness` body).
- **Target metric for tomorrow:** `v_rpc_trust_health` still 7/7 ok after the ~10:07Z pinnacle-sync tick (value should drop to ~0–1h); the `rpc-trust-health-watch` task reads the view without error.

## Health (Section 2)

- **Security 0/0** all four checks (RLS-off [], anon/auth-write-on-RLS-off base tables [] with `relkind IN ('r','p')`, `check_secdef_anon_execute_violations()` [], `check_public_security_invariants()` []).
- **`detect_stalled_pipelines()` = []** at sweep time (08:05Z). NOTE: `topshot-fmv-populate` last ran 00:50Z (FAILED, pool timeout) and missed its ~06:50Z tick — it will trip its 480m watchlist around 08:50Z. Same TFP/CRON-DROP class; operator re-fire "RPC TS FMV Populate" + check the entry isn't auto-disabled.
- **Sentinel:** TS-UUID-48h **0**; trust health **7/7 ok** (closest to breach: pack_ev_board_max_stale_days 1.74/2 — known rush-class compute-topshot-pack-ev fails, 49/24h, board still fresh).
- **FMV:** TS HIGH+MED **2,852** (567 H / 2,285 M; flat vs 2,917 baseline), NO_DATA **4,715** (improving from 5,029), ASK_ONLY 994, STALE 238. AllDay HIGH+MED **481** (flat). Writers fresh (fmv-recalc 08:08Z, 4 fails/24h saturation-class; sales-indexer + allday-fmv-populate + offers-sweep 0 fails/24h). `fmv_sanity_flags` 0. AF1-v2 holding (`v_tracked_wallet_fmv_confidence` 20 rows, fast).
- **Editions:** TS 15,542 / AllDay 6,191 / Golazos 581 / UFC 446 — identical to baseline; DUPE1 re-mint still stopped.
- **DB size:** **6,883 MB** (+196 vs 06-09 08:30Z baseline 6,687; same slow creep the monitors tracked all day — watch-only).
- **Deploys:** 20/20 READY, 0 ERROR; prod `983b0e3`. Git identity drift fixed (today's commits authored Trevor).
- **unmapped_sales:** 183 open (flat).
- **Artifacts:** 17/17 — monitors validated backing queries through 06:09Z; key fragile view re-validated this run (20 rows, no timeout). None repaired (none broken; per task rules, no regeneration of working artifacts).
- **Sentry (10h):** 9 unresolved, no net-new from any recent ship except **NEXTJS-1M** (NEW: `TypeError: Load failed` on `/dashboard`, 1 event/1 user 07:3xZ — same WebKit fetch-abort class as NEXTJS-1K on `/share`; watch). NEXTJS-1H (9 ev) / NEXTJS-1J (8 ev) = SMOKE-EDITION-TIMEOUT (see below, new datapoint). NEXTJS-4/A/E/1E = 00Z saturation echoes. NEXTJS-15 = known Q4/PIN1 carry. NEXTJS-14 resolved (clean on fixed release).

## New datapoint — SMOKE-EDITION-TIMEOUT (1H/1J): pages are HEALTHY; the fault is the smoke fetch

Did the distinguishing anon fetch the 06:09Z monitor asked for: `GET /nba-top-shot/edition/124:4493` → **200 in 2.6s, "Recent Sales" present**; `GET /nba-top-shot/pack/dist/7800` → **200 in 2.3s, "Sales History" present**. Both sections render fine anonymously, yet smoke failed a majority of ticks overnight (9+8 events/8h, many outside saturation windows). Conclusion: the product pages are NOT broken — the smoke `checkUrl` per-fetch budget is too tight for these two heavy SSR pages under load/cold-start, and the timeout-abort is an assertion-class failure that bypasses SMOKE-RETRY by design. **Fix is in `app/api/smoke-test/route.ts`** (bump per-fetch timeout for these two checks, or route timeout-aborts through SMOKE-RETRY) — hot file (touched by `4138db6` <24h) + smoke-route = queued for CC, not auto-shipped. Also confirmed: smoke's edition URL is the hardcoded int-pair `124:4493`, so `7b03815`'s hyphen-404 cannot affect it.

## Queued / carried (full list in ledger)

- **SMOKE-EDITION-TIMEOUT** — escalated with tonight's proof (pages healthy, fix the smoke fetch). CC, hot file.
- **BUYERBF-WATCHLIST** — held: `topshot-buyer-backfill` has only ~10h observed cadence (60 runs/12h, 7 saturation fails) vs the item's own 24–48h gate. SHIP-eligible tomorrow night with the ready INSERT @40m/medium.
- **NEXTJS-1M** (NEW, watch) — `/dashboard` "Load failed", 1 event; same class as NEXTJS-1K (`/share`, 2 events, quiet 5h). If either accumulates, CC wraps the client poll fetches in try/catch (ignore AbortError).
- **TFP re-fire** (operator) — `topshot-fmv-populate` 00:50Z fail + missed 06:50Z tick; trips watchlist ~08:50Z. Check for cron-job.org auto-disable (the 56ad4ff class) — the route is NOT yet 202-wrapped.
- **DBSAT-00Z** — recurred mildly (27 fails/14 pipelines in 00Z hour, quiet by 01:06Z). Bounds recorded for the carried DBSAT re-baseline; tonight's 05–08:30Z window essentially GONE post-wmc-fix.
- **USERNAME-CRON-UNWIRED** (operator) — `resolve-wallet-usernames` still 0 runs ever; cron-job.org entry still missing.
- Carried unchanged: PINFMV-DRIFT-14 ✅ (resolved, Sentry clean), UFC-WMC-NULLKEY, OFFER-SANITY-RAISE, IPFS deferrals, CRON-30S 3/4 + hygiene, PIN-FMV-REKEY waves 2/3, PACKVIZ-GRID, NEXTJS-15/Q4, P3-BUYERS, Q5/Q6/Q8, N1.

## Closed in ledger this run

- **b7211fb-VOLUME-WATCH** — gate met (06-09 peak 102–216/hr across 14–23Z, squarely in the 100–250 band; buyer coverage healthy). Closed.
- **PIN-SYNC-FMV-WATCH** — both halves done: (a) verified 06-09, (b) shipped tonight. Closed.

## Notes

- Wave-watch criteria interpretation per focus.md items 6/7: ALL legs (including TS via `a3c1a0c`) measured cheap; new wallet-search/wallet-cache write activity is expected recovery (previously silent 42P10 no-ops), not regression — none observed misbehaving.
- This run could push (creds present in the sandbox for the first time since ~05-31). If this persists, Q7 (NO-PUSH root cause) may be resolved infra-side — watch the next scheduled run before closing Q7.

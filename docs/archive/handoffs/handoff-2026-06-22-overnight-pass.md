# RPC nightly autonomous pass — 2026-06-22

**Mode:** GENUINE OVERNIGHT (fired 08:02Z / 01:02 PDT, in-window). **Push AVAILABLE.** Sandbox clone `$HOME/rpc`. `origin/main` `6a386b2` unchanged start→end (no active human pushing; no commits in the 90 min before the ship). Lock taken over (prior marked RELEASED, ~24h stale).

**Shipped 1 (verified PASS) · reverted 0 · repaired 0 artifacts · closed 3 · Sentry resolved 1.** Drained 6 inbox files (06-21 15:16Z → 06-22 06:05Z).

**Git env note:** the documented `/tmp` uid-squash hazard recurred — `git clone` to `/tmp/rpc` left it owned by `nobody:nogroup` (uid 65534) while the shell runs as uid 1254, so every write hit Permission denied. Re-cloned to `$HOME/rpc` (owned by the session uid, writable, push-capable), per the 2026-06-16 precedent. Recommend the git-setup doc target `$HOME/<dir>`, never `/tmp`.

---

## Headline

The 06-22 monitor's primary finding — **REFRESH-SPECIAL-SERIAL-OWNERS-MV pg_cron first tick FAILED** (120s statement-timeout cancelled the `REFRESH … CONCURRENTLY` at 04:13Z) — is **DURABLY RESOLVED**, but **NOT via the monitor's proposed fix**. Independent measurement **disproved** the monitor's Fix-A hypothesis ("drop CONCURRENTLY → ~30-60s"): the underlying view query `topshot_special_serial_owners` is **itself ~113s** (lock-free EXPLAIN ANALYZE), so a plain refresh would be ~114s — still marginal and would fail again at the 16:13Z daytime tick under load. The real root cause is a **catastrophic planner misestimate**: a Nested Loop over ~10,888 canonical TS editions, each doing a wmc index scan that fetches ~138 non-special serials before filtering. Forcing a hash join (`SET enable_nestloop=off`) collapses the query **112,699 ms → ~3,500 ms (~30x)**. The fix therefore KEEPS CONCURRENTLY (no read-blocking AccessExclusive lock) and the refresh now completes ~34x under the 120s ceiling.

This is the genuine durable resolution of an item that was prematurely marked "CLOSED" on 06-22 (the self-log fix only changed how the failure was logged; the pg_cron path then hit a *different* 120s cap — the session-default `statement_timeout`, which the fn's proconfig `200s` cannot re-arm mid-command).

---

## SHIPPED — `audit_20260622_refresh_special_serial_owners_mv_force_hashjoin`

**What:** `CREATE OR REPLACE FUNCTION public.refresh_topshot_special_serial_owners_mv()` adding a single planner setting `SET enable_nestloop TO 'off'` (+ defensive `REVOKE EXECUTE … FROM PUBLIC, anon, authenticated; GRANT EXECUTE … TO postgres, service_role;`). All other attributes preserved verbatim: SECURITY DEFINER, `search_path='public','pg_temp'`, `statement_timeout='200s'`, `REFRESH MATERIALIZED VIEW CONCURRENTLY public.topshot_special_serial_owners_mv`, and the `log_pipeline_run` self-log in both the success (ok=true) and `EXCEPTION WHEN OTHERS` (ok=false) paths.

**Why it works:** unlike `statement_timeout` (armed once at top-level command start, so the fn-entry proconfig can't re-arm it — the cause of the 120s failure), planner GUCs like `enable_nestloop` are read at PLAN time of each statement. The REFRESH's inner view-query is planned during function execution, after the proconfig SET takes effect, so it now plans as the hash join. Result correctness is unaffected (join-algorithm choice only; verified the off-plan returns the same 6,783 unique rows as the on-plan).

**Verification (independently confirmed by a fresh no-context subagent — VERDICT PASS, all 6 checks):**
- `pg_get_functiondef` shows `SET enable_nestloop TO 'off'` present + SECDEF + search_path + `statement_timeout='200s'` + CONCURRENTLY + self-log (both paths) preserved.
- ACL = `{postgres=X/postgres,service_role=X/postgres}` (no anon/authenticated/PUBLIC).
- `check_secdef_anon_execute_violations()` = `[]`; `check_public_security_invariants()` clean.
- `EXPLAIN (ANALYZE) … SELECT * FROM topshot_special_serial_owners` with `enable_nestloop=off` → **Hash Join, Execution Time ~3,100–4,100 ms** (vs the on-plan Nested Loop at 112,699 ms).
- **Force-ran the exact cron path** `SELECT public.refresh_topshot_special_serial_owners_mv()` TWICE (once by this pass, once by the verifier): both logged `pipeline_runs` rows `ok=true`, `logged_by='fn'`, `error=null`, `duration_ms` **3540 / 3516** (~3.5s).
- MV freshened **6,778 → 6,783 rows** (the ~1.7-day staleness from the failed ticks is cleared).

**Revert:** `CREATE OR REPLACE FUNCTION` back to the prior body (identical, minus the `SET enable_nestloop TO 'off'` line). Exact prior body captured in the ledger Shipped entry.

**Target metric (re-check tomorrow):** the next scheduled pg_cron tick `rpc-refresh-special-serial-owners-mv` at **16:13Z 2026-06-22** logs a `refresh-special-serial-owners-mv` `pipeline_runs` row `ok=true` with `duration_ms` in the low single-digit thousands; `cron.job_run_details` status='succeeded'; MV stays fresh; `ts-backfill-drain-serial-fmv-watch` stays quiet.

---

## Post-ship regression watch (changes shipped in the last ~24–48h) — ALL PASS, 0 reverts

- **06-21 TS mis-attribution closeout** (`f796447`/`f908c83`/`6b9e89a` + 7 `audit_20260621_*` + `d240fb85` drain cron): conflation guard **17** (converged 44→27→17, NOT rising), `ts_uuid_dupes_created_24h` **2/200**, sentinel hyphen-48h **24/250**, FMV reconciles. PASS.
- **06-21 thin-data deal flag** (`498790cd` + 2 migrations): `topshot_thin_fmv_editions` **96**, `topshot_deals_vs_fmv` **526 / 10 low_confidence_fmv**, `cross_collection_deals_board` **687**. Matches CC's figures exactly. PASS.
- **06-21 pack-sniper wave** (`0f19da4`/`962fc0b8`/`bc3b01c`/`f095f60`): `snapshot-pack-asks` **106 runs / 0 fails / 24h, watchlisted=true**, `pack_ask_state` **2,882**. PASS. (SNAPSHOT-PACK-ASKS-WATCHLIST candidate satisfied — already watchlisted.)
- **06-22 `next` 16.1.6→16.2.9 security bump** (`d54f66c8`): prod READY, 0 new Sentry, security 0/0/0/0 (proxy-bypass CVE class opened no anon-write hole). PASS.
- **06-22 concierge model revival** (`f6ee7d47`, CRITICAL — concierge dead 7d from the 06-15 model retirement): prod READY (below `f27bb70`), no support-chat Sentry. PASS. (A live authed round-trip couldn't be exercised from this session; the model swap is live + 0 new errors.)
- **06-22 pack-reality intro median** (`f27bb70`): current prod READY, cosmetic. PASS.

---

## Health-drift triage + overnight deltas (vs metrics-latest 2026-06-21)

GREEN across the board.

- **Security:** 0 RLS-off base tables · 0 anon/auth-write on RLS-off base · `check_public_security_invariants()` [] · `check_secdef_anon_execute_violations()` []. (The unfiltered anon-write query false-positives on 58 *views*; with `relkind IN ('r','p')` → 0.)
- **Pipelines:** `detect_stalled_pipelines()` [] · `get_pipeline_alerts()` [] (cleaner than last night's 1 INFO). 24h fails = 13, all transient/known: analytics-smoke ×5 (residual, quiet since 17:43Z 06-21), evm-transfers-ingest ×5 (Base-429 benign STEER), check-alerts ×1 @07:15Z (isolated stmt-timeout, 1/24h — noise), refresh-special-serial-owners-mv ×1 @06-21 09:13Z (**stale pre-fix route row**, predates the pg_cron move), wallet-backfill-ufc ×1 (Flow-429 transient).
- **Trust health: 9/9 ok** (edition_integrity 4/50, fmv_sanity 0/1, offer_edition_gap $0/50, pack_ev_board_stale 0.72d/2, pack_ev_depleted 0/30, pinnacle_ask 0.1h/3, pinnacle_fmv 22.2h/30, ts_uuid_dupes 2/200, unmapped_backlog 23/100).
- **FMV (fmv_current latest-per-edition):** TS HIGH+MED **4,328** (1206+3122) ↑ from 4,247 baseline; AllDay HIGH+MED **891** (254+637) ↑ from 874. Reconciles: TS sum 17,316 vs 17,318 editions (gap 2 = freshly-cataloged `::` parallels awaiting first snapshot, benign); AllDay 6,191 = 6,191 exact.
- **Editions:** TS 17,318 (15,543 + 1,775 `::`) / AllDay 6,191 / Golazos 581 / UFC 446 — flat.
- **Sentinel** hyphen-48h **24/250** (only 2 new/24h per trust; inert + suppressed). **DB 5,090 MB** (+67 over ~1.5d vs 5,023 — benign creep). **conflation 17** (was 27 at the 06-21 baseline — continued convergence).
- **Sentry:** was 1 unresolved (NEXTJS-1C, smoke RLS-leg, cause-fixed 16:13Z 06-21, quiet 16h) → **RESOLVED tonight** (regression-armed) after independently verifying security clean. 0 others.
- **Vercel:** 20 recent deploys, **0 ERROR**; current prod `f27bb70` READY (includes the concierge revival + next bump + pack-sniper wave below it).
- **Artifacts:** 16 enumerated, 2 intentional tombstones (`pack-drops-ev-check`, `rpc-ts-data-mission` — 06-22 Cowork asset audit), none flagged broken. HTML on OneDrive is outside this run's mount (MONITOR-ARTIFACT-ACCESS); the monitor validated all backing objects return rows at 06:05Z. Tonight's MV fix changes no schema, so no artifact repair was needed; any special-serials-backed artifact now shows fresher MV data (6,783 rows).

---

## Closed tonight

- **REFRESH-SPECIAL-SERIAL-OWNERS-MV-TIMEOUT** — DURABLY RESOLVED (see Shipped). The prior "CLOSED 2026-06-22 (self-log)" was insufficient — the pg_cron path hit the session-default 120s cap. Tonight's plan fix makes the refresh ~3.5s, eliminating the timeout entirely. (Target metric watch: 16:13Z tick logs ok=true.)
- **SNAPSHOT-PACK-ASKS-WATCHLIST** — satisfied; `snapshot-pack-asks` is already `watchlisted=true` (operator added it between monitor ticks; 106/0/24h).
- **PACK-SNIPER-INSIGHTS-QA** — read-only rpc-insights-qa run on `/insights/pack-sniper`: **clean pass, no CC gap.** Sitemap ✓ (line 317), OG route ✓ (1200×630), param-stripped self-canonical ✓, `/api/og/*` + `/insights` anon-public ✓, 0 hardcoded `#E03A2F` in client+layout ✓, hydration-safe freshness chips (mounted-gated `relTime`) ✓, backing `pack_ask_state` RLS-on (no invariant trip) ✓.

## Carried / queued (unchanged — all off-limits / operator / CC, not night-pass-shippable)

refresh-conflated-editions cron (operator wire daily — note: conflation+thin-FMV guards already refresh via pg_cron `rpc-refresh-thin-fmv-guard`); BUYERBF-PERINVOCATION-WORK; ALLDAY-V1-UNMAPPED-DRIFT (23/100 backlog, trust-green); UFC-EDITIONS-SEED-GAP; TS-WMC-UUID-FOSSILS (inert/suppressed); N1 snapshot-institutional-wallets; BADGE-CATALOG-CRONJOB-DUP; VERCEL cost family; A1-WORKER-PASSTHROUGH-CLEANUP; get_user_top_owned_moments 3-arg orphan; PIN-FMV-REKEY-WAVES 2/3; PIN-SYNC-CRON; P3-BUYERS; DUPE1; Q2/Q5/Q6; ANALYTICS-SMOKE-RESIDUAL; IPFS ×2. **STEER honored:** SERIAL-FMV-MULT-CRON BY DESIGN (weekly pg_cron); evm-429 benign; allday-listing-serial-backfill 1009 WAF (external, not a code bug).

## Failed / blocked / auto-reverted

None. No verification failure; production shipping was not hard-stopped.

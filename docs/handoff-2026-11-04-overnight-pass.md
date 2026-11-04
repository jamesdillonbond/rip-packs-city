# Overnight pass — 2026-11-04 (~1:05 AM PT)

**Session:** Cowork cloud, laptop-VM clone + `.rpc-git-cred` push route. **Verdict: GREEN. 0 production shipped, 0 reverted.** Genuine overnight run (fired 09:03Z = 1:03 AM PT, inside 00:00–06:00). Clock no-skew (shell `date -u` 09:02:53Z ≈ DB `now()` 09:05:15Z ≈ newest `sales.ingested_at` 09:03:09Z). Push AVAILABLE (dry-run authenticated). Not frozen. Lock was RELEASED + ~23.8h old → took over.

Nothing was both low-risk and completable to ship this pass. The one notable finding (the #228 cold-whale timeout recurring from real users) is not autonomously shippable — its documented next lever is route/edge work — so it is QUEUED for Trevor/Claude Code.

## What was reviewed

- **CLAUDE.md** in full + continuity state (ledger, newest handoffs, metrics-latest.json, focus.md top steers).
- **Git safety:** confirmed the fresh clone is on the clean POST-privacy-purge history — the six dangerous pre-rewrite SHAs (`7911619 557f4cc d5ae01a d25b79f 0cdf84c 6d51ed4`) are all ABSENT from this clone. `origin/main` = `16dce1389` at run start; it did not advance during the pass (no concurrent pusher).
- **Inbox — 2 new filings since the last pass (11-03 09:07Z), BOTH already fully dispositioned by the 11-03 evening Claude Code session; no action owed:**
  1. `2026-11-04T0410Z` (#228 collection-snapshot timeout recurred, watch falsifier tripped) → the evening session re-measured, attributed the 5:53 PM PT trip to its own surface-sweep subagent, falsified the "planner picks the old index" hypothesis, and shipped a further STALE-only reduction (`20261104042335`, 86.7k→54.0k buffers). Watch restated.
  2. `2026-11-04T0611Z` (measurements owed after SQL was blocked) → ALL four reads taken 11-03 ~10:55 PM PT: sniper NULL-series incidence 0 (fix was preventive), index swap NOT run (stays Trevor's click — destructive), #228 watch (as of then) not tripped, writer-side `?? 0` no measured incidence (`trg_sales_coerce_zero_serial_to_null` already lands serial-0 as NULL; 0 zero-price writes in 90d). The only residual actionable — the staged `DROP INDEX`/rename — is OFF-LIMITS (destructive) and stays Trevor's click.
- **Inbox left UNTOUCHED** (append-only); dispositions recorded here only.

## Section 2 — health-drift triage

**FAST BASELINE — `rpc_ops_snapshot()` (09:05Z):**
- **Security: fully clean** — `invariants []`, `anon_write_holes []`, `rls_off_base_tables []`, `secdef_anon_violations []`.
- **Trust health: 0 breaches, all 40 legs ok.** Notable legs: `candy_sales_stale_hours` 557.7 (<1114.9, climbing by design → re-verify candy_mlb row ~11-27); `edition_integrity_flags` 22 (<250); `panini_coverage_pct_drop` 5.9 (<15); `panini_fmv_stale_hours` 0; `trust_precompute_max_age_hours` 5.29 (<13); `fmv_sanity_flags` 0.
- **Structural: all clean** — `stalled_pipelines []`, `wmc_null_edition_key []`, `backward_cursor_rewinds []`, `function_search_path_drift []`, cross-collection mat staleness [], suppression drifts []. `sentinel_ts_uuid_editions_48h` 0, `ts_uuid_dupes_created_24h` 0.
- **pipeline_alerts:** 4 rows, ALL `info`/designed — the four Atlas upstream-403 lanes (editions/market/pack-supply/pack-book). Each is a Cloudflare challenge at the documented ~5–15% base rate; every lane's last-200 is fresh at 09:05Z and none meets its escalation condition. Not findings.
- **pipeline_fails_24h:** all `upstream:0` designed noise — `atlas-pack-market` 19, `atlas-market-feed` 7, `topshot-pack-supply-atlas` 6, `gha-schedule-watchdog` 6, `member-wallet-usernames-atlas` 2, others ≤1. **gha-schedule-watchdog confirmed healthy** — its last 8 runs are all `ok=true`, `verdict:"delivering"`, `gha_schedule_stalled:false`, `cadence_breach_count:0`, `instrument_broken:false`; the 6 fails are historical/self-healed.

**Vercel:** production last READY = `dpl_GguSfdrjt61dhwCQpfvT5UKs8MFi` on **`16dce1389`** (= current tip = clone HEAD = origin/main). The ~10 newer-looking CANCELED deploys are the expected docs-only rapid-succession supersessions. 24h runtime errors = 3 groups, two chronic/graceful-degradation (`ipfs-media` body timeout count=5 last 11-03 21:51Z; `pack-detail/allday_pack_lifecycle` count=1 last 11-04 03:53Z) and the #228 group below. No NEW crash group. Sentry dark (#34); `client_error` beacon clean.

**POST-SHIP REGRESSION WATCH (done first):**
- **#228 collection-snapshot cold-whale timeout — RECURRED from a real user; do NOT revert.** `RPC_READ_TIMEOUT` on `/api/collection-snapshot`, group count 8→9, **last = 2026-11-04T08:32:27Z (12:32 AM PT)**. The 11-03 evening watch restarted the falsifier at "a non-session RPC_READ_TIMEOUT after 8:30 PM PT 11-03"; this hit is after that and before this session began (09:03Z), so it is a non-session caller. Runtime log confirms it: `GET /api/collection-snapshot`, `domain=www.rippackscity.com`, production, dep `dpl_GguSfdrjt61dhwCQpfvT5UKs8MFi`, and the honest error path fired (`code=timeout detail=RPC_READ_TIMEOUT … read exceeded 8000ms`) — an honest 503, NOT a crash and NOT fabricated data. **This is a latency ceiling, not a regression:** the two SQL reductions (`20261104013841` cover index, `20261104042335` STALE-only conf) materially cut buffers (75k→45k→54k paths) and are correct; the documented next lever is a CDN warm of the top wallets (#228 lever b), which is route/edge work. Do not revert; see QUEUE.
- All other 11-03 ships (the "Unknown"-subject code fixes, Pinnacle set-name recovery `20261104043706`, site-search `20261104044435`, error-sentinel player `20261104045324`, player-minter guard `20261104050155`, #228 follow-up) show no regression signal: baseline `fmv_sanity_flags` 0, `edition_integrity_flags` 22 (<250), 0 new trust breaches, and the current tip deploy is READY with no new error group.

**Panini throughput (carried queue):** FMV fresh — newest Panini `fmv_snapshots.computed_at` 08:46Z 11-04; `panini_coverage_pct_drop` 5.9% (<15); editions 40,217 (+61 vs last night). The 11-03 fresh-tab-runner fix (`8a143a3`) restored walk throughput (verified ledger 11-03: ~1,000+ cards/run, 1,300+ new sales in 2h). The old-catalogue backlog drain is OFF-LIMITS (laptop Task-Scheduler env + ingest route-logic = Claude Code/Trevor); instruments green, carried forward.

**Overnight deltas vs metrics-latest (11-03):**
- db_size_mb 44,715 → **45,263** (+548; within ±1.3 GB band — `net._http_response` sawtooth; no public table crossed 200 MB between passes).
- FMV HIGH+MED: nba 6,604→**6,663** (+59); panini 18,001→**18,027** (+26); nfl 1,645→**1,672** (+27); pinnacle 904→**925** (+21, recovered); candy 68→**63** (−5); golazos **1** flat; ufc **0** flat.
- editions: nba 14,600→**14,682** (+82); panini 40,156→**40,217** (+61); nfl 6,190 / golazos 575 / ufc 617 / candy 125 flat.
- trust breaches 0→0; 0 stale/sanity flags. Normal churn.

## Shipped
None. Quiet healthy night.

## Needs your decision (QUEUE)

1. **#228 — `/api/collection-snapshot` cold-whale timeout now recurring from REAL users on consecutive days (11-03 5:53 PM PT and 11-04 12:32 AM PT) after the two SQL reductions.** The behavior is an honest 503 on the largest cache-cold wallets (~1 hit/day, ~63k+-moment wallets), not a crash or fabrication. The SQL lever is exhausted (the 11-03 disposition: "the lever is CDN warm, not more SQL"). **Ready next step: CDN warm of the top N wallets (#228 lever b)** — route/edge work, OFF-LIMITS for the autonomous pass. Alternatively accept ~1 honest-503/day as within tolerance. Your call.
2. **Staged destructive index swap — `docs/proposals/wmc-snapshot-cover-index-swap-STAGED.sql`** (drop the 342 MB subset `idx_wmc_wallet_coll_ek_fmv_tier`, rename the 259 MB cover `idx_wmc_wallet_coll_ek_snap_cover` onto its name). Both valid; the planner always picks the cover now, so this is pure hygiene (frees ~342 MB + one index-maintenance per wmc write). It raised the Supabase MCP destructive prompt twice (unanswered). Run each statement ALONE (dashboard SQL editor or `execute_sql`). Still your click.
3. **Panini old-catalogue backlog drain** (carried, night 3): throughput restored 11-03, FMV fresh, coverage 5.9% drop (ok). Drain depends on the laptop Task-Scheduler env (`PANINI_SERIAL_PAGES`/walk budget) + possible ingest route-logic (OFF-LIMITS). Claude Code/Trevor.
4. **saved_wallets username root-cause code fix** (carried; handoff `2026-11-02-saved-wallets-username-address-path`): the resolve-and-associate address branch hard-nulls username; 21 existing null rows already backfilled. Claude Code.

Long-standing, one line each: `#58 OPENSEA_API_KEY` (P2, Trevor; candy re-verify ~11-27) — secret, no sandbox lever. `panini-ingest-enum max_silent_minutes` (738) recalibration — OPTIONAL, low value. `topshot-active-listings-ingest egress_blocked` — backstop shipped 11-01, ages out, monitor.

## Failed / blocked / reverted
None. No production shipping attempted; no hard-stop triggered.

## Continuity
Ledger: GREEN entry spliced at the first `^### `. metrics-latest.json overwritten with tonight's values. Session entry prepended to `docs/sessions/2026-11.md`. Inbox untouched (append-only). Lock marked RELEASED on exit.

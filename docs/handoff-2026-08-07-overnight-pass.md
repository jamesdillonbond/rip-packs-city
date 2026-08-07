# RPC nightly autonomous pass — 2026-08-07 (OFF-HOURS / monitor-mode)

**Mode: OFF-HOURS → MONITOR-MODE (queued, shipped nothing).** The task fired late — real local
time at run start was ~07:57 PDT (14:57Z), outside the 00:00–06:00 overnight window. Clock verified
NOT skewed: shell `date -u` 14:56:50Z ≈ DB `now()` 14:57:01Z ≈ max `sales.sold_at` 14:51Z ≈ max
`fmv_snapshots.computed_at` 14:56:59Z. Per the quiet-hours guard, this run did the full review +
health triage + post-ship watch and QUEUED everything it would otherwise ship. Auto-reverts were
permitted but none were needed. Push was AVAILABLE (`git push --dry-run` up-to-date); it just wasn't
used to ship code.

Shipped 0 · reverted 0 · repaired 0. A quiet, honest morning: the CC/interactive wave of 08-06→07
is healthy, the one 08-06 HIGH inbox item (rollup `jsonb_object_keys`-on-array failure) was already
fixed and is confirmed cleared, and every open finding is either operator-owned, already handed off,
or a documented do-not-re-flag class.

Sandbox note: the recurring "no space left on device" on `/sessions` (~1GB, 90% full) recurred — the
clone went to `/tmp` (root fs, 4GB) as prior runs documented; git otherwise fully functional.

Concurrency note: an active **RPC Daytime Monitor** run pushed its 14:58Z inbox candidate
(`84cba78b`) DURING this pass, and a concurrent CC session landed fmtDollars-dupe fixes
(`ea9ed693`, `dc61d0a5`). origin/main advanced 401624ca → dc61d0a5 → ea9ed693 → 84cba78b mid-run.
This independently reinforced queue-only for the night. Rebased onto `84cba78b` before writing these
outputs; folded the monitor's 14:58Z candidate into the queue below.

---

## Post-ship regression watch — 08-06→07 CC/interactive wave: ALL PASS, 0 reverts

Changes shipped in the last ~24–48h (all by CC / interactive sessions; no 08-06 overnight pass ran)
and their re-measured state:

- **`rollup_pipeline_runs()` shape-defensive fix** (migration `20260806031249_audit_20260806_rollup_pipeline_runs_shape_defensive_extra`, commit `38d91194`) — the 08-06 HIGH inbox item (`cannot call jsonb_object_keys on an array` aborting the whole daily rollup, opening a permanent hole in the only indefinite pipeline history). **CONFIRMED RESOLVED:** `check_pgcron_recent_failures()` = `[]`; `pipeline_runs_daily` now has 129 rows for `current_date` (2026-08-07) and `max(day)` = 2026-08-07. The rollup is current again. The concurrent monitor independently confirmed the same.
- **Edition-read RPC statement_timeout caps** (`c9aa9d6e` + migration `20260806013247_audit_20260805_cap_edition_read_fn_statement_timeout`, scraper/pooler incident hardening) — the entity-page Sentry cluster is stable/easing: 3 unresolved (NEXTJS-1Z pack 5 users, 1Y team 1, 24 set 1), down from 6 at the 08-06 evening tick; **0 new issues first-seen in 24h**; no new class. `public_board_slow_count`/`_empty_count` both recovered to 0 (the 999/999 budget-exhaustion pair on 08-06 was scraper-incident collateral, now eased).
- **`get_wallet_collection_stats` fmv_current-scan drop** (`20260806020844`) + **`get_wallet_moments` TopShot series-convention** (`20260806024616`) + dashboard/profile/packs honest-stats wave (`38d91194`) — all 4 recent migrations verified live in `supabase_migrations.schema_migrations`. No regression: the wallet-backfill failure rows in `pipeline_runs` are the pre-existing pooler-timeout / Flow-script class, not new.
- **fmtDollars negative-handling** (`3ccf476e` shared + `ea9ed693` page-local dupes), a11y dropdowns (`565bc795`), RTR Lock-ROI copy (`e36fc95a`), NaN limit/offset guards (`401624ca`) — cosmetic/guard-only, no runtime regression signal.

Vercel: current production = `401624ca` (READY). The two newest deploys (`ea9ed693` fmtDollars-dupes,
`84cba78b` monitor docs-only inbox) show state **BLOCKED** — this is supersede-during-rapid-push
behavior (the monitor commit is docs-only and `ignoreCommand`-skipped regardless), NOT an error
state; no ERROR-state deploy in the last 20. Nothing to revert.

---

## Section 2 health-drift findings + deltas

**Security: fully clean.** `rls_off_base` 0 · `check_public_security_invariants()` 0 rows ·
`check_secdef_anon_exec_drift()` [] · `check_anon_write_surface()` 0 rows · anon/auth write-holes 0.

**Pipelines:** `detect_stalled_pipelines()` = 2 info-level (`candy-offers-indexer` 62h,
`panini-ingest` 37.7h — both queued below). `check_pgcron_recent_failures()` = []. `pipeline_runs`
187 ok=false/24h, ALL documented classes: `topshot-pack-opens-history-backfill` 68 (wedge, handed
off `8d01cc61`), wallet-backfill-* pooler-timeout/Flow-script noise, `wallet-username-resolver` 12
(queued), `lock-check-batch`/`allday-lock-refresh` timeouts, `sync-nba-projections` (off-season),
`topshot-active-listings-ingest` (egress_blocked). No new defect class.

**Sentry:** 3 unresolved (entity-page statement-timeout class), 0 new in 24h. Documented saturation
collateral; real fix is edge rate-limiting the scraper (operator, Vercel Firewall).

**Trust health — 4 BREACH, all covered:**
- `panini_fmv_stale_hours` 37.7 (breach_at 36) — **NEW; = the Panini home-box runner being dark ~37.7h** (moves with the `panini-ingest` stall). Operator + a queued config-only severity bump. See queue.
- `panini_sale_price_capture_dry_days` 9 (breach_at 3) — documented upstream capture outage, mechanism needs a live A/B on the runner box (interactive). Carried.
- `ufc_fmv_stale_hours` 80.5 (breach_at 30) — RED BY DESIGN since UFC market closed 2026-05-13; decision owed to Trevor (retire-or-rebase). Carried, do NOT raise breach_at.
- `unmapped_resolution_backlog_max` 175 (breach_at 100) — documented continuously-replenished permanent-class floor. ⚠ Climbing 105 (08-05) → 127 (08-06) → 175 (08-07): a 3-day rise, not draining. Still the known class, but if it keeps climbing the resolver-failure-REASON investigation should be pulled forward. Carried.

**Overnight deltas vs metrics-latest (2026-08-05):**
- FMV HIGH+MED: TopShot 6800 → **7112** (+312), AllDay 1586 → **1713** (+127), Golazos 3, UFC 0 (by-design), Candy 74. Sweep healthy: `fmv_sweep_stall_pct_24h` 4.4 → 4.2, `fmv_sweep_wedge_hours` 0.25 (ok).
- editions: TS 19581 → 19666, AllDay 6190, Golazos 575, UFC 518, Candy 125.
- DB size 12108 → **12368 MB** (+260).
- `edition_integrity_flags` 97 → 113 (ok, breach_at 250) · `fmv_sanity_flags` 0 · `public_board_slow_count` 7 → **0** (999-pair recovered) · `sales_serial_supply_worst_pct` 0.33 → 0.0.
- `ts_uuid_dupes_created_24h` 0 (dupe-writer clean).

**Artifacts:** monitor reported 11 active + 2 newer; all shared backing views
(`rpc_ops_snapshot`, `v_rpc_trust_health`, cross-collection mats, `public_board_liveness` 0 errored)
read clean — no schema-break signal, no repair needed. Not touched (off-hours; fresh-on-open).

---

## Queued (nothing shipped this off-hours run)

### NEW this run

1. **Panini home-box runner dark ~37.7h → public board serving stale FMV.** `panini-ingest` last ran
   2026-08-06 01:21Z; `panini_fmv_stale_hours` = 37.7 BREACH. `/insights/panini-squeeze` is PUBLIC
   since 2026-08-01, so this is now a user-facing freshness stall. **Two parts:**
   - **(a) Operator (Trevor):** the residential Windows Task-Scheduler box (5th scheduler, fires every
     4h on 01/05/09/13/17/21 UTC) needs to be awake/online — his machine, not a code defect.
   - **(b) Config-only, ship-eligible on a normal overnight run (QUEUED here only because off-hours):**
     raise the `panini-ingest` watchlist severity `info` → `medium` now that the board is public — the
     watchlist row's OWN note says *"RAISE TO medium/high AT PANINI GO-LIVE"* and go-live was 6 days
     ago (verified live: row exists, severity still `info`). Monitoring-config only; no FMV/ingest/
     auth/wallet surface. **Ready SQL:** `UPDATE public.pipeline_cadence_watchlist SET severity='medium' WHERE pipeline='panini-ingest';` **Revert:** set back to `'info'`.

2. **`candy-offers-indexer` Vercel cron silent ~62h** (last run 2026-08-05 00:50Z, `50 */6 * * *`).
   The cron entry STILL EXISTS in `vercel.json` (path `/api/ingest/candy-offers`; 35 crons total), so
   it is registered but not executing — the route is likely erroring pre-log, or Vercel isn't firing
   it. LOW: best-offer/bid signal only, NEVER FMV (`fmv_snapshots` untouched; ask/sales/FMV legs all
   fresh). But it may now be user-facing via the public `/insights/candy-mlb` **Spread** tab
   (`candy_offer_spread_board` / `candy_best_offers`), so its ~62h-stale bid data could be showing.
   **Operator action:** hit the route once with `INGEST_SECRET_TOKEN` to see whether it 200s or errors;
   if the Spread tab is genuinely user-facing, raise the `candy-offers-indexer` watchlist severity off
   `info`. Not autonomously fixable (needs the auth token + a route probe).

### Carried

- **`wallet-username-resolver` 33.9–46% statement timeout** — profiled 08-05 to a heavy 21-day
  re-aggregation selector; no low-risk additive fix (covering index already exists). Levers: operator
  cadence-cut (~20min → hourly, negligible freshness cost on a 14-day-negative-cached @handle nicety)
  or a code RPC watermark rewrite (live-function replacement, needs tests). Night-count 3.
- **`topshot-pack-opens-history-backfill` wedge** — fully diagnosed, handoff `docs/handoff-2026-08-07-pack-opens-history-backfill-wedge.md` (`8d01cc61`). A spork-routed Deno edge fn hard-wedged on a persistently-transient leading chunk `[61808596,61808845]` (`status 0`); Option A (adaptive sub-chunking, safe) / Option B (operator decision). Unverifiable from the cloud sandbox (Flow/spork egress proxy-blocked) → operator/CC. Sentinel already pages it. Night-count 1.
- **`unmapped_resolution_backlog_max` climbing 105→127→175** — documented permanent-class floor; fix is a resolver failure-REASON + exclude-by-reason, not a threshold. Pull the resolver-reason work forward if it keeps climbing.
- **`ufc_fmv_stale_hours` red-by-design** — Trevor decision owed: retire-or-rebase the arm (do NOT raise breach_at). Precedent: the ufc_sales CRITICAL arm was suppressed 2026-08-02 for the same reason.
- **`panini_sale_price_capture_dry_days` = 9** — upstream capture-mechanism outage since 07-29; needs a live A/B across listType values on the runner box (interactive). Do NOT install a mechanism guess in the arm text without that A/B.
- **FMV-RECALC-MAXDURATION 300 → 800** — DE-PRIORITIZED; sweep-stall fell to ~4% and holds. Only worth it if kills re-elevate.
- **`topshot_flowty_backfill` cursor_stalled false positive** at `SPORK_FLOOR_HINT` — LOW/cosmetic.
- **Standing queue** — edge-orchestration, non-wave wallet driver, DUNE seller-recovery inert, chain-two gated.

### Observation (no action)
- The two newest Vercel prod deploys are BLOCKED (supersede-during-rapid-push, not an error);
  production is `401624ca` READY. If Trevor wants `ea9ed693` (fmtDollars page-local dupes) live, any
  non-docs push will carry it forward. No harm in the meantime (cosmetic display fix).

---

## Failed / blocked / reverted
None. Nothing shipped, nothing errored, nothing rolled back. Shipping was never started (off-hours).

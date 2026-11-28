# Overnight autonomous pass — 2026-11-28 (~01:00–02:00 AM PT)

> ⚠ **Environment scope:** this run is a **Cowork cloud** session. **Cloud git push is DENIED** for this scheduled
> session (repo not in its authorized set; no `add_repo` tool) — this pass pushed via the **laptop-VM route**
> (`$HOME/rpcwork` clone + `.rpc-git-cred` store). **This blocker is specific to this cloud session. Trevor's machine
> and Claude Code push normally via Git Credential Manager — commit/push as usual there.** No FREEZE. Lock was
> RELEASED (prior `rpc-nightly` 62039fb4b, 11-27 OFF-HOURS monitor), taken over.

**Mode:** genuine overnight (real time 01:0x AM PT; clock no-skew — shell 09:02:24Z vs DB `now()` 09:02:42Z vs newest
sale 08:32Z / newest FMV 08:53Z all agree). Normal shipping allowed. VM `/sessions` disk healthy again (5% used; the
11-26/27 disk-full push blocker is gone).

## Verdict

**GREEN · 0 shipped · idle: routed-to-claude-code · oldest routed: Held DELETE 384 TS same-tx twins — 2 nights.**

Nothing was clearly-safe **and** overnight-eligible to ship. The one trust breach (`public_board_slow_count` = 1) is a
load-correlated transient on the hour-aliased board probe that will clear at the next quiet-hour sweep; its only real
fix is off-limits view/route logic (queued). Every other actionable item is route logic in a file committed <48h ago
(queued to Claude Code) or an attended-only held DELETE (MCP write-hold). A quiet, honest night.

## What was reviewed

- **Inbox** (through `inbox/INDEX.md`, filings since the 11-27 pass): `2026-11-28T0713Z` nba-espn box-score 404
  (NEW — queued, route logic), `2026-11-27T2213Z` pg_net 401 flowscan (NEW — nil blast radius, queued LOW),
  `2026-11-27T0125Z` held DELETE 384 TS twins (carried, attended), `2026-11-27T1532Z` candy-wallet-refresh &
  `2026-11-27T0107Z` candy set-progress (both CLOSED per focus.md:15/16). No inbox filing moved/edited (append-only).
- **ready-queue** (`node scripts/report-ready-queue.mjs`): 5 items from the 11-27 handoff. Items 1–3 (candy-wallet-refresh,
  candy-set-progress, candy-edition-holders MV) ruled CLOSED by focus.md:14–16 — not re-carried. Item 5 (two stale
  zero-yield suppressions) is **actually closed** — applied 11-26 as `20261126161804` per its own filing's drain
  section (the ready-queue `✓ ledger.md:743` pointer was a FALSE match: line 743 is the unrelated Panini-soccer entry).
  Dropped. Item 4 (384 TS twins) remains open.
- **focus.md** overnight reads (see Health).

## Health-drift findings (rpc_ops_snapshot @ 09:04:41Z; drilled where flagged)

- **Security:** all 4 arms `[]` (invariants / anon_write_holes / rls_off_base_tables / secdef_anon_violations). Clean.
- **Trust health: 42/43 ok, 1 BREACH — `public_board_slow_count` = 1.** The slow board is **`v_insights_trophies`**
  (`public_board_liveness_state`): probed **9823 ms** vs 7000 ms budget at **10:28 PM PT**, 8518 rows (not empty).
  ⚠ **State the hour:** that reading is during the tail of the documented 11-27 daytime/evening load. 14-day history
  n=56, **p50 3408 ms, p90 4491 ms, 3 over-budget** (all under load); 24h p50 6090 (load-driven). All quiet-hour
  (03:28 PT) reads sit 3000–4200 ms. Re-measured now at ~1 AM PT: `EXPLAIN (ANALYZE,BUFFERS)` **5555 ms**
  (shared hit=101451 read=5541). Dominant cost = the per-edition latest-FMV lookup across the 3 yearly
  `fmv_snapshots` partitions (8519 loops, 3.2 s I/O) + the `held` CTE Memoize over `wallet_moments_cache`
  (1429 heap fetches). **Not a structural regression, not empty, honest when slow** (Vercel confirms one user-facing
  `[insights/trophies] read exceeded 8000ms`, count 1 / 1 user / 13h at 00:34 AM PT — served as board-unavailable via
  `boardUnavailable()`, not a false empty). The arm is hour-aliased and will self-clear at the ~03:28 PT quiet sweep.
  **Queued** (below): the only real fix is view materialization / query restructure = off-limits route/view logic, and
  CLAUDE.md flags speculative board indexes as past regressions (#121) — no clean additive lever tonight.
- **stalled_pipelines** `[]`. **All drift arms** `[]` (search_path / txn-control / cursor-rewind / suppression-parked /
  suppression-count / cross-collection-mat / backward-cursor). **sentinel_ts_uuid_48h** 0, **wmc_null_edition_key** [].
- **Pipeline alerts:** 1 HIGH `candy-wallet-refresh` (CLOSED per focus.md:15 — all 6 fails were one ~125k-card wallet
  during 11-26 whale QA; no runs since; the row persists only because it pools 3 calendar days). 1 HIGH
  `flow-rest-upstream-429` (9/1805 pack-pull hydration = 0.5% public-node throttle; last ok tick current — chronic
  upstream rate-limit, off-limits: lowering p_max = cron/route). 1 MEDIUM `candy-editions-ingest` (47/267 unhydrated
  cards skipped not written — self-healing). ~10 info rows: Atlas/Dapper Cloudflare-403 base-rate + flow-rest
  moved-moment 400, all by-design, none at its freshness escalation trigger.
- **pipeline_fails_24h:** all upstream/transient/by-design — panini-collector-walk 22 (per-walk cap + usernotfound),
  candy-chain-sales 10 (Solana getSignaturesForAddress), the rest ≤5.
- **Vercel:** prod = **d409b1b1c (Fast Break launch) READY** (`dpl_6WRT7fhcGwwrY4Lu7Kiha17KqV4c`, rollback candidate).
  Newest commit 136736f03 (docs-only inbox) + 04498de (docs) CANCELED via ignoreCommand — expected, no ERROR.
  **26 runtime-error groups / 13h, all chronic read-timeout degradations** (get_edition_detail ×24 the chronic leader
  since 08-23; pack-detail legs, player/franchise top-sales, popular-on-collection), each honestly degraded. **No new
  cluster attributable to the 11-27 wave.** (Sentry dark since 08-18 (#34) — not used; health read from Vercel + beacon.)

### Post-ship watch — the 11-27 Claude Code day/evening wave (CLEAN, 0 reverts)

This pass is the first autonomous pass to see the 11-27 ~6:00–9:45 PM PT wave (Fast Break launch; Candy FMV haircut
exemption; big-spender Whale Watch lanes 958/959; Top Collector census DB + entity-top-fans cron 955/956/957).

- **Fast Break launch** (d409b1b1c + migrations `…050200/050912/051325`): prod READY; `nba-espn-projections` hourly runs
  `ok=true`. One regression surfaced and self-recovered: box-score drain fails a whole run on a single ESPN gamesummary
  404 (`2026-11-28T0713Z`, 1/24 runs in 14h, no data lost) — **queued** (route logic).
- **Candy FMV haircut exemption** (`20261128045155`): **held** — 0 rows carry `1.8.3_haircut` among 309 Candy snapshots
  computed since the 11-27 8 PM restore (newest 01:08 AM PT). No re-cut.
- **big_spender_usernames** (10-min) and **big_spender_candy_usernames** (10-min): all runs `ok=true`, no errors.
- **fmv-recalc** (20-min): all runs `ok=true`, `purge_error` null; latest `extra` stale_touch_candidates 0,
  hot_lane_editions 1, haircut_error null.
- **entity-top-fans cron** 955/956/957 (2:15/2:45/2:56 AM PT) — first runs land during/after this window; nothing runs
  the census before the 12-14 Dune cycle; no errors yet.

### FMV accuracy gate (R125, published vs what collectors paid, 7d)

- **Top Shot:** published ALL ratio **1.000**, median abs err 11.1%, within-25 78.5%; HIGH 1.000 / 10.0% / 85.7%.
  No regression (11-27 was 1.000 / 11.1% / 78.1%).
- **All Day:** published ALL ratio **1.18**, median abs err **$0.04** — the documented sub-dollar high-bias (93% of
  sales under $1; a few cents reads as a large %). Consistent with 11-27 (1.15); allday_fmv fresh 0.3h. Not a regression.

### focus.md overnight reads

- **focus.md:14 (is the afternoon load gone?)** — **YES.** pg_cron s/h: 11-28 00h = 6568 (full hour), in the normal
  overnight band; the 11-27 12h–16h peak (8,951–10,371) is gone; non_succeeded ~0 across 20h–00h. Sold-tab backlog
  drained. Close this bullet.
- **focus.md:13 (fmv-recalc 2:48 PM purge gap — did page-3000 editions reprice after the ~10 PM wrap?)** — **healed.**
  fmv-recalc every run `ok` with `purge_error` null; latest `extra.stale_touch_candidates = 0` (exactly the stale
  population the bullet worried about); all FMV staleness arms fresh (topshot/allday/candy fmv_stale 0.3h,
  topshot_fmv_pct_stale_30d 0). No manual offset run made (would rewind the cursor). Close this bullet.

## Shipped

None.

## Queued for Trevor / Claude Code

1. **[P2, attended, 2 nights] Held DELETE — 384 Top Shot same-tx twins** (inbox `2026-11-27T0125Z`). $1,841.67
   double-counted: a `topshot_marketplace` NULL-`nft_id` twin of a `dapper_chain_tx_v1` keeper, March 23–30 2026.
   Status NOT APPLIED (the `apply_migration` confirmation timed out in a headless session; a plain data DELETE is held
   for the operator and this session cannot answer it). Ready-to-run SQL + verify are in the filing under migration
   name `audit_20261127_…same_tx_topshot_twins`. **Apply via the dashboard SQL editor in Trevor's Chrome, or an
   attended `apply_migration`.** Commit the migration file + ledger after.
2. **[P3, Claude Code, 1 night] `v_insights_trophies` crosses the 7000 ms board budget under daytime/evening load**
   (trust `public_board_slow_count` breach; one user-facing `read exceeded 8000ms` at 00:34 AM PT). Quiet-hour baseline
   ~3.4 s, cold ~5.5 s, load spikes 8–11 s. Dominant cost = per-edition latest-FMV lookup across `fmv_snapshots_2025/26/27`
   partitions (8519 correlated loops) + `wallet_moments_cache` Memoize (1429 heap fetches). **Not an additive-index win**
   (an index can't collapse the loop count; CLAUDE.md #121 warns speculative board indexes regress). The real lever is
   materializing the board or restructuring the latest-FMV join — route/view logic, needs a local preflight + a BUFFERS
   before/after. Self-clears in quiet hours but recurs each daytime load. EXPLAIN evidence in this handoff.
3. **[P4, Claude Code, 1 night] nba-espn-projections box-score drain fails a whole run on one ESPN gamesummary 404**
   (inbox `2026-11-28T0713Z`). 1/24 runs in 14h, self-recovered, no data lost. The box-score drain should skip the
   404'd game and finish `ok` (a per-game error should not fail the whole lane — same honesty shape as
   "a sweep whose ok means it completed, not that its lanes worked"). Route logic in a hot file (committed <48h).
4. **[P4, read-only, 1 night] pg_net 401 on flowscan `/flow/v1/transaction` — attribute** (inbox `2026-11-27T2213Z`).
   2 HTTP 401, not attributable to the three Atlas lanes; nil blast radius (all Flow freshness current, stalled/pg_cron
   clean). Likely a self-inflicted probe; recording the probe clears the row (a write = MCP-held). LOW.

## Failed / blocked / reverted

None failed; nothing reverted. Push blocked on the cloud path only (laptop-VM route used — see scope line).

## Continuity

Ledger line spliced (2026-11-28); `metrics-latest.json` overwritten; this handoff committed + pushed via the VM route
and mirrored to the claude.ai Project. Session entry prepended to `docs/sessions/2026-11.md`. Lock released.

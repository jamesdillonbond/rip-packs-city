# Overnight autonomous pass — 2026-11-27 (OFF-HOURS monitor mode)

**Verdict line:** GREEN · 0 shipped · idle: off-hours (fired 07:21 PT, outside ~00:00–06:00 → monitor-mode, queue not ship) · oldest routed: held DELETE two stale zero-yield suppressions, 2 nights.

> ⚠ **Push scope (this cloud session only):** cloud push is DENIED — this scheduled run's authorized repo set does not include `jamesdillonbond/rip-packs-city` and a scheduled run cannot add it (no `add_repo` tool). The VM full-checkout route is blocked because the laptop Cowork VM `/sessions` disk is 100% full (inbox `2026-11-26T1936Z`). **This pass pushed via the frugal shallow-sparse-clone route** (proven to fit the ~120M headroom). **Trevor's machine and Claude Code push normally via Git Credential Manager — commit/push as usual.** An environment limitation is a fact about the environment that hit it, never about the artifact.

## Mode & gates

- **Real time:** DB `now()` 15:21:10Z, newest sale 15:18:12Z, newest FMV 15:17:14Z, shell 15:21:40Z — all within ~4 min, **no clock skew**. 15:21Z = **07:21 AM PT** → outside the overnight window → **MONITOR-MODE**: full triage + post-ship watch + inbox drain, **queue everything, ship no production change** (auto-revert of a regression would still have been allowed; none was needed).
- **Lock:** was RELEASED (prior rpc-nightly run-id 63a86f0f, pushed 565e2a375). Taken over this run; marked RELEASED at exit.
- **FREEZE:** none.

## What was reviewed

- **CLAUDE.md** read in full; continuity state (ledger top matter, `metrics-latest.json`, focus.md steers, the 11-26 overnight handoff) loaded from the fresh origin/main clone (`a50ebfca0`).
- **Inbox drained** through INDEX.md. Two filings new since the last night pass, both handled (see sweep + queue).
- **Ready-queue** (`report-ready-queue.mjs`): 3 items from the 11-26 handoff, 1 genuinely open (held DELETE suppressions). The `refresh_wmc_fmv_changed SKIP-LOCKED` row is DECLINED (leave as-is); the pinnacle-image MODULE_NOT_FOUND item is CLOSED (verified 11-26, 1 straggler only tonight).

## Health-drift triage (Section 2) — GREEN

- **Security:** snapshot arms all `[]` (invariants / anon_write_holes / rls_off_base_tables / secdef_anon_violations) AND independently via direct catalog SQL: **0 RLS-off public base tables, 0 anon/authenticated write-grant-on-RLS-off holes.**
- **Trust health:** 43/43 ok, **0 breaches**, no UNKNOWN. trust_precompute_max_age 5.56h/ok (refresher healthy). public_board_empty 0 / public_board_slow 0.
- **Stalled pipelines:** `[]`. All drift arms `[]` (search_path / txn-control / cursor-rewind / suppression-parked / suppression-count / cross-collection-mat / backward-cursor). sentinel_ts_uuid_48h 0, ts_uuid_dupes_24h 0.
- **Pipeline alerts:** **1 HIGH** (`candy-wallet-refresh`, queued below) + **1 MEDIUM** (`candy-editions-ingest`: upstream metadata fetch failed for 47/267 unhydrated cards, skipped-not-written, self-healing — re-asked next tick). The other 10 are `info`, all Atlas/Dapper Cloudflare-403 base-rate challenges + the designed flow-rest moved-moment 400; none at its freshness-escalation trigger (market feed last 200 15:21Z, newest event 15:15Z).
- **pipeline_fails_24h:** all explained — candy-wallet-refresh 5 (HIGH, queued); candy-collection-brand 5 = the by-design `no_symbol_in_document` collection (per the 11-26 Candy session, not a defect); panini-soccer-season-lines 4 = upstream ESPN 500s; candy-chain-sales 3 = upstream Solana `getSignaturesForAddress` long-term-storage query; panini-collector-walk 3 = per-walk 4-min cap + `usernotfound` (designed, re-walks); rest ≤2 upstream/transient.
- **FMV accuracy gate (once-a-pass, R125):** Top Shot `published` ALL median_abs_err 11.1% / within±25 78.1% / **median_ratio 1.000** (HIGH 10.2% / 84.7% / 1.000). All Day `published` ALL 25.0% / 51.3% / ratio 1.154 — but **median_abs_err_usd $0.04** (93% of All Day sales are sub-$1; allday_fmv fresh 0.2h): the documented sub-dollar high-bias, a tracked characteristic, **not a regression**.
- **db_size:** 59,763 → **56,725 MB (−3,038)** — reindex/vacuum reclaim following the 11-26 March-twin cleanup; not a concern.

## Post-ship watch — CLEAN, 0 reverts

Targets: the 11-26 Claude Code afternoon/evening wave (migrations `20261127012030`/`010311`/`005234`, pack-sniper/pinnacle-pin/candy-kind code) + the 11-26 overnight pass.

- **Prod:** `dpl_Ea2fRS6yvixwZzAwnKj19nZVTwbx` = `f4574b4e` (All Day reality-check code tip) **READY**, rollback candidate. The 3 newer `main` commits — Atlas-twin migration `5926b447` (`20261127012030`), inbox doc `1c80f377`, migration-recovery `a50ebfca0` — are docs/DB-only → their deploys correctly **CANCELED via ignoreCommand** (expected), **no ERROR**.
- **Runtime errors:** 19 groups/18h, all chronic read-timeout degradations (count 1–8, first-seen Aug/Sept: set-activity, player-top-sales, pack-sniper/market-cap 8000ms, pack-detail drop_pool/lifecycle/ev_contributors, wallet-summary, sniper-feed, analytics, candy-set-progress timeout, league-split). **No new cluster attributable to the wave.**
- **pinnacle-image `/_next/image` MODULE_NOT_FOUND:** 1 straggler at 03:05Z (count 1) — not a cluster; the 11-25 store fix holds, **stays closed**.

## Inbox dispositions

- `2026-11-26T2207Z` (candy-edition-holders MV 2nd timeout) — **swept onto main** (was mount-only, VM disk full). Filing self-concludes it's an IO-saturation symptom; **queued as a quiet-window re-measure**, no action.
- `2026-11-27T0107Z` (candy-set-progress whale-wallet truncation) — **swept onto main**; **queued** (route read-budget).
- `2026-11-27T0125Z` (held DELETE 384 Top Shot same-tx twins) — already on main (Claude Code); **queued** (attended-only).
- `2026-11-26T1936Z` (VM disk full) — already on main; infra/ops, see scope note. **Recommend: recycle the VM to reclaim `/sessions`, and absorb the shallow-sparse-clone fallback into `docs/reference/autonomous-tasks.md`.**
- `2026-11-26T0432Z` (held DELETE 2 stale zero-yield suppressions) — **carried** (attended-only).

## Shipped (docs only — the one change touching main)

- **Stranded-output sweep:** rescued `2026-11-26T2207Z` + `2026-11-27T0107Z` onto main + their INDEX.md lines (`fix-inbox-index-counts.mjs`: 708→710), plus this handoff / ledger / metrics / session entry. **Revert:** `git revert <sha>` (docs-only; the filings also remain on the mount).

## Queued for Trevor / Claude Code

1. **[P2, Claude Code, 1 night] candy-wallet-refresh HIGH — resumable walk hits its time budget.** 5/6 runs failed over 3 calendar days: `time budget reached before the last page` (56–58 s) and one `more than 20000 assets — walk stopped`. Runs appear only 11-26/27 (a newly active lane). Impact is bounded — the walk is cursor-resumable and all Candy FMV/sales freshness is green — but it never completes a full large-wallet walk. **Off-limits to autonomous (route-logic on an ingest walk).** Fix shape: raise the per-run time budget / page the walk across ticks, or carve the >20k-asset whale wallet onto its own cadence. Verify with the next runs reading `ok=true` and the walk cursor advancing, not wall-clock.
2. **[P3, Claude Code, 1 night] candy-set-progress truncates for large candy wallets** (`maxPages=20` / 57014 `candy holdings read was truncated`). 2 users / 3 events, honest partial (returns truncated set progress), NEW-today as `candy_mlb` editions grew to ~21.5k. Same whale-wallet family the 11-26 session fixed for league-split / Candy Sets, but this route is uncovered. Fix: identify the wallet(s) from `usage_events.metadata`, then a covering index or per-wallet budget raise / higher `maxPages` — **verify with EXPLAIN (index-binding), not wall-clock.**
3. **[P3, Claude Code, 1 night] candy-edition-holders MV refresh — 2nd statement-timeout in 24h** (21:33Z + 03:33Z) but observed under IO saturation during the afternoon shipping wave (9/9 backends in IO-wait). The filing itself says **do not act on this reading** — re-measure `REFRESH MATERIALIZED VIEW mv_candy_edition_holders` duration in a quiet, uncontended window over ≥ several days before weighing `REFRESH … CONCURRENTLY` / a longer per-jobid timeout / moving its `33 */3` start minute.
4. **[P2, attended, 1 night] Held DELETE — 384 Top Shot same-tx twins** (inbox `2026-11-27T0125Z`). $1,841.67 double-counted (`topshot_marketplace` NULL-nft_id twin of a `dapper_chain_tx_v1` keeper, March 23–30). `apply_migration` holds the DELETE for confirmation and times out headless → **attended apply only** (SQL editor or an attended session, migration name `audit_20261126_topshot_marketplace_same_tx_twins_retired`; body + revert in the filing). Companion to the already-shipped 2,487 Atlas twins (`20261127012030`).
5. **[P4, attended, 2 nights] Held DELETE — two stale zero-yield suppressions** (inbox `2026-11-26T0432Z`): `ufc-enrichment-drain` (live again via the backstop) and `pack-pull-source-rip-id-backfill` (examined 12,976 in 72h). Attended-only (confirmation hold); no current Sentinel impact.

## Not done this pass (left to its owner)

- The 11-27 10:23 AM PT verification task (`trig_0137N4o42ZG5rUKfYcQDjC3G`, Supabase+Vercel attached) runs the three 11-26-change-held checks + the overnight-fixes verification + the twin-retire lane. Left to fire with its own full prompt (~3h out); this pass did not pre-empt it.

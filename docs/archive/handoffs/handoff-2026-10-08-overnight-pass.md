# Overnight pass — 2026-10-08

⚙️ **Environment scope:** This was a **genuine overnight, PUSH-CAPABLE** run (Cowork cloud, unattended; DB `now()` 08:08Z = ~1:08 AM PT, shell agreed within <1 min — no clock skew). Push went through the **desktop-VM clone + `.rpc-git-cred`** path (`git push --dry-run` exit 0 at run start). The cloud-container `add_repo` path was not needed. Any environment limitation noted below is about *this* session, not the artifact — **Trevor's machine and Claude Code push normally via Git Credential Manager; commit these files as usual.**

**Verdict: GREEN, 0 shipped, 0 reverted.** Security / structural / trust-integrity all clean (0 trust breaches — last night's single marginal `public_board_slow_count` cleared on its own). FMV accuracy gate GREEN (TS published ratio 1.000, All Day 1.000 — both tighter than last night, inside the 0.90–1.10 band). Sentry-dark zero corroborated real by a shrinking Vercel 24h error board (6→4 chronic groups, no new group). One live data lane (`chain-arrival-pack-pulls`) is wedged for the **4th consecutive night**; its only real fix is off-limits (ingest route-logic, owner's lane) and already queued — **and this pass deliberately did NOT do a 5th hand-drain** (see below).

## Reviewed

- **Inbox:** 1 new filing since the last pass — `2026-10-08T0010Z-chain-arrival-pack-pulls-re-wedged-16h-stale-4th-consecutive-night-prioritize-durable-bound.md` (mount-only; the daytime monitor's own escalation of an already-queued item). It explicitly recommends shipping the durable bound **instead of** a 5th hand-drain. Folded; disposition below. No other filing newer than the last pass sits in origin or on the mount. (Inbox is append-only + CI-pinned — not archived.)
- **Post-ship watch (previous ships / carried watches):**
  - **10-07 chain-arrival hand-drain (previous pass):** re-wedged exactly as predicted. `source='chain_history'` `moment_acquisitions` max = `2026-10-07 08:22:48Z` (= last night's drain), **23.9 h stale**; `rpc-chain-arrival-pack-pulls` (jobid 637) last **14/14 hourly ticks all failed at a flat 120.0 s** statement-timeout wall (through 07:41Z today). Expected — the durable bound was queued, not shipped.
  - **allday-lock-refresh (10-04):** ✅ still healthy — `allday_*` trust arms all `ok`; 1,942 allday runs/24h. `wmc-reindex-verify` sentinel clears on the weekly run Sat 10-10.
  - **fmv-backfill `20261005001848`:** ✅ holding — 5 runs/24h, 0 failed, `fmv_sweep_wedge_hours` 0.03, all fmv trust arms `ok`.
  - **wallet-reconstructed-rips (daily rebuild):** ✅ 0 fails in 26 h; last ok 10-07 10:37Z (3:37 AM PT); today's run is ~2.5 h out.
  - **topshot-pack-supply-backfill:** still 100 % HTTP 530 (runs ~daily at 08:15Z; last 08:15Z 10-07). Carried queued (4 nights).

## Health-drift findings + deltas

- **Security invariants:** clean — `invariants []`, `anon_write_holes []`, `rls_off_base_tables []`, `secdef_anon_violations []`.
- **Structural:** clean — `function_search_path_drift`, `procedure_txn_control_pins`, `procedure_search_path_unpinned`, `cross_collection_mat_staleness`, `backward_cursor_rewinds`, `wmc_null_edition_key`, `suppression_parked_claim_drift` all `[]`.
- **Trust health:** **0 breaches** (down from 1 — the 10-07 `public_board_slow_count` = 1 on `v_topshot_parallel_premiums` is back to 0). `trust_precompute_max_age_hours` 5.37 (ok, breach_at 13). `edition_integrity_flags` 8 (ok). `topshot_impossible_parallel_serials` 0. R118 `check_when_others_timeout_blind` = 0.
- **Stalled pipelines:** `[]`. Sentinel `ts_uuid_editions_48h` 0, `ts_uuid_dupes_created_24h` 0.
- **pg_cron recent failures:** `rpc-chain-arrival-pack-pulls` only (21/24, the recurring wedge — see below). No other pg_cron failures.
- **zero-yield lanes:** 5 offenders, all **exhausted/standby backfills** (last find 09-28→09-30), noted only — `pinnacle-pull-chain`, `ingest-pinnacle-mints-backfill`, `topshot-wmc-null-key-heal`, `wmc-edition-key-reconcile`, `golazos-sales-history-backfill`. Not a new finding; these write 0 because their source is drained, not because they're broken.
- **pipeline_alerts:** `atlas-edition-supply` failure_rate HIGH (9/9 = CF-403 pages re-read next cycle; freshness OK — 0 of 282 sets un-walked >6h; known-class do-not-reflag, WATCH). `panini-collector-walk` / `topshot-pack-supply-atlas` medium (per-walk cap / CF single-request partials — by design). `unmapped-sales-nfl_all_day` INFO (7,963 open, draining ~2.4d — down from 10,301 last night). `pg_net_http_400` HIGH = the Flow "failed to convert event payload" node fault (upstream, known). atlas-*-403 / flow-moment-moved-400 INFO (by-design).
- **Vercel 24h:** 4 runtime-error groups, all chronic, NO new group: panini-ingest walk-order maxPages partial (by design, x12); ipfs-media 12 s timeout (chronic 09-03, x4); insights/pack-drops composition timeout (chronic 09-25, x3); collection-snapshot RPC_READ_TIMEOUT (chronic 09-11, x1). Latest deploy `dpl_BxonUaB5` READY. Corroborates the Sentry-dark zero as real health. Client-error beacon 24h = 0.
- **Accuracy gate (7d backtest):**
  - `nba_top_shot` published ALL ratio **1.000**, MdAPE 12.5 %, within±25% 73.4 %, $0.04; HIGH ratio 0.957, 9.1 %, 88.1 %.
  - `nfl_all_day` published ALL ratio **1.000**, MdAPE 24.0 %, within±25% 51.7 %, $0.05; HIGH ratio 1.000, 15.0 %, 70.3 %. (High err% is the sub-dollar market — $0.05 abs. Not lagging; tighter than 10-07's 1.053.)
  - Verdict: **GREEN** — both estimators inside the acceptance band.
- **Deltas vs 10-07:** db_size 35,425 → 35,812 MB (+387, steady — chronic `net._http_response` + Flowty index tables, not runaway). FMV HIGH+MED: topshot 8300→8301, panini 6127→6221 (+editions 20,882→22,110 new walks), pinnacle 853→861, nfl_all_day 1743→1663, candy 27→24, golazos 6. unmapped-sales-nfl_all_day 10,301→7,963 (draining). Trust breaches 1→0.

## Shipped

**None.** Health was GREEN and nothing new cleared the "clearly-safe + net-positive" bar. The one active anomaly's fix is off-limits (below). A quiet, honest night.

### ⛔ Deliberately NOT done: the 5th chain-arrival hand-drain

The previous 4 nights (10-04/05/06/07) each hand-drained this lane, reported GREEN, and watched it re-wedge the same day on the 11:13Z seed. The daytime monitor's 10-08 filing explicitly asks the night pass to **stop hand-draining and ship the bound instead**, and a 5th drain would restore freshness only for the ~08:30–11:13Z window — it re-wedges hours **before** Trevor wakes, so the restoration is invisible to him and provides no durable value. Draining again would be manufacturing work and masking a ~16–24h/day user-facing stall behind a GREEN headline. Declined on purpose; escalated as the P1 below. (Blast radius of leaving it: `wallet_reconstructed_rips` / pack-history freshness for ~27–33 seeded/saved wallets only — no site outage, no security/trust/FMV impact.)

## Queued for Trevor / Claude Code (not auto-shipped)

1. **[P1, recurring — 4 nights] `chain-arrival-pack-pulls` durable BOUND** — off-limits (ingest route-logic, owner's lane). `apply_chain_arrival_pack_pulls()` does insert-all + rebuild-all-touched-wallets in ONE transaction; the pg_cron job hits a hard 120 s wall below the function's own `SET statement_timeout='300s'` (inert under pg_cron), so any non-empty backlog rolls back whole and never self-recovers. The daily 11:13Z `chain-arrivals-seed` re-accumulates the backlog each day → re-wedges. **Fix (ready to build):** chunk into bounded committed batches with a cursor / per-tick wallet cap or time budget, plus a durable `needs_rebuild` marker so a partial tick commits progress and the seed can't re-wedge it; 3-file (migration + pin + drift-guard). **Do NOT** lengthen the function-header `statement_timeout` — measured inert under pg_cron (10-02/10-04). **Acceptance:** a `:41` tick finishes well under 120 s on a full post-seed pending set, and `source='chain_history'` `moment_acquisitions` max stays within ~2 h of now across the 11:13Z seed. This is the only real fix; hand-draining is proven futile (4 nights). If a one-off freshness restore is wanted before the bound ships, the proven data-only drain recipe is in the 10-07 handoff (advisory-locked INSERT replicating the predicate + per-wallet `rebuild_wallet_reconstructed_rips`).

2. **[P2, self-resolved] `topshot-sellback-walk` nft_id-null regression** — off-limits (ingest route-logic). A 10-06 burst (322–360 ticks failed 09:00Z–15:45Z on `null value in column "nft_id" … violates not-null`), zero before and zero since (self-resolved; transient upstream payload-shape window, no deploy). While live, a single NULL-id event rolled back the whole tick's `INSERT … ON CONFLICT` page. **Ready fix:** add `WHERE (…id extraction…) IS NOT NULL` (skip-and-log) to `run_topshot_sellback_walk` + sibling backfill fns so a tick commits the rest. Not urgent (not live) but recurs on the next un-id'd payload window.

3. **[P3, recurring — 4 nights] `topshot-pack-supply-backfill` HTTP 530** — upstream endpoint 100 % 530 since 10-03 (runs ~daily ~08:15Z). Fix = repoint moved endpoint / retire if the live lane covers it / add retry-backoff (code). Needs Trevor's repoint-vs-retire call.

4. **[operator-gated] dedupe + scratch-drop SQL** (`2026-10-05T0410Z` inbox / 0410Z ledger) — `dedupe_tx_lane_20261004.sql` then `drop_scratch_20261004.sql` (both guarded, Trevor-authorized). Destructive → `execute_sql`/`apply_migration` are **held for operator confirmation** this headless session cannot answer; must run in the Supabase SQL editor.

5. **[Claude Code] #173** `topshot_moment_subeditions` conflated bases — sizing in the 10-05 handoff. Do not ship from a night pass.

## Failed / blocked / reverted

None. No production change attempted this pass.

## Notes / deviations

- Session entry → `docs/sessions/2026-10.md` (per CLAUDE.md convention), not CLAUDE.md "Recent sessions".
- Handoff mirrored to the claude.ai Project (`project_write`) per the skill's remote-devices-drop resilience note.
- Lock: taken on the mount at run start (`HELD 2026-10-08T08:09Z … run-1791446966-3048`), released at end.

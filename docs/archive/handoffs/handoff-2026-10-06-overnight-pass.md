# Overnight pass — 2026-10-06 (~1:10 AM PT, Cowork cloud + laptop VM, unattended)

> ⚠ **Environment scope.** Git-push constraints discussed in this project are specific to the Cowork session. This pass WAS push-capable (desktop-VM clone + `.rpc-git-cred`; `git push --dry-run` exit 0, `ls-remote` ok), so its docs are committed to `main`. Earlier in the run the push credential looked absent (the cloud container's proxy 403s this repo — not in its authorized set — and the VM has no `gh`/helper); the working route is the documented `.rpc-git-cred` store helper from the VM clone, per `docs/reference/tooling-gotchas.md`.

**Mode:** genuine overnight run. Real time from the DB (`now()` 08:14:38Z) vs shell (08:09Z) vs app-stamped rows (`max(sales.ingested_at)` 08:14:00Z, `max(fmv.computed_at)` 08:08:29Z) — all agree, no clock skew; **~01:14 AM PT**, inside 00:00–06:00. Lock taken (`run-1791274394-19260`), released at end. No `docs/FREEZE.md`.

## Verdict: GREEN with one live HIGH fixed. 1 shipped (data-only, verified), 0 reverted.

The one live HIGH — the `rpc-chain-arrival-pack-pulls` wedge — was hand-drained (the proven 10-04 unblock, data-only + reversible). Everything else is clean or known-class, and no 10-04/05 ship is regressing.

---

## 1. Reviewed

**Inbox (new since the 10-05 ~1:10 AM PT pass):**
- `2026-10-05T2106Z-chain-arrival-pack-pulls-wedged-…` (🔴 HIGH) + the tip filing `a06fb6e2d` ("13 consecutive timeouts") — same lane. **ACTED: hand-drained (§4); durable bound QUEUED (§5).**
- `2026-10-05T1809Z-…topshot-pack-supply-backfill-100pct-http-530-3-days` (NEW, low/med) — **QUEUED (§5):** historical lane, 100% HTTP 530 since 10-03; the live `topshot-pack-supply-atlas` lane is healthy (last 200 08:02Z).
- `2026-10-05T1512Z-pack-pulls-apply-self-stuck-…` — the same wedge, earlier in its progression; resolved by the drain.

**Also folded:** CLAUDE.md open lists; focus steers (through 10-04 ~10:45 PM PT) — every do-not-reflag honoured; the 10-04/05 ledger ships (post-ship watch §3); Vercel 24h; the carried `0410Z` Flowty item and #173.

## 2. Health-drift triage — GREEN (one HIGH, fixed)

Fast baseline `rpc_ops_snapshot()` @ 08:14:56Z, then the instruments that lie, each drilled:

- **Security:** invariants `[]`, anon_write_holes `[]`, rls_off_base `[]`, secdef_anon `[]`. Clean.
- **Structural:** function_search_path_drift / procedure_txn_control_pins / procedure_search_path_unpinned / cross_collection_mat_staleness / backward_cursor_rewinds / wmc_null_edition_key / suppression_parked_claim_drift — all `[]`.
- **Trust health:** **0 breaches**, 38/38 arms ok. `trust_precompute_max_age_hours` 5.45 (breach 13). `public_board_slow_count` 0, `public_board_empty_count` 0, `edition_integrity_flags` 8 (breach 250), `topshot_impossible_parallel_serials` 0.
- **Sentinel** `ts_uuid_editions_48h` 0; `ts_uuid_dupes_created_24h` 0.
- **stalled_pipelines** `[]`. **pgcron recent failures** (`check_pgcron_recent_failures()`): only `rpc-chain-arrival-pack-pulls` (21/24 fails — the wedge, hand-drained this pass).
- **pipeline_alerts:** `atlas-edition-supply` **HIGH** failure_rate (5/9 over 3 days = Cloudflare-403 pages re-read next cycle; **freshness OK** — the upstream-403 row reports 0 of 282 sets un-walked in 6 h, oldest 1.9 h — so the pooled rate crossed `high` but the lane is keeping up; known-class, do-not-reflag, WATCH); `panini-collector-walk` MEDIUM (10-min per-walk cap, by design); `unmapped-sales-nfl_all_day` INFO (12,761 open, ~2.7 d to clear, draining from 15,269 on 10-05); `atlas-*-upstream-403` / `flow-rest-moment-moved-400` INFO (by-design).
- **pipeline_fails_24h:** `topshot-pack-supply-atlas` 158 (per-tick CF-403 single-request partials on a ~every-minute lane; re-asked next tick; last 200 08:02Z — **not a finding**); `topshot-pack-supply-backfill` 100% HTTP 530 (QUEUED §5); `sync-nba-projections` 8 (muted to 10-28); `member-wallet-usernames-atlas` 7 (cadence item); `wallet-backfill-golazos` 4 (Flow `computation_limit`, Golazos market-limited); `chain-arrival-flips` 4 (Flow node payload-convert 400, upstream); rest ≤4 by-design/upstream.
- **Vercel 24h:** 1 runtime-error group — `/insights/pack-drops` composition TimeoutError (3 occ, chronic since 09-25, honest board-degrade). No new group. Latest **code** deploy `dpl_BxonUaB5` (`allday-lock-refresh` `101f9c18e`) **READY**; subsequent docs/migration-only commits CANCELED (expected per `ignoreCommand`). No ERROR state.
- **Sentry:** dark since 08-18 (no spend) — not used as a signal; Vercel chronic-only corroborates real health.
- **DB size:** 34,826 MB, **+291 vs 10-05** (34,535). Growth decelerating sharply (10-04→10-05 was +2,562). Flowty index tables + chronic `net._http_response` log. Carried watch.

### Accuracy gate (leading indicator; full backtest not re-run this pass)
`fmv_by_collection` HIGH+MEDIUM counts (computed 05:35Z): NBA Top Shot 8,275 (HIGH 1,670 / MED 6,605); Panini 5,220 (907/4,313; editions 17,859→19,316 on new walks); Pinnacle 861; All Day 1,730; Candy 28; Golazos 6; UFC 0. TS flat vs 10-05 (8,309), Panini +1,383 with the new walks. The 7-d `fmv_sales_backtest` was not re-measured (in-band cost; not a shipping gate tonight) — the 10-05 reading (TS published ALL ratio 1.000 / err 13.0%, HIGH within-25 87.3%; All Day ratio 1.20 but $0.05 abs sub-dollar) stands.

## 3. Post-ship regression watch (10-04/05 ships; re-measured, none regressing)

- **`fmv-backfill` MATERIALIZED-CTE fix (`20261005001848`):** HOLDING. Runs 00:21Z 4.4 s, 06:38Z 4.0 s, 18:38Z 10-05 4.8 s — all ≤5 s, 0 timeouts since the fix. Falsifier (any statement-timeout after 00:18Z 10-05) not triggered.
- **`chain-arrivals-seed` fix (`20261004160000`):** HOLDING. 11:13Z 10-05 ran 70.4 s, `ok=true` (was timing out at 300 s). (This is the SEED — healthy; it is the APPLY lane downstream that wedged, §4.)
- **`allday-lock-refresh` cadence fix (`101f9c18e`):** HOLDING. Hourly, mostly ~0.4–0.6 s (two longer FULL ticks 58–86 s, `ok`); `rows_written/day` reduction expected to show from 10-06; `wmc-reindex-verify` clears Sat 10-10.
- **Panini board covering indexes (10-04):** HOLDING. `public_board_slow_count` 0, no board timeout.
- **Top Shot team-moment player_name (`20261004232750` / `230911`):** integrity clean by instrument — `edition_integrity_flags` 8 (ok), `topshot_impossible_parallel_serials` 0; no Vercel/Sentry signal. (Fine-grained re-check belongs to the daytime routine.)

## 4. Shipped

**(1) `rpc-chain-arrival-pack-pulls` backlog hand-drain** — DATA, no code, reversible, independently verified.
- **State found:** 21/24 hourly ticks `failed` with `statement timeout` since 10-05 10:41Z; `moment_acquisitions` `chain_history` pack-pull writes last landed 10-05 00:41Z (~31 h of lag). Pending set: **4,796 deliveries across 18 wallets** (top wallets 2,068 / 887 / 602 / 456 …).
- **Method:** two `execute_sql` DO-block batches (heaviest 4 wallets, then the remaining 14), each holding `pg_try_advisory_xact_lock(hashtext('apply_chain_arrival_pack_pulls'))`, looping per wallet: the function's **verbatim** insert (predicate + columns + `ON CONFLICT DO NOTHING`) then `rebuild_wallet_reconstructed_rips(wallet)`. Per-wallet-atomic: a timeout rolls back only that batch, leaving the DB consistent.
- **Result:** 4,796 rows inserted (`source='chain_history'`, `acquisition_method='pack_pull'`) across 18 wallets, window 08:22:16–08:23:07Z (~51 s total). Pending now **0**. All 18 wallets' reconstructed rips rebuilt.
- **Independent verification (fresh subagent, no prior context): PASS** — pending 0; 4,796 rows / 18 wallets confirmed; 0 wallets with pack-pull acquisitions but missing rips; `rpc_ops_snapshot` security `[]`, trust_health_breaches `[]`, stalled `[]`.
- **Target metric to re-check:** the next :41 tick reads `succeeded` (with the backlog at 0 it now has little/nothing to apply) and `moment_acquisitions` `chain_history` writes continue.
- **Revert:** `DELETE FROM public.moment_acquisitions WHERE source='chain_history' AND acquisition_method='pack_pull' AND created_at BETWEEN '2026-10-06 08:22:16+00' AND '2026-10-06 08:23:08+00';` then re-run `rebuild_wallet_reconstructed_rips(w)` for the 18 wallets. (Revert only to undo a defect — the lane re-inserts these next tick.)

## 5. Needs Trevor / queued

1. **🔴 `apply_chain_arrival_pack_pulls()` durable BOUND (the recurring root cause; code, off-limits ingest route-logic).** The hand-drain is a stop-gap; the unbounded one-transaction insert+per-wallet-rebuild will re-wedge on the next large `chain-arrivals-seed` (daily 11:13Z) exactly as it did 10-04 → 10-05. **Fix:** bound the rebuild loop to a per-tick wallet cap or wall-clock budget with a durable needs-rebuild marker (so un-rebuilt wallets are picked up next tick instead of rolled back), then re-pin (migration + pin `.sql` + drift-guard). Size the cap off a quiet-window re-measure of per-wallet rebuild cost. Owner's lane since 10-04; still unshipped.
2. **`topshot-pack-supply-backfill` 100% HTTP 530 since 10-03** (NEW). Every daily ~08:15Z run fails with Cloudflare 530 "origin unreachable" (distinct from the 403 *challenges* the healthy live lane absorbs). Historical pack-supply only — no user/FMV/accuracy-gate impact. **Decide:** is the backfill endpoint moved (repoint), gone (retire — the live lane covers steady-state), or transient (add retry/backoff so a 530 day stops reading as a 3-day 100% failure)? Route-logic + a keep/kill call → Trevor/Claude Code.
3. **(carried, night-count ~2) `0410Z` Flowty dedupe + scratch-drop** — `dedupe_tx_lane_20261004.sql` then `drop_scratch_20261004.sql` in the Supabase **SQL editor** (destructive `DELETE`+`DROP`; autonomous off-limits + MCP write-held). Not re-verified this pass; pre-checks as of 10-05: 7 tx-lane dupes, 0 cron refs to scratch. Dedupe first.
4. **(carried) #173 `topshot_moment_subeditions` conflated base editions** — exact-count + writer-attribution + re-key, pricing-adjacent with many readers → Claude Code / Trevor (refined sizing in the 10-05 handoff).
5. **(watch) `net._http_response` ~3.5 GB pg_net log + overall DB growth** — pruning is a `DELETE` on pg_net infra (write-held, not an autonomous lever). Growth decelerated to +291 MB this pass; revisit if it re-accelerates.

## 6. Failed / blocked / reverted

None. No verification failure, no revert, no hard-stop. Ship budget: 1 of 4 used.

---

*Continuity written (committed + pushed to `main` from the VM clone): this handoff; ledger `### 2026-10-06` entry; `metrics-latest.json` overwritten; `docs/sessions/2026-10.md` entry. No inbox filing retired or moved (append-only; the pack-pulls filings stay open because the durable bound is unshipped). Lock released. One deviation noted: the prompt's "prepend to CLAUDE.md Recent sessions" was written to `docs/sessions/2026-10.md` instead, per CLAUDE.md's rule that session entries never go in CLAUDE.md.*

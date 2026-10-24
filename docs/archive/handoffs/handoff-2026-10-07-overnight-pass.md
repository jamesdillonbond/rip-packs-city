# RPC overnight pass — 2026-10-07

**When:** ~1:10–1:30 AM PT, 2026-10-07 (unattended nightly autonomous pass, Cowork cloud).
**Mode:** GENUINE OVERNIGHT, push-capable. Real time from DB `now()` 08:09Z = ~1:09 AM PT (shell clock agreed within ~1 min → no skew). Lock taken (`run-1791360647-25325`), no FREEZE.

> ⚠ **SCOPE — the push path is specific to this cloud session.** The cloud container cannot push (no `add_repo` tool this run; it is not in the container's authorized repo set), and it cannot see the Windows mount. Push therefore went through a **fresh desktop-VM clone** (`$HOME/rpcwork` on the laptop VM) using the `.rpc-git-cred` store helper; `git push --dry-run` returned exit 0 (authenticated). **Trevor's machine and Claude Code push normally via Git Credential Manager — commit/pull as usual.** This is an environment fact about this session, not about the work.

## Verdict

**GREEN, 1 shipped (data-only, verified), 0 reverted.** Security / structural / trust-integrity all clean; FMV accuracy gate green (TS published ratio 1.000, All Day 1.053 sub-dollar); Sentry-dark zero corroborated real by a near-empty Vercel 24h error board. One live data lane (`chain-arrival-pack-pulls`) re-wedged as predicted and was re-drained; its durable fix remains Trevor's (off-limits ingest route-logic). One new 10-06 ingest regression (`topshot-sellback-walk`) was caught, found already self-resolved, root-caused, and QUEUED.

## Reviewed

- **Inbox:** no filing newer than the last pass sits in origin. **4 mount-only monitor filings** (NO-PUSH daytime-monitor runs) were folded: `2026-10-05T1512Z` (pack-pulls apply self-stuck), `2026-10-05T1809Z` (pack-supply-backfill 530), `2026-10-05T2106Z` (chain-arrival 10 timeouts), and `2026-10-06T1510Z` (sellback nft_id-null + chain-arrival redrain-held-3-ticks — the only one dated after the last pass). They remain mount-only/uncommitted (they are the monitor's files and the INDEX.md CI guard makes hand-committing them hazardous); dispositions are recorded here and in the ledger, which is what the next pass reads first.
- **Post-ship watch (previous ships):**
  - **10-06 chain-arrival hand-drain (mine):** held only ~3 ticks then re-wedged (23/26 fail, and 14/14 fail over the last 14 h at the flat 120 s ceiling). Expected — the durable bound was queued, not shipped. Re-drained this pass (see Shipped).
  - **allday-lock-refresh (10-04, Claude Code):** ✅ target met. `rows_written/day` 2.60 M (10-02/03/04) → 497 k (10-05) → 428 k (10-06). The `wmc-reindex-verify` sentinel clears on the weekly run Sat 10-10 9:03 PM PT.
  - **fmv-backfill fix `20261005001848`:** ✅ holding — recent runs 0.6–5.6 s, all ok, no statement timeouts.
  - **topshot-pack-supply-backfill:** still 100 % HTTP 530 (last 08:15Z 10-07, 37 s). Carried queued.
- **Artifacts:** none flagged broken/stale this pass; the 10-05 monitor validated the backing-view layer. Not re-enumerated.

## Health-drift findings + deltas

- **Security:** clean — invariants [], anon_write_holes [], rls_off_base_tables [], secdef_anon_violations []. Structural all clean (search-path drift, txn-control pins, cross-collection staleness, cursor rewinds, wmc null edition key, suppression drift all []).
- **Trust:** 37/38 ok, **1 breach = `public_board_slow_count` = 1**. The slow board is `v_topshot_parallel_premiums` (~2.4 s `count(*)` probe at 06:28Z; 2.2 s at 00:28Z) — over the 2 s probe threshold but **not erroring**: Vercel shows **no** runtime error on `/insights/parallel-premiums`. Per the skill the `count(*)` probe is an unreliable latency proxy (the planner prunes it); the user-facing instrument (Vercel logs) is clean here. Marginal, not user-impacting — noted, not shipped. (`panini_sale_feed_status` touched 3.1 s once at 00:28Z, also non-erroring.)
- **R118 `check_when_others_timeout_blind`:** 0. **Sentinel ts_uuid 48h:** 0. **Stalled pipelines:** [].
- **Zero-yield lanes:** 1 offender — `ingest-pinnacle-mints-backfill` (5,226 recent runs, 0 written, last find 2026-09-28). Backfill lane, almost certainly exhausted; low-value. Noted only (disabling an ingest lane without confirming it is retired is not clearly-safe).
- **Pipeline alerts:** `atlas-edition-supply` failure_rate now **high** (7/9 over 3 d, "9 pages failed") — but this is the known by-design Cloudflare-403 page re-read class (focus do-not-flag); catalog freshness is clean (0 of 282 sets un-walked >6 h, oldest 1.9 h, `atlas-editions-upstream-403` info). The severity bump is the pooled 3-day page rate, not a freshness regression. All `atlas-*-upstream-403` / `flow-rest-moment-moved-400` rows info/by-design. `unmapped-sales-nfl_all_day` info (10,301 open, ~2.6 d to clear; was 12,761 → draining).
- **FMV accuracy gate (7 d `fmv_sales_backtest`):** GREEN.
  - `nba_top_shot` published ALL: ratio **1.000**, median abs err 12.5 %, within-25 73.0 %; HIGH within-25 87.8 %. `last3_median_30d` ALL ratio 1.000.
  - `nfl_all_day` published ALL: ratio **1.053** (inside the 0.90–1.10 band), err 23.3 % but **$0.05 abs** (sub-dollar market); HIGH within-25 75.5 %. Not lagging.
- **Sentry:** dark (no spend). **Vercel 24h:** 6 runtime-error groups, all chronic/low-count (ipfs-media 12 s timeout ×15; panini-ingest walk-order maxPages partial ×8 by-design; pack-drops composition timeout ×2 chronic; pack_realized_ev >5 s ×1; collection-snapshot RPC_READ_TIMEOUT ×1; edition special-serials statement-timeout→degrade ×1). No new group → the Sentry zero is corroborated real health. **Client-error beacon:** 2 in 24 h.
- **DB size:** 35,425 MB (+599 vs 34,826 last pass; growth steady, chronic `net._http_response` + Flowty index tables).

### Deltas vs 10-06
db_size 34,826 → 35,425 MB (+599). trust_precompute 5.45 → 5.41 h. trust breaches 0 → **1** (public_board_slow_count, new, marginal). FMV HIGH+MED: topshot 8,275 → 8,300, panini 5,220 → 6,127 (+907; editions 19,316 → 20,882 new walks), pinnacle 861 → 853, nfl_all_day 1,730 → 1,743, candy 28 → 27, golazos 6. unmapped-sales nfl_all_day 12,761 → 10,301 (draining). New since last pass: the `topshot-sellback-walk` 10-06 nft_id burst (self-resolved).

## Shipped

**🗄 DATA (unblock, no code) — re-drained `rpc-chain-arrival-pack-pulls`: 4,083 deliveries / 16 wallets → pending 0.**
- The 10-06 hand-drain held ~3 ticks; the daily 11:13Z `chain-arrivals-seed` re-accumulated 4,083 historical done-probes (newest arrival 10-06 00:17Z), which the 120 s-capped hourly apply cannot drain whole.
- A monolithic re-invoke of `apply_chain_arrival_pack_pulls()` timed out again inside `rebuild_wallet_reconstructed_rips` and rolled back cleanly (verified pending unchanged) — same failure mode as the cron.
- Drained via the proven split: **one advisory-locked INSERT** replicating the function's exact predicate (`chain_arrival_probes status='done'` + Dapper from-addresses `{0xe1f2a091f7bb5245, 0xb6f2481eba4df97b, 0xfa57101aa0d55954}`, both NOT-EXISTS guards vs `moment_acquisitions`/`pack_open_pulls`, `ON CONFLICT (nft_id,wallet,transaction_hash) DO NOTHING`) → 4,083 `moment_acquisitions` rows (`source='chain_history'`, `acquisition_method='pack_pull'`, `acquisition_confidence='verified'`) at 08:22:48.706182Z; then **`rebuild_wallet_reconstructed_rips(w)` per wallet** in its own committed statement (16 wallets, all ok; reconstructed counts 85–9,530/wallet).
- **Independent fresh-subagent verification: PASS** — pending 0; 4,083 rows / 16 distinct wallets; 0 wallets with pack-pull acquisitions but no reconstructed rips; `rpc_ops_snapshot` security/structural/stalled all clean.
- ⚠ **Stopgap, not a fix.** Re-wedges on the next 11:13Z seed. This is the second consecutive night of hand-draining the same lane — the honest signal is that the durable bound (below) needs to ship.
- **Revert:** `DELETE FROM public.moment_acquisitions WHERE source='chain_history' AND acquisition_method='pack_pull' AND created_at = '2026-10-07 08:22:48.706182+00';` then re-run `rebuild_wallet_reconstructed_rips(w)` for the 16 wallets (lane re-inserts the same rows next successful tick; revert only to undo a defect).
- **Target metric:** `moment_acquisitions` `chain_history` writes current; `chain-arrival-pack-pulls` :41 ticks stay `failed` until the bound ships.

## Queued for Trevor / Claude Code (not auto-shipped)

1. **[P1, recurring] `chain-arrival-pack-pulls` durable BOUND** — off-limits (ingest route-logic, owner's lane). `apply_chain_arrival_pack_pulls()` does insert-all + rebuild-all-touched-wallets in ONE transaction; the pg_cron job is capped at 120 s below the function's own `SET statement_timeout='300s'`, so any non-empty backlog rolls back whole and never self-recovers. **Fix:** chunk into bounded committed batches with a cursor / per-tick wallet cap or time budget, plus a durable needs-rebuild marker so the daily 11:13Z seed cannot re-wedge it. 3-file (migration + pin + drift-guard). This is the only real fix; hand-draining re-wedges the same day (now proven two nights running).

2. **[P2, NEW, self-resolved] `topshot-sellback-walk` nft_id-null regression** — off-limits (ingest route-logic). A 10-06 burst: **322–360 ticks failed 09:00Z–15:45Z on `null value in column "nft_id" of relation "topshot_sellback_walk_purchases" violates not-null constraint`**, zero before and **zero in the ~16.5 h since** (self-resolved — looks like a transient upstream payload-shape window, not a code change; no deploy at 15:45Z). **Impact while live:** the insert extracts `nft_id` from each event payload's `id` field; an event lacking that field yields NULL, and because the whole page is one `INSERT … SELECT … ON CONFLICT (tx,nft_id) DO NOTHING`, the NOT NULL abort rolls back **every row in that tick** — so sell-back/burn events in those windows were dropped (1,118/1,440 ticks still succeeded). **Ready fix** in `run_topshot_sellback_walk` (and the sibling backfill fns that share the pattern): add `WHERE (…id extraction…) IS NOT NULL` to the SELECT (skip-and-log the un-id'd events) so a tick commits the rest instead of aborting whole. Acceptance: nft_id-null error count stays 0 and partial-tick drops stop. Not currently live, so not urgent — but it will recur on the next such payload window.

3. **[P2, carried 3 nights] `topshot-pack-supply-backfill` 100 % HTTP 530 since 10-03** — daily lane, still failing (08:15Z 10-07). 530 = Cloudflare origin-unreachable, distinct from the 403 challenges the healthy live supply lane absorbs. Decide: repoint a moved endpoint / retire the backfill if the live `topshot-pack-supply-atlas` lane covers steady-state / add retry-backoff so a 530 day stops reading as 100 %. Backfill-only, no user-facing or accuracy impact.

4. **[carried] 0410Z dedupe + scratch-drop** — destructive SQL, operator-gated (MCP write-hold + SQL-editor-only). Unchanged.

5. **[carried, Claude Code] #173 `topshot_moment_subeditions` conflated bases** — exact-count + writer-attribution + re-key. Sizing in the 10-05 handoff.

## Failed / reverted

None. (The one monolithic `apply_chain_arrival_pack_pulls()` re-invoke timed out and rolled back cleanly — expected probe, no partial state, not a ship.)

## Notes / deviations

- **CLAUDE.md "Recent sessions":** the prompt says prepend there, but CLAUDE.md §Recent sessions says write into `docs/sessions/<month>.md`, never into CLAUDE.md. Followed CLAUDE.md (prompt-vs-CLAUDE.md conflict → CLAUDE.md wins). Session entry prepended to `docs/sessions/2026-10.md`.
- **Inbox NOT archived** (append-only since 08-17, CI-pinned). The 4 mount-only monitor filings left as-is.
- **MCP write-hold:** INSERT … SELECT and function calls executed normally this pass (the 4,083-row drain committed); the hold that bites literal-value UPDATE/DELETE did not block this work.

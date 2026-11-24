# Claude Code → Cowork: create 4 scheduled tasks (connectors needed), and the UFC enrichment fix

**Filed 2026-11-23 ~6:52 PM PT by Claude Code cloud.** Trevor: "Make sure all these scheduled checks live outside of this thread, and anything needed is handed to cowork".

**Why Cowork:** a scheduled task created from a Claude Code cloud session gets no connectors:
- `create_trigger` refuses the `connectors` parameter for this org ("not available for this organization").
- Without it, the task stores none, so a fired session has no Supabase. One was created and deleted for this reason; see tooling-gotchas.md "A scheduled task created from a cloud session carries NO connectors here".
- The existing data-read tasks carry Supabase because they were made from Cowork / the routines UI.

**Please create items 1–4 as one-shot scheduled tasks WITH the Supabase connector** (plus GitHub repo access to push docs), then tick them here. Each prompt below is ready to paste.

## Already scheduled (with connectors) — no action

| when (PT) | task |
|---|---|
| Tue 11-24 ~10:40 AM | Rpc context hygiene (recurring) |
| Wed 11-25 7:37 AM | fmv-recalc `:08` historical_fallback_error full-day rate |
| Wed 11-25 9:07 AM | retire job 901 into the pack-value cache |
| Fri 11-27 10:10 AM | FMV offer-rule backtests (All Day, Panini) |
| Mon 11-30 5:23 AM | Top Shot go-live gate week 3 |
| Mon 11-30 9:44 AM | FMV week-2 reads |
| Sun 12-06 1:23 PM | Panini pack-EV backtest |
| Sun 12-13 5:00 PM | #190 transfer hop after the Dune reset |
| Mon 12-14 10:23 AM | UFC Aptos wallet link via Dune |
| Mon 12-15 1 AM | Rpc monthly deep audit (recurring) |

✅ Done tonight, nothing owed:
- Panini Sentinel WARN: cleared, read by another session at 5:25 PM PT.
- `pinnacle-wmc-render-id` derive timeout: self-healed 6:37 PM PT.
- GHA schedule stall: cleared 2:08 PM PT.

---

## 1. ⏰ Tue 11-24 ~7:40 AM PT — verify the `panini_card_serials` VACUUM moved to `cron_heavy`

```
Rip Packs City (repo jamesdillonbond/rip-packs-city, Supabase project bxcqstmqfzmuolpuynti). Follow CLAUDE.md (PT times only, ledger rules, push to main). READ-ONLY on the DB.

Migration 20261123231928 (11-23 3:19 PM PT) moved pg_cron job `maint-vacuum-panini-card-serials` from `postgres` (120 s cluster default; it timed out at 11:04 AM PT 11-23) to `cron_heavy` (600 s) with GRANT MAINTAIN. It is now jobid 919, schedule `4 11,19 * * *` UTC = 3:04 AM / 11:04 AM PT.

1. cron.job_run_details for jobid 919 since 2026-11-24 00:00 PT: status and duration of the 3:04 AM PT run.
2. pg_stat_user_tables.last_vacuum for public.panini_card_serials: it must be ≈ that run (between its start and end). ⚠ If cron_heavy lacked MAINTAIN, VACUUM only WARNS "permission denied … skipping" and the job still reads `succeeded`. So `succeeded` alone proves nothing: last_vacuum is the proof. If it still reads 2026-11-23 ~11:05 AM PT, that is the warn-and-skip; check has_table_privilege('cron_heavy','public.panini_card_serials','MAINTAIN').
3. If both hold: append "✅ VERIFIED <time PT>" to docs/overnight/inbox/2026-11-23T2206Z-rpc-daytime-monitor-panini-card-serials-vacuum-statement-timeout.md, mark its INDEX.md line RESOLVED (run `npm run inbox:index:check`), and close the matching focus.md steer. If not, say what failed and change nothing.
4. Ledger line (docs-only; re-read from disk, splice at the first line-start '### '), push to main, and tell Trevor in one sentence in PT.
```

## 2. ⏰ Wed 11-25 ~8:20 AM PT — Top Shot sale-ingest lag, full day 11-24 (verification of the 5-min drain)

```
Rip Packs City (repo jamesdillonbond/rip-packs-city, Supabase project bxcqstmqfzmuolpuynti). Follow CLAUDE.md (PT times only, ledger rules, push to main). READ-ONLY on the DB.

Background (ledger 11-23 ~1:08 PM and ~3:55 PM PT):
- Parked (unmapped) Top Shot sales reach `sales` only via pg_cron 474 promote_unmapped_sales('95f28a17-224a-4025-96ad-adf8a4c63bfd'), now every 5 min (`3-59/5`). Resolver 476 runs at `1-59/5`.
- 20261123235536 set the Top Shot gap to 4 min. A 5-min gap had skipped 14 of 33 ticks on pg_cron jitter.
- Early read 1:15–3:27 PM PT 11-23, before that fix: direct-indexed sales p50 2.8 / p90 4.6 min; promoted-from-unmapped p50 12.1 / p90 14.6 (they waited two ticks); overall p90 13.9.

For the full PT day 2026-11-24:
1. pipeline_runs pipeline 'promote_unmapped_sales', collection_slug 'nba_top_shot': count real drains vs extra->>'note'='skipped_recent_run' (expect ~0 skips) and any ok=false.
2. Lag = sales.ingested_at − sales.sold_at for collection 95f28a17-224a-4025-96ad-adf8a4c63bfd, source 'onchain'. Split promoted vs direct: promoted = EXISTS an unmapped_sales row with the same (collection_id, transaction_hash, nft_id). Report n, p50, p90 for each and overall, and the count over 20 min. Also the wait between unmapped_sales.ingested_at and the promoted sales.ingested_at (expect ~5 min, one tick).
3. Verdict: promoted wait ≈ 5 min and overall p90 ≤ ~10 min → close it. Otherwise say which group carries the tail (resolver 476's 12-per-run Atlas cap, or the indexer) without changing anything.
4. Write the result into the "Sale-ingest lag" bullet of docs/strategy/collections/nba-top-shot.md, replace the focus.md steer "SHIPPED 11-23 ~1:08 PM PT — Top Shot promote gap 5 min" with a closed line, add a docs-only ledger entry (re-read from disk, splice at the first line-start '### '), push to main, and tell Trevor in two plain sentences in PT.
```

## 3. ⏰ Mon 12-07 ~5:25 AM PT — Top Shot go-live gate WEEK 4, and the R73 re-read it gates

```
Rip Packs City (repo jamesdillonbond/rip-packs-city, Supabase project bxcqstmqfzmuolpuynti). Follow CLAUDE.md (PT times only, ledger rules, push to main). READ-ONLY on the DB.

A) Gate week 4.
- pg_cron job 828 writes fmv_accuracy_weekly Mondays ~3:37 AM PT; confirm it ran today.
- Read fmv_accuracy_weekly for Top Shot (95f28a17-224a-4025-96ad-adf8a4c63bfd), week_start 2026-11-30, by confidence: sum(within_25_pct*n)/sum(n) and sum(n). ⚠ within_25_pct is already a percentage: do NOT ×100.
- Gate: HIGH and MEDIUM each ≥ 70. Weeks 1–2: 80.1/74.1, 83.3/73.1. Week 3 is in docs/strategy/go-live-2026-09.md §6 item 5.
- If the row is missing, say so; never substitute a re-derived number.
- Write week 4 into §6 item 5 and state whether the gate is PASSED (4 of 4) or not.
B) If the gate PASSED, the items gated on it:
- known-issues #234 (the computed MEDIUM ≤7d 3+/90d → HIGH relabel, deferred past the gate) and #66 (re-gated on the gate pass): re-read each item's own text and say whether its condition is now met. Do NOT ship either; they are Trevor's decision.
- Deep-audit register R73 (concierge reach): re-read the external concierge opens for the last 14 days the way the 11-23 re-read did (5 external opens: 4 peeks, 1 pill click; exclude internal_accounts and bot_ua), and update its row.
C) Ledger entry (docs-only; re-read from disk, splice at the first line-start '### '), push to main, and tell Trevor in two lines in PT: gate result, and what it unlocks for his decision.
```

## 4. 🔧 UFC enrichment chain fix (code + edge deploy). For a Claude Code session, or Cowork via the push route

Diagnosis: [2026-11-24T0114Z-…-ufc-wmc-null-edition-key-over-watcher.md](2026-11-24T0114Z-rpc-daytime-monitor-ufc-wmc-null-edition-key-over-watcher.md) ("DIAGNOSED" section).

**Impact:** 155 UFC `wallet_moments_cache` rows with no edition_key, in 2 non-member wallets. They render without fighter, set or value, and they never heal.

**Causes:**
1. The caller's 45 s `AbortSignal.timeout` is shorter than one 100-NFT page of `enrich-ufc-wallet`.
2. Every run restarts at `start=0` over all rows, keyed or not.
3. The fallback `ufc-enrichment-drain` has had no caller since 10-18.

**The fix, all in one change:**
- `supabase/functions/enrich-ufc-wallet/index.ts`: select only rows with `edition_key IS NULL`, and page by a `moment_id > cursor` keyset. An offset over a set that shrinks as it is enriched skips rows.
- `lib/chains/flow/wallet-backfill-helpers.ts` `triggerUfcEnrichmentChain`: pass the cursor, and give each page a timeout above one page's work. Keep it ≤ 140 s (edge wall 150 s), and keep the chain inside `wallet-backfill-ufc`'s 300 s `maxDuration`, e.g. stop starting a new page after ~200 s.
- Deploy the edge function per `rpc-edge-fn-deploy`: push, then dispatch `.github/workflows/edge-fn-deploy.yml` with `function=enrich-ufc-wallet`.
- Verify the two wallets drain: `0xfd6debe3815415c3` (149 rows) and `0xe5492c968fb5d358` (6). Do this on their next multicollection walk, or by one manual `wallet-backfill-ufc` call with the ingest token.

**Optional, budget-neutral:** a UFC arm in `v_rpc_trust_health`; template `20261110230853`.

**Priority LOW** (legacy Flow UFC, no members affected). Do it when a session has the edge deploy route.

## 5. Still with Cowork from earlier, unchanged

Split-player merge (Luis Robert, Andre Jackson Jr.): [2026-11-23T2145Z](2026-11-23T2145Z-claude-code-for-cowork-merge-two-split-suffix-players.md), SQL in `docs/proposals/merge-two-split-suffix-players-STAGED.sql`. The MCP holds its DELETE, so it needs the SQL editor or an attended `apply_migration`.


---

## ↪ 2026-11-23 ~7:10 PM PT — Cowork cloud (Trevor: "Approve and proceed with all. Make sure these scheduled tasks live outside this thread")

- ✅ Item 1: `trig_01QRQpDVVWLhUfSgMCpvEX97`, Tue 11-24 7:40 AM PT.
- ✅ Item 2: `trig_01BaNKB1iFhDC7zHPXsZWm7M`, Wed 11-25 8:20 AM PT.
- ✅ Item 3: `trig_01QqtQFuJLBVEwKjbjkVZDYK`, Mon 12-07 5:25 AM PT.
- All three: standalone one-shot tasks (fresh session, not this thread), Supabase connector attached, prompts verbatim from above.
- ⏳ Item 4 (UFC enrichment fix): still open — needs code + edge deploy (Claude Code).
- ✅ Item 5: split-player merge applied ~7:06 PM PT (see 2145Z).

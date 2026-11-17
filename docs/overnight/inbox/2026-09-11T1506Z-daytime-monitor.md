# Daytime monitor — 2026-09-11T15:06Z (08:06 PT, first tick of day)

READ-ONLY sweep. Bash/clone mount is DOWN (Windows Sept-8 update, 3rd day per the released `.lock`), so **inbox written to mount, push unavailable** — night pass picks up locally. DB/Vercel/Sentry/artifact-manifest connectors all live.

## Sweep result: healthy, one earlier saturation spell already cleared

- **Security invariants clean** (`rpc_ops_snapshot`: invariants / anon_write_holes / rls_off_base / secdef_anon all `[]`).
- **Trust health 1 BREACH — KNOWN, not new:** `topshot_impossible_parallel_serials`=4 vs breach_at 3. This is the exact "4" of issue **#82** (three ledger entries earlier today; precompute row `value=4` computed 06:48Z, fresh — not the 999 stale-sentinel). The remaining repair (`remap_topshot_parallel_to_base_misattributed()`, no cron) is Trevor's call. **No action.**
- **`ts_uuid_dupes_created_24h`=0**, sentinel_ts_uuid_editions_48h=0 — DQ4 leak quiet.
- **Cross-collection refresh (1a) healthy:** rpc-ccm-step1/step2 both `active`, both `succeeded` last night (23:10Z / 23:25Z); cohort_mat 182 rows @ 16.0h, ts_set_overlap_mat @ 15.7h. Fresh.
- **Vercel:** no ERROR deploys in the last 20; top is CANCELED on a `docs(ledger)` commit (expected — docs tip doesn't rebuild); several READY present. `public_board_empty_count`/`public_board_slow_count`=0 (real board reads), so prod is serving.
- **pg_cron:** 11 jobs failed 08:30Z–12:52Z — **ALL `statement timeout` / `job startup timeout`, zero logic errors.** Section-1c saturation-collateral signature. This is the **#84 / M11 spell** already documented today (culprit: pg_cron jobid 355 `backfill_pinnacle_trade_acquisitions(50000)`, 60× runtime swing with backlog; batch-size fix deliberately QUEUED for a quiet-window BUFFERS measurement). **Positive control at 15:06Z: `io_wait=0, active=0` of 41 backends — the spell has CLEARED.** A valid quiet window exists right now for the #84 measurement the night pass owes (ephemeral — night pass should take its own reading).
- **`match-topshot-players` "running_but_not_succeeding" (medium):** once-daily 08:00Z job; 09-09 and 09-10 both `ok` with `rows_written=0` (0 rows is NORMAL for it); 09-11 08:00Z failed `upstream request timeout` — inside the spell window, clears next tick. **Spell collateral, not the 08-14 persistent-stall class.** No action.
- Other cron_silent mediums (allday-listings-indexer/-retry, pinnacle-events-ingest, snapshot-pack-asks, wmc-fmv-populate) all show heartbeat last_run ~12:20Z with silent_minutes ~165 — clocks reset by the same spell; expected to re-green on their next ticks.

## Candidate for the night pass

**[SYMPTOM — re-measure in a quiet window before acting] Two new Sentry "Consecutive HTTP" issues on the wallet-backfill routes.**
- Source: Sentry `JAVASCRIPT-NEXTJS-2R` (`/api/wallet-backfill-allday`, 2 events) and `JAVASCRIPT-NEXTJS-2Q` (`POST /api/wallet-backfill-pinnacle`, 1 event). Both first-seen ~08:00Z today, 0 users affected, http_client category.
- Not in the ledger; genuinely new today. But first-seen coincides with the #84 spell window, and the snapshot's `pipeline_fails_24h` shows wallet-backfill (10), -allday (4), -pinnacle (1) fails over the same period — consistent with backfill fetches timing out under saturation rather than a code-level N+1.
- **Risk read: low.** 0 users, ≤2 events, performance-span issue not an error.
- **Suggested action (night pass): quiet-window RE-MEASURE, do not conclude.** Check whether these Consecutive-HTTP spans persist OUTSIDE a spell. If they vanish → spell collateral, resolve in Sentry. If they recur on a quiet estate → the wallet-backfill routes issue serial upstream fetches worth batching/parallelizing (a genuine, still-low-risk fix). Do not derive a causal fix from readings taken during the spell.

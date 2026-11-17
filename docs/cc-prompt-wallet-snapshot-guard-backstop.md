# Claude Code prompt — concurrency-guard + GHA backstop for the wallet/snapshot writer families

The last cron-surface single-point-of-failure: `snapshot-institutional-wallets` and the `seed-wallet-refresh`/`wallet-backfill` family are triggered **only by cron-job.org**, which silently auto-disables a job that fails its 30s client cap (the class that killed `allday-fmv-populate` 06-26 and `topshot-sales-indexer` 05-31). Give them a redundant GitHub Actions trigger like the sales-indexer backstop — but do it correctly, because these are not cursor-idempotent like the sales indexers. **Re-measure every figure/path live before acting** (`docs/operations/cron-schedule.md` is the reference but re-confirm).

## Key correction — the hazard is NOT dup rows (verified this session)
Both families are already **row-level idempotent**: `wallet-backfill` writes via `upsert_wmc_batch` (`INSERT ... ON CONFLICT (wallet_address,collection_id,moment_id)`); the snapshot UPSERTs on `(wallet,collection,snapshot_at)` and `compute_institutional_wallet_diff` is `EXISTS`-guarded. So double-firing won't duplicate rows. The real cost of overlap is **2× expensive on-chain Cadence calls per wallet + Supabase connection-pool / IO saturation (the documented 2026-06-10 DBSAT incident class)**. So a *bare* backstop would just trade the silent-disable risk for a recurring 2×-Cadence/IO cost.

**Therefore: make a concurrent invocation a NO-OP (a guard) FIRST, then add the redundant GHA backstop.** With the guard in place, overlap is harmless — so there's **no atomic cutover**, and the cron-job.org entries can stay as a redundant trigger or be disabled later as optional cleanup. The guard also closes the onboarding/operator overlap hole (a pure cutover wouldn't).

## Guard pattern — reuse what's already in the codebase
- `pg_try_advisory_xact_lock(hashtext(<key>))` — advisory locks are already used by `award_points` / `redeem_shop_item`; auto-release on txn/function exit (no stuck-lock risk).
- Claim-row gold standard: `allow_list_claim_prewarm` (`FOR UPDATE SKIP LOCKED` → conditional UPDATE to `in_progress`, released by `allow_list_finish_prewarm`) — a drop-in template for a per-wallet claim.

## Family #1 — snapshot-institutional-wallets  [LOW risk; guard = belt-and-suspenders]
- Path: `app/api/cron/snapshot-institutional-wallets/route.ts` (thin trigger, `maxDuration=30`) → edge fn `supabase/functions/snapshot-institutional-wallets/index.ts` (real work in `runWork`, ~`index.ts:377`). cron-job.org: "RPC Snapshot Institutional Wallets", **daily 06:37 UTC**. The work is READ-only against `wallet_moments_cache` (no Cadence) → overlap is only an IO blip, so the guard is belt-and-suspenders.
- **Guard:** at the top of `runWork`, `SELECT pg_try_advisory_xact_lock(hashtext('snapshot-institutional-wallets'))`; if false, log a `snapshot-institutional-wallets` `pipeline_runs` row (`skipped_concurrent`) and return early.
- **Backstop:** a GHA workflow (or a step in an existing one) POSTing `/api/cron/snapshot-institutional-wallets` with `Bearer ${{ secrets.INGEST_SECRET_TOKEN }}`, at an empty minute ~30–60 min after 06:37 (e.g. `7 7 * * *`), `continue-on-error`, `timeout-minutes: 5`, `www.` host.

## Family #2 — wallet-backfill / seed-wallet-refresh  [the important one; overlap = 2× Cadence/wallet]
- Topology: `app/api/seed-wallet-refresh/route.ts` (cohort orchestrator, fired as **4 staggered cron-job.org entries** `?cohort=K&of=4` at `45/59 0,6,12,18` + `13/27 1,7,13,19` UTC) → fans to `app/api/wallet-backfill-multicollection/route.ts` → 5 children: `wallet-backfill` (TS), `-allday`, `-pinnacle`, `-golazos`, `-ufc`. The children are ALSO invoked by onboarding prewarm + ad-hoc operator curls → overlap is not only cron×GHA.
- **Guard (the key change — make the per-wallet walk a no-op under concurrency):** either
  - (preferred) `pg_try_advisory_xact_lock(hashtext('wallet-backfill:'||lower(wallet)||':'||collection))` taken inside `runBackfill` (`wallet-backfill/route.ts:~167`), replicated to the 4 sibling children; or
  - a `claim_wallet_backfill(wallet, collection)` RPC mirroring `allow_list_claim_prewarm` (small `wallet_backfill_locks` table or a column on `seeded_wallets`, `FOR UPDATE SKIP LOCKED`), released in a `finally`.
  - If the lock/claim isn't acquired → log `skipped_in_progress` + return 202 (do NOT 2×-walk). Keep the existing `skip_cached` behavior.
  - Optional coarse guard: advisory lock on `'seed-wallet-refresh:cohort:'||K` at the orchestrator so two whole-cohort waves can't stack.
- **Backstop:** a GHA workflow firing the 4 cohort URLs (`/api/seed-wallet-refresh?cohort=0..3&of=4`) on a schedule mirroring the cron-job.org windows, offset to empty minutes, one `continue-on-error` step per cohort, `www.` host.

## Verify
- **Guard works:** fire a child twice concurrently for the same wallet (or overlap a cohort wave with a manual GHA dispatch) → the 2nd logs `skipped_*`/no-ops; on-chain Cadence call volume does NOT double; pool/DBSAT stays stable (watch `pg_stat_activity` + the analytics-smoke saturation legs).
- **Backstop works:** each GHA schedule logs `ok` ticks at its slots; the pipelines keep cadence; `detect_stalled_pipelines()` stays `[]`; wmc row counts flat (no dup rows).
- `npx tsc --noEmit` clean; deploy READY + smoke.

## Revert
Per item: remove the advisory-lock lines / drop the `claim_wallet_backfill` RPC (+ `wallet_backfill_locks` table if added); delete the GHA workflow(s). Advisory-lock-only approach = no schema change to revert.

## Constraints / notes
- The delete-guard (`rpc_guard_block_destructive`) is LIVE on `wallet_moments_cache`/`editions`/`pinnacle_editions`. These families UPSERT wmc (not delete) → unaffected; don't introduce a bulk wmc delete.
- `.github/workflows/**` is CC-pushable (Trevor's gh auth); the nightly-pass PAT can't push workflows.
- **No atomic cutover needed.** Ship guard + backstop; the cron-job.org entries then stay (redundant, harmless) or get disabled later as optional cleanup — and that disable stays **operator-only** (the cron-job.org job pages expose `INGEST_SECRET_TOKEN` in the DOM).
- Pattern refs: `.github/workflows/sales-indexers-backstop.yml` + `rpc-pipeline.yml` (curl + Bearer + `continue-on-error` + `www.`); guard refs `allow_list_claim_prewarm` + `award_points`.

### Suggested order
Family #2 guard first (the only place overlap is actually expensive) → #2 backstop → #1 guard+backstop (low-risk, quick).

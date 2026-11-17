# Ledger note — wmc/pack_rips reindex jobs, index audit, and a live upsert bug (2026-07-13, Cowork)

Investigated the two `rpc_ox_reindex_*` cron jobs (per Trevor). Three findings; fold into `ledger.md`.

## 1. The reindex jobs were another session's experiment — already removed, and a non-problem
`rpc_ox_reindex_wmc2` (jobid 99, `REINDEX TABLE CONCURRENTLY wallet_moments_cache`, daily 23:13) and `rpc_ox_reindex_pack_rips2` (jobid 100, `pack_rips`, daily 23:20) were created ~23:1x UTC 07-13 by a **concurrent session** (jobid climbed 57→109, `cron_heavy` 18→19 during my checks — Claude Code, live-editing the scheduler). They ran once each, failed (both as `postgres`/120s — a REINDEX of a ~1.4 GB table can't finish in 120s), and that session **already removed them** (0 reindex jobs now). No leftover invalid `_ccnew` indexes.

They were solving a near-non-problem: heap dead is `wmc` 4.9% / `pack_rips` 1.0%, autovacuum current. **Do not revive a daily REINDEX cron** — wrong tool, wrong cadence, can't finish in-budget.

## 2. Index audit — one genuine reclaim, entangled with finding #3
- **`pack_rips` (858 MB idx):** all 6 indexes actively used (2.7K–33.7M scans), no duplicates. Nothing to drop; REINDEX would reclaim ~nothing.
- **`wallet_moments_cache` (653 MB idx):** nearly all used. The one large low-use index is **`wmc_wallet_moment_unique_idx` = `(lower(wallet_address), moment_id)`, 99 MB, 1,372 scans, backs no constraint.** Originally looked like a droppable legacy leftover — but see #3: it's tangled up with the broken upsert, so **do NOT drop it until #3 is resolved.**

## 3. BUG (the real find): `upsert_wallet_moments` is broken → silent wmc-write failure
`public.upsert_wallet_moments(text, uuid, jsonb)` does `INSERT INTO wallet_moments_cache … ON CONFLICT (wallet_address, moment_id) DO UPDATE …`. But **no unique index on `(wallet_address, moment_id)` exists** — only `(wallet_address, collection_id, moment_id)` (canonical constraint), `(lower(wallet_address), moment_id)`, and the PK. So the ON CONFLICT fails inference at plan time → **SQLSTATE 42P10 on every call** (confirmed empirically with a throwaway-row probe).

**Impact:** it's called live from `app/api/wallet/seed/route.ts:257`, which does `if (error) results.push({… status: rpc_error})` but **still returns `ok: true`** — so that path's wmc upsert has been **silently failing** (returns 200, writes nothing) since the plain `(wallet_address, moment_id)` unique index was removed/changed (the May-6 → later index churn). Other wmc writers (backfill RPCs / edge fns) are unaffected — wmc is still populated — so this is a broken secondary path, not a total outage, but it's a silent failure that should be fixed and its blast radius checked (which wallets rely on `/wallet/seed`).

**Recommended fix (one-line, DB-only migration; grants preserved on same signature):**
`CREATE OR REPLACE FUNCTION public.upsert_wallet_moments(...)` with `ON CONFLICT (wallet_address, collection_id, moment_id)` — the canonical constraint, which is correct because the function is collection-aware (takes `p_collection_id`, inserts it, and its trailing DELETE is already collection-scoped). It inserts `lower(p_wallet_address)`, so conflicts resolve on the stored lowercase wallet — consistent. Revert = restore the prior definition.

After the fix, revisit whether `wmc_wallet_moment_unique_idx` (99 MB) is still needed — if nothing infers on `(lower(wallet_address), moment_id)`, it becomes a clean 99 MB drop.

## Coordination
A concurrent session is actively editing cron right now. I left the scheduler and the wmc write-path untouched to avoid collision. The function fix (#3) is the highest-value item here.

# `idx_wmc_fmv_conf_null` — finding VERIFIED, fix READY, build BLOCKED on an idle window (and it left an INVALID index you must drop first)

Filed 2026-08-18 08:45 PT (15:45Z), from the daytime-monitor handoff of the same morning.

## ⚠ READ THIS FIRST — current live state

**An INVALID index named `idx_wmc_fmv_conf_null` exists on `public.wallet_moments_cache` right now.**
`indisvalid = false`, `indisready = false`, **0 bytes**. It is the residue of a
`CREATE INDEX CONCURRENTLY` that `statement_timeout` cancelled at 2 min.

- It is **inert**: `indisready = false` means writes do not maintain it and reads never use it. It is
  a catalog entry, not overhead. Leaving it costs nothing.
- ⛔ **But it makes the obvious retry silently do NOTHING.** The handoff's command uses
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS` — and the index **exists**, so `IF NOT EXISTS` skips the
  build, returns success, and leaves you with a permanently invalid index and an unchanged seq scan.
  **Drop it in the same statement/transaction as the rebuild.**

## The finding — INDEPENDENTLY RE-DERIVED, and it is correct

Re-measured rather than taken on trust, per the standing rule that a filed finding is a hypothesis:

- `cron.job` **jobid 302** `rpc-backfill-wmc-fmv-confidence`, schedule `2-59/5 * * * *`, `active = true`,
  command `SELECT public.backfill_wmc_fmv_confidence(NULL, 1000);` — confirmed verbatim.
- **Zero** indexes on `wallet_moments_cache` mention `fmv_confidence` (counted from `pg_indexes`).
- `idx_wmc_fmv_null` is
  `(collection_id, edition_key) WHERE fmv_usd IS NULL AND edition_key IS NOT NULL` — a **different
  column**, exactly as the handoff said.
- `EXPLAIN` on the exact target query reproduces the handoff's plan to the cost unit:

```
Limit  (cost=0.00..245.23 rows=1000 width=46)
  ->  LockRows  (cost=0.00..140409.77 rows=572559 width=46)
        ->  Seq Scan on wallet_moments_cache wmc  (cost=0.00..134684.18 rows=572559 width=46)
              Filter: ((fmv_confidence IS NULL) AND (edition_key IS NOT NULL))
```

~572k qualifying rows, full 874 MB heap scan, **~288x/day**, forever. The finding stands.

## Why it is not applied yet — and why "just run it" does not work here

`CONCURRENTLY` is **not achievable through the Supabase MCP**, which this session re-confirmed the
hard way and which was already recorded:

| route | result |
|---|---|
| lone `CREATE INDEX CONCURRENTLY` | escapes the txn, but is bound by the connection's **2 min `statement_timeout`** → `57014` cancel, leaves the invalid index |
| `SET statement_timeout='15min'; CREATE INDEX CONCURRENTLY …` | **`25001` cannot run inside a transaction block** — multi-statement `execute_sql` is txn-wrapped |
| `apply_migration` | always txn-wrapped → same `25001` |
| `pg_cron` | txn-wrapped → same `25001` |
| `DROP INDEX CONCURRENTLY` (to clean up) | **also cancelled at 2 min** — it waits out existing transactions, and the longest open one was **161 s** |
| non-concurrent `DROP INDEX` with `SET LOCAL lock_timeout='4s'` | **`55P03` lock timeout** — could not get `ACCESS EXCLUSIVE` on the hot table |

The `lock_timeout` guard did its job: it failed harmlessly instead of forming a lock convoy.

**The working route is the recorded one: a PLAIN (non-concurrent) build in a VERIFIED-IDLE window**,
where the exclusive lock is uncontended and the build finishes inside the 2 min ceiling.

⛔ **Do not fire it during a spell.** A plain build takes `ACCESS EXCLUSIVE` on
`wallet_moments_cache` and **blocks every read of the product's hottest table** for the build's
duration. Conditions while this was attempted: **28-34 active sessions, 100% of them in IO wait**,
longest query 272 s, an `autovacuum` on this same table running over an hour. That is the opposite
of the required window.

**Idle-window test before firing** (all must hold):

```sql
SELECT count(*) AS active,
       count(*) FILTER (WHERE wait_event_type='IO') AS io_wait,
       max(EXTRACT(epoch FROM now()-query_start))::int AS longest_s,
       (SELECT count(*) FROM pg_stat_progress_vacuum) AS vacuums
FROM pg_stat_activity WHERE state='active' AND pid <> pg_backend_pid();
-- require: active ~0, io_wait ~0, longest_s < 15, vacuums = 0
```

## READY TO FIRE — one `apply_migration`, in an idle window

Non-concurrent, so it is txn-safe and `apply_migration` is the right channel. The `DROP` is what
clears the invalid residue; without it the `CREATE` is a silent no-op.

```sql
SET LOCAL lock_timeout = '4s';
SET LOCAL maintenance_work_mem = '128MB';
DROP INDEX IF EXISTS public.idx_wmc_fmv_conf_null;
CREATE INDEX idx_wmc_fmv_conf_null
  ON public.wallet_moments_cache (collection_id, edition_key)
  WHERE fmv_confidence IS NULL AND edition_key IS NOT NULL;
```

If `55P03` comes back, the window was not idle — **wait, do not retry in a loop**, and do not raise
`lock_timeout` to force it.

## Verify after

1. `SELECT indisvalid, indisready FROM pg_index JOIN pg_class c ON c.oid=indexrelid WHERE c.relname='idx_wmc_fmv_conf_null';`
   → both **true**. (This is the step that catches a repeat of the invalid-index residue.)
2. Re-run the `EXPLAIN` above → expect an Index/Bitmap Index Scan, **not** `Seq Scan`.
3. `SELECT public.backfill_wmc_fmv_confidence(NULL, 1000);` → similar non-zero count to before; same
   rows, found faster.

## Revert

`DROP INDEX CONCURRENTLY IF EXISTS public.idx_wmc_fmv_conf_null;` in an idle window (or plain
`DROP INDEX` with the `lock_timeout` guard). Purely additive — no function, cron, ACL or data change.

## Confirmed from the handoff, not re-litigated

The handoff's own exclusions were checked and hold: every index on the table is used (all 14, minimum
~617 scans, `idx_wmc_moment_collection_cover` at 99M) so there is **no dead index to drop**; and the
`fmv_confidence IS NULL` vs `fmv_usd IS NULL` sets are genuinely different, so repointing the
function's predicate instead of adding the index would silently skip rows — the new index is the
behaviour-preserving fix.

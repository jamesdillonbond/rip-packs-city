# `query_sql` is the database's #1 reader over 24 h, and `fmv-recalc` owns it — seven ad-hoc scans per run, 153 runs a day

**Filed 2026-09-04 05:00Z (2026-09-03 22:00 PT) · Claude Code on Trevor's box, interactive · measured, NOT shipped — the fix is a restructure of a pipeline the register already classifies as "wasteful, NOT broken", so it is filed for a daytime pass, not done at 22:00**

## The measurement

`ops_pgss_delta('24 hours', 12)`, baseline 2026-09-03 04:05Z (a full day):

| rank | statement | calls | ms/call | total s | blocks read |
|---|---|---:|---:|---:|---:|
| 1 | `public.query_sql(query)` via PostgREST | **2,171** | **2,436** | **5,290** | **12,125,016** |
| 2 | `refresh_wmc_fmv_changed(…)` (pg_cron) | 150 | 18,656 | 2,798 | 3,588,017 |
| 3 | `claim_sales_counterparty_batch(…)` | 296 | 6,282 | 1,859 | 3,089,242 |
| 4 | `get_lock_check_batch(…)` | 98 | 20,534 | 2,012 | 2,610,953 |

`query_sql` reads **3.4× the blocks of the next statement**. It is `SECURITY DEFINER`, `service_role`-only (anon/authenticated revoked — checked), a generic `EXECUTE format('SELECT … FROM (%s) t', query)` wrapper, so `pg_stat_statements` sees ONE queryid for every query ever passed through it. **That is the finding's shape: the platform's biggest reader is invisible by construction — every ad-hoc scan collapses into one row whose text is `%s`.**

## Attribution (by caller, since the statement cannot split it)

Repo callers of `rpc("query_sql")` (a Grep, comments stripped by reading): `app/api/fmv-recalc/route.ts` **×7** (L1110 missing-snapshot count over `editions`, L1124 uncovered editions, L1286 historical candidates CTE, L1502 ask-only backfill, L1605 parallel-ask backfill, L1707 AllDay ask backfill, L1819 stale touch when `forceStale`), `lib/pack-dist/fetchers.ts` ×1 (a `SUM(drop_weight)` over `pack_drop_pool` per pack-dist page view — small), `app/api/edition-stats/route.ts` ×1, `app/api/admin/pipeline-health/route.ts` ×1, and five ops scripts (parity, pin-staleness, duplicate-cron, recover-fileless, all rare).

`pipeline_runs`: **`fmv-recalc` ran 153 times in the same 24 h** (avg 64.5 s). 153 × ~6–7 scans ≈ **1,000–1,070 of the 2,171 calls**, and they are the heavy ones (the `editions` ⋈ `fmv_snapshots` "missing / uncovered / historical" scans); the pack-dist and edition-stats calls are cheap point reads. So the ~5,300 DB-seconds a day are, to first order, fmv-recalc's inline SQL.

## Why nothing shipped

- The register already carries fmv-recalc as **"wasteful, NOT broken"** (CLAUDE.md open items; `npm run pipelines:kills` reads it RECOVERED). Its cadence and shape are a standing decision, and this filing changes the SIZE of the waste, not its verdict.
- The right fix is not "make query_sql faster": each of the seven scans should become a **named SQL function with its own queryid** (so the cost becomes visible per scan) and, for the two `editions ⋈ fmv_snapshots` scans, a **scoped predicate + covering index** measured by BUFFERS, not timings (database.md rule). That is an afternoon with a control, not a 22:00 push.
- ⚠ Do NOT lower `fmv-recalc`'s cadence as the lever without reading #42 first — the 08-30 cadence cut was REVERTED and the revert confirmed.

## Falsifier / re-derive

```sql
select * from ops_pgss_delta('24 hours'::interval, 5);
```
If `query_sql` is not in the top 3 by `d_shared_blks_read`, the attribution is stale. If it is, count `pipeline_runs` rows for `fmv-recalc` in the same window and multiply by 7 — the product should be within ~30 % of `d_calls`.

# `idx_wmc_fmv_conf_null` is BUILT — and the route that built it overturns a recorded "impossible". The backfill is still converting ~0 rows, for a different reason.

Filed 2026-08-18 10:25 PT (17:25Z), by Claude Code (interactive), landing the daytime-monitor handoff
`docs/handoff-2026-08-18-wmc-backfill-seqscan.md` and the 15:45Z inbox filing.

## SHIPPED — the index exists and the seq scan is gone

`public.idx_wmc_fmv_conf_null` on `wallet_moments_cache (collection_id, edition_key)
WHERE fmv_confidence IS NULL AND edition_key IS NOT NULL` — **`indisvalid = true`, `indisready = true`,
4,400 kB**. Built `CONCURRENTLY`, so **zero `ACCESS EXCLUSIVE` time on the hottest table product-wide**.

Measured before/after on the function's exact target query:

| | plan | cost of one tick |
|---|---|---|
| before | `Seq Scan on wallet_moments_cache` (`cost=0.00..134684.18`, 874 MB heap) | 32 s+, ~288x/day |
| after | `Index Scan using idx_wmc_fmv_conf_null` (`cost=0.42..112554.89`) | **46 ms** |

`SELECT public.backfill_wmc_fmv_confidence(NULL, 1000)` now returns in **46 ms–3.0 s**. The
every-5-minute full-heap scan the handoff set out to kill is **gone**. That was the IO objective and
it is met.

## ⚠ THE ROUTE — `CREATE INDEX CONCURRENTLY` **IS** reachable from here. The 15:45Z filing was wrong about pg_cron.

That filing recorded pg_cron as txn-wrapped → `25001`, and concluded the only route was a **plain
non-concurrent build in a verified-idle window** (which would have meant an exclusive lock on
`wallet_moments_cache` for the build's duration). **Re-derived, and it is not true.**

`SHOW cron.use_background_workers` = **`off`**. With background workers off, pg_cron connects over
**libpq** and sends the job command as a simple query. A **single-statement** command is therefore
its own implicit transaction — exactly what `CONCURRENTLY` requires. The `25001` the earlier session
hit is real but is a property of **multi-statement** commands (`SET …; CREATE INDEX CONCURRENTLY …`),
which libpq wraps in an implicit transaction block. One statement, no wrapper, no error.

**The recipe, proven end-to-end today:**

1. `ALTER ROLE postgres IN DATABASE postgres SET statement_timeout = '30min';` — the global default is
   **120000 ms from `/etc/postgresql-custom/platform-defaults.conf`**, and `postgres` had no
   `rolconfig` override, so a fresh pg_cron libpq login inherits 2 min and the build dies there. This
   is applied at LOGIN, so it must be set **before** the job fires. ⚠ **Revert it immediately after.**
2. `SELECT cron.schedule('<name>', '<minute> * * * *', '<ONE statement, no trailing semicolon needed>');`
3. Once the run appears in `pg_stat_progress_create_index`, **`cron.alter_job(<id>, schedule := '55 5 1 1 *')`**
   so it cannot re-fire. Do **not** `cron.unschedule` a job whose run is in flight.
4. Verify, then `cron.unschedule(<id>)` and `ALTER ROLE postgres IN DATABASE postgres RESET statement_timeout;`

Timings observed: `DROP INDEX CONCURRENTLY` ~90 s (all of it `Lock/virtualxid`, waiting out open
transactions — it blocks nobody); `CREATE INDEX CONCURRENTLY` ~2 m 20 s end-to-end (≈40 s waiting for
writers, then 113,729 blocks scanned, then a validation pass).

**Two other corrections to the record, both measured:**

- ⚠ **Index DDL causes NO `PGRST002` burst.** CLAUDE.md says every `apply_migration` triggers a
  10–20 s schema-cache re-introspection. Read `pgrst_ddl_watch` / `pgrst_drop_watch`: they notify only
  for an explicit command-tag list (`CREATE TABLE`, `ALTER TABLE`, views, functions, types, `COMMENT`
  …). **`CREATE INDEX` / `DROP INDEX` and the object type `index` are on neither list.** This change
  caused no user-facing 500s.
- ⚠ **Plain `DROP INDEX` with `SET LOCAL lock_timeout='3s'` still `55P03`'d** even on the *invalid,
  `indisready=false`, 0-byte* stub. The stub is inert but dropping it still needs `ACCESS EXCLUSIVE`
  on the table, and this table never goes quiet enough during the day. `CONCURRENTLY` via the route
  above is what cleared it.

## ⛔ THE BACKFILL IS STILL CONVERTING ~0 ROWS — and the index is not why

Two consecutive manual ticks after the index landed returned **2 rows, then 0 rows**. The index made
the tick *cheap*; it did not make it *productive*. Measured cause:

`backfill_wmc_fmv_confidence` applies `LIMIT p_limit` **inside the `targets` CTE, before the join** to
`editions`/`fmv_snapshots`. So the tick only ever examines the first 1,000 rows of the scan, and rows
that fail the join stay `fmv_confidence IS NULL` and **remain at the head forever**. Of the exact
1,000 rows the function selects:

- **6 have a matching `editions` row at all** (994 have none).
- The head is **19,994 / 20,000 `disney_pinnacle`**, spanning only **199 distinct `edition_key`s**.

That is the documented Pinnacle key problem, not a new one. The function joins
`e.external_id = wmc.edition_key` — **the single-key Pinnacle join CLAUDE.md's concierge rule 2
forbids** ("NEVER join by `edition_key` alone — always the triple
(`character_name`, `set_name`, `variant_type`)"). It also matches the existing memory
"wmc carries fmv_confidence — backfill draining, **Pinnacle NOT covered**". The new part is that the
uncovered Pinnacle rows **sit at the head of the scan and starve the ~550k rows behind them**, so
"Pinnacle not covered" is silently also "nothing else gets covered either".

⚠ **Stated as hypothesis, NOT measured:** the index may have made this *stickier* than the seq scan
did. A seq scan returns heap order, which churns as rows are updated; the index returns a
deterministic `(collection_id, edition_key)` order, so the same head block is re-read every tick. I
**cannot** measure the pre-index head's resolvability — that scan order no longer exists — so this is
a mechanism, not a finding. **The starvation itself is in the function's `LIMIT`-before-`JOIN`, which
predates the index.**

**Not fixed here, deliberately** — the handoff's scope was the index, and changing this is FMV-pipeline
logic. Options for whoever picks it up, cheapest first:

1. **Pass `p_collection_id` per tick.** The parameter already exists and the cron passes `NULL`; the
   new index leads on `collection_id`, so per-collection ticks are cheap and a starved Pinnacle head
   stops blocking Top Shot / All Day / UFC. Smallest change, no join-logic risk.
2. Move the join above the `LIMIT` (select 1,000 *resolvable* targets rather than 1,000 targets).
   Bigger cost profile — measure buffers before shipping.
3. Fix Pinnacle resolution properly via the triple / `render_id` re-key. Largest, and the real fix.

⚠ **Whatever ships, note that `rows_written`/return-count is a null instrument here** — this job
returned "1 row" and `succeeded` on 41 of 72 runs while converting essentially nothing.

## Also corrected: what job 302's failures actually were

The handoff states 302 "failed 31 of 31 runs in the last 6 hours, every one `canceling statement due
to statement timeout`". Re-read from `cron.job_run_details`: in that window it was **41 succeeded /
31 failed**, and every failure message is **`job startup timeout`** — pg_cron never launched the tick
(the recorded "a tick that never started writes no row" mode), *not* a statement-timeout cancel of the
seq scan. The job was doing real work at ~57% of ticks, so the handoff's "strictly wasteful, nothing
is lost by pausing it" justification did not hold. It was still paused for the build window and has
been **resumed** (`active = true`; the 17:22Z run succeeded).

## Current state — verified, nothing left behind

- `idx_wmc_fmv_conf_null`: valid / ready / 4,400 kB.
- cron **302** `rpc-backfill-wmc-fmv-confidence`: **active = true**, last run 17:22Z **succeeded**.
- Temporary one-shot jobs 343 / 344: **unscheduled** (`0` jobs matching `rpc-oneshot-%`).
- `postgres` role `statement_timeout` override: **reverted** (`0` rows in `pg_db_role_setting`).

## Revert

`DROP INDEX CONCURRENTLY IF EXISTS public.idx_wmc_fmv_conf_null;` — via the pg_cron route above.
Purely additive: no function, cron, ACL, data or repo change.

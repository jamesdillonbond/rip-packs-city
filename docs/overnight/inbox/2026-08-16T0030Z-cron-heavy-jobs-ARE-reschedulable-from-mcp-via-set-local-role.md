# MEMORY / CORRECTION — `cron_heavy`-owned pg_cron jobs ARE reschedulable from the MCP/SQL editor; the "needs superuser/dashboard" claim is WRONG

**Found** 2026-08-15 (Trevor, interactive), verified in a rolled-back `DO` block. **This corrects a canonical claim** — fold into the CLAUDE.md cron section and supersede the "PERMISSION DEAD END" section of `docs/overnight/inbox/2026-08-15T1630Z-three-heavy-pg-cron-jobs-collide-at-minute-13.md`, which states rescheduling jobs 71/109 "requires a superuser or the Supabase dashboard — it cannot be done from the MCP/SQL editor as postgres." That is false.

## The correction

`cron.alter_job` genuinely is a pincer (both halves confirmed):
- as `postgres` → `ERROR: Job N does not exist or you don't own it` (71/109 are owned by `cron_heavy`).
- as `cron_heavy` (`SET LOCAL ROLE`) → `ERROR: 42501: permission denied for function alter_job` (the function is owned by `supabase_admin`; `cron_heavy` has no EXECUTE; `postgres` is not a member of `supabase_admin`, so it cannot grant one).

**But `cron.schedule` is not `cron.alter_job`.** `cron_heavy` CAN execute `cron.schedule`, and **`postgres` IS a member of `cron_heavy`**. So the working path from the MCP/SQL editor as `postgres` is:

```sql
SET LOCAL ROLE cron_heavy;
SELECT cron.schedule('<existing job name>', '<new schedule>', '<same command>');
```

Called with an **existing job name**, `cron.schedule` UPDATES IN PLACE — same jobid, no duplicate row.

## The load-bearing subtlety (and why the 1630Z warning was over-broad)

The 1630Z filing warned: "DO NOT `cron.schedule()` with the same name — it re-owns the job as `postgres` and drops its 600s `statement_timeout`." **That is true ONLY when run as `postgres`.** Run under `SET LOCAL ROLE cron_heavy`, the owner is set to the *current role* = `cron_heavy`, so the re-own is a **no-op** and the `cron_heavy` role-level `statement_timeout=600s` in `rolconfig` is retained. The `SET LOCAL ROLE cron_heavy` line is therefore load-bearing, not optional — dropping it reintroduces exactly the ownership/timeout regression the warning describes.

Probe result (rolled-back `DO` block, nothing written): **2 rows, not 4** (in-place update), jobids 71/109 preserved, owner still `cron_heavy`, schedules updated to `40 * * * *` / `25 4,16 * * *`; rollback verified (both back to `:13`).

## Safety notes carried with it

- **Probe in a rolled-back `DO` block first** — apply the schedule, read back the row state, then let the block roll back — before writing for real.
- **Read each job's `command` IN-BLOCK, never return it.** `cron.job.command` for gate-keyed jobs can contain a `?key=` secret; select it into a local variable and pass it straight to `cron.schedule`, never `SELECT` it to output. (Same class as the `get_edge_function`/cron-console gate-key leaks.)
- No DDL → no `PGRST002` schema-cache burst; does not need batching with any migration.

## Status of the actual `:13` stagger (the reason this path was found)

**NOT applied as of 2026-08-16T00:30Z** — jobs 71 and 109 are still both on `13 * * * *` / `13 4,16 * * *`, both `cron_heavy`. Staged for the operator to run + ledger atomically (a monitor/no-push session can't ledger a prod change). Ready block (revert = same block with `'13 * * * *'` / `'13 4,16 * * *'`):

```sql
do $$
declare c71 text; c109 text;
begin
  set local role cron_heavy;
  select command into c71  from cron.job where jobid = 71;
  select command into c109 from cron.job where jobid = 109;
  perform cron.schedule('rpc-backfill-historical-pack-ev',      '40 * * * *',    c71);
  perform cron.schedule('rpc-refresh-special-serial-owners-mv', '25 4,16 * * *', c109);
end $$;
```

⚠ Expectation-setting (from 1630Z's own UPDATE): this stops the guaranteed three-way `:13` pile-up but the schedule is oversubscribed for a 2-core/2GB instance — a small improvement, not the saturation cure. Confirm via `refresh-insights-cache` board-warm failure rate over the following day (`pipeline_runs.extra->'boards'`), same clock-hours, not the next tick. The real levers remain the structural filings (fmv-recalc page size, wmc-denorm fan-out, 8-way trust-precompute split).

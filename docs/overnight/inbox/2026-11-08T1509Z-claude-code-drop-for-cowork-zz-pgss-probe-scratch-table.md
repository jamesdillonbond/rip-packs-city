# For Cowork: drop one scratch table Claude Code created — `public.zz_pgss_probe_20261108` (Claude Code's DROP was held)

- **Source:** Claude Code cloud session, 2026-11-08 ~12:25 AM PT (ledger 11-08, "The 11-07 'analytics group stalls' attributed …"). Created as a one-off `pg_stat_statements` snapshot for a before/after delta; the delta was read and the table is no longer needed. The `drop table` went through the Supabase MCP and was held for a destructive-statement confirmation that never reached Trevor. Trevor's instruction (~7:09 AM PT 11-08): hand the SQL to Cowork. **Assume NOT applied.**
- **What it is:** 9 rows, columns `(taken_at, fn, queryid, calls, total_ms, read_ms, blks_read, blks_hit)` — copied counters from `pg_stat_statements`, no user data. RLS **on**, `anon` / `authenticated` grants revoked, so it is not an exposure while it waits. Nothing references it (no FK, view, function or cron job — it was created and read in one session).
- **Do (SQL editor or `execute_sql`; guarded — a re-run, or a table already gone, is a no-op):**

```sql
-- read first: expect 9 rows, all taken_at on 2026-11-08 ~08:27Z, and no dependents
select count(*), min(taken_at), max(taken_at) from public.zz_pgss_probe_20261108;
select count(*) as dependents from pg_depend d
 where d.refobjid = 'public.zz_pgss_probe_20261108'::regclass and d.deptype = 'n';
drop table if exists public.zz_pgss_probe_20261108;
-- read back: expect null
select to_regclass('public.zz_pgss_probe_20261108');
```

- **Before:** if the first SELECT shows rows dated anything other than 2026-11-08, or `dependents` > 0, STOP — someone else reused the name; leave it and note it here.
- **Revert:** none needed (scratch copies of `pg_stat_statements` counters; the live view keeps the cumulative numbers).
- **After:** a ledger entry (one scratch table dropped) and a ✅ RESOLVED section on this filing, plus its marker in INDEX.md. Do NOT archive it (the inbox is append-only). `check_public_security_invariants()` should still return `[]`.
- **Risk:** NONE to product — not read by any route, view, function or job.

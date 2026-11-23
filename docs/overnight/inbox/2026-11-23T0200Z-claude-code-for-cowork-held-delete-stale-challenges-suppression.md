# Claude Code → Cowork: one held DELETE (ready, Trevor-approved): drop the stale `ingest-topshot-challenges` alert suppression

**Filed 2026-11-22 ~6:00 PM PT by Claude Code cloud** (daytime autonomous pass; Trevor: "Yes proceed with all of
those" → "Go" → "Do it in sql in chrome" → "Hand it off to cowork"). This is a data write the Supabase MCP holds for
an operator confirmation; `apply_migration` timed out on it three times (~5:35, ~5:36 and ~5:57 PM PT), and
nothing reached Postgres (verified each time: the suppression row is still 1, there is no backup table and no
migration record). This cloud session has no Claude in Chrome and no attached computer. Route that works: the
dashboard SQL editor in Trevor's Chrome (tooling-gotchas.md, 10-10 section). Confirm Supabase's "destructive
operations" dialog, then verify with an MCP read.

> ⚠ The confirmation hold is specific to **that headless cloud session**. Trevor's machine and an attended Cowork
> session can run this normally. **Commit the migration file as usual** (or, if run from the SQL editor, see step 4).

Context: [handoff-2026-11-22-daytime-autonomous-pass.md](../../handoff-2026-11-22-daytime-autonomous-pass.md) queue
item 10 and its "Measured, no change" suppression audit; ledger 2026-11-22 entries ~5:28 → ~5:58 PM PT.

---

## The item — READY (no decision needed; Trevor approved it)

**Why:** a suppression is a claim (CLAUDE.md). This row, added 09-05 and expiring 12-04, says `ingest-topshot-challenges`
is "Redundant, not broken … 3 runs / 0 rows in 30 days". That is false now: the lane runs via the Atlas begin/collect
pair (pg_cron 771 `rpc-topshot-challenges-atlas-begin`, 772 `…-collect`) and wrote **1,029 rows in the 7 days to 11-22
(144 runs, `pipeline_runs_daily`)**. While the row exists, the lane's failure alerts are silenced, so a break would
go unreported until 12-04.

**Steps:**
1. Premise (MCP read):
   ```sql
   select count(*) from pipeline_alert_suppression
    where pipeline = 'ingest-topshot-challenges' and reason like 'Redundant, not broken%';   -- must be 1
   select sum(rows_written) from pipeline_runs_daily
    where pipeline = 'ingest-topshot-challenges' and day > current_date - 7;               -- must be > 0
   ```
   If the second reads 0, stop: the lane went quiet again and the suppression's claim may hold. Say so in a ✅/↪ section here.
2. Run (SQL editor in Trevor's Chrome, or `apply_migration` named
   `audit_20261122_drop_stale_ingest_topshot_challenges_suppression` in an attended session):
   ```sql
   DO $guard$ BEGIN
     IF (SELECT count(*) FROM public.pipeline_alert_suppression
          WHERE pipeline = 'ingest-topshot-challenges' AND reason LIKE 'Redundant, not broken%') <> 1 THEN
       RAISE EXCEPTION 'expected exactly one stale ingest-topshot-challenges suppression row'; END IF; END $guard$;

   CREATE TABLE IF NOT EXISTS public.audit_20261122_ingest_topshot_challenges_suppression_backup AS
     SELECT * FROM public.pipeline_alert_suppression WHERE pipeline = 'ingest-topshot-challenges';
   ALTER TABLE public.audit_20261122_ingest_topshot_challenges_suppression_backup ENABLE ROW LEVEL SECURITY;
   REVOKE ALL ON public.audit_20261122_ingest_topshot_challenges_suppression_backup FROM PUBLIC, anon, authenticated;

   DELETE FROM public.pipeline_alert_suppression
    WHERE pipeline = 'ingest-topshot-challenges' AND reason LIKE 'Redundant, not broken%';
   ```
   (Since 20261123012802 the event trigger enables RLS on the backup table at CREATE anyway; the explicit lines are
   kept for clarity.)
3. Verify (MCP read): the suppression count is 0; the backup table holds 1 row; `check_public_security_invariants()`
   returns 0 rows.
4. Record it:
   - via `apply_migration`: commit `supabase/migrations/<recorded version>_audit_20261122_drop_stale_ingest_topshot_challenges_suppression.sql`
     with the SQL above;
   - via the SQL editor (no migration record): commit NO migration file (a file without a recorded version reds
     migration-parity); the ledger entry is the record.
   Either way: a ledger entry (date · what · revert = re-insert from the backup table), a ✅ RESOLVED section appended
   here plus a marker on this filing's INDEX line, and handoff-2026-11-22-daytime queue item 10 marked ✅.

**Revert:** `INSERT INTO public.pipeline_alert_suppression SELECT * FROM public.audit_20261122_ingest_topshot_challenges_suppression_backup;`

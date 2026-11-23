# Claude Code → Cowork: two held DELETEs (ready, Trevor-approved; item 2 added 11-22 ~11:20 PM PT): drop the stale `ingest-topshot-challenges` alert suppression

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

---

## Item 2 (added 2026-11-22 ~11:20 PM PT, Claude Code cloud, evening pass; Trevor: "Keep going") — READY, time-boxed: retire two cadence bridges whose baseline is clean

**Held twice** by the MCP confirmation prompt (`apply_migration` ~11:12 and ~11:16 PM PT); nothing reached Postgres
(verified: both rows present, no backup table, no migration record).

**Why:** `cadence_exempt_lanes` rows `pack-pulls-chain-history` and `pinnacle-pack-openers` (cadence cut 11-10,
`20261110203906`) have `review_by = 2026-11-23`. When the DB date rolls (**4:00 PM PT 11-23**) they lapse, and
`summariseCadenceCollapse` floors the sentinel cadence arm at **WARN** ("an unreviewed suppression list is itself
the finding"). The review is done: each row's own condition, "lapses when the baseline is clean", holds. Measured
~11:15 PM PT 11-22 against the 11-24 baseline window (`pipeline_runs_daily` 11-07..11-20, median) vs the last 12 h:
`pack-pulls-chain-history` 120/day vs 120/day, `pinnacle-pack-openers` 144/day vs 144/day (ratio 1.000; trips at 0.40).

**Steps:**
1. Premise (MCP read): both rows exist with `review_by = '2026-11-23'`; re-run the ratio (each ≥ 0.40):
   ```sql
   with base as (select pipeline, percentile_cont(0.5) within group (order by runs)::numeric med
     from pipeline_runs_daily where day >= current_date - 17 and day < current_date - 3
      and pipeline in ('pack-pulls-chain-history','pinnacle-pack-openers') group by 1),
   obs as (select pipeline, count(*)*2.0 per_day from pipeline_runs where started_at > now()-interval '12 hours'
      and pipeline in ('pack-pulls-chain-history','pinnacle-pack-openers') group by 1)
   select b.pipeline, b.med, o.per_day, round(o.per_day/b.med,3) ratio from base b left join obs o using(pipeline);
   ```
   A ratio < 0.40 → stop: the lane really did collapse, and the lapse is right.
2. Run (SQL editor, or `apply_migration` named `audit_20261122_retire_two_cadence_bridges_whose_baseline_is_clean`):
   ```sql
   CREATE TABLE IF NOT EXISTS public.audit_20261122_cadence_bridges_retired_backup AS
     SELECT * FROM public.cadence_exempt_lanes
     WHERE pipeline_pattern IN ('pack-pulls-chain-history', 'pinnacle-pack-openers');
   ALTER TABLE public.audit_20261122_cadence_bridges_retired_backup ENABLE ROW LEVEL SECURITY;
   REVOKE ALL ON public.audit_20261122_cadence_bridges_retired_backup FROM PUBLIC, anon, authenticated;
   DELETE FROM public.cadence_exempt_lanes
   WHERE pipeline_pattern IN ('pack-pulls-chain-history', 'pinnacle-pack-openers') AND review_by = DATE '2026-11-23';
   ```
3. Verify: `select (check_pipeline_cadence_collapse())->'expired_exemptions'` has neither pattern; neither lane is
   in `degraded`/`stopped`.
4. Record as in item 1 step 4. **If done after 4 PM PT 11-23** the sentinel will already have read WARN for the
   lapse; the same delete clears it.

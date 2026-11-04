-- STAGED 2026-11-04 2:55 PM PT (Claude Code cloud) — NOT APPLIED. The Supabase connector's destructive-statement
-- confirmation timed out unanswered. Run this whole file as ONE apply_migration (or the dashboard SQL editor, then
-- record the version); it RAISEs and rolls back unless exactly 4,361 rows are deleted. After: name the migration file
-- for the version it gets, delete this staged file, ledger entry.
--
-- 2026-11-04 (Claude Code cloud) — step 2 of 2: delete the 4,361 Top Shot "sales" that are cancelled
-- listings (backed up in step 1, 20261104224945 — read that file for the evidence), and drop the dormant
-- function that wrote them.
--
-- Before: 139 of the 1,613 editions showed one of these as their NEWEST sale; 14 had no other sale.
-- All are sold 08-10 → 09-09 (56+ days old), so the 30-day HIGH/MEDIUM inputs never saw them; they fed
-- sale history, "last sale" figures, 90-day stats, the #209 STALE last-sale cap and sales volume boards.
-- Editions re-price on their next fmv-recalc pass.
--
-- backfill_topshot_sales_from_atlas_events(integer, timestamptz): 0 pg_cron jobs, 0 pipeline_runs ever,
-- 0 callers in app/lib/scripts/functions/.github; anon/authenticated EXECUTE false. Its predicate
-- (`completed IS TRUE`, never `purchased`) is the defect, so it is dropped, not kept for a re-run.
-- The live Atlas lane, sync_sales_from_atlas(), already requires `ev.purchased` and is untouched.
--
-- Revert:
--   INSERT INTO public.sales SELECT * FROM public.audit_20261104_atlas_backfill_cancelled_listing_sales;
--   (and re-apply 20260909003000 to recreate the function — do not, its predicate is the bug)

DO $$
DECLARE n_backup int; n_del int;
BEGIN
  SELECT count(*) INTO n_backup FROM public.audit_20261104_atlas_backfill_cancelled_listing_sales;
  IF n_backup <> 4361 THEN
    RAISE EXCEPTION 'backup holds % rows, expected 4361', n_backup;
  END IF;

  DELETE FROM public.sales s
   USING public.audit_20261104_atlas_backfill_cancelled_listing_sales b
   WHERE s.id = b.id
     AND s.source = 'atlas_backfill'
     AND s.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  GET DIAGNOSTICS n_del = ROW_COUNT;
  IF n_del <> 4361 THEN
    RAISE EXCEPTION 'deleted % sales rows, expected 4361 — rolled back', n_del;
  END IF;
END $$;

DROP FUNCTION public.backfill_topshot_sales_from_atlas_events(integer, timestamptz);

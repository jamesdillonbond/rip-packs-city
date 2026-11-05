-- APPLIED 2026-11-04 ~5:05 PM PT (Cowork cloud, Trevor's Chrome) via the Supabase dashboard SQL editor as ONE batch;
-- the MCP apply_migration was auto-cancelled (DELETE). Pre-check 4:40 PM PT: backups 4,361 / 1,036, overlap 0,
-- live matches 4,361 / 1,036, no FKs reference sales. Post-check: live matches 0 / 0, function gone; editor "Success".
-- Top-100 Top Shot sales by price (90 d) after: max $11,000, 8 atlas_backfill rows left (not in either class).
-- This version is the record-only apply (SELECT 1); the body that ran follows, verbatim from the staged file.
--
-- STAGED 2026-11-04 (Claude Code cloud) — NOT APPLIED. The claude.ai Supabase connector's destructive-statement
-- confirmation timed out unanswered twice (~2:50 and ~3:27 PM PT). Run this whole file as ONE apply_migration
-- (or the dashboard SQL editor, then record the version by hand). It RAISEs and rolls back unless exactly
-- 4,361 + 1,036 = 5,397 rows are deleted. After: name the migration file for its version, delete this staged
-- file, ledger entry, mark the focus.md steer ANSWERED.
--
-- Deletes the Top Shot "sales" that the 09-09 Atlas recovery wrote from listings that did NOT sell, both
-- classes already backed up:
--   class 1  audit_20261104_atlas_backfill_cancelled_listing_sales   (20261104224945)  4,361 · $388,216
--            Atlas's own record: the listing ended with purchased = false, and no purchased listing within ±2 min.
--   class 2  audit_20261104_atlas_backfill_seller_kept_moment_sales  (20261104233041)  1,036 · $75,039
--            the seller kept the Moment: they sold it again later, or still hold it (control: 0.6 % / 0 %).
-- …and drops the dormant function that wrote them, backfill_topshot_sales_from_atlas_events(integer,
-- timestamptz): 0 pg_cron jobs, 0 pipeline_runs ever, 0 code callers, anon/authenticated EXECUTE false; its
-- predicate (`completed IS TRUE`, never `purchased`) is the defect. The live lane sync_sales_from_atlas()
-- already requires `ev.purchased` and is untouched. Editions re-price on their next fmv-recalc pass.
--
-- Revert:
--   INSERT INTO public.sales SELECT * FROM public.audit_20261104_atlas_backfill_cancelled_listing_sales;
--   INSERT INTO public.sales SELECT * FROM public.audit_20261104_atlas_backfill_seller_kept_moment_sales;

DO $$
DECLARE n1 int; n2 int; d1 int; d2 int;
BEGIN
  SELECT count(*) INTO n1 FROM public.audit_20261104_atlas_backfill_cancelled_listing_sales;
  SELECT count(*) INTO n2 FROM public.audit_20261104_atlas_backfill_seller_kept_moment_sales;
  IF n1 <> 4361 OR n2 <> 1036 THEN
    RAISE EXCEPTION 'backups hold % / % rows, expected 4361 / 1036', n1, n2;
  END IF;

  DELETE FROM public.sales s
   USING public.audit_20261104_atlas_backfill_cancelled_listing_sales b
   WHERE s.id = b.id AND s.source = 'atlas_backfill'
     AND s.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  GET DIAGNOSTICS d1 = ROW_COUNT;

  DELETE FROM public.sales s
   USING public.audit_20261104_atlas_backfill_seller_kept_moment_sales b
   WHERE s.id = b.id AND s.source = 'atlas_backfill'
     AND s.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  GET DIAGNOSTICS d2 = ROW_COUNT;

  IF d1 <> 4361 OR d2 <> 1036 THEN
    RAISE EXCEPTION 'deleted % / % sales rows, expected 4361 / 1036 — rolled back', d1, d2;
  END IF;
END $$;

DROP FUNCTION public.backfill_topshot_sales_from_atlas_events(integer, timestamptz);

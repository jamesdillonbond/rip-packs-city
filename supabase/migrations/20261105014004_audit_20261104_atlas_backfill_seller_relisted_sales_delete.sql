-- APPLIED 2026-11-04 ~5:45 PM PT (Cowork cloud, Trevor's Chrome, on his "You do it") via the dashboard SQL editor as ONE
-- batch; the MCP auto-cancels DELETE. Pre-check: backup 754, live 754. Post-check: live 0, editor "Success".
-- Top-100 Top Shot sales by price (90 d) after: max $11,000, 1 atlas_backfill row left (was 8).
-- This version is the record-only apply (SELECT 1); the body that ran follows, verbatim from the staged file.
--
-- STAGED 2026-11-04 (Claude Code cloud) — #232 class 3. Run this whole file as ONE batch (apply_migration, or the
-- dashboard SQL editor, then record the version by hand, as 20261105010616 was). It RAISEs and rolls back unless
-- exactly 754 rows are deleted. After: name the migration file for its version, delete this staged file, ledger
-- entry, mark the focus.md steer DONE.
--
-- Deletes the atlas_backfill Top Shot "sales" backed up in audit_20261104_atlas_backfill_seller_relisted_sales
-- (20261105012315): 754 rows, $48,611, buyer NULL, no purchased Atlas listing within ±10 min, and the SAME seller
-- listed the same NFT again afterwards (713; control onchain 0.13 %, atlas 0.27 %) or sold it again later (41;
-- control onchain 0.07 %). Includes 7 of the 8 atlas_backfill rows still in the 90-day top-100 after the 11-04
-- delete ($7,499 / $7,297 / $7,036 / $6,000 / $2,225 / $900 / $800). Editions re-price on their next fmv-recalc pass.
--
-- Revert:
--   INSERT INTO public.sales SELECT * FROM public.audit_20261104_atlas_backfill_seller_relisted_sales;

DO $$
DECLARE n int; d int;
BEGIN
  SELECT count(*) INTO n FROM public.audit_20261104_atlas_backfill_seller_relisted_sales;
  IF n <> 754 THEN
    RAISE EXCEPTION 'backup holds % rows, expected 754', n;
  END IF;

  DELETE FROM public.sales s
   USING public.audit_20261104_atlas_backfill_seller_relisted_sales b
   WHERE s.id = b.id AND s.source = 'atlas_backfill'
     AND s.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  GET DIAGNOSTICS d = ROW_COUNT;
  IF d <> 754 THEN
    RAISE EXCEPTION 'deleted % rows, expected 754 — rolled back', d;
  END IF;
END $$;

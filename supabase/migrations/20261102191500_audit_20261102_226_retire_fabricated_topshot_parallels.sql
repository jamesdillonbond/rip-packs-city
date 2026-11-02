-- #226 step (3b) — APPLIED 2026-11-02 ~11:10 AM PT through the Supabase SQL editor (Cowork cloud via
-- Trevor's Chrome; Trevor: "Use chrome to take care of any pending sql tasks"). Pre-counts matched
-- (editions 9 · fmv_snapshots 271 · price_snapshots 1 · edition_fmv_current 9 · sales/moments/offers 0);
-- after: 0 editions left, backups 9 / 271 / 1 / 9, RLS on, anon SELECT false. schema_migrations row
-- inserted by hand (20261102191500).
--
-- Retires the nine Top Shot "parallel" editions that do not exist on chain (minted 2026-06-20 / 07-26
-- by the conflated-edition split from a mis-attributed base). As of 2026-11-02 ~9:55 AM PT nothing
-- real points at them any more — sales, wallet holdings, the subedition map, moments, offers and the
-- moment→edition id map were all moved to the chain editions (see known-issues #226 and migrations
-- 20261102180000_audit_20261102_226_repoint_moments_offers_idmap). What is left is only what the
-- pricing jobs wrote ABOUT them, which is still served publicly on their edition pages:
--   fmv_snapshots 271 · price_snapshots 1 · edition_fmv_current 9 · editions 9
-- Re-count those four just before running; the DO block below RAISEs (rolling everything back) if
-- any number differs, or if any sale / holding / moment / offer has re-attached to these editions.
--
--
-- REVERT (one transaction; fmv_snapshots insert triggers may need disabling for historical rows):
--   INSERT INTO public.editions SELECT * FROM public.audit_20261102_226_fab_editions;
--   INSERT INTO public.fmv_snapshots SELECT * FROM public.audit_20261102_226_fab_fmv_snapshots;
--   INSERT INTO public.price_snapshots SELECT * FROM public.audit_20261102_226_fab_price_snapshots;
--   INSERT INTO public.edition_fmv_current SELECT * FROM public.audit_20261102_226_fab_edition_fmv_current;

BEGIN;
SET LOCAL rpc.allow_bulk_delete = 'on';

CREATE TEMP TABLE _fab ON COMMIT DROP AS
  SELECT id FROM public.editions
   WHERE collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
     AND external_id IN ('2:1::16','2:4::16','2:7::16','51:1780::16','51:1789::16','51:1862::16','51:2053::16','90:3572::16','90:4065::16');

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.sales WHERE edition_id IN (SELECT id FROM _fab))
     OR EXISTS (SELECT 1 FROM public.moments WHERE edition_id IN (SELECT id FROM _fab))
     OR EXISTS (SELECT 1 FROM public.offers WHERE edition_id IN (SELECT id FROM _fab))
     OR EXISTS (SELECT 1 FROM public.wallet_moments_cache WHERE collection_id='95f28a17-224a-4025-96ad-adf8a4c63bfd'
                AND edition_key IN ('2:1::16','2:4::16','2:7::16','51:1780::16','51:1789::16','51:1862::16','51:2053::16','90:3572::16','90:4065::16')) THEN
    RAISE EXCEPTION '#226: something real re-attached to a fabricated edition — stop and investigate';
  END IF;
END $$;

CREATE TABLE public.audit_20261102_226_fab_editions AS SELECT e.* FROM public.editions e WHERE e.id IN (SELECT id FROM _fab);
CREATE TABLE public.audit_20261102_226_fab_fmv_snapshots AS SELECT f.* FROM public.fmv_snapshots f WHERE f.edition_id IN (SELECT id FROM _fab);
CREATE TABLE public.audit_20261102_226_fab_price_snapshots AS SELECT p.* FROM public.price_snapshots p WHERE p.edition_id IN (SELECT id FROM _fab);
CREATE TABLE public.audit_20261102_226_fab_edition_fmv_current AS SELECT c.* FROM public.edition_fmv_current c WHERE c.edition_id IN (SELECT id FROM _fab);
ALTER TABLE public.audit_20261102_226_fab_editions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_20261102_226_fab_fmv_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_20261102_226_fab_price_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_20261102_226_fab_edition_fmv_current ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.audit_20261102_226_fab_editions, public.audit_20261102_226_fab_fmv_snapshots,
  public.audit_20261102_226_fab_price_snapshots, public.audit_20261102_226_fab_edition_fmv_current FROM anon, authenticated;

DELETE FROM public.fmv_snapshots       WHERE edition_id IN (SELECT id FROM _fab);
DELETE FROM public.price_snapshots     WHERE edition_id IN (SELECT id FROM _fab);
DELETE FROM public.edition_fmv_current WHERE edition_id IN (SELECT id FROM _fab);
DELETE FROM public.editions            WHERE id IN (SELECT id FROM _fab);

DO $$
DECLARE n_ed int; n_fmv int; n_px int; n_efc int;
BEGIN
  SELECT count(*) INTO n_ed  FROM public.audit_20261102_226_fab_editions;
  SELECT count(*) INTO n_fmv FROM public.audit_20261102_226_fab_fmv_snapshots;
  SELECT count(*) INTO n_px  FROM public.audit_20261102_226_fab_price_snapshots;
  SELECT count(*) INTO n_efc FROM public.audit_20261102_226_fab_edition_fmv_current;
  IF n_ed <> 9 OR n_px <> 1 OR n_efc <> 9 OR n_fmv < 271 OR n_fmv > 300 THEN
    RAISE EXCEPTION '#226 count mismatch: editions % fmv % price % efc %', n_ed, n_fmv, n_px, n_efc;
  END IF;
END $$;

COMMIT;

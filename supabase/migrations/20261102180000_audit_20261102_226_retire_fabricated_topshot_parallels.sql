-- audit_20261102_226_retire_fabricated_topshot_parallels
--
-- #226 step (3). Nine Top Shot "parallel" editions that do not exist on chain were minted by the
-- conflated-edition split from a mis-attributed base (seeders copy the base from sales/wmc; only the
-- subedition number is read from chain). Every moment that pointed at them was chain-read on
-- 2026-11-02 (Flow REST, owner borrowMoment + getMomentsSubedition) and is in set 218 — evidence in
-- audit_20261102_226_chain_map (234) + audit_20261102_fab_clubcoll_sub_backup (24). The map, wmc and
-- sales copies were repaired earlier the same morning; this finishes the job:
--   1. moments.edition_id      → the chain edition for every verified nft (176 rows; 0 serial collisions, pre-checked)
--   2. offers.edition_id       → the chain edition for the 2 (cancelled) serial offers on a fabricated parallel
--   3. topshot_moment_id_editions.edition_external_id → the chain key for every verified nft (122 rows)
--   4. back up, then delete, the fabricated editions and what hangs only off them:
--      fmv_snapshots 271 · price_snapshots 1 · edition_fmv_current 9 · editions 9
--      (pre-counted 11-02 ~9:50 AM PT: sales / wmc / map / listings / badges / wishlists / watchlists /
--       trophies / trade rows / special serials all 0 for these ids).
-- Run in the dashboard SQL editor (the client cancels DELETE/DROP via MCP), inside BEGIN/COMMIT; the
-- DO block RAISEs — rolling everything back — if any count differs from the pre-count.
--
-- REVERT (one transaction):
--   INSERT INTO public.editions SELECT * FROM public.audit_20261102_226_fab_editions;
--   INSERT INTO public.fmv_snapshots SELECT * FROM public.audit_20261102_226_fab_fmv_snapshots;
--   INSERT INTO public.price_snapshots SELECT * FROM public.audit_20261102_226_fab_price_snapshots;
--   INSERT INTO public.edition_fmv_current SELECT * FROM public.audit_20261102_226_fab_edition_fmv_current;
--   UPDATE public.moments m SET edition_id=b.edition_id FROM public.audit_20261102_226_moments_backup b WHERE b.id=m.id;
--   UPDATE public.offers o SET edition_id=b.edition_id FROM public.audit_20261102_226_offers_backup b WHERE b.id=o.id;
--   UPDATE public.topshot_moment_id_editions i SET edition_external_id=b.edition_external_id FROM public.audit_20261102_226_idmap_backup b WHERE b.id=i.id;
--   (fmv_snapshots insert triggers may reject historical rows — disable them for the revert if so.)

BEGIN;
SET LOCAL rpc.allow_bulk_delete = 'on';

CREATE TEMP TABLE _known ON COMMIT DROP AS
  SELECT nft_id, chain_key FROM public.audit_20261102_226_chain_map
  UNION ALL
  SELECT nft_id, CASE base_external_id WHEN '2:1' THEN '218:7629::16' WHEN '2:4' THEN '218:7476::16' ELSE '218:7616::16' END
    FROM public.audit_20261102_fab_clubcoll_sub_backup;

CREATE TEMP TABLE _fab ON COMMIT DROP AS
  SELECT id, external_id FROM public.editions
   WHERE collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
     AND external_id IN ('2:1::16','2:4::16','2:7::16','51:1780::16','51:1789::16','51:1862::16','51:2053::16','90:3572::16','90:4065::16');

CREATE TABLE public.audit_20261102_226_moments_backup AS
  SELECT m.* FROM public.moments m JOIN _known k ON k.nft_id = m.nft_id JOIN public.editions e ON e.id = m.edition_id
   WHERE m.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd' AND e.external_id <> k.chain_key;
CREATE TABLE public.audit_20261102_226_offers_backup AS
  SELECT o.* FROM public.offers o WHERE o.edition_id IN (SELECT id FROM _fab);
CREATE TABLE public.audit_20261102_226_idmap_backup AS
  SELECT i.* FROM public.topshot_moment_id_editions i JOIN _known k ON k.nft_id = i.id::text WHERE i.edition_external_id <> k.chain_key;
CREATE TABLE public.audit_20261102_226_fab_editions AS SELECT e.* FROM public.editions e WHERE e.id IN (SELECT id FROM _fab);
CREATE TABLE public.audit_20261102_226_fab_fmv_snapshots AS SELECT f.* FROM public.fmv_snapshots f WHERE f.edition_id IN (SELECT id FROM _fab);
CREATE TABLE public.audit_20261102_226_fab_price_snapshots AS SELECT p.* FROM public.price_snapshots p WHERE p.edition_id IN (SELECT id FROM _fab);
CREATE TABLE public.audit_20261102_226_fab_edition_fmv_current AS SELECT c.* FROM public.edition_fmv_current c WHERE c.edition_id IN (SELECT id FROM _fab);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['audit_20261102_226_moments_backup','audit_20261102_226_offers_backup','audit_20261102_226_idmap_backup',
    'audit_20261102_226_fab_editions','audit_20261102_226_fab_fmv_snapshots','audit_20261102_226_fab_price_snapshots','audit_20261102_226_fab_edition_fmv_current'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated', t);
  END LOOP;
END $$;

UPDATE public.moments m SET edition_id = t.id, updated_at = now()
  FROM _known k, public.editions t
 WHERE m.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd' AND k.nft_id = m.nft_id
   AND t.collection_id = m.collection_id AND t.external_id = k.chain_key AND m.edition_id <> t.id;

UPDATE public.offers o SET edition_id = t.id
  FROM public.moments m, public.editions t
 WHERE o.edition_id IN (SELECT id FROM _fab) AND m.id = o.moment_id AND t.id = m.edition_id;

UPDATE public.topshot_moment_id_editions i SET edition_external_id = k.chain_key
  FROM _known k WHERE k.nft_id = i.id::text AND i.edition_external_id <> k.chain_key;

DELETE FROM public.fmv_snapshots      WHERE edition_id IN (SELECT id FROM _fab);
DELETE FROM public.price_snapshots    WHERE edition_id IN (SELECT id FROM _fab);
DELETE FROM public.edition_fmv_current WHERE edition_id IN (SELECT id FROM _fab);
DELETE FROM public.editions           WHERE id IN (SELECT id FROM _fab);

DO $$
DECLARE n_mom int; n_off int; n_idm int; n_ed int; n_fmv int; n_px int; n_efc int;
BEGIN
  SELECT count(*) INTO n_mom FROM public.audit_20261102_226_moments_backup;
  SELECT count(*) INTO n_off FROM public.audit_20261102_226_offers_backup;
  SELECT count(*) INTO n_idm FROM public.audit_20261102_226_idmap_backup;
  SELECT count(*) INTO n_ed  FROM public.audit_20261102_226_fab_editions;
  SELECT count(*) INTO n_fmv FROM public.audit_20261102_226_fab_fmv_snapshots;
  SELECT count(*) INTO n_px  FROM public.audit_20261102_226_fab_price_snapshots;
  SELECT count(*) INTO n_efc FROM public.audit_20261102_226_fab_edition_fmv_current;
  IF n_mom <> 176 OR n_off <> 2 OR n_idm <> 122 OR n_ed <> 9 OR n_fmv <> 271 OR n_px <> 1 OR n_efc <> 9 THEN
    RAISE EXCEPTION '#226 pre-count mismatch: moments % offers % idmap % editions % fmv % price % efc %', n_mom, n_off, n_idm, n_ed, n_fmv, n_px, n_efc;
  END IF;
  IF EXISTS (SELECT 1 FROM public.editions WHERE collection_id='95f28a17-224a-4025-96ad-adf8a4c63bfd'
             AND external_id IN ('2:1::16','2:4::16','2:7::16','51:1780::16','51:1789::16','51:1862::16','51:2053::16','90:3572::16','90:4065::16'))
     OR EXISTS (SELECT 1 FROM public.offers WHERE edition_id IN (SELECT id FROM public.audit_20261102_226_fab_editions)) THEN
    RAISE EXCEPTION '#226 retirement incomplete';
  END IF;
END $$;

COMMIT;

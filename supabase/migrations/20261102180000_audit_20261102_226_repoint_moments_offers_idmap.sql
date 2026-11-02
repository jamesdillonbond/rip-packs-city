-- audit_20261102_226_repoint_moments_offers_idmap
--
-- #226 step (3a) — APPLIED 2026-11-02 ~9:55 AM PT via execute_sql (Cowork cloud). The non-destructive
-- half of retiring the nine fabricated Top Shot parallel editions: every remaining reference that
-- carried the wrong attribution now points at the chain edition (evidence: audit_20261102_226_chain_map
-- 234 + audit_20261102_fab_clubcoll_sub_backup 24, each moment read on Flow mainnet 11-02).
--   moments.edition_id                        176 rows  (0 (edition, serial) collisions, pre-checked)
--   offers.edition_id                           2 rows  (cancelled serial offers; follow their moment)
--   topshot_moment_id_editions.edition_external_id  122 rows
-- Read-back: 0 moments / offers / id-map rows on the fabricated editions.
-- The DELETE half (the 9 editions + their 271 fmv_snapshots, 1 price_snapshot, 9 edition_fmv_current)
-- is docs/pending/226-retire-fabricated-parallels-run-in-sql-editor.sql — the auto-mode classifier
-- refused loading it into the SQL editor from the cloud session, so it is Trevor's paste.
--
-- REVERT:
--   UPDATE public.moments m SET edition_id=b.edition_id FROM public.audit_20261102_226_moments_backup b WHERE b.id=m.id;
--   UPDATE public.offers o SET edition_id=b.edition_id FROM public.audit_20261102_226_offers_backup b WHERE b.id=o.id;
--   UPDATE public.topshot_moment_id_editions i SET edition_external_id=b.edition_external_id FROM public.audit_20261102_226_idmap_backup b WHERE b.id=i.id;

DO $$
DECLARE a int; b int; c int;
BEGIN
  CREATE TEMP TABLE _known ON COMMIT DROP AS
    SELECT nft_id, chain_key FROM public.audit_20261102_226_chain_map
    UNION ALL
    SELECT nft_id, CASE base_external_id WHEN '2:1' THEN '218:7629::16' WHEN '2:4' THEN '218:7476::16' ELSE '218:7616::16' END
      FROM public.audit_20261102_fab_clubcoll_sub_backup;
  CREATE TEMP TABLE _fab ON COMMIT DROP AS
    SELECT id FROM public.editions WHERE collection_id='95f28a17-224a-4025-96ad-adf8a4c63bfd'
     AND external_id IN ('2:1::16','2:4::16','2:7::16','51:1780::16','51:1789::16','51:1862::16','51:2053::16','90:3572::16','90:4065::16');
  CREATE TABLE public.audit_20261102_226_moments_backup AS
    SELECT m.* FROM public.moments m JOIN _known k ON k.nft_id=m.nft_id JOIN public.editions e ON e.id=m.edition_id
     WHERE m.collection_id='95f28a17-224a-4025-96ad-adf8a4c63bfd' AND e.external_id<>k.chain_key;
  CREATE TABLE public.audit_20261102_226_offers_backup AS SELECT o.* FROM public.offers o WHERE o.edition_id IN (SELECT id FROM _fab);
  CREATE TABLE public.audit_20261102_226_idmap_backup AS
    SELECT i.* FROM public.topshot_moment_id_editions i JOIN _known k ON k.nft_id=i.id::text WHERE i.edition_external_id<>k.chain_key;
  ALTER TABLE public.audit_20261102_226_moments_backup ENABLE ROW LEVEL SECURITY;
  ALTER TABLE public.audit_20261102_226_offers_backup ENABLE ROW LEVEL SECURITY;
  ALTER TABLE public.audit_20261102_226_idmap_backup ENABLE ROW LEVEL SECURITY;
  REVOKE ALL ON public.audit_20261102_226_moments_backup, public.audit_20261102_226_offers_backup, public.audit_20261102_226_idmap_backup FROM anon, authenticated;

  UPDATE public.moments m SET edition_id=t.id, updated_at=now() FROM _known k, public.editions t
   WHERE m.collection_id='95f28a17-224a-4025-96ad-adf8a4c63bfd' AND k.nft_id=m.nft_id AND t.collection_id=m.collection_id AND t.external_id=k.chain_key AND m.edition_id<>t.id;
  GET DIAGNOSTICS a = ROW_COUNT;
  UPDATE public.offers o SET edition_id=m.edition_id FROM public.moments m WHERE o.edition_id IN (SELECT id FROM _fab) AND m.id=o.moment_id;
  GET DIAGNOSTICS b = ROW_COUNT;
  UPDATE public.topshot_moment_id_editions i SET edition_external_id=k.chain_key FROM _known k WHERE k.nft_id=i.id::text AND i.edition_external_id<>k.chain_key;
  GET DIAGNOSTICS c = ROW_COUNT;
  IF a<>176 OR b<>2 OR c<>122 THEN RAISE EXCEPTION 'unexpected: moments % offers % idmap %', a, b, c; END IF;
END $$;

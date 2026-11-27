-- audit_20261127_sold_pack_pulls_seeded_all_day
--
-- 2026-11-27 (PT, early afternoon; Claude Code cloud; Trevor: "Keep digging and probing").
--
-- WHY: the first seed (20261127194925) copied 1,198 sold-pack pulls into pack_open_pulls -- ALL Top
-- Shot. All Day's pull ids barely live in moment_acquisitions (37 of 5,884 sold rips had a link); they
-- live in allday_pack_pull (2,393 sold packs, 11,931 pulls, only 493 named). Trevor's 55 "partial"
-- All Day Sold rows are this class.
--
-- WHAT: seed_sold_pack_pulls gains an All Day leg: a sold pack (or its box's inner packs) with an
-- unnamed allday_pack_pull row and no pack_open_pulls rows gets its allday_pack_pull ids copied in, so
-- collect_wallet_pack_pulls step (3) (Atlas GetNFTs, 1,000 ids a tick) names them. The reader already
-- takes a name from any source. Base: 20261127194925_audit_20261127_sold_pack_pulls_seeded_for_naming.sql
-- (live prosrc md5 3d7648335fa2cdb602de40a4ef6109ae verified before this rewrite).
--
-- WRITES: pack_open_pulls (additive, ON CONFLICT DO NOTHING).
-- REVERT: re-apply the seed_sold_pack_pulls body from the base file;
--   DELETE FROM public.pack_open_pulls WHERE resolved_via = 'sold_pack_seed'
--     AND collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070';

CREATE OR REPLACE FUNCTION public.seed_sold_pack_pulls(p_max integer DEFAULT 300)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_ts constant uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  v_ad constant uuid := 'dee28451-5d62-409e-a1ad-a83f763ac070';
  v_n integer := 0;
  v_n2 integer := 0;
BEGIN
  WITH RECURSIVE sold AS (
    SELECT pp.collection_id, pp.pack_nft_id
      FROM public.pack_purchases pp
     WHERE pp.collection_id IN (v_ts, v_ad)
       AND pp.pack_nft_id IS NOT NULL
       AND pp.custom_id IS DISTINCT FROM 'nba'
       AND pp.seller_address IN (SELECT DISTINCT wallet_addr FROM public.saved_wallets)
    UNION
    SELECT v_ts, h.pack_nft_id FROM public.topshot_pack_sales_history h
     WHERE h.purchased AND h.storefront_address IN (SELECT DISTINCT wallet_addr FROM public.saved_wallets)
    UNION
    SELECT v_ad, h.pack_nft_id FROM public.allday_pack_sales_history h
     WHERE h.purchased AND h.storefront_address IN (SELECT DISTINCT wallet_addr FROM public.saved_wallets)
  ), scope(collection_id, pack_nft_id, depth) AS (
    SELECT collection_id, pack_nft_id, 0 FROM sold
    UNION
    SELECT s.collection_id, b.pack_nft_id, s.depth + 1
      FROM scope s
      JOIN public.pack_box_contents b ON b.collection_id = s.collection_id AND b.box_pack_nft_id = s.pack_nft_id
     WHERE s.depth < 2
  ), cand AS MATERIALIZED (
    SELECT r.collection_id, r.pack_nft_id, r.id AS rip_id, r.tx_hash, r.opener_address
      FROM (SELECT DISTINCT collection_id, pack_nft_id FROM scope) s
      -- per-id probe of pack_rips' unique pack_nft_id index (a plain join hashes every rip)
      CROSS JOIN LATERAL (SELECT r0.* FROM public.pack_rips r0
                           WHERE r0.pack_nft_id = s.pack_nft_id AND r0.collection_id = s.collection_id
                           LIMIT 1) r
     WHERE r.opener_address ~ '^0x[0-9a-f]{16}$'
       AND NOT EXISTS (SELECT 1 FROM public.pack_open_pulls o
                        WHERE o.collection_id = r.collection_id AND o.pack_nft_id = r.pack_nft_id)
       -- at least one linked pull that nothing names yet
       AND EXISTS (SELECT 1 FROM public.moment_acquisitions ma
                    WHERE ma.source_pack_rip_id = r.id AND ma.collection_id = r.collection_id
                      AND ma.acquisition_method = 'pack_pull'
                      AND (r.tx_hash IS NULL OR ma.transaction_hash IS NULL OR ma.transaction_hash = r.tx_hash)
                      AND NOT EXISTS (SELECT 1 FROM public.moments m
                                       WHERE m.collection_id = ma.collection_id AND m.nft_id = ma.nft_id)
                      AND NOT EXISTS (SELECT 1 FROM public.allday_pack_pull a
                                       WHERE r.collection_id = v_ad AND a.pack_nft_id = r.pack_nft_id
                                         AND a.moment_nft_id = ma.nft_id AND a.edition_id IS NOT NULL))
     LIMIT GREATEST(p_max, 0)
  ), ins AS (
    INSERT INTO public.pack_open_pulls (collection_id, pack_nft_id, nft_id, opener_address, edition_id, resolved_via, resolved_at)
    SELECT c.collection_id, c.pack_nft_id, ma.nft_id, c.opener_address, m.edition_id,
           CASE WHEN m.edition_id IS NOT NULL THEN 'moments' ELSE 'sold_pack_seed' END,
           CASE WHEN m.edition_id IS NOT NULL THEN now() END
      FROM cand c
      JOIN public.moment_acquisitions ma
        ON ma.source_pack_rip_id = c.rip_id AND ma.collection_id = c.collection_id
       AND ma.acquisition_method = 'pack_pull'
       AND (c.tx_hash IS NULL OR ma.transaction_hash IS NULL OR ma.transaction_hash = c.tx_hash)
      LEFT JOIN LATERAL (SELECT mo.edition_id FROM public.moments mo
                          WHERE mo.collection_id = c.collection_id AND mo.nft_id = ma.nft_id
                            AND mo.edition_id IS NOT NULL LIMIT 1) m ON true
     WHERE ma.nft_id ~ '^[0-9]{1,15}$'
    ON CONFLICT DO NOTHING
    RETURNING 1
  )
  SELECT count(*) INTO v_n FROM ins;

  -- All Day's pull ids mostly live in allday_pack_pull, not moment_acquisitions (11-27: 37 of 5,884
  -- sold All Day rips had an acquisition link; 2,393 had allday_pack_pull rows, 11,438 of 11,931
  -- unnamed). Copy a sold pack's unnamed allday_pack_pull ids so the Atlas GetNFTs leg names them.
  WITH RECURSIVE sold AS (
    SELECT pp.pack_nft_id
      FROM public.pack_purchases pp
     WHERE pp.collection_id = v_ad AND pp.pack_nft_id IS NOT NULL
       AND pp.seller_address IN (SELECT DISTINCT wallet_addr FROM public.saved_wallets)
    UNION
    SELECT h.pack_nft_id FROM public.allday_pack_sales_history h
     WHERE h.purchased AND h.storefront_address IN (SELECT DISTINCT wallet_addr FROM public.saved_wallets)
  ), scope(pack_nft_id, depth) AS (
    SELECT pack_nft_id, 0 FROM sold
    UNION
    SELECT b.pack_nft_id, s.depth + 1
      FROM scope s
      JOIN public.pack_box_contents b ON b.collection_id = v_ad AND b.box_pack_nft_id = s.pack_nft_id
     WHERE s.depth < 2
  ), cand AS MATERIALIZED (
    SELECT s.pack_nft_id
      FROM (SELECT DISTINCT pack_nft_id FROM scope) s
     WHERE NOT EXISTS (SELECT 1 FROM public.pack_open_pulls o
                        WHERE o.collection_id = v_ad AND o.pack_nft_id = s.pack_nft_id)
       AND EXISTS (SELECT 1 FROM public.allday_pack_pull a
                    WHERE a.pack_nft_id = s.pack_nft_id AND a.edition_id IS NULL)
     LIMIT GREATEST(p_max, 0)
  ), ins AS (
    INSERT INTO public.pack_open_pulls (collection_id, pack_nft_id, nft_id, opener_address, edition_id, resolved_via, resolved_at)
    SELECT v_ad, a.pack_nft_id, a.moment_nft_id, lower(a.opener_address), a.edition_id,
           CASE WHEN a.edition_id IS NOT NULL THEN 'allday_pack_pull' ELSE 'sold_pack_seed' END,
           CASE WHEN a.edition_id IS NOT NULL THEN now() END
      FROM cand c
      JOIN public.allday_pack_pull a ON a.pack_nft_id = c.pack_nft_id
     WHERE a.moment_nft_id ~ '^[0-9]{1,15}$'
       AND a.opener_address ~* '^0x[0-9a-f]{16}$'
    ON CONFLICT DO NOTHING
    RETURNING 1
  )
  SELECT count(*) INTO v_n2 FROM ins;

  RETURN v_n + v_n2;
END
$fn$;

COMMENT ON FUNCTION public.seed_sold_pack_pulls(integer) IS
  'Copies the unnamed linked pulls of packs saved wallets SOLD into pack_open_pulls so the existing naming lanes name them (audit_20261127_sold_pack_pulls_seeded_for_naming). Run by run_seed_sold_pack_pulls (pg_cron rpc-sold-pack-pull-seed).';
REVOKE ALL ON FUNCTION public.seed_sold_pack_pulls(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.seed_sold_pack_pulls(integer) TO service_role;

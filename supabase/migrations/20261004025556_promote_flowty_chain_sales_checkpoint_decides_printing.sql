-- 2026-10-03 (PT) — promote_flowty_chain_sales: the CHECKPOINT decides a Top Shot moment's printing.
--
-- WHY (validation of the full mainnet-28 map, before the function was ever run). For 532,244
-- Top Shot NFTs in both, topshot_moment_id_editions agrees with the checkpoint on set:play for
-- all but 316 — but files 26,853 PARALLEL moments under their BASE edition, while the
-- checkpoint's SubEditionAdmin.momentsSubedition says parallel; both independent readers
-- agree with the checkpoint (topshot_chain_moment_reads 28/28 on that subset, 6,450/6,450
-- overall; topshot_moment_subeditions 833/833 non-NULL, 141,938/141,939 overall). Register #171.
-- The 20261004023334 body would (a) have skipped those as "conflicts" and (b) fallen back to the
-- local (base) edition when a parallel's '::sub' edition is not catalogued — folding it.
-- NOW: when the checkpoint names a TOP SHOT NFT, ITS edition is the answer (missing edition =>
-- unresolved, counted as unresolved_in_ckpt_edition_missing — never the base). Only for NFTs the
-- checkpoint lacks (burned before 2025-12-29) does a local map answer, and for Top Shot only a
-- SUBEDITION-AWARE one (topshot_chain_moment_reads, topshot_moment_subeditions) — never
-- topshot_moment_id_editions. A conflict is now a different set:play; a subedition-only
-- difference is counted (subedition_differs_from_local) and the checkpoint wins. All Day /
-- Golazos / UFC have no parallels: checkpoint first, then nft_edition_map, as before.
-- The map is read at its LATEST spork per NFT (mainnet-28 first; an earlier checkpoint back-fills
-- NFTs burned before 2025-12-29), the subedition from that same spork (immutable once minted).
-- Everything else as 20261004023334. Revert: re-apply that migration's function body.

CREATE OR REPLACE FUNCTION flowty_archive.promote_flowty_chain_sales(p_from bigint, p_to bigint)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO 'public', 'flowty_archive', 'pg_temp'
AS $f$
DECLARE
  c_ts  constant uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  c_ad  constant uuid := 'dee28451-5d62-409e-a1ad-a83f763ac070';
  c_gz  constant uuid := '06248cc4-b85f-47cd-af67-1855d14acd75';
  c_ufc constant uuid := '9b4824a8-736d-4a96-b450-8dcc0c46b023';
  v jsonb;
BEGIN
  IF p_to < p_from OR p_to - p_from > 5000000 THEN
    RAISE EXCEPTION 'slice % .. % is empty or wider than 5,000,000 blocks', p_from, p_to;
  END IF;

  CREATE TEMP TABLE _cand ON COMMIT DROP AS
  SELECT c.*,
         c.payment_vault ~ '\.(DapperUtilityCoin|FiatToken|USDCFlow)\.Vault$' AS usd_pegged,
         CASE c.collection_id WHEN c_ts THEN 'ts' WHEN c_ad THEN 'ad' WHEN c_gz THEN 'gz' WHEN c_ufc THEN 'ufc' END AS kind
    FROM flowty_archive.flowty_chain_listing_completed c
   WHERE c.block_height BETWEEN p_from AND p_to
     AND c.collection_id IN (c_ts, c_ad, c_gz, c_ufc)
     AND c.nft_id ~ '^[0-9]{1,18}$';

  CREATE TEMP TABLE _ufc_map ON COMMIT DROP AS
  SELECT m.a AS set_id, min(n.edition_external_id) AS ext
    FROM public.checkpoint_nft_meta m
    JOIN public.nft_edition_map n ON n.collection_id = c_ufc AND n.nft_id = m.nft_id::text
   WHERE m.c = 'ufc'
   GROUP BY m.a HAVING count(DISTINCT n.edition_external_id) = 1;

  CREATE TEMP TABLE _res ON COMMIT DROP AS
  SELECT k.*,
         (SELECT e.id FROM public.editions e WHERE e.collection_id = k.collection_id AND e.external_id = k.ckpt_ext) AS ckpt_edition,
         (SELECT e.id FROM public.editions e WHERE e.collection_id = k.collection_id AND e.external_id = k.local_ext) AS local_edition
    FROM (
      SELECT c.*,
             CASE c.kind
               WHEN 'ts' THEN m.a || ':' || m.b || CASE WHEN COALESCE(sub.a, 0) > 0 THEN '::' || sub.a ELSE '' END
               WHEN 'ad' THEN m.a::text
               WHEN 'gz' THEN m.a::text
               WHEN 'ufc' THEN (SELECT u.ext FROM _ufc_map u WHERE u.set_id = m.a)
             END AS ckpt_ext,
             m.serial AS ckpt_serial,
             (m.nft_id IS NOT NULL) AS in_ckpt,
             CASE c.kind
               WHEN 'ts' THEN COALESCE(
                 (SELECT r.set_id || ':' || r.play_id || CASE WHEN COALESCE(r.subedition_id, 0) > 0 THEN '::' || r.subedition_id ELSE '' END
                    FROM public.topshot_chain_moment_reads r WHERE r.nft_id = c.nft_id::bigint AND r.subedition_id IS NOT NULL LIMIT 1),
                 (SELECT x.base_external_id || CASE WHEN x.subedition_id > 0 THEN '::' || x.subedition_id ELSE '' END
                    FROM public.topshot_moment_subeditions x WHERE x.nft_id = c.nft_id AND x.subedition_id IS NOT NULL))
               ELSE (SELECT n.edition_external_id FROM public.nft_edition_map n WHERE n.collection_id = c.collection_id AND n.nft_id = c.nft_id)
             END AS local_ext,
             (SELECT n.serial_number FROM public.nft_edition_map n
               WHERE n.collection_id = c.collection_id AND n.nft_id = c.nft_id AND n.serial_number > 0) AS local_serial
        FROM _cand c
        LEFT JOIN LATERAL (SELECT * FROM public.checkpoint_nft_meta m0
                            WHERE m0.c = c.kind AND m0.nft_id = c.nft_id::bigint
                            ORDER BY m0.spork DESC LIMIT 1) m ON true
        LEFT JOIN public.checkpoint_nft_meta sub ON c.kind = 'ts' AND sub.c = 'tssub' AND sub.nft_id = c.nft_id::bigint AND sub.spork = m.spork
    ) k;

  WITH ok AS (
    SELECT r.*, CASE WHEN r.in_ckpt AND r.kind = 'ts' THEN r.ckpt_edition ELSE COALESCE(r.ckpt_edition, r.local_edition) END AS edition_id,
           COALESCE(NULLIF(r.ckpt_serial, 0), NULLIF(r.local_serial, 0))::int AS serial
      FROM _res r
     WHERE r.usd_pegged AND r.price > 0
       AND CASE WHEN r.in_ckpt AND r.kind = 'ts' THEN r.ckpt_edition ELSE COALESCE(r.ckpt_edition, r.local_edition) END IS NOT NULL
       AND NOT (r.ckpt_ext IS NOT NULL AND r.local_ext IS NOT NULL
                AND split_part(r.ckpt_ext, '::', 1) <> split_part(r.local_ext, '::', 1))
       AND NOT EXISTS (SELECT 1 FROM public.sales s WHERE s.transaction_hash = r.tx_hash AND s.nft_id = r.nft_id)
  ), ins AS (
    INSERT INTO public.sales (moment_id, edition_id, collection_id, serial_number, price_usd, price_native, currency,
                              seller_address, buyer_address, marketplace, transaction_hash, block_height, sold_at,
                              nft_id, collection, source)
    SELECT NULL, o.edition_id, o.collection_id, o.serial, o.price, o.price,
           CASE WHEN o.payment_vault LIKE '%DapperUtilityCoin%' THEN 'DUC' ELSE 'USDC' END,
           o.seller, o.buyer, 'flowty', o.tx_hash, o.block_height, o.block_ts, o.nft_id,
           (SELECT slug FROM public.collections WHERE id = o.collection_id), 'flowty_chain_v1'
      FROM ok o
    ON CONFLICT DO NOTHING
    RETURNING collection
  )
  SELECT jsonb_build_object(
    'slice', jsonb_build_array(p_from, p_to),
    'candidates', (SELECT count(*) FROM _res),
    'not_usd_pegged', (SELECT count(*) FROM _res WHERE NOT usd_pegged),
    'unresolved_edition', (SELECT count(*) FROM _res WHERE usd_pegged AND CASE WHEN in_ckpt AND kind = 'ts' THEN ckpt_edition ELSE COALESCE(ckpt_edition, local_edition) END IS NULL),
    'unresolved_in_ckpt_edition_missing', (SELECT count(*) FROM _res WHERE usd_pegged AND in_ckpt AND kind = 'ts' AND ckpt_edition IS NULL),
    'edition_conflict', (SELECT count(*) FROM _res WHERE ckpt_ext IS NOT NULL AND local_ext IS NOT NULL AND split_part(ckpt_ext, '::', 1) <> split_part(local_ext, '::', 1)),
    'subedition_differs_from_local', (SELECT count(*) FROM _res WHERE ckpt_ext IS NOT NULL AND local_ext IS NOT NULL AND ckpt_ext <> local_ext AND split_part(ckpt_ext, '::', 1) = split_part(local_ext, '::', 1)),
    'resolved_by_checkpoint', (SELECT count(*) FROM _res WHERE in_ckpt AND ckpt_edition IS NOT NULL),
    'resolved_by_local', (SELECT count(*) FROM _res WHERE ckpt_edition IS NULL AND local_edition IS NOT NULL AND NOT (in_ckpt AND kind = 'ts')),
    'already_in_sales', (SELECT count(*) FROM _res r WHERE EXISTS (SELECT 1 FROM public.sales s WHERE s.transaction_hash = r.tx_hash AND s.nft_id = r.nft_id)),
    'eligible', (SELECT count(*) FROM ok),
    'inserted', (SELECT count(*) FROM ins),
    'inserted_by_collection', (SELECT COALESCE(jsonb_object_agg(collection, n), '{}'::jsonb) FROM (SELECT collection, count(*) n FROM ins GROUP BY 1) x)
  ) INTO v;
  RETURN v;
END $f$;

REVOKE ALL ON FUNCTION flowty_archive.promote_flowty_chain_sales(bigint, bigint) FROM PUBLIC, anon, authenticated;

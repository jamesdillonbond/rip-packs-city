-- 2026-10-03 (PT) — Promote CHAIN-VERIFIED Flowty-venue sales (2023-11-08 .. 2025-12-29) into
-- public.sales, source 'flowty_chain_v1', one block-height slice per call.
--
-- WHAT QUALIFIES (every condition is a check on chain data, never on Flowty's index alone):
--   * an event in flowty_archive.flowty_chain_listing_completed — a Flowty NFTStorefrontV2
--     ListingCompleted(purchased=true) READ FROM A FLOW HISTORY NODE (the GHA walk);
--   * Top Shot / All Day / Golazos / UFC Strike (Pinnacle is render-keyed, not in `sales`);
--   * paid in a USD-pegged vault (DapperUtilityCoin, FiatToken = USDC, USDCFlow): price_usd
--     IS the on-chain price. FLOW / FUT sales stay in the archive — a USD figure for them
--     would be a conversion RPC has no historical rate for, i.e. a fabricated value;
--   * price > 0, and the edition resolves (below) — an unresolved sale is NOT written with a
--     guessed edition; it stays in the archive and is counted;
--   * not already in `sales` under the same (transaction_hash, nft_id).
-- EDITION: the mainnet-28 checkpoint map public.checkpoint_nft_meta first (holder-independent;
-- Top Shot parallels via SubEditionAdmin.momentsSubedition, absent = Standard; the '::sub'
-- edition must exist — a parallel is NEVER folded onto its base), then RPC's own maps
-- (topshot_moment_id_editions, nft_edition_map) for NFTs burned before the checkpoint. Where
-- both name an edition and they DISAGREE the sale is skipped and counted as a conflict.
-- UFC editions are slug-keyed: setId -> external_id is learned from NFTs present in both
-- the checkpoint and nft_edition_map, and used only where that mapping is unanimous.
-- BUYER/SELLER are the event's own `buyer` / `storefrontAddress` (control: on 70,039
-- overlapping 2026 sales, 99.70 % / 99.83 % identical to RPC's own chain decode; the rest
-- are the paying Flow parent vs the receiving Dapper child — the same person).
-- sold_at = the block's timestamp; block_height and transaction_hash are the chain's.
--
-- Returns counts derived from the write itself (inserted = rows RETURNED by the INSERT;
-- eligible - inserted = rows the All Day cross-source trigger merged into an existing twin,
-- or a same-key race; never silently "written").
-- Revert (all of it): DELETE FROM public.sales WHERE source = 'flowty_chain_v1';
--                     DROP FUNCTION public.flowty_chain_walk_covered(bigint, bigint);
--                     DROP FUNCTION flowty_archive.promote_flowty_chain_sales(bigint, bigint);

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
   WHERE m.c = 'ufc' AND m.spork = 28
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
             CASE c.kind
               WHEN 'ts' THEN (SELECT t.edition_external_id FROM public.topshot_moment_id_editions t WHERE t.id = c.nft_id::bigint)
               ELSE (SELECT n.edition_external_id FROM public.nft_edition_map n WHERE n.collection_id = c.collection_id AND n.nft_id = c.nft_id)
             END AS local_ext,
             (SELECT n.serial_number FROM public.nft_edition_map n
               WHERE n.collection_id = c.collection_id AND n.nft_id = c.nft_id AND n.serial_number > 0) AS local_serial
        FROM _cand c
        LEFT JOIN public.checkpoint_nft_meta m ON m.c = c.kind AND m.nft_id = c.nft_id::bigint AND m.spork = 28
        LEFT JOIN public.checkpoint_nft_meta sub ON c.kind = 'ts' AND sub.c = 'tssub' AND sub.nft_id = c.nft_id::bigint AND sub.spork = 28
    ) k;

  WITH ok AS (
    SELECT r.*, COALESCE(r.ckpt_edition, r.local_edition) AS edition_id,
           COALESCE(NULLIF(r.ckpt_serial, 0), NULLIF(r.local_serial, 0))::int AS serial
      FROM _res r
     WHERE r.usd_pegged AND r.price > 0
       AND COALESCE(r.ckpt_edition, r.local_edition) IS NOT NULL
       AND NOT (r.ckpt_edition IS NOT NULL AND r.local_edition IS NOT NULL AND r.ckpt_edition <> r.local_edition)
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
    'unresolved_edition', (SELECT count(*) FROM _res WHERE usd_pegged AND ckpt_edition IS NULL AND local_edition IS NULL),
    'edition_conflict', (SELECT count(*) FROM _res WHERE ckpt_edition IS NOT NULL AND local_edition IS NOT NULL AND ckpt_edition <> local_edition),
    'resolved_by_checkpoint', (SELECT count(*) FROM _res WHERE ckpt_edition IS NOT NULL),
    'already_in_sales', (SELECT count(*) FROM _res r WHERE EXISTS (SELECT 1 FROM public.sales s WHERE s.transaction_hash = r.tx_hash AND s.nft_id = r.nft_id)),
    'eligible', (SELECT count(*) FROM ok),
    'inserted', (SELECT count(*) FROM ins),
    'inserted_by_collection', (SELECT COALESCE(jsonb_object_agg(collection, n), '{}'::jsonb) FROM (SELECT collection, count(*) n FROM ins GROUP BY 1) x)
  ) INTO v;
  RETURN v;
END $f$;

REVOKE ALL ON FUNCTION flowty_archive.promote_flowty_chain_sales(bigint, bigint) FROM PUBLIC, anon, authenticated;

-- Resume support for the GHA walk: the windows already covered in [p_from, p_to], as ONE array
-- row (an array is not clamped by PostgREST's 1000-row cap; a set-returning RPC would be).
CREATE OR REPLACE FUNCTION public.flowty_chain_walk_covered(p_from bigint, p_to bigint)
RETURNS bigint[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'flowty_archive', 'pg_temp'
AS $f$
  SELECT COALESCE(array_agg(win_start ORDER BY win_start), '{}'::bigint[])
    FROM flowty_archive.flowty_chain_walk_coverage
   WHERE win_start BETWEEN p_from AND p_to
$f$;
REVOKE ALL ON FUNCTION public.flowty_chain_walk_covered(bigint, bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.flowty_chain_walk_covered(bigint, bigint) TO service_role;

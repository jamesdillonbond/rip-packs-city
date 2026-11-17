-- audit_20261019: a single Golazos pack's lifecycle, from Golazos' own pack tables
--
-- WHY. /[collection]/pack/[id] (and its OG card) read get_pack_lifecycle(p_pack_nft_id),
-- which knows only pack_purchases / pack_rips. Golazos has 0 rows there, so every Golazos
-- pack id either 404'd or redirected — although golazos_pack_opens (78,830 opens, equal to
-- Dapper's index), golazos_pack_open_pulls (267,844 pulls, every one named) and
-- golazos_pack_sales_history (31,846 drop purchases) hold the whole story.
--
-- ⛔ PACK NFT IDS ARE PER-CONTRACT, NOT GLOBAL. Measured 2026-10-19 ~7:45 PM PT: 2,294
-- Golazos pack ids are ALSO the ids of All Day rips in pack_rips — different packs
-- (0 share a tx, an opener or a time). get_pack_lifecycle is keyed on the id alone, so
-- /laliga-golazos/pack/<id> could render an All Day pack. This function reads Golazos
-- tables ONLY, and the app now routes a Golazos id here and refuses a get_pack_lifecycle
-- row filed under another collection (lib/pack-detail/lifecycle.ts).
--
-- WHAT. The get_pack_lifecycle jsonb shape:
--   distribution  pack_distributions (Golazos) — title, image, tier, retail price, slots.
--                 Mint/open/sealed/depletion are NULL: Golazos rows carry 0/0 placeholders
--                 (0 of 224 dists have total_minted), and a placeholder is not a count.
--   ownership     golazos_pack_sales_history purchases (the drop sale; USD).
--   rip           golazos_pack_opens (opener, tx, time, block, moments pulled).
--   pulls         golazos_pack_open_pulls → editions (Golazos) → latest Golazos FMV.
--   stats         gross pull value is NULL when no pull is priced, never 0.
-- A pack in neither table returns status 'unknown' with an error, as get_pack_lifecycle does.
--
-- REVERT: DROP FUNCTION public.get_golazos_pack_lifecycle(text);
--
-- anon-exec: no (get_golazos_pack_lifecycle) — EXECUTE revoked from PUBLIC, anon and authenticated; service_role only, like get_pack_lifecycle (the page and OG card read it through the service-role client).

CREATE OR REPLACE FUNCTION public.get_golazos_pack_lifecycle(p_pack_nft_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_gz constant uuid := '06248cc4-b85f-47cd-af67-1855d14acd75';
  v_open public.golazos_pack_opens%ROWTYPE;
  v_has_sale boolean;
  v_dist_id text;
  v_distribution jsonb;
  v_pack_name text;
  v_ownership jsonb;
  v_rip jsonb;
  v_pulls jsonb;
  v_pull_count int;
  v_pulls_with_fmv int;
  v_gross numeric;
  v_cost numeric;
  v_first_seen timestamptz;
BEGIN
  SELECT * INTO v_open FROM public.golazos_pack_opens o WHERE o.pack_nft_id = p_pack_nft_id;
  SELECT EXISTS (SELECT 1 FROM public.golazos_pack_sales_history h WHERE h.pack_nft_id = p_pack_nft_id)
    INTO v_has_sale;

  IF v_open.pack_nft_id IS NULL AND NOT v_has_sale THEN
    RETURN jsonb_build_object(
      'pack_nft_id', p_pack_nft_id,
      'status', 'unknown',
      'error', 'no purchase or open recorded for this Golazos pack id'
    );
  END IF;

  v_dist_id := v_open.dist_id;
  IF v_dist_id IS NULL THEN
    SELECT h.dist_id INTO v_dist_id FROM public.golazos_pack_sales_history h
     WHERE h.pack_nft_id = p_pack_nft_id AND h.dist_id IS NOT NULL
     ORDER BY h.block_time DESC LIMIT 1;
  END IF;

  IF v_dist_id IS NOT NULL THEN
    SELECT pd.title,
           jsonb_build_object(
             'dist_id', pd.dist_id,
             'title', pd.title,
             'image_url', pd.image_url,
             'tier', pd.metadata->>'tier',
             'retail_price_usd', public.pack_retail_usd(pd.metadata->>'retail_price_usd', pd.title),
             'drop_date', pd.metadata->>'start_time',
             'pack_slots', (pd.metadata->>'number_of_pack_slots')::int,
             'total_minted', NULL,
             'total_opened', NULL,
             'total_sealed', NULL,
             'depletion_pct', NULL,
             'source', 'drop_pool'
           )
      INTO v_pack_name, v_distribution
      FROM public.pack_distributions pd
     WHERE pd.collection_id = v_gz AND pd.dist_id = v_dist_id;
  END IF;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'buyer_address', h.buyer_address,
           'seller_address', h.storefront_address,
           'sale_price', h.sale_price_usd,
           'sale_currency', 'USD',
           'custom_id', h.custom_id,
           'tx_hash', h.tx_hash,
           'sealed_at', h.block_time,
           'block_height', h.block_height
         ) ORDER BY h.block_time ASC), '[]'::jsonb),
         sum(h.sale_price_usd),
         min(h.block_time)
    INTO v_ownership, v_cost, v_first_seen
    FROM public.golazos_pack_sales_history h
   WHERE h.pack_nft_id = p_pack_nft_id AND h.purchased;

  IF v_open.pack_nft_id IS NOT NULL THEN
    v_rip := jsonb_build_object(
      'opener_address', v_open.opener_address,
      'tx_hash', v_open.open_tx,
      'sealed_at', v_open.opened_at,
      'block_height', v_open.open_block,
      'moments_pulled', v_open.moments_pulled
    );
    v_first_seen := LEAST(v_first_seen, v_open.opened_at);
  END IF;

  SELECT coalesce(jsonb_agg(p ORDER BY (p->>'serial_number')::int NULLS LAST), '[]'::jsonb),
         count(*)::int,
         count(*) FILTER (WHERE (p->>'current_fmv') IS NOT NULL)::int,
         sum((p->>'current_fmv')::numeric)
    INTO v_pulls, v_pull_count, v_pulls_with_fmv, v_gross
    FROM (
      SELECT jsonb_build_object(
               'nft_id', gp.nft_id,
               'serial_number', gp.serial_number,
               'edition_id', e.id,
               'player_name', e.player_name,
               'set_name', e.set_name,
               'tier', e.tier::text,
               'circulation_count', e.circulation_count,
               'thumbnail_url', e.thumbnail_url,
               'video_url', e.video_url,
               'current_owner', NULL,
               'current_fmv', f.fmv_usd,
               'floor_price', f.floor_price_usd,
               'confidence', f.confidence::text
             ) AS p
        FROM public.golazos_pack_open_pulls gp
        LEFT JOIN public.editions e
          ON e.collection_id = v_gz AND e.external_id = gp.edition_external_id
        LEFT JOIN LATERAL (
          SELECT fs.fmv_usd, fs.floor_price_usd, fs.confidence
            FROM public.fmv_snapshots fs
           WHERE fs.collection_id = v_gz AND fs.edition_id = e.id
           ORDER BY fs.computed_at DESC
           LIMIT 1
        ) f ON e.id IS NOT NULL
       WHERE gp.pack_nft_id = p_pack_nft_id
    ) sub;

  RETURN jsonb_build_object(
    'pack_nft_id', p_pack_nft_id,
    'collection_id', v_gz,
    'collection_slug', 'laliga_golazos',
    'pack_name', v_pack_name,
    'distribution', v_distribution,
    'status', CASE WHEN v_rip IS NOT NULL THEN 'ripped' ELSE 'sealed' END,
    'first_seen_at', v_first_seen,
    'ownership_chain', v_ownership,
    'rip', v_rip,
    'pulls', v_pulls,
    'stats', jsonb_build_object(
      'total_cost_basis', v_cost,
      'currency', CASE WHEN v_cost IS NOT NULL THEN 'USD' END,
      'gross_pull_value_usd', v_gross,
      'pull_count', v_pull_count,
      'pulls_with_fmv', v_pulls_with_fmv
    )
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.get_golazos_pack_lifecycle(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_golazos_pack_lifecycle(text) TO service_role;

-- audit_20261019: a single Disney Pinnacle pack's page, and pull links that resolve
--
-- WHY (1). /disney-pinnacle/pack/<id> always 404'd or redirected: get_pack_lifecycle
-- reads pack_purchases / pack_rips only, with 0 Pinnacle rows. pinnacle_pack_opens holds
-- the complete open history (91,471 opens = Dapper's index; 5,577 distinct openers — the
-- custodial account 0xedf9df96c92f4595 is 11,851 of them, read 2026-10-19 ~8:30 PM PT),
-- and price_pinnacle_pack_opens already names every pulled pin to price it.
--
-- WHY (2). The pack page links each pull to /<collection>/moment/<nft_id>. That resolves
-- through the `moments` table, which holds 0 Golazos and 0 Pinnacle rows, so every pull
-- card on the Golazos single-pack page (shipped 7:25 PM PT) linked a 404. Each pull now
-- carries `edition_key` — the Golazos edition external_id (the edition page resolves by
-- it), the Pinnacle render_id (/pinnacle/moment/<render_id>) — and the page links by it.
--
-- WHAT.
--   get_golazos_pack_lifecycle  + 'edition_key' on each pull; otherwise unchanged
--                               (verbatim from 20261020022244).
--   get_pinnacle_pack_lifecycle the get_pack_lifecycle shape from pinnacle_pack_opens: the
--                               rip (opener, tx, time, block), each pull named by the SAME
--                               ladder the pricing lane uses, priced at the pin's catalog
--                               FMV. No ownership chain and no cost (RPC holds 0 Pinnacle
--                               pack buys), and no mint/open counters (Pinnacle's are
--                               placeholders on PDS-seeded rows) — NULL, never 0.
--
-- REVERT: DROP FUNCTION public.get_pinnacle_pack_lifecycle(text); re-apply
-- 20261020022244_audit_20261019_golazos_single_pack_lifecycle.sql.
--
-- anon-exec: no (get_pinnacle_pack_lifecycle) — EXECUTE revoked from PUBLIC, anon and authenticated; service_role only. get_golazos_pack_lifecycle: unchanged — CREATE OR REPLACE, same signature, ACL preserved (service_role only).

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
               -- 2026-10-19: the key the pull's page is reached by (Golazos has no
               -- per-NFT moment rows, so /moment/<nft_id> 404'd; the edition page
               -- resolves by external_id).
               'edition_key', gp.edition_external_id,
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

CREATE OR REPLACE FUNCTION public.get_pinnacle_pack_lifecycle(p_pack_nft_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_pin constant uuid := '7dd9dd11-e8b6-45c4-ac99-71331f959714';
  v_open public.pinnacle_pack_opens%ROWTYPE;
  v_distribution jsonb;
  v_pack_name text;
  v_rip jsonb;
  v_pulls jsonb;
  v_pull_count int;
  v_pulls_with_fmv int;
  v_gross numeric;
BEGIN
  SELECT * INTO v_open FROM public.pinnacle_pack_opens o WHERE o.pack_nft_id = p_pack_nft_id;
  IF v_open.pack_nft_id IS NULL THEN
    RETURN jsonb_build_object(
      'pack_nft_id', p_pack_nft_id,
      'status', 'unknown',
      'error', 'no open recorded for this Pinnacle pack id'
    );
  END IF;

  IF v_open.dist_id IS NOT NULL THEN
    SELECT pd.title,
           jsonb_build_object(
             'dist_id', pd.dist_id,
             'title', pd.title,
             'image_url', COALESCE(pd.metadata->>'thumbnail', pd.image_url),
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
     WHERE pd.collection_id = v_pin AND pd.dist_id = v_open.dist_id;
  END IF;

  v_rip := jsonb_build_object(
    'opener_address', v_open.opener_address,
    'tx_hash', v_open.open_tx,
    'sealed_at', v_open.opened_at,
    'block_height', v_open.open_block,
    'moments_pulled', v_open.moments_pulled
  );

  -- Each pulled pin is named by the SAME ladder price_pinnacle_pack_opens prices it
  -- with: its mint event; else its editionID read on chain at the open; else what
  -- every other record of that nft_id names (wallet walk, sale, live listing), only
  -- when they all name ONE render. An unnamed pull stays unnamed (edition_id NULL).
  SELECT coalesce(jsonb_agg(p ORDER BY ord), '[]'::jsonb),
         count(*)::int,
         count(*) FILTER (WHERE (p->>'current_fmv') IS NOT NULL)::int,
         sum((p->>'current_fmv')::numeric)
    INTO v_pulls, v_pull_count, v_pulls_with_fmv, v_gross
    FROM (
      SELECT u.ord,
             jsonb_build_object(
               'nft_id', u.nft_id,
               'edition_key', pc.render_id,
               'serial_number', NULL,
               'edition_id', pc.render_id,
               'player_name', pc.character_name,
               'set_name', pc.set_name,
               'tier', pc.edition_type,
               'circulation_count', pc.total_minted,
               'thumbnail_url', pc.thumbnail_url,
               'video_url', pc.front_anim_url,
               'current_owner', NULL,
               'current_fmv', pc.fmv_usd,
               'floor_price', pc.floor_ask,
               'confidence', pc.fmv_confidence::text
             ) AS p
        FROM unnest(v_open.nft_ids) WITH ORDINALITY AS u(nft_id, ord)
        LEFT JOIN public.pinnacle_mint_events m ON m.nft_id = u.nft_id
        LEFT JOIN LATERAL (
          SELECT c.render_id
            FROM public.pinnacle_pull_chain_reads cr
            JOIN public.pinnacle_catalog c ON c.edition_id = cr.edition_id::text
           WHERE m.render_id IS NULL AND cr.nft_id = u.nft_id
        ) ch ON true
        LEFT JOIN LATERAL (
          SELECT min(x.render_id) AS render_id
            FROM (
              SELECT wm.render_id FROM public.wallet_moments_cache wm
               WHERE wm.collection_id = v_pin AND wm.moment_id = u.nft_id AND wm.render_id IS NOT NULL
              UNION ALL
              SELECT s.render_id FROM public.pinnacle_sales s
               WHERE s.nft_id = u.nft_id AND s.render_id IS NOT NULL
              UNION ALL
              SELECT l.render_id FROM public.pinnacle_live_listings l
               WHERE l.nft_id = u.nft_id AND l.render_id IS NOT NULL
            ) x
           WHERE m.render_id IS NULL AND ch.render_id IS NULL
          HAVING count(DISTINCT x.render_id) = 1
        ) w ON true
        LEFT JOIN public.pinnacle_catalog pc ON pc.render_id = COALESCE(m.render_id, ch.render_id, w.render_id)
    ) sub;

  RETURN jsonb_build_object(
    'pack_nft_id', p_pack_nft_id,
    'collection_id', v_pin,
    'collection_slug', 'disney_pinnacle',
    'pack_name', v_pack_name,
    'distribution', v_distribution,
    'status', 'ripped',
    'first_seen_at', v_open.opened_at,
    'ownership_chain', '[]'::jsonb,
    'rip', v_rip,
    'pulls', v_pulls,
    'stats', jsonb_build_object(
      'total_cost_basis', NULL,
      'currency', NULL,
      'gross_pull_value_usd', v_gross,
      'pull_count', v_pull_count,
      'pulls_with_fmv', v_pulls_with_fmv
    )
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.get_pinnacle_pack_lifecycle(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_pinnacle_pack_lifecycle(text) TO service_role;

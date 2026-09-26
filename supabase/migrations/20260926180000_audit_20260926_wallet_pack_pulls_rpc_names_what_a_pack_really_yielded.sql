-- 2026-09-26 (PT) — the wallet pack row's "Pulls" panel shows what the pack
-- actually yielded, not every moment acquired near it.
--
-- WHY. The Packs page expands a row through /api/wallet/pack-lifecycle →
-- get_pack_lifecycle, whose pull list joins moment_acquisitions on
-- source_pack_rip_id. For 0xbd94cade097e50ac that linkage is the bulk_seed
-- attribution that hangs every nearby acquisition on a rip: three packs that
-- yielded 3, 5 and 3 moments listed 46, 35 and 95 "pulls" (measured 09-26). A
-- reconstructed rip (burst:<nft>, 20260926170000) has no pack id at all, so its
-- panel could show nothing.
--
-- WHAT. get_wallet_pack_pulls(wallet, collection_slug, pack_nft_id) → jsonb:
--   source 'dapper_pulls'   pack_open_pulls rows for this pack AND this opener
--                           (Dapper's searchPackNft.nfts), else
--   source 'delivery_burst' the reconstructed rip's own moment list, else
--   source NULL             nothing trustworthy -- pulls [] (the route then
--                           keeps get_pack_lifecycle's list ONLY where its
--                           count equals the rip's moments_pulled).
-- Each pull: nft_id, serial_number, edition_id, player_name, set_name, tier,
-- circulation_count, thumbnail_url, current_fmv / confidence (latest snapshot,
-- fmv_usd > 0, collection-scoped). Editions from moments / wallet_moments_cache,
-- collection-scoped (a moment id is unique only within a collection).
-- STABLE, SECURITY DEFINER, service_role only (the route checks the wallet is
-- saved on the caller's account, as for pack-history).
--
-- Revert: DROP FUNCTION public.get_wallet_pack_pulls(text, text, text);
--         (revert the route/UI commit first.)

CREATE OR REPLACE FUNCTION public.get_wallet_pack_pulls(p_wallet text, p_collection_slug text, p_pack_nft_id text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
SET statement_timeout TO '10s'
AS $function$
DECLARE
  v_wallet text := lower(trim(coalesce(p_wallet, '')));
  v_coll uuid;
  v_source text;
  v_ids text[];
  v_pulls jsonb;
  v_total int;
  v_identified int;
  v_priced int;
BEGIN
  IF v_wallet = '' OR coalesce(p_pack_nft_id, '') = '' THEN
    RETURN jsonb_build_object('error', 'wallet and pack required');
  END IF;
  SELECT id INTO v_coll FROM public.collections
   WHERE slug = replace(coalesce(p_collection_slug, ''), '-', '_');
  IF v_coll IS NULL THEN
    RETURN jsonb_build_object('error', 'unknown collection');
  END IF;

  SELECT array_agg(o.nft_id ORDER BY o.nft_id) INTO v_ids
    FROM public.pack_open_pulls o
   WHERE o.collection_id = v_coll AND o.pack_nft_id = p_pack_nft_id AND o.opener_address = v_wallet;
  IF v_ids IS NOT NULL THEN
    v_source := 'dapper_pulls';
  ELSE
    SELECT r.nft_ids INTO v_ids
      FROM public.wallet_reconstructed_rips r
     WHERE r.wallet = v_wallet AND r.collection_id = v_coll AND r.burst_id = p_pack_nft_id;
    IF v_ids IS NOT NULL THEN
      v_source := 'delivery_burst';
    END IF;
  END IF;

  IF v_ids IS NULL THEN
    RETURN jsonb_build_object('source', NULL, 'pulls', '[]'::jsonb,
                              'pulls_total', NULL, 'pulls_identified', NULL, 'pulls_priced', NULL);
  END IF;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'nft_id', u.nft_id,
           'serial_number', coalesce(mo.serial_number, wm.serial_number),
           'edition_id', e.id,
           'player_name', e.player_name,
           'set_name', e.set_name,
           'tier', e.tier::text,
           'circulation_count', e.circulation_count,
           'thumbnail_url', e.thumbnail_url,
           'current_fmv', f.fmv_usd,
           'confidence', f.confidence
         ) ORDER BY u.ord), '[]'::jsonb),
         count(*), count(e.id), count(f.fmv_usd)
    INTO v_pulls, v_total, v_identified, v_priced
  FROM unnest(v_ids) WITH ORDINALITY AS u(nft_id, ord)
  LEFT JOIN LATERAL (
    SELECT m.edition_id, m.serial_number FROM public.moments m
     WHERE m.nft_id = u.nft_id AND m.collection_id = v_coll AND m.edition_id IS NOT NULL
     LIMIT 1
  ) mo ON true
  LEFT JOIN LATERAL (
    SELECT ed.id AS edition_id, w.serial_number FROM public.wallet_moments_cache w
      JOIN public.editions ed ON ed.collection_id = w.collection_id AND ed.external_id = w.edition_key
     WHERE w.moment_id = u.nft_id AND w.collection_id = v_coll AND w.edition_key IS NOT NULL
     LIMIT 1
  ) wm ON mo.edition_id IS NULL
  LEFT JOIN public.editions e ON e.id = coalesce(mo.edition_id, wm.edition_id)
  LEFT JOIN LATERAL (
    SELECT CASE WHEN s.fmv_usd > 0 THEN s.fmv_usd END AS fmv_usd,
           CASE WHEN s.fmv_usd > 0 THEN s.confidence::text END AS confidence
      FROM public.fmv_snapshots s
     WHERE e.id IS NOT NULL AND s.collection_id = v_coll AND s.edition_id = e.id
     ORDER BY s.computed_at DESC
     LIMIT 1
  ) f ON true;

  RETURN jsonb_build_object('source', v_source, 'pulls', v_pulls,
                            'pulls_total', v_total, 'pulls_identified', v_identified, 'pulls_priced', v_priced);
END;
$function$;

REVOKE ALL ON FUNCTION public.get_wallet_pack_pulls(text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_wallet_pack_pulls(text, text, text) TO postgres, service_role;

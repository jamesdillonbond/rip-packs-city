-- 2026-09-29 (PT) — get_wallet_pack_pulls: a pull's SERIAL falls back to the
-- one read on chain at its pack's rip block.
--
-- WHY. run_topshot_pull_chain_lane (20260929160000) names Top Shot pulls that
-- have left every wallet by reading them on the historical spork node; those
-- moments are in neither `moments` nor wallet_moments_cache, so the pull list
-- named them but showed no serial. topshot_chain_moment_reads carries it.
--
-- WHAT (guarded splice of the live body, md5 90f6bdbd8dcec618d4a48851af17053e
-- = 20260929133500): serial_number = moments, else the wallet cache, else the
-- chain read -- Top Shot only (the reads table is Top Shot moment ids, and a
-- moment id is unique only within a collection). Nothing else changes.
-- anon-exec: unchanged (get_wallet_pack_pulls) — CREATE OR REPLACE of an existing fn; ACL preserved, has_function_privilege anon=false, authenticated=false (read 2026-09-29).
--
-- Revert: re-apply the body from
--   supabase/migrations/20260929133500_audit_20260929_pack_pull_list_names_what_the_value_was_priced_from.sql
-- and repoint its pin.

DO $guard$
DECLARE v_md5 text;
BEGIN
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = 'public.get_wallet_pack_pulls(text, text, text)'::regprocedure;
  IF v_md5 IS DISTINCT FROM '90f6bdbd8dcec618d4a48851af17053e' THEN
    RAISE EXCEPTION 'get_wallet_pack_pulls changed since the splice base (live md5 %) -- re-splice', v_md5;
  END IF;
END
$guard$;

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
  v_inferred int;
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
           -- 2026-09-29: else the serial read on chain at the rip block
           -- (Top Shot only; moments that left every wallet have no other)
           'serial_number', coalesce(mo.serial_number, wm.serial_number, cr.serial_number),
           'edition_id', e.id,
           'player_name', e.player_name,
           'set_name', e.set_name,
           'tier', e.tier::text,
           'circulation_count', e.circulation_count,
           'thumbnail_url', e.thumbnail_url,
           'current_fmv', f.fmv_usd,
           'confidence', f.confidence,
           -- 2026-09-29: how the pull was named -- 'record' (a row we hold about
           -- that moment id), 'id_neighbours' (inferred from the ids minted
           -- beside it; 99 % measured), NULL when unnamed
           'named_by', CASE WHEN e.id IS NULL THEN NULL
                            WHEN po.edition_id IS NOT NULL AND po.resolved_via = 'id_neighbours' THEN 'id_neighbours'
                            ELSE 'record' END
         ) ORDER BY u.ord), '[]'::jsonb),
         count(*), count(e.id), count(f.fmv_usd),
         count(*) FILTER (WHERE e.id IS NOT NULL AND po.resolved_via = 'id_neighbours')
    INTO v_pulls, v_total, v_identified, v_priced, v_inferred
  FROM unnest(v_ids) WITH ORDINALITY AS u(nft_id, ord)
  -- 2026-09-29: the pull lane's own name first (it also reads sales, the
  -- ownership walk, the edition map, Atlas and the id-neighbour inference), so
  -- this list names what the pack's VALUE was priced from -- before, a pull
  -- the lane had named from a sale showed as unknown here.
  LEFT JOIN LATERAL (
    SELECT o.edition_id, o.resolved_via FROM public.pack_open_pulls o
     WHERE v_source = 'dapper_pulls'
       AND o.collection_id = v_coll AND o.pack_nft_id = p_pack_nft_id
       AND o.opener_address = v_wallet AND o.nft_id = u.nft_id
       AND o.edition_id IS NOT NULL
     LIMIT 1
  ) po ON true
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
  LEFT JOIN LATERAL (
    SELECT c.serial_number FROM public.topshot_chain_moment_reads c
     WHERE v_coll = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
       AND u.nft_id ~ '^[0-9]{1,15}$' AND c.nft_id = u.nft_id::bigint
  ) cr ON mo.serial_number IS NULL AND wm.serial_number IS NULL
  LEFT JOIN public.editions e ON e.id = coalesce(po.edition_id, mo.edition_id, wm.edition_id)
  LEFT JOIN LATERAL (
    SELECT CASE WHEN s.fmv_usd > 0 THEN s.fmv_usd END AS fmv_usd,
           CASE WHEN s.fmv_usd > 0 THEN s.confidence::text END AS confidence
      FROM public.fmv_snapshots s
     WHERE e.id IS NOT NULL AND s.collection_id = v_coll AND s.edition_id = e.id
     ORDER BY s.computed_at DESC
     LIMIT 1
  ) f ON true;

  RETURN jsonb_build_object('source', v_source, 'pulls', v_pulls,
                            'pulls_total', v_total, 'pulls_identified', v_identified, 'pulls_priced', v_priced,
                            'pulls_inferred', v_inferred);
END;
$function$;

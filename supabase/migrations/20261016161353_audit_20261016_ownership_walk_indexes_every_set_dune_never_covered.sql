-- audit_20261016_ownership_walk_indexes_every_set_dune_never_covered
-- anon-exec: unchanged (topshot_index_walk_holdings, get_topshot_index_walk_id_floor) — CREATE OR REPLACE of existing fns, identical signatures and return types; ACL preserved (service_role).
--
-- 20261015224833 indexed holdings only in sets with set_id_onchain > 265, on the belief that Dune had
-- covered everything up to 265. It had not: Dune covered 39 named sets (219–265, frozen here in
-- topshot_index_dune_sets), and these Series 8 sets were never in the index — 224 Top Shot This,
-- 225 Vintage Vibes, 235 Hoop Vision, 245 Top Shot This: Playoffs Edition, 250 2026 NBA Playoffs,
-- 255 Throne Room, 257 WNBA Rookie Debut, 258 WNBA Base Set (413,423 mapped moments together). Found
-- by checking one pack opener's chain holdings (0xfddd…8ab2): 142 ids above the old floor, 110 of them
-- WNBA Base Set and invisible to the index.
--   Rule now: index a held id whose edition's set is >= 219 and NOT a Dune set. Set 218 (Series 8
--   Base Set, 1,538,797 minted) stays out on purpose: the squeeze board's 98 % census gate would not
--   pass on it from walked wallets alone, so it would add ~1M rows for no displayed number.
--   Floor: 52,537,846 -> 50,688,258.
-- Positive control on apply (9:14 AM PT): that wallet's 142 chain-verified ids -> 110 written (the
-- set-258 ones; the 32 set-270 rows already existed).
--
-- REVERT: re-apply the bodies in 20261016161027 (walk_holdings) and 20261015224833 (floor),
-- i.e. `e.set_id_onchain > 265` in both; topshot_index_dune_sets can stay (unread).

CREATE TABLE IF NOT EXISTS public.topshot_index_dune_sets (
  set_id_onchain integer PRIMARY KEY
);
ALTER TABLE public.topshot_index_dune_sets ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.topshot_index_dune_sets FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.topshot_index_dune_sets TO service_role;
COMMENT ON TABLE public.topshot_index_dune_sets IS
  'The Top Shot sets the dead Dune lane indexed (frozen 2026-10-16). The ownership walk indexes holdings in every OTHER set from 219 (Series 8 after its Base Set) upward; Dune-era sets keep their rows and are re-confirmed/flagged by the walk as before. audit_20261016.';
INSERT INTO public.topshot_index_dune_sets (set_id_onchain)
SELECT DISTINCT e.set_id_onchain
  FROM public.topshot_ownership o
  JOIN public.editions e ON e.external_id = o.edition_external_id AND e.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
 WHERE e.set_id_onchain <= 265
ON CONFLICT DO NOTHING;

CREATE OR REPLACE FUNCTION public.topshot_index_walk_holdings(
  p_owners text[], p_nft_ids bigint[], p_walked text[], p_walk_at timestamptz)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_ts constant uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  v_written int := 0; v_stamped int := 0; v_queued int := 0;
BEGIN
  IF p_walk_at IS NULL OR cardinality(COALESCE(p_owners, '{}')) <> cardinality(COALESCE(p_nft_ids, '{}')) THEN
    RAISE EXCEPTION 'topshot_index_walk_holdings: owners and nft_ids must be equal-length, walk_at required';
  END IF;

  -- 2026-10-16: an id maps through the daily id map OR straight through `moments` (the hydrator's
  -- own output), so a moment hydrated today is indexed on the next walk, not after the 3:23 AM map
  -- refresh. Ids no source can place are queued (with the wallet holding them) for the hydrator.
  WITH pairs AS (
    SELECT DISTINCT ON (p.nft_id) p.owner_address, p.nft_id
      FROM unnest(COALESCE(p_owners, '{}'), COALESCE(p_nft_ids, '{}')) AS p(owner_address, nft_id)
     WHERE p.owner_address ~ '^0x[0-9a-f]{16}$'
     ORDER BY p.nft_id, p.owner_address
  ), mapped AS (
    SELECT pr.owner_address, pr.nft_id,
           COALESCE(m.edition_external_id, eo.external_id::text) AS edition_external_id,
           mo.serial_number
      FROM pairs pr
      LEFT JOIN public.topshot_moment_id_editions m ON m.id = pr.nft_id
      LEFT JOIN public.moments mo ON mo.nft_id = pr.nft_id::text AND mo.collection_id = v_ts
      LEFT JOIN public.editions eo ON eo.id = mo.edition_id AND eo.collection_id = v_ts
  ), up AS (
    INSERT INTO public.topshot_ownership AS t (nft_id, edition_external_id, owner_address, serial_number, source, observed_at)
    SELECT mp.nft_id::text, mp.edition_external_id, mp.owner_address, mp.serial_number, 'onchain_walk', p_walk_at
      FROM mapped mp
      JOIN public.editions e ON e.collection_id = v_ts AND e.external_id = mp.edition_external_id
     WHERE e.set_id_onchain >= 219
       AND NOT EXISTS (SELECT 1 FROM public.topshot_index_dune_sets d WHERE d.set_id_onchain = e.set_id_onchain)
    ON CONFLICT (nft_id) DO UPDATE SET
      owner_address = EXCLUDED.owner_address,
      observed_at   = EXCLUDED.observed_at,
      serial_number = COALESCE(t.serial_number, EXCLUDED.serial_number),
      source        = 'onchain_walk'
     WHERE t.observed_at < EXCLUDED.observed_at
       AND (t.owner_address <> EXCLUDED.owner_address OR t.walk_missed_at IS NOT NULL)
    RETURNING 1
  ), q AS (
    INSERT INTO public.topshot_index_unmapped_ids AS u (nft_id, wallet, first_seen_at, last_seen_at)
    SELECT mp.nft_id, mp.owner_address, p_walk_at, p_walk_at
      FROM mapped mp
     WHERE mp.edition_external_id IS NULL
    ON CONFLICT (nft_id) DO UPDATE SET wallet = EXCLUDED.wallet, last_seen_at = EXCLUDED.last_seen_at
    RETURNING 1
  )
  SELECT (SELECT count(*) FROM up), (SELECT count(*) FROM q) INTO v_written, v_queued;

  UPDATE public.topshot_ownership_walk_candidates c
     SET last_walked_at = p_walk_at
   WHERE c.owner_address = ANY (COALESCE(p_walked, '{}'));
  GET DIAGNOSTICS v_stamped = ROW_COUNT;

  RETURN jsonb_build_object('written', v_written, 'candidates_stamped', v_stamped, 'unmapped_queued', v_queued);
END
$function$;

-- Hydrate queued ids through the existing chain hydrator: same Cadence script, same request table,
-- same drain (topshot_moment_hydrate_tick drains every request). Same re-ask rules as
-- topshot_moment_hydrate_dispatch_head (no_nft/no_collection 30 d, in flight 10 min, else 1 day).

CREATE OR REPLACE FUNCTION public.get_topshot_index_walk_id_floor()
RETURNS bigint
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT min(m.id)
    FROM public.topshot_moment_id_editions m
    JOIN public.editions e ON e.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
                          AND e.external_id = m.edition_external_id
   WHERE e.set_id_onchain >= 219
     AND NOT EXISTS (SELECT 1 FROM public.topshot_index_dune_sets d WHERE d.set_id_onchain = e.set_id_onchain);
$function$;

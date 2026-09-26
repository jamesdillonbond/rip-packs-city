-- 2026-09-25 (PT) — nothing created a pack_distributions row for a new Top Shot
-- distribution, so every PDS-era dist a collector opened rendered as "Pack".
--
-- WHY. Top Shot dist rows were created by the Studio Platform seeder, and
-- Studio does not carry PDS-era dists (8761+ today). The daily on-chain route
-- (/api/cron/topshot-pack-dist-names-onchain) names and pictures rows whose
-- title/image are NULL, but only rows that EXIST — so a brand-new dist never
-- got one. 64 had piled up (backfilled in 20260926030602), and 2 more appeared
-- within minutes of that backfill.
--
-- WHAT. discover_missing_topshot_pack_distributions(p_days) inserts a
-- placeholder row (title NULL) for every Top Shot dist_id that a pack rip or a
-- pack purchase in the last p_days references and pack_distributions lacks.
-- The route calls it FIRST, so the same run's naming pass (PDS) and image pass
-- (pack-NFT media redirect) fill the row. Returns the rows it inserted.
-- Cost measured at 14 days: ~33k buffers, 2.8 s cold — the route uses 7.
--
-- Revert: DROP FUNCTION public.discover_missing_topshot_pack_distributions(integer);
-- (the route treats a failed call as a failed step and still names/pictures).

CREATE OR REPLACE FUNCTION public.discover_missing_topshot_pack_distributions(p_days integer DEFAULT 7)
RETURNS integer
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  WITH src AS (
    SELECT DISTINCT r.dist_id
      FROM public.pack_rips r
     WHERE r.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
       AND r.dist_id IS NOT NULL
       AND r.sealed_at > now() - make_interval(days => GREATEST(LEAST(COALESCE(p_days, 7), 60), 1))
    UNION
    SELECT DISTINCT pp.pack_dist_id
      FROM public.pack_purchases pp
     WHERE pp.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
       AND pp.pack_dist_id IS NOT NULL
       AND pp.sealed_at > now() - make_interval(days => GREATEST(LEAST(COALESCE(p_days, 7), 60), 1))
  ), ins AS (
    INSERT INTO public.pack_distributions (collection_id, dist_id, nft_type, metadata)
    SELECT '95f28a17-224a-4025-96ad-adf8a4c63bfd', s.dist_id, 'A.0b2a3299cc857e29.PackNFT.NFT',
           jsonb_build_object('seeded_from', 'discovered_from_pack_events')
      FROM src s
     WHERE s.dist_id ~ '^[0-9]+$'
       AND NOT EXISTS (SELECT 1 FROM public.pack_distributions pd
                        WHERE pd.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd' AND pd.dist_id = s.dist_id)
    ON CONFLICT (dist_id, collection_id) DO NOTHING
    RETURNING 1
  )
  SELECT count(*)::integer FROM ins;
$function$;

REVOKE ALL ON FUNCTION public.discover_missing_topshot_pack_distributions(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.discover_missing_topshot_pack_distributions(integer) TO service_role;

-- Post-condition: the ACL is service-role only.
DO $$
BEGIN
  IF has_function_privilege('anon', 'public.discover_missing_topshot_pack_distributions(integer)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.discover_missing_topshot_pack_distributions(integer)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.discover_missing_topshot_pack_distributions(integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'discover_missing_topshot_pack_distributions ACL wrong';
  END IF;
END $$;

-- audit_20261108_pinnacle_dist_discovery_reads_the_atlas_book — 2026-11-08 (Cowork cloud, ~1:55 PM PT, applied on Trevor's 1:49 PM "Yes do it all";
-- Trevor: "make sure packs are included across all supported collections").
--
-- FOUND. Disney Pinnacle's newest drop, dist 8913 "A Disney Villains Halloween Vol.2" (listed by
-- Atlas SearchDistributions product 'disney', probed 11-08 1:45 PM PT), has no pack_distributions
-- row, so /disney-pinnacle/pack/dist/8913 is a 404. discover_missing_pinnacle_pack_distributions()
-- learns a dist only from pinnacle_pack_opens, and that lane's source (Dapper's searchPackNft
-- index) has returned nothing newer than 2026-10-23 8:19 AM PT for two weeks — 300 runs, ok=true,
-- head_new 0 (the #218 freeze, reaching Pinnacle). Studio's searchDistributions, the other
-- writer, stopped listing new Pinnacle dists in August (20261019155503).
--
-- WHAT. The same third source as Top Shot's (20261108213316): a dist the Atlas book ('disney',
-- added by audit_20261108_atlas_pack_book_adds_golazos_and_pinnacle — apply that first) has seen
-- in the last day, starting within the window or later, gets the placeholder row (title NULL —
-- /api/cron/pinnacle-pack-dist-names-onchain names it from PDS, unchanged) plus Atlas's image.
-- Fill-only; an existing row is never touched. Until the book walks 'disney' this branch reads
-- no rows, so the function behaves exactly as before.
--
-- Base verified before this CREATE OR REPLACE: live prosrc md5 0ef9d980dc4890075cb59cd3a86bcf5b
-- == the body in 20261019155503 (same normalisation).
--
-- anon-exec: unchanged (discover_missing_pinnacle_pack_distributions) — CREATE OR REPLACE of an existing fn; ACL preserved, verified has_function_privilege anon=false.
--
-- REVERT: re-apply the body from 20261019155503_audit_20261019_pinnacle_pack_distributions_discovered_from_opens.sql.
--   Rows it created carry metadata.seeded_from = 'discovered_from_atlas_book'.

CREATE OR REPLACE FUNCTION public.discover_missing_pinnacle_pack_distributions(p_days integer DEFAULT 14)
 RETURNS integer
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH src AS (
    SELECT DISTINCT o.dist_id, 'discovered_from_pinnacle_opens'::text AS seeded_from, NULL::text AS image_url
      FROM public.pinnacle_pack_opens o
     WHERE o.dist_id IS NOT NULL
       AND o.opened_at > now() - make_interval(days => GREATEST(LEAST(COALESCE(p_days, 14), 60), 1))
    UNION
    -- 2026-11-08: a dist Dapper has published that the frozen opens index cannot name.
    SELECT a.dist_id, 'discovered_from_atlas_book', a.image_url
      FROM public.atlas_pack_market a
     WHERE a.product = 'disney'
       AND a.observed_at > now() - interval '1 day'
       AND a.start_time > now() - make_interval(days => GREATEST(LEAST(COALESCE(p_days, 14), 60), 1))
  ), one AS (
    SELECT DISTINCT ON (dist_id) dist_id, seeded_from, image_url
      FROM src
     ORDER BY dist_id, (seeded_from = 'discovered_from_pinnacle_opens') DESC
  ), ins AS (
    INSERT INTO public.pack_distributions (collection_id, dist_id, nft_type, image_url, metadata)
    SELECT '7dd9dd11-e8b6-45c4-ac99-71331f959714', s.dist_id, 'Pinnacle',
           NULLIF(s.image_url, ''), jsonb_build_object('seeded_from', s.seeded_from)
      FROM one s
     WHERE s.dist_id ~ '^[0-9]+$'
       AND NOT EXISTS (SELECT 1 FROM public.pack_distributions pd
                        WHERE pd.collection_id = '7dd9dd11-e8b6-45c4-ac99-71331f959714' AND pd.dist_id = s.dist_id)
    ON CONFLICT (dist_id, collection_id) DO NOTHING
    RETURNING 1
  )
  SELECT count(*)::integer FROM ins;
$function$;

DO $$
BEGIN
  IF has_function_privilege('anon', 'public.discover_missing_pinnacle_pack_distributions(integer)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.discover_missing_pinnacle_pack_distributions(integer)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.discover_missing_pinnacle_pack_distributions(integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'discover_missing_pinnacle_pack_distributions ACL wrong';
  END IF;
END $$;

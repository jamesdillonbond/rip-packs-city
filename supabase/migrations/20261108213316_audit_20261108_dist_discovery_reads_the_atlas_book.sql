-- audit_20261108_dist_discovery_reads_the_atlas_book — 2026-11-08 (Cowork cloud, ~1:35 PM PT, applied on Trevor's "Yes do it";
-- Trevor: "keep digging and looking for improvements. We should also have a 'drops this week'
-- type of post").
--
-- FOUND. Building the drops post, the five newest Top Shot drops 404'd on our own pack pages:
-- 8916 Rookie Debut Case, 8917 Box, 8918 Trade Ticket Pack, 8919 Collector Pack (RSVP open
-- 11-05 → 11-11, the season's biggest drop) and 8921 Caleb Wilson Tip-Off Pack. None had a
-- pack_distributions row. discover_missing_topshot_pack_distributions() only learns a dist from
-- a RIP or a PURCHASE (pack_rips / pack_purchases), and the Studio seeder that used to list
-- unsold dists has been frozen since 10-29 (#218). So a dist is invisible on our site until its
-- first pack changes hands — i.e. for its whole RSVP window, exactly when collectors look it up.
--
-- The Atlas pack book (atlas_pack_market, refreshed every 15 min since 10-31) already lists
-- every Top Shot dist Dapper publishes, including ones with no sale yet, and the chain names
-- them: PDS.getDistInfo returned the right title for 8916, 8918 and 8921 on 11-08 (read via Flow
-- REST). So the discovery reads the book as a THIRD source: a dist the book has seen in the last
-- day, starting within the window or later (so upcoming drops count), gets the same placeholder
-- row (title NULL — PDS names it, unchanged rule from 11-07) plus Atlas's image, which the
-- image pass cannot get before a pack is minted. Fill-only: ON CONFLICT DO NOTHING, an
-- existing row is never touched. The caller is unchanged (/api/cron/topshot-pack-dist-names-
-- onchain, `25 */3`, discover → name → picture in one run).
--
-- Base verified before this CREATE OR REPLACE: live prosrc md5 a71a7cdfbaa436b565164d66c3ab3f17
-- == the body in 20260926030748 (same normalisation).
--
-- anon-exec: unchanged (discover_missing_topshot_pack_distributions) — CREATE OR REPLACE of an existing fn; ACL preserved, verified has_function_privilege anon=false.
--
-- REVERT: re-apply the body from 20260926030748_audit_20260925_discover_missing_topshot_pack_distributions.sql.
--   Rows it created carry metadata.seeded_from = 'discovered_from_atlas_book'.

CREATE OR REPLACE FUNCTION public.discover_missing_topshot_pack_distributions(p_days integer DEFAULT 7)
RETURNS integer
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  WITH src AS (
    SELECT DISTINCT r.dist_id, 'discovered_from_pack_events'::text AS seeded_from, NULL::text AS image_url
      FROM public.pack_rips r
     WHERE r.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
       AND r.dist_id IS NOT NULL
       AND r.sealed_at > now() - make_interval(days => GREATEST(LEAST(COALESCE(p_days, 7), 60), 1))
    UNION
    SELECT DISTINCT pp.pack_dist_id, 'discovered_from_pack_events', NULL
      FROM public.pack_purchases pp
     WHERE pp.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
       AND pp.pack_dist_id IS NOT NULL
       AND pp.sealed_at > now() - make_interval(days => GREATEST(LEAST(COALESCE(p_days, 7), 60), 1))
    UNION
    -- 2026-11-08: a dist Dapper has published but nobody has bought or opened yet (an RSVP or an
    -- upcoming drop) — the Atlas book is the only source that knows it.
    SELECT a.dist_id, 'discovered_from_atlas_book', a.image_url
      FROM public.atlas_pack_market a
     WHERE a.product = 'nba'
       AND a.observed_at > now() - interval '1 day'
       AND a.start_time > now() - make_interval(days => GREATEST(LEAST(COALESCE(p_days, 7), 60), 1))
  ), one AS (
    -- a dist seen by two sources keeps the pack-event label (the older, proven path)
    SELECT DISTINCT ON (dist_id) dist_id, seeded_from, image_url
      FROM src
     ORDER BY dist_id, (seeded_from = 'discovered_from_pack_events') DESC
  ), ins AS (
    INSERT INTO public.pack_distributions (collection_id, dist_id, nft_type, image_url, metadata)
    SELECT '95f28a17-224a-4025-96ad-adf8a4c63bfd', s.dist_id, 'A.0b2a3299cc857e29.PackNFT.NFT',
           NULLIF(s.image_url, ''), jsonb_build_object('seeded_from', s.seeded_from)
      FROM one s
     WHERE s.dist_id ~ '^[0-9]+$'
       AND NOT EXISTS (SELECT 1 FROM public.pack_distributions pd
                        WHERE pd.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd' AND pd.dist_id = s.dist_id)
    ON CONFLICT (dist_id, collection_id) DO NOTHING
    RETURNING 1
  )
  SELECT count(*)::integer FROM ins;
$function$;

-- Post-condition: the ACL is still service-role only.
DO $$
BEGIN
  IF has_function_privilege('anon', 'public.discover_missing_topshot_pack_distributions(integer)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.discover_missing_topshot_pack_distributions(integer)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.discover_missing_topshot_pack_distributions(integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'discover_missing_topshot_pack_distributions ACL wrong';
  END IF;
END $$;

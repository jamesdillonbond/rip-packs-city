-- COMMENT-ONLY change. Body is the live definition (md5
-- 3c6d1b6ecd7c91b45c8d4a54c463ce37, read immediately before this replace);
-- only the Top Shot arm's comment differs. Verified byte-for-byte on behaviour:
-- 51:1997 -> 73 and 2:298 -> 6 both before and after.
--
-- WHY IT MATTERS ENOUGH TO SHIP: the comment said the arm's source was
-- "currently dead". It is not, and has not been since 2026-09-07 -- verified
-- 2026-09-20, edition 51:1997 returns active_listings = 73 and the production
-- page renders "0.1% - 73 of 60,000 listed". A comment calling a working arm
-- dead is an invitation to delete it as dead code.
--
-- ⭐ Worth preserving as the POSITIVE example: this arm gates on a DERIVED
-- freshness test, so it self-healed the day the feed returned. The analytics
-- tab's Order Book Depth card gated on a hardcoded retirement date instead and
-- published a false claim for 13 days (migration 20260920163320).
CREATE OR REPLACE FUNCTION public.get_edition_market_bundle(p_edition_id uuid, p_external_id text)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '8s'
AS $function$
  SELECT jsonb_build_object(
    'high_offer', (
      SELECT to_jsonb(ho) FROM public.get_edition_high_offer(p_edition_id) ho
    ),
    'subedition_siblings', CASE
      WHEN p_external_id ~ '^\d+:\d+(::\d+)?$' THEN COALESCE((
        SELECT jsonb_agg(to_jsonb(s) ORDER BY COALESCE(s.subedition_id, 0))
        FROM public.get_edition_subedition_siblings(p_external_id) s
      ), '[]'::jsonb)
      ELSE '[]'::jsonb
    END,
    'ipfs_assets', CASE
      WHEN p_external_id ~ '^\d+:\d+$' THEN (
        SELECT to_jsonb(a) FROM (
          SELECT ia.video_cid, ia.hero_cid
          FROM public.topshot_ipfs_assets ia
          WHERE ia.set_flow_id  = split_part(p_external_id, ':', 1)::int
            AND ia.play_flow_id = split_part(p_external_id, ':', 2)::int
            AND ia.parallel = 'Base'
            AND (ia.video_cid IS NOT NULL OR ia.hero_cid IS NOT NULL)
          LIMIT 1
        ) a
      )
      ELSE NULL
    END,
    'active_listings', (
      SELECT CASE
        -- AllDay + Golazos: fresh cached_listings_v2 feed.
        WHEN ed.collection_id IN (
          'dee28451-5d62-409e-a1ad-a83f763ac070'::uuid,   -- AllDay
          '06248cc4-b85f-47cd-af67-1855d14acd75'::uuid    -- Golazos
        ) THEN (
          CASE WHEN EXISTS (
            SELECT 1 FROM cached_listings_v2 f
            WHERE f.collection_id = ed.collection_id
              AND f.completed_at IS NULL
              AND f.ingested_at > now() - interval '48 hours'
          ) THEN (
            SELECT count(*)::int FROM cached_listings_v2 cl
            WHERE cl.edition_id = ed.id
              AND cl.completed_at IS NULL
              AND cl.price_usd > 0
              AND (cl.expiry_at IS NULL OR cl.expiry_at > now())
          ) ELSE NULL END
        )
        -- Top Shot: ts_listings, gated on the feed being fresh.
        --
        -- ⚠ This comment said "(currently dead)" until 2026-09-20. The feed was
        -- rewired to the Atlas firehose on 2026-09-07 and this arm has been
        -- returning real counts ever since (51:1997 -> 73). Do NOT remove it as
        -- dead code. The 6 h gate is what makes the arm safe either way: if the
        -- feed goes dark again this returns NULL and the page em-dashes, with
        -- no code change and no stale constant to update.
        WHEN ed.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid
             AND ed.external_id ~ '^\d+:\d+(::\d+)?$' THEN (
          CASE WHEN (SELECT max(ingested_at) FROM ts_listings) > now() - interval '6 hours' THEN (
            SELECT count(*)::int FROM ts_listings tl
            WHERE tl.set_id  = split_part(split_part(ed.external_id, '::', 1), ':', 1)::int
              AND tl.play_id = split_part(split_part(ed.external_id, '::', 1), ':', 2)::int
              AND COALESCE(tl.parallel_id, 0) = CASE
                    WHEN ed.external_id LIKE '%::%'
                    THEN split_part(ed.external_id, '::', 2)::int ELSE 0 END
          ) ELSE NULL END
        )
        ELSE NULL
      END
      FROM editions ed
      WHERE ed.id = p_edition_id
    )
  );
$function$;

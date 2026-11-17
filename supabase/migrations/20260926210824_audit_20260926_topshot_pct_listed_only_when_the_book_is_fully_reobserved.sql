-- anon-exec: unchanged (get_edition_market_bundle) — CREATE OR REPLACE of an EXISTING function, so the ACL is
-- preserved (verified live 2026-09-26 with has_function_privilege before the replace: anon and
-- authenticated EXECUTE false, prosecdef true).
-- Top Shot "% Listed" is published only when our open book for the edition is fully re-observed
-- (2026-09-26, #149). The Top Shot arm counted ts_listings — listings re-reported in the last 24 h
-- — and the firehose re-reports CHANGED listings only (#85), so 10,871 of 13,537 editions with an
-- open listing seen within 30 d rendered "0.0% · 0 of N listed" (Tre Jones 124:5108: "0 of 8,000"
-- over 69 open listings) and 1,728 more rendered a count that was only a lower bound. Now the arm
-- returns NULL (page em-dashes) unless the edition has no open listing older than 24 h. AllDay /
-- Golazos arms and every other key byte-identical. Base: live md5 3f459c3125e566ccd408a1613d483669
-- (= 20260920172400's body, guard below). EXISTS probe: 0.4 ms via idx_tame_open_by_edition_any_kind.
-- The ONLY caller is the edition page's % Listed cell (null -> em-dash, already handled).
--
-- REVERT: re-apply the body from 20260920172400.

DO $guard$
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE proname = 'get_edition_market_bundle' AND pronamespace = 'public'::regnamespace) <> '3f459c3125e566ccd408a1613d483669' THEN
    RAISE EXCEPTION 'get_edition_market_bundle live body is not the 20260920172400 one — re-read before a full-body write';
  END IF;
END $guard$;

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
        --
        -- ⛔ A 24 h RE-OBSERVATION WINDOW IS NOT A CENSUS (2026-09-26, #149). ts_listings holds only
        -- listings the Atlas firehose re-reported in the last 24 h, and it re-reports CHANGED
        -- listings only (#85): measured 2026-09-26, 29,183 of 411,308 open listings seen within
        -- 30 d; 10,871 editions read "0.0% · 0 of N listed" while holding open listings (Tre Jones
        -- 124:5108: 69). So the count is returned ONLY when this edition has NO open listing older
        -- than 24 h — then the window holds our whole book for it (an edition verification settles
        -- that: it re-sees what is open and closes the rest). Otherwise NULL, and the page
        -- em-dashes: unknown, never a count that is only a lower bound.
        WHEN ed.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid
             AND ed.external_id ~ '^\d+:\d+(::\d+)?$' THEN (
          CASE WHEN (SELECT max(ingested_at) FROM ts_listings) > now() - interval '6 hours'
                AND NOT EXISTS (
                  SELECT 1 FROM public.topshot_atlas_edition_map m
                    JOIN public.topshot_atlas_market_events ev
                      ON ev.product = 'nba' AND ev.atlas_edition_id = m.atlas_edition_id
                     AND ev.kind = 'listing' AND NOT ev.completed
                   WHERE m.rpc_edition_id = ed.id
                     AND ev.nft_id IS NOT NULL AND ev.price_cents > 0
                     AND ev.last_seen_at <= now() - interval '24 hours') THEN (
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

-- 2026-10-26 (Candy ↔ Top Shot parity): an edition page's "% Listed" read "—" on
-- every Candy edition, because get_edition_market_bundle.active_listings had arms
-- for All Day / Golazos (cached_listings_v2) and Top Shot (ts_listings) only. Candy's
-- asks live in candy_listings (Magic Eden), which the candy-listings-indexer
-- re-reads as a WHOLE BOOK every 3 h — a census, not a change feed (#149 does not
-- apply: a row the sweep stops seeing is flipped is_active=false).
--
-- The Candy arm counts distinct listed tokens the sweep re-saw in the last 12 h
-- (the same 12 h confirmation window candy_listing_floor.confirmed_* uses), and
-- returns NULL — "—", unknown — when the book itself has not been re-read in 12 h,
-- so a dark lane never publishes "0 % listed". Troll asks count: a listed card is
-- listed whatever its price. Every other arm is unchanged (body re-read live
-- 2026-10-26 immediately before this replace).

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
              AND (cl.collection_id <> 'dee28451-5d62-409e-a1ad-a83f763ac070'::uuid OR NOT EXISTS (
                SELECT 1 FROM allday_listings_sold_after_listing g
                WHERE g.listing_resource_id = cl.listing_resource_id AND g.source = cl.source))
          ) ELSE NULL END
        )
        -- Candy MLB (2026-10-26): candy_listings is a whole-book sweep every 3 h. Count the
        -- tokens it re-saw in the last 12 h; NULL when the book itself is older than that.
        WHEN ed.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid THEN (
          CASE WHEN (
            SELECT max(cl.last_seen_at) FROM candy_listings cl
            WHERE cl.collection_id = ed.collection_id AND cl.is_active
          ) > now() - interval '12 hours' THEN (
            SELECT count(DISTINCT cl.token_mint)::int FROM candy_listings cl
            WHERE cl.edition_id = ed.id
              AND cl.is_active
              AND cl.price_usd > 0
              AND cl.last_seen_at > now() - interval '12 hours'
              AND (cl.expiry IS NULL OR cl.expiry > now())
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
-- anon-exec: unchanged (get_edition_market_bundle) — CREATE OR REPLACE of an existing fn; ACL preserved.

-- 2026-10-26 (Candy ↔ Top Shot parity): the player page's "Top Collectors" section
-- is Top Shot-only (get_topshot_rookie_collectors takes a NAME over a Top Shot
-- index, so it can never serve another collection). Candy's wallet_moments_cache
-- is a full daily census, so a Candy player's collectors are exact: every
-- collector wallet holding this player's Candy cards, ranked by those cards'
-- current FMV, then count. The issuer treasury and the Magic Eden listing escrow
-- are excluded (as on candy_holder_board). Keyed by players.id + the Candy
-- collection, so a same-named Top Shot player is never in scope. username is
-- NULL by construction (no Solana wallet carries an RPC username today); the
-- column keeps the Top Shot section's row shape. est_value_usd is NULL when none
-- of the wallet's cards for this player has an FMV (unknown, never $0).
CREATE OR REPLACE FUNCTION public.get_candy_player_top_collectors(p_player_id uuid, p_limit integer DEFAULT 10)
 RETURNS TABLE(wallet_address text, username text, moments_held integer, est_value_usd numeric, rnk integer, total_holders integer)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '8s'
AS $function$
  WITH eds AS MATERIALIZED (
    SELECT e.id, e.external_id FROM public.editions e
    WHERE e.player_id = p_player_id
      AND e.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid
  ),
  ex AS MATERIALIZED (
    SELECT wallet_address FROM public.candy_treasury_wallet
    UNION
    SELECT wallet_address FROM public.candy_holder_board_exclusions
  ),
  fmv AS MATERIALIZED (
    SELECT fc.edition_id, fc.fmv_usd FROM public.candy_fmv_current fc
    WHERE fc.edition_id IN (SELECT id FROM eds)
  ),
  o AS MATERIALIZED (
    SELECT w.wallet_address, f.fmv_usd
    FROM eds
    JOIN public.wallet_moments_cache w
      ON w.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid
     AND w.edition_key = eds.external_id
    LEFT JOIN fmv f ON f.edition_id = eds.id
    WHERE w.wallet_address NOT IN (SELECT wallet_address FROM ex)
  ),
  agg AS (
    SELECT o.wallet_address, count(*)::int AS n, sum(o.fmv_usd) AS v
    FROM o GROUP BY o.wallet_address
  ),
  ranked AS (
    SELECT a.wallet_address, a.n, a.v,
           (row_number() OVER (ORDER BY a.v DESC NULLS LAST, a.n DESC, a.wallet_address))::int AS rnk,
           (count(*) OVER ())::int AS total_holders
    FROM agg a
  )
  SELECT r.wallet_address, NULL::text AS username, r.n AS moments_held, round(r.v, 2) AS est_value_usd, r.rnk, r.total_holders
  FROM ranked r
  WHERE r.rnk <= greatest(1, least(COALESCE(p_limit, 10), 25))
  ORDER BY r.rnk;
$function$;
-- anon-exec: revoked (get_candy_player_top_collectors) — service-role only; the player page reads it server-side.
REVOKE EXECUTE ON FUNCTION public.get_candy_player_top_collectors(uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_candy_player_top_collectors(uuid, integer) TO postgres, service_role;

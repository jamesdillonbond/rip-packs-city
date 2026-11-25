-- audit_20261125_pinnacle_pack_reality_value_at_open_from_fmv_history
--
-- WHY (2026-11-25 ~7:55 AM PT, Claude Code cloud; Trevor: "Keep digging and probing"). Pinnacle Pack Reality's
-- "value at open" is pinnacle_pack_opens.pull_value_usd, counted only when the open was priced within 3 days.
-- Opens ingested late never qualify: the 10-26 → 11-08 opens reached pinnacle_pack_opens only on 11-08 (the
-- chain-opens lane went live and backfilled them), so Predator Vol.1 (8909, 450 packs) and the Super Bowl LXI
-- Squad LEE drop (8910, 240) published NO value at open, and Villains Halloween Vol.2 / Stitch in Costume
-- were short (87/100, 508/514). RPC did price those pins at the time — pinnacle_fmv_history holds each render's
-- FMV from 10-29 on.
--
-- WHAT: where the stored value at open is missing, rebuild it from pinnacle_fmv_history — per pin, the render's
-- last FMV at or before the open, else its first within 3 days after (the window the stored value already uses).
-- A pack with any pin unpriced that way stays unknown (never summed as 0). A stored value always wins.
-- New output field n_at_open_rebuilt counts the packs whose value at open was rebuilt.
--
-- CONTROL (measured before writing, 2026-11-25): rebuilt on the 4,073 opens that DO have a stored value at open,
-- avg $67.66 vs $67.74 stored, median |diff| $0.00, 75 % exact. It fills 690 of the 710 opens with none.
--
-- Applied 2026-11-25 ~7:47 AM PT with Trevor's approval in chat (the session safety check held the first attempt).
-- anon-exec: unchanged (get_pinnacle_pack_reality) — CREATE OR REPLACE of an existing fn, same signature; ACL preserved, verified has_function_privilege('anon', …, 'EXECUTE') = false.
-- Not pinned (no supabase/tests file). Revert: re-apply the body from
--   20261123210500_audit_20261123_pinnacle_pack_reality.sql and its COMMENT.

CREATE OR REPLACE FUNCTION public.get_pinnacle_pack_reality(
  p_since timestamptz DEFAULT '2026-09-01 00:00:00-07',
  p_min_opens integer DEFAULT 25
)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH d AS (
    SELECT pd.dist_id::text AS dist_id,
           pd.title,
           NULLIF((pd.metadata ->> 'retail_price_usd')::numeric, 0) AS price_usd,
           COALESCE((regexp_match(pd.title, '^(.*Standard) - (.+)$'))[1], pd.title) AS drop_name
      FROM public.pack_distributions pd
     WHERE pd.collection_id = '7dd9dd11-e8b6-45c4-ac99-71331f959714'::uuid
       AND pd.title IS NOT NULL
       AND pd.title !~ '^\[OLD\]'
       AND pd.title NOT IN ('Internal Test', 'Distribution Mock Test')
       AND pd.dist_id::text <> '8922'
  ), o0 AS (
    SELECT o.pack_nft_id, o.dist_id, o.opened_at,
           CASE WHEN o.priced_at IS NOT NULL AND o.priced_at <= o.opened_at + interval '3 days'
                THEN o.pull_value_usd END AS stored_at_open,
           o.nft_ids
      FROM public.pinnacle_pack_opens o
     WHERE o.opened_at >= p_since
       AND o.dist_id IN (SELECT dist_id FROM d)
  ), rebuilt AS (
    -- 2026-11-25: an open priced LATE (> 3 days) has no stored value at open, but RPC did price its pins then:
    -- each pin's render FMV from pinnacle_fmv_history — the last one at or before the open, else the first within
    -- 3 days after it. A pack with ANY pin unpriced that way stays unknown, never summed as 0.
    SELECT o0.pack_nft_id,
           CASE WHEN count(*) > 0 AND count(h.fmv_usd) = count(*) THEN sum(h.fmv_usd) END AS value
      FROM o0
      CROSS JOIN LATERAL unnest(o0.nft_ids) u(nft)
      LEFT JOIN public.pinnacle_mint_events me ON me.nft_id::text = u.nft
      LEFT JOIN LATERAL (
        SELECT COALESCE(
                 (SELECT h1.fmv_usd FROM public.pinnacle_fmv_history h1
                   WHERE h1.render_id = me.render_id AND h1.computed_at <= o0.opened_at AND h1.fmv_usd > 0
                   ORDER BY h1.computed_at DESC LIMIT 1),
                 (SELECT h2.fmv_usd FROM public.pinnacle_fmv_history h2
                   WHERE h2.render_id = me.render_id AND h2.computed_at > o0.opened_at
                     AND h2.computed_at <= o0.opened_at + interval '3 days' AND h2.fmv_usd > 0
                   ORDER BY h2.computed_at LIMIT 1)) AS fmv_usd
      ) h ON true
     WHERE o0.stored_at_open IS NULL
     GROUP BY o0.pack_nft_id
  ), o AS (
    SELECT o0.pack_nft_id, o0.dist_id, o0.opened_at,
           COALESCE(o0.stored_at_open, r.value) AS value_at_open,
           (o0.stored_at_open IS NULL AND r.value IS NOT NULL) AS at_open_rebuilt,
           o0.nft_ids
      FROM o0
      LEFT JOIN rebuilt r ON r.pack_nft_id = o0.pack_nft_id
  ), pulls AS (
    SELECT o.pack_nft_id, count(*) AS n, count(pc.fmv_usd) FILTER (WHERE pc.fmv_usd > 0) AS n_priced,
           sum(pc.fmv_usd) FILTER (WHERE pc.fmv_usd > 0) AS value_today
      FROM o
      CROSS JOIN LATERAL unnest(o.nft_ids) u(nft)
      LEFT JOIN public.pinnacle_mint_events me ON me.nft_id::text = u.nft
      LEFT JOIN public.pinnacle_catalog pc ON pc.render_id = me.render_id
     GROUP BY o.pack_nft_id
  ), per_pack AS (
    SELECT d.drop_name, d.price_usd, d.dist_id, o.opened_at, o.value_at_open, o.at_open_rebuilt,
           CASE WHEN p.n > 0 AND p.n = p.n_priced THEN p.value_today END AS value_today
      FROM o
      JOIN d ON d.dist_id = o.dist_id
      LEFT JOIN pulls p ON p.pack_nft_id = o.pack_nft_id
  ), drops AS (
    SELECT drop_name, price_usd,
           array_agg(DISTINCT dist_id ORDER BY dist_id)                    AS dist_ids,
           count(*)::int                                                   AS packs_opened,
           min(opened_at)                                                  AS first_open_at,
           max(opened_at)                                                  AS last_open_at,
           count(value_at_open)::int                                       AS n_at_open,
           count(*) FILTER (WHERE at_open_rebuilt)::int                    AS n_at_open_rebuilt,
           round(avg(value_at_open), 2)                                    AS avg_value_at_open,
           count(value_today)::int                                         AS n_today,
           round(avg(value_today), 2)                                      AS avg_value_today,
           round((percentile_cont(0.5) WITHIN GROUP (ORDER BY value_today))::numeric, 2) AS median_value_today,
           round(max(value_today), 2)                                      AS best_pull_today,
           CASE WHEN price_usd IS NULL OR count(value_today) = 0 THEN NULL
                ELSE round(100.0 * count(*) FILTER (WHERE value_today >= price_usd) / count(value_today), 1)
           END                                                             AS pct_today_at_or_above_price
      FROM per_pack
     GROUP BY drop_name, price_usd
    HAVING count(*) >= GREATEST(COALESCE(p_min_opens, 25), 1)
  )
  SELECT jsonb_build_object(
    'since', p_since,
    'min_opens', GREATEST(COALESCE(p_min_opens, 25), 1),
    'drops', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'drop_name', drop_name, 'price_usd', price_usd, 'dist_ids', to_jsonb(dist_ids),
               'packs_opened', packs_opened, 'first_open_at', first_open_at, 'last_open_at', last_open_at,
               'n_at_open', n_at_open, 'n_at_open_rebuilt', n_at_open_rebuilt, 'avg_value_at_open', avg_value_at_open,
               'n_today', n_today, 'avg_value_today', avg_value_today,
               'median_value_today', median_value_today, 'best_pull_today', best_pull_today,
               'pct_today_at_or_above_price', pct_today_at_or_above_price)
             ORDER BY first_open_at DESC, drop_name)
        FROM drops), '[]'::jsonb)
  )
$function$;

COMMENT ON FUNCTION public.get_pinnacle_pack_reality(timestamptz, integer) IS
  'Disney Pinnacle Pack Reality (2026-11-23; value at open rebuilt from pinnacle_fmv_history 2026-11-25): per purchasable drop opened since p_since (default 2026-09-01 PT, the first drops valued at open), retail price vs the pulls'' value at open (first price within 3 days; where that was written late, each pin''s render FMV from pinnacle_fmv_history at the open, else within 3 days after — n_at_open_rebuilt) and today (current render FMV; packs with any unpriced pin left out), and the share of packs worth >= price today. Sub-pools of one "<X> Standard" product grouped (#157); non-products and the chase-only dist 8922 excluded; >= p_min_opens opens.';

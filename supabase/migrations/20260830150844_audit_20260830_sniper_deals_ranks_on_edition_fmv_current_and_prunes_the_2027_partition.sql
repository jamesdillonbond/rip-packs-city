-- audit_20260830: get_topshot_sniper_deals paid a scattered fmv_snapshots
-- heap read for every one of ~1,650 asked editions to rank 50.
--
-- MEASURED (pg_stat_statements lifetime): 5,342 calls, 8,425 ms mean,
-- 37,819 buffer hits + 1,653 disk reads per call, returning 50 rows. Callers:
-- /api/market (TS leg, per request), /api/sniper-feed (augmentation when the
-- GQL feed is sparse), /api/cron/warm every 30 min. In the 14:31->14:48Z
-- window: 9 calls / 151 s / 16.8 s mean.
--
-- The body with literal parameters runs in 48 ms warm on the identical
-- 17.6k buffers, so this is not a plan problem: it is one random
-- fmv_snapshots heap page per edition (the LATERAL "latest snapshot" per
-- edition) on a 512 MB-buffer instance where those pages are never resident
-- -- 1,726 cold reads at the ~9 ms/read this disk gives under load = the
-- whole 15 s. Two further wastes inside the same 17.6k: the empty
-- fmv_snapshots_2027 partition was probed on every loop (3,302 buffers, 19 %)
-- because `computed_at > now() - 90 days` is a LOWER bound and cannot prune a
-- FUTURE partition; and the whole latest-snapshot lookup is repeated for 1,600
-- editions that will not survive the LIMIT.
--
-- CHANGE: two stages, the pattern edition_fmv_current documents on itself
-- ("for ORDERING and bulk aggregation only -- NEVER as the displayed price;
-- readers take the ordering from here and re-read live values for the rows
-- that survive their LIMIT"):
--   1. rank every asked edition on edition_fmv_current (hourly refresh, 13 MB,
--      one hot index probe per edition), falling back to a live lookup ONLY for
--      editions with no current row (18 of 1,651 today), apply the caller's
--      rarity/team/price/discount filters on that estimate, LIMIT;
--   2. re-read the live latest snapshot for the survivors, recompute the
--      discount on the live value, re-apply the discount filter on it (so a
--      "deal" is never shown below the discount the caller asked for), and
--      order by the live values.
-- Every snapshot lookup now carries `computed_at <= now()` so the 2027
-- partition prunes at run time ("Subplans Removed: 2").
--
-- Measured on the same warm cache, default arguments: old 17,667 buffers;
-- new 13,829 (12,793 hit + 1,036 read, the reads being badge_editions and
-- edition_fmv_current pages that stay hot), 699 ms vs 15,652 ms in the
-- function call taken a minute earlier. Top-50 set diffed with EXCEPT in both
-- directions: 0 / 0; min discount identical (-2.9).
--
-- Trade stated: the CANDIDATE ranking uses a value up to ~3 h stale (hourly
-- refresh, 2 h watermark lag) for editions that are in edition_fmv_current;
-- the displayed price, discount and final order are live. An edition whose
-- FMV moved enough in the last 3 h to cross the LIMIT boundary can be ranked
-- one tick late. low_ask is live in both stages.
--
-- Same signature, same return columns, same source/buy_url strings.
-- anon-exec: get_topshot_sniper_deals -- unchanged (service_role only since
-- 20260731213000; CREATE OR REPLACE keeps the grants).
-- Revert: the previous body is not in any migration (pre-migration DDL);
-- it is reproduced verbatim at the bottom of this file under REVERT BODY.

CREATE OR REPLACE FUNCTION public.get_topshot_sniper_deals(
  p_min_discount numeric DEFAULT 0,
  p_max_price    numeric DEFAULT 0,
  p_rarity       text    DEFAULT 'all'::text,
  p_team         text    DEFAULT 'all'::text,
  p_sort_by      text    DEFAULT 'discount_desc'::text,
  p_limit        integer DEFAULT 50
)
 RETURNS TABLE(flow_id text, moment_id text, player_name text, team_name text, set_name text, series_name text, tier text, subedition_name text, serial_number integer, circulation_count integer, ask_price numeric, fmv_usd numeric, discount_pct numeric, confidence text, buy_url text, thumbnail_url text, listing_resource_id text, source text, listed_at timestamp with time zone)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH ranked AS (
    SELECT
      e.id,
      e.external_id,
      e.player_name,
      e.team_name,
      e.set_name,
      e.series::text        AS series_name,
      e.tier::text          AS tier,
      e.subedition_name,
      e.circulation_count,
      e.thumbnail_url,
      be.low_ask,
      be.updated_at,
      COALESCE(
        CASE WHEN efc.computed_at > now() - interval '90 days' THEN efc.fmv_usd END,
        lf.fmv_usd
      ) AS fmv_est
    FROM badge_editions be
    JOIN editions e
      ON e.external_id = be.external_id
     AND e.collection_id = be.collection_id
    LEFT JOIN edition_fmv_current efc
      ON efc.edition_id = e.id
     AND efc.fmv_usd IS NOT NULL
    LEFT JOIN LATERAL (
      -- Live fallback ONLY for editions edition_fmv_current has not seen yet.
      SELECT s.fmv_usd
      FROM fmv_snapshots s
      WHERE efc.edition_id IS NULL
        AND s.edition_id = e.id
        AND s.fmv_usd IS NOT NULL
        AND s.computed_at > now() - interval '90 days'
        AND s.computed_at <= now()
      ORDER BY s.computed_at DESC
      LIMIT 1
    ) lf ON true
    WHERE e.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid
      AND be.low_ask IS NOT NULL
      AND be.low_ask > 0
      AND COALESCE(CASE WHEN efc.computed_at > now() - interval '90 days' THEN efc.fmv_usd END, lf.fmv_usd) IS NOT NULL
      AND (COALESCE(p_rarity, 'all') = 'all' OR UPPER(e.tier::text) = UPPER(p_rarity))
      AND (COALESCE(p_team,   'all') = 'all' OR e.team_name ILIKE p_team)
      AND (COALESCE(p_max_price, 0) = 0    OR be.low_ask <= p_max_price)
      AND (
        COALESCE(p_min_discount, 0) = 0
        OR ROUND(((COALESCE(CASE WHEN efc.computed_at > now() - interval '90 days' THEN efc.fmv_usd END, lf.fmv_usd) - be.low_ask)
                  / NULLIF(COALESCE(CASE WHEN efc.computed_at > now() - interval '90 days' THEN efc.fmv_usd END, lf.fmv_usd), 0)) * 100, 1) >= p_min_discount
      )
    ORDER BY
      CASE WHEN p_sort_by = 'price_asc'  THEN be.low_ask END ASC  NULLS LAST,
      CASE WHEN p_sort_by = 'price_desc' THEN be.low_ask END DESC NULLS LAST,
      CASE WHEN p_sort_by = 'fmv_desc'   THEN COALESCE(CASE WHEN efc.computed_at > now() - interval '90 days' THEN efc.fmv_usd END, lf.fmv_usd) END DESC NULLS LAST,
      ROUND(((COALESCE(CASE WHEN efc.computed_at > now() - interval '90 days' THEN efc.fmv_usd END, lf.fmv_usd) - be.low_ask)
             / NULLIF(COALESCE(CASE WHEN efc.computed_at > now() - interval '90 days' THEN efc.fmv_usd END, lf.fmv_usd), 0)) * 100, 1) DESC NULLS LAST,
      be.low_ask ASC
    LIMIT COALESCE(p_limit, 50)
  ),
  live AS (
    SELECT
      r.*,
      fs.fmv_usd    AS live_fmv,
      fs.confidence AS live_confidence,
      ROUND(((fs.fmv_usd - r.low_ask) / NULLIF(fs.fmv_usd, 0)) * 100, 1) AS live_discount
    FROM ranked r
    JOIN LATERAL (
      SELECT s.fmv_usd, s.confidence
      FROM fmv_snapshots s
      WHERE s.edition_id = r.id
        AND s.fmv_usd IS NOT NULL
        AND s.computed_at > now() - interval '90 days'
        AND s.computed_at <= now()
      ORDER BY s.computed_at DESC
      LIMIT 1
    ) fs ON true
  )
  SELECT
    NULL::text                                                                AS flow_id,
    l.external_id                                                             AS moment_id,
    l.player_name                                                             AS player_name,
    l.team_name                                                               AS team_name,
    l.set_name                                                                AS set_name,
    l.series_name                                                             AS series_name,
    l.tier                                                                    AS tier,
    l.subedition_name                                                         AS subedition_name,
    NULL::integer                                                             AS serial_number,
    l.circulation_count                                                       AS circulation_count,
    l.low_ask                                                                 AS ask_price,
    l.live_fmv                                                                AS fmv_usd,
    l.live_discount                                                           AS discount_pct,
    l.live_confidence::text                                                   AS confidence,
    'https://www.nbatopshot.com/listings/p2p?editionFlowID=' || l.external_id AS buy_url,
    l.thumbnail_url                                                           AS thumbnail_url,
    NULL::text                                                                AS listing_resource_id,
    'topshot_marketplace'::text                                               AS source,
    l.updated_at                                                              AS listed_at
  FROM live l
  WHERE COALESCE(p_min_discount, 0) = 0 OR l.live_discount >= p_min_discount
  ORDER BY
    CASE WHEN p_sort_by = 'price_asc'  THEN l.low_ask END ASC  NULLS LAST,
    CASE WHEN p_sort_by = 'price_desc' THEN l.low_ask END DESC NULLS LAST,
    CASE WHEN p_sort_by = 'fmv_desc'   THEN l.live_fmv END DESC NULLS LAST,
    l.live_discount DESC NULLS LAST,
    l.low_ask ASC;
$function$;

-- REVERT BODY (verbatim pg_get_functiondef output, 2026-08-30 15:05Z, before this migration).
-- Re-apply with the same header (LANGUAGE sql STABLE SECURITY DEFINER, search_path public, pg_temp):
--
--   SELECT
--     NULL::text                                                                            AS flow_id,
--     e.external_id                                                                         AS moment_id,
--     e.player_name                                                                         AS player_name,
--     e.team_name                                                                           AS team_name,
--     e.set_name                                                                            AS set_name,
--     e.series::text                                                                        AS series_name,
--     e.tier::text                                                                          AS tier,
--     e.subedition_name                                                                     AS subedition_name,
--     NULL::integer                                                                         AS serial_number,
--     e.circulation_count                                                                   AS circulation_count,
--     be.low_ask                                                                            AS ask_price,
--     fs.fmv_usd                                                                            AS fmv_usd,
--     ROUND(((fs.fmv_usd - be.low_ask) / NULLIF(fs.fmv_usd, 0)) * 100, 1)                   AS discount_pct,
--     fs.confidence::text                                                                   AS confidence,
--     'https://www.nbatopshot.com/listings/p2p?editionFlowID=' || e.external_id             AS buy_url,
--     e.thumbnail_url                                                                       AS thumbnail_url,
--     NULL::text                                                                            AS listing_resource_id,
--     'topshot_marketplace'::text                                                           AS source,
--     be.updated_at                                                                         AS listed_at
--   FROM badge_editions be
--   JOIN editions e
--     ON e.external_id = be.external_id
--    AND e.collection_id = be.collection_id
--   JOIN LATERAL (
--     SELECT s.fmv_usd, s.confidence
--     FROM fmv_snapshots s
--     WHERE s.edition_id = e.id
--       AND s.fmv_usd IS NOT NULL
--       AND s.computed_at > now() - interval '90 days'
--     ORDER BY s.computed_at DESC
--     LIMIT 1
--   ) fs ON true
--   WHERE e.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid
--     AND be.low_ask IS NOT NULL
--     AND be.low_ask > 0
--     AND (COALESCE(p_rarity, 'all') = 'all' OR UPPER(e.tier::text) = UPPER(p_rarity))
--     AND (COALESCE(p_team,   'all') = 'all' OR e.team_name ILIKE p_team)
--     AND (COALESCE(p_max_price, 0) = 0    OR be.low_ask <= p_max_price)
--     AND (
--       COALESCE(p_min_discount, 0) = 0
--       OR ROUND(((fs.fmv_usd - be.low_ask) / NULLIF(fs.fmv_usd, 0)) * 100, 1) >= p_min_discount
--     )
--   ORDER BY
--     CASE WHEN p_sort_by = 'price_asc'  THEN be.low_ask END ASC  NULLS LAST,
--     CASE WHEN p_sort_by = 'price_desc' THEN be.low_ask END DESC NULLS LAST,
--     CASE WHEN p_sort_by = 'fmv_desc'   THEN fs.fmv_usd END DESC NULLS LAST,
--     ROUND(((fs.fmv_usd - be.low_ask) / NULLIF(fs.fmv_usd, 0)) * 100, 1) DESC NULLS LAST,
--     be.low_ask ASC
--   LIMIT COALESCE(p_limit, 50);

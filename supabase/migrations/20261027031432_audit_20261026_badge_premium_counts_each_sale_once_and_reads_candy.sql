-- audit_20261026: get_badge_premium counts each sale ONCE, and reads Candy MLB's designations.
--
-- (1) DOUBLE COUNT (every collection it serves — Top Shot today). badge_map was SELECT DISTINCT (edition_key,
--     badge), so an edition carrying two qualifying badges ("Rookie Year" + "Rookie Premiere", ...) sat in the map
--     twice and every one of its sales joined twice into `badged`. Measured 2026-10-26 on Top Shot, 30 d: the map
--     held 5,447 rows over 3,819 editions; COMMON badged sales read 7,569 for a true 3,826, badged avg $6.22 for a
--     true $4.13 — so the Analytics tab's "Badge Premium" published ~+450 % for a true ~+265 %. The map is now one
--     row per EDITION (the badge title was never output). `unbadged` was unaffected (anti-join).
-- (2) CANDY MLB had no arm: the Top Shot titles come from badge_editions (Top Shot play tags), so Candy returned
--     NULL and its Analytics tab printed "No data" beside a collection that DOES carry edition designations —
--     editions.badges 'Rookie' / 'First Mint', from Candy's published checklist (the Market tab's Badges filter
--     already reads them). 30 d on 10-26: COMMON badged 80 sales $6.80 vs unbadged 733 at $1.41. The Rainbow
--     colour badges ('Rainbow (…)') are the PARALLEL, not a designation, and are not counted.
-- Output shape, defaults, volatility, search_path and ACL unchanged.
--
-- anon-exec: unchanged (get_badge_premium) — CREATE OR REPLACE of an existing fn; ACL preserved (PUBLIC/anon/authenticated EXECUTE, as before: an invoker-rights read of public tables behind the public Analytics tab).
--
-- Revert: re-apply the body with `SELECT DISTINCT <edition_key>, tag->>'title' as badge` and no Candy UNION arm
-- (prosrc md5 before this migration: 690942f89b8828dcc2056e0d6958775c).

CREATE OR REPLACE FUNCTION public.get_badge_premium(p_collection_id uuid DEFAULT '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid, p_since timestamp with time zone DEFAULT (now() - '30 days'::interval))
 RETURNS json
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH badge_map AS (
    -- one row per EDITION (2026-10-26): a (edition, badge) map joined every sale of a two-badge edition twice
    SELECT DISTINCT split_part(be.id, '+', 1) || ':' || split_part(be.id, '+', 2) as edition_key
    FROM badge_editions be, jsonb_array_elements(play_tags) as tag
    WHERE be.collection_id = p_collection_id
      AND tag->>'title' IN ('Top Shot Debut','Rookie Year','Championship Year','MVP Year','Rookie of the Year','Rookie Premiere','Rookie Mint')
    UNION
    -- Candy MLB (2026-10-26): Candy's checklist designations, carried on editions.badges
    SELECT e.external_id
    FROM editions e
    WHERE p_collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid
      AND e.collection_id = p_collection_id
      AND e.badges && ARRAY['Rookie', 'First Mint']::text[]
  ),
  badged AS (
    SELECT e.tier::text, round(avg(s.price_usd)::numeric, 2) as avg_price, count(*)::int as sales
    FROM sales s JOIN editions e ON e.id = s.edition_id
    JOIN badge_map bm ON bm.edition_key = e.external_id
    WHERE s.collection_id = p_collection_id AND s.sold_at >= p_since AND s.price_usd > 0
    GROUP BY e.tier
  ),
  unbadged AS (
    SELECT e.tier::text, round(avg(s.price_usd)::numeric, 2) as avg_price, count(*)::int as sales
    FROM sales s JOIN editions e ON e.id = s.edition_id
    LEFT JOIN badge_map bm ON bm.edition_key = e.external_id
    WHERE s.collection_id = p_collection_id AND s.sold_at >= p_since AND s.price_usd > 0 AND bm.edition_key IS NULL
    GROUP BY e.tier
  )
  SELECT json_agg(row_to_json(t)) FROM (
    SELECT b.tier,
      b.avg_price as badged_avg, b.sales as badged_sales,
      u.avg_price as unbadged_avg, u.sales as unbadged_sales,
      CASE WHEN u.avg_price > 0 THEN round(((b.avg_price - u.avg_price) / u.avg_price * 100)::numeric, 1) ELSE null END as premium_pct
    FROM badged b JOIN unbadged u ON b.tier = u.tier
    ORDER BY premium_pct DESC NULLS LAST
  ) t;
$function$;

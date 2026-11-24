-- audit_20261123: Candy squeeze default view = the 2026 sets only (follow-up to 20261124032031, same evening).
--
-- 20261124032031 made the default (p_set NULL) "every registry set", which also pulled in 2024 MLB Team Balls
-- (+12 rows: 295 vs 283) under page copy that says "2026". The default is now the registry sets named "2026 …"
-- (Base, All-Star Game, Gold, Quest) — 283 rows, identical to 20261124023333; Team Balls stays selectable by p_set
-- like every other eligible set. Body otherwise unchanged.
--
-- Revert: re-apply get_candy_listed_squeeze from 20261124032031.

-- anon-exec: unchanged (get_candy_listed_squeeze) — CREATE OR REPLACE of the existing 3-arg fn; ACL preserved, verified has_function_privilege anon=false.
CREATE OR REPLACE FUNCTION public.get_candy_listed_squeeze(p_min_held integer DEFAULT 25, p_limit integer DEFAULT 100, p_set uuid DEFAULT NULL)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH elig AS MATERIALIZED (
    SELECT c.set_id, (c.registry_key IS NOT NULL) AS is_registry, c.market_checked_at
      FROM public.candy_collections c
     WHERE c.set_id IS NOT NULL
       AND c.kind IS DISTINCT FROM 'test'
       AND (c.registry_key IS NOT NULL
            OR (c.me_symbol IS NOT NULL
                AND c.market_error IS NULL
                AND c.market_checked_at > now() - interval '12 hours'
                AND c.last_census_clean_walk_started_at IS NOT NULL))
  ), ed AS MATERIALIZED (
    SELECT e.id, e.external_id::text AS k, e.set_id, e.player_name, e.name AS edition_name, e.set_name,
           e.rarity_label, e.thumbnail_url, e.circulation_count, el.is_registry
      FROM public.editions e
      JOIN elig el ON el.set_id = e.set_id
     WHERE e.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid
  ), base AS MATERIALIZED (
    SELECT ed.*, h.collector_held, h.candy_held,
           COALESCE(f.confirmed_listing_count, 0)::int AS listed,
           CASE WHEN f.confirmed_floor_usd > 0 THEN f.confirmed_floor_usd END AS floor_ask_usd
      FROM ed
      JOIN public.mv_candy_edition_holders h ON h.edition_key = ed.k
      LEFT JOIN public.candy_listing_floor f ON f.edition_id = ed.id
     WHERE h.collector_held >= GREATEST(COALESCE(p_min_held, 25), 1)
  ), pick AS (
    SELECT * FROM base b WHERE (p_set IS NULL AND b.is_registry AND b.set_name LIKE '2026 %') OR b.set_id = p_set
  ), s AS (
    SELECT edition_id, count(*)::int AS sales_30d
      FROM public.sales
     WHERE collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid
       AND sold_at >= now() - interval '30 days' AND price_usd > 0
       AND edition_id IN (SELECT id FROM pick)
     GROUP BY edition_id
  ), r AS (
    SELECT p.k AS external_id, p.set_id, COALESCE(NULLIF(btrim(p.player_name), ''), p.edition_name) AS player_name,
           p.set_name, p.rarity_label, p.thumbnail_url,
           p.circulation_count AS minted, NULL::int AS burned, p.candy_held AS issuer_held, p.collector_held,
           p.listed, p.floor_ask_usd,
           CASE WHEN fc.fmv_usd > 0 THEN fc.fmv_usd END AS fmv_usd,
           COALESCE(s.sales_30d, 0) AS sales_30d
      FROM pick p
      LEFT JOIN public.candy_fmv_current fc ON fc.edition_id = p.id
      LEFT JOIN s ON s.edition_id = p.id
  )
  SELECT jsonb_build_object(
    'listings_seen_at', (SELECT max(last_seen_at) FROM public.candy_listings WHERE is_active),
    'holders_counted_at', (SELECT max(refreshed_at) FROM public.mv_candy_edition_holders),
    'min_held', GREATEST(COALESCE(p_min_held, 25), 1),
    'set_id', p_set,
    'editions_ranked', (SELECT count(*) FROM r),
    'editions_zero_listed', (SELECT count(*) FROM r WHERE listed = 0),
    'sets', COALESCE((SELECT jsonb_agg(jsonb_build_object(
                'set_id', set_id, 'set_name', set_name, 'registry', is_registry,
                'ranked', n, 'zero_listed', z, 'asks', a) ORDER BY is_registry DESC, a DESC, n DESC, set_name)
              FROM (SELECT set_id, set_name, bool_or(is_registry) AS is_registry, count(*) n,
                           count(*) FILTER (WHERE listed = 0) z, sum(listed)::int a
                      FROM base GROUP BY set_id, set_name) x), '[]'::jsonb),
    'rows', COALESCE((SELECT jsonb_agg(to_jsonb(x) ORDER BY x.pct_listed, x.sales_30d DESC, x.collector_held DESC, x.external_id)
       FROM (SELECT r.*, round(100.0 * r.listed / r.collector_held, 1) AS pct_listed
               FROM r
              ORDER BY (r.listed::numeric / r.collector_held), r.sales_30d DESC, r.collector_held DESC, r.external_id
              LIMIT LEAST(GREATEST(COALESCE(p_limit, 100), 1), 500)) x), '[]'::jsonb)
  )
$function$;


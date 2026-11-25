-- audit_20261124_candy_squeeze_listings_stamp_is_the_oldest_venue
--
-- 2026-11-24 ~8:40 PM PT (Claude Code cloud, autonomous pass; Trevor: "work autonomously ... fix any issues you encounter").
-- WHY. get_candy_listed_squeeze's `listings_seen_at` (rendered "Listings as of ..." on the Candy Squeeze board) was
-- max(last_seen_at) over ALL active candy_listings. Since 11-23 two lanes write that table: the hourly OpenSea chain
-- lane and the 3-hourly Magic Eden indexer (live 11-24 ~6:40 PM PT: OpenSea newest 6:41 PM, Magic Eden 5:51 PM, ~1,500
-- active rows each). If the Magic Eden sweep stalled, its rows would drop out of the 12 h confirmed listing count and
-- those editions would read "0 listed" (tightest supply) while the stamp still showed the last hour. Found by review.
-- WHAT. The stamp is the oldest of the per-venue newest active rows: "as of" now means every venue was read at least
-- that recently. Nothing else changes. Body otherwise = 20261124034000 (live prosrc md5 c6e7f6b0dd018bff0969a9a6795a8c92,
-- asserted below).
-- anon-exec: unchanged (get_candy_listed_squeeze) -- CREATE OR REPLACE of an existing fn, same signature; ACL preserved.
-- REVERT: re-apply the function block of 20261124034000_audit_20261123_candy_squeeze_default_2026_sets.sql.

DO $guard$
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.get_candy_listed_squeeze(integer,integer,uuid)'::regprocedure)
     IS DISTINCT FROM 'c6e7f6b0dd018bff0969a9a6795a8c92' THEN
    RAISE EXCEPTION 'get_candy_listed_squeeze is not the 20261124034000 body; re-read it and re-base';
  END IF;
END
$guard$;

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
    -- 2026-11-24: the OLDEST venue's newest active row, not the newest across venues. Since 11-23 the hourly OpenSea lane
    -- writes candy_listings too, so a max() across venues read "as of the last hour" while a stalled Magic Eden sweep
    -- (every 3 h, half the book) aged out of the 12 h confirmed count and its editions read "0 listed".
    'listings_seen_at', (SELECT min(v.newest) FROM (SELECT max(l.last_seen_at) AS newest FROM public.candy_listings l
                                                     WHERE l.is_active GROUP BY l.venue) v),
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

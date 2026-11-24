-- audit_20261123: Candy squeeze opens to every Candy set with a trustworthy listing sweep (Candy parity pass 3,
-- 2026-11-23 evening, Trevor: "Do it all").
--
-- WHY LEGACY SETS CAN JOIN NOW (measured 11-23 ~7:20 PM PT). Magic Eden's /stats listedCount looked like proof our
-- legacy ask book was ~7 % complete (2025 All-Star ICONS: ME 501, ours 34). It is not: the collections-market lane
-- SEES ~494 of them and skips the ones already stamped owner_moved_at. On three sets those were 986 asks from 74
-- sellers, and 70 of the 74 hold no Candy at all — the pre-October custodial wallets Candy's migration emptied. Magic
-- Eden still serves their dead listings, so its listedCount is inflated and our filtered book is the live one. The lane
-- sweeps every collection ≥ once per ~7.5 h (max age read 7.5 h), so a confirmed ask (re-seen ≤ 12 h) is a census.
--
-- 1. mv_candy_edition_holders — per Candy edition_key: collector_held (census rows outside candy_house_wallets —
--    inventory, ICON buyback, pack treasury) and candy_held (inside them), the same split 20261124023333 counts live.
--    Live it costs ~1.27M buffers / ~17 s over ~1.37M census rows, so it is precomputed. Refreshed CONCURRENTLY by pg_cron
--    `rpc-refresh-candy-edition-holders` at 33 */3 (a free minute; the census itself walks hourly). Not exposed to the
--    API roles.
-- 2. get_candy_listed_squeeze(p_min_held, p_limit, p_set) replaces the 2-arg form. Eligible sets: the registry sets
--    (2026 Base / All-Star Game / Gold / Quest, 2024 Team Balls — their asks come from candy-listings-indexer) and every
--    non-test legacy collection whose Magic Eden symbol is known, whose last market sweep had no error and is < 12 h
--    old, and whose census has a clean walk. Anything else is left OFF, never shown as "0 listed".
--    p_set NULL = the registry sets (the board's default, unchanged); p_set = one eligible set's id. The payload adds
--    `sets` for EVERY eligible set (id, name, ranked, zero_listed, confirmed asks, registry flag) and
--    `holders_counted_at`.
--
-- Revert: DROP FUNCTION public.get_candy_listed_squeeze(integer, integer, uuid); re-apply the 2-arg body from
-- 20261124023333; SELECT cron.unschedule('rpc-refresh-candy-edition-holders'); DROP MATERIALIZED VIEW public.mv_candy_edition_holders;

CREATE MATERIALIZED VIEW IF NOT EXISTS public.mv_candy_edition_holders AS
  WITH hw AS MATERIALIZED (SELECT wallet_address FROM public.candy_house_wallets)
  SELECT w.edition_key,
         count(*) FILTER (WHERE w.wallet_address NOT IN (SELECT wallet_address FROM hw))::int AS collector_held,
         count(*) FILTER (WHERE w.wallet_address IN (SELECT wallet_address FROM hw))::int AS candy_held,
         now() AS refreshed_at
    FROM public.wallet_moments_cache w
   WHERE w.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid
     AND w.edition_key IS NOT NULL
   GROUP BY w.edition_key;

CREATE UNIQUE INDEX IF NOT EXISTS mv_candy_edition_holders_key ON public.mv_candy_edition_holders (edition_key);

REVOKE ALL ON public.mv_candy_edition_holders FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.mv_candy_edition_holders TO service_role;

COMMENT ON MATERIALIZED VIEW public.mv_candy_edition_holders IS
  'Candy holders per edition_key from the census (wallet_moments_cache): collector_held outside candy_house_wallets, candy_held inside them; refreshed_at = refresh time. Refreshed CONCURRENTLY by pg_cron rpc-refresh-candy-edition-holders (33 */3). Read by get_candy_listed_squeeze. 2026-11-23.';

SELECT cron.schedule('rpc-refresh-candy-edition-holders', '33 */3 * * *',
  'REFRESH MATERIALIZED VIEW CONCURRENTLY public.mv_candy_edition_holders');

DROP FUNCTION IF EXISTS public.get_candy_listed_squeeze(integer, integer);

-- anon-exec: revoked (get_candy_listed_squeeze) — new 3-arg signature (the 2-arg form is dropped above); REVOKE FROM PUBLIC, anon, authenticated below.
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
    SELECT * FROM base b WHERE (p_set IS NULL AND b.is_registry) OR b.set_id = p_set
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

REVOKE ALL ON FUNCTION public.get_candy_listed_squeeze(integer, integer, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_candy_listed_squeeze(integer, integer, uuid) TO service_role;

COMMENT ON FUNCTION public.get_candy_listed_squeeze(integer, integer, uuid) IS
  'Candy listed-share squeeze (2026-11-23; every set with a trustworthy sweep from 20261124033000): editions with >= p_min_held collector-held copies (mv_candy_edition_holders) ranked by confirmed Magic Eden listings (candy_listing_floor, re-seen within 12 h) / collector_held ascending. p_set NULL = registry (2026) sets; else one eligible set. Eligible legacy sets: ME symbol known, last market sweep error-free and < 12 h old, clean census walk. Payload: per-set summary for every eligible set, holders_counted_at, newest sweep stamp.';

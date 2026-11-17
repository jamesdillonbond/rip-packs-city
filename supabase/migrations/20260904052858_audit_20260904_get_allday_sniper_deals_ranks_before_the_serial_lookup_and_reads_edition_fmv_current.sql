-- audit_20260904_get_allday_sniper_deals_ranks_before_the_serial_lookup_and_reads_edition_fmv_current
-- Applied to prod via MCP apply_migration 2026-09-04 05:28Z (version 20260904052858).
--
-- FINDING (2026-09-04 Playwright sweep): /nfl-all-day/sniper rendered "COULDN'T LOAD THE FLOOR" on
-- EVERY load — not a transient. The route's first leg (Dapper Studio GraphQL) answers 403 for the
-- server, so it always falls back to this RPC — and this RPC was measured at 16,767 ms / ~170K
-- buffers, past the route's 8 s `boundedRead`, on every call. So the honest-error branch fired
-- every time and the page never showed a deal, while 39,091 open All Day listings sat in
-- `cached_listings_v2` (newest ingested 04:32Z — the feed is live, the reader was the problem).
--
-- WHY IT WAS SLOW: the old body joined the per-Moment `wallet_moments_cache` serial lookup
-- (LEFT JOIN LATERAL … LIMIT 1) to EVERY open listing BEFORE filtering, ranking and LIMITing, and
-- read FMV through the fmv_snapshots partitions. 39K lateral probes to produce 50 rows.
--
-- FIX (same signature, same columns, same sort keys, same buy_url shape):
--   1. `open_l` MATERIALIZED — the open AD listings, via idx_cl_v2_collection_active, max-price applied.
--   2. `ranked` — join `edition_fmv_current` (the sanctioned latest-per-edition surface; fmv_usd not
--      null, computed_at within 90 d) and `editions`, apply rarity/team/min-discount, ORDER BY the
--      original CASE sort keys, LIMIT p_limit.
--   3. ONLY THEN the serial lookup, over the ≤ p_limit rows that survive.
-- MEASURED (EXPLAIN ANALYZE BUFFERS, defaults): 16,767 ms / 170K buffers → 204 ms / 19.5K buffers;
-- warm `select count(*) from get_allday_sniper_deals()` = 50 rows in 385 ms. Page re-check after
-- apply: 97 deals render, 0 bad responses.
--
-- ACL: `CREATE OR REPLACE` on an UNCHANGED signature keeps the existing acl —
-- re-read after apply: {postgres=X/postgres,service_role=X/postgres}, one overload,
-- check_secdef_anon_execute_violations() = []. The explicit REVOKE/GRANT below is belt-and-braces
-- for a fresh database where this file is applied first.
-- anon-exec: no — get_allday_sniper_deals stays postgres/service_role only (the route calls it with
--   the service client); REVOKE … FROM PUBLIC, anon, authenticated below.
--
-- REVERT: re-apply the previous body — it is the definition in
--   supabase/migrations/*get_allday_sniper_deals* files earlier than this version (the last one to
--   define the function), or `git log -S get_allday_sniper_deals -- supabase/migrations`. The DB half
--   is the function body only; no data changed.

CREATE OR REPLACE FUNCTION public.get_allday_sniper_deals(
  p_min_discount numeric DEFAULT 0,
  p_max_price numeric DEFAULT 0,
  p_rarity text DEFAULT 'all'::text,
  p_team text DEFAULT 'all'::text,
  p_sort_by text DEFAULT 'discount_desc'::text,
  p_limit integer DEFAULT 50
)
RETURNS TABLE(
  flow_id text, moment_id text, player_name text, team_name text, set_name text, series_name text,
  tier text, serial_number integer, circulation_count integer, ask_price numeric, fmv_usd numeric,
  discount_pct numeric, confidence text, buy_url text, thumbnail_url text, listing_resource_id text,
  source text, listed_at timestamp with time zone
)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH open_l AS MATERIALIZED (
    SELECT cl.listing_resource_id, cl.source, cl.flow_id, cl.edition_id, cl.collection_id, cl.price_usd, cl.listed_at
    FROM cached_listings_v2 cl
    WHERE cl.collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070'::uuid
      AND cl.completed_at IS NULL
      AND (COALESCE(p_max_price, 0) = 0 OR cl.price_usd <= p_max_price)
  ),
  ranked AS (
    SELECT
      cl.flow_id, cl.edition_id, cl.collection_id, cl.price_usd, cl.listed_at, cl.listing_resource_id, cl.source,
      e.external_id, e.player_name, e.team_name, e.set_name, e.series, e.tier, e.circulation_count, e.thumbnail_url,
      l.fmv_usd, l.confidence,
      ROUND(((l.fmv_usd - cl.price_usd) / NULLIF(l.fmv_usd, 0)) * 100, 1) AS discount_pct
    FROM open_l cl
    JOIN edition_fmv_current l
      ON l.edition_id = cl.edition_id
     AND l.fmv_usd IS NOT NULL
     AND l.computed_at > now() - interval '90 days'
    JOIN editions e ON e.id = cl.edition_id
    WHERE (COALESCE(p_rarity, 'all') = 'all' OR UPPER(e.tier::text) = UPPER(p_rarity))
      AND (COALESCE(p_team,   'all') = 'all' OR e.team_name ILIKE p_team)
      AND (
        COALESCE(p_min_discount, 0) = 0
        OR ROUND(((l.fmv_usd - cl.price_usd) / NULLIF(l.fmv_usd, 0)) * 100, 1) >= p_min_discount
      )
    ORDER BY
      CASE WHEN p_sort_by = 'price_asc'  THEN cl.price_usd END ASC  NULLS LAST,
      CASE WHEN p_sort_by = 'price_desc' THEN cl.price_usd END DESC NULLS LAST,
      CASE WHEN p_sort_by = 'fmv_desc'   THEN l.fmv_usd   END DESC NULLS LAST,
      ROUND(((l.fmv_usd - cl.price_usd) / NULLIF(l.fmv_usd, 0)) * 100, 1) DESC NULLS LAST,
      cl.price_usd ASC
    LIMIT COALESCE(p_limit, 50)
  )
  SELECT
    r.flow_id::text                                          AS flow_id,
    r.external_id                                            AS moment_id,
    r.player_name                                            AS player_name,
    r.team_name                                              AS team_name,
    r.set_name                                               AS set_name,
    r.series::text                                           AS series_name,
    r.tier::text                                             AS tier,
    wmc.serial_number                                        AS serial_number,
    r.circulation_count                                      AS circulation_count,
    r.price_usd                                              AS ask_price,
    r.fmv_usd                                                AS fmv_usd,
    r.discount_pct                                           AS discount_pct,
    r.confidence::text                                       AS confidence,
    'https://nflallday.com/listing/' || r.listing_resource_id::text AS buy_url,
    r.thumbnail_url                                          AS thumbnail_url,
    r.listing_resource_id::text                              AS listing_resource_id,
    r.source                                                 AS source,
    r.listed_at                                              AS listed_at
  FROM ranked r
  LEFT JOIN LATERAL (
    SELECT w.serial_number
    FROM wallet_moments_cache w
    WHERE w.moment_id = r.flow_id::text
      AND w.collection_id = r.collection_id
    LIMIT 1
  ) wmc ON true
  ORDER BY
    CASE WHEN p_sort_by = 'price_asc'  THEN r.price_usd END ASC  NULLS LAST,
    CASE WHEN p_sort_by = 'price_desc' THEN r.price_usd END DESC NULLS LAST,
    CASE WHEN p_sort_by = 'fmv_desc'   THEN r.fmv_usd   END DESC NULLS LAST,
    r.discount_pct DESC NULLS LAST,
    r.price_usd ASC;
$function$;

REVOKE EXECUTE ON FUNCTION public.get_allday_sniper_deals(numeric, numeric, text, text, text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_allday_sniper_deals(numeric, numeric, text, text, text, integer) TO postgres, service_role;

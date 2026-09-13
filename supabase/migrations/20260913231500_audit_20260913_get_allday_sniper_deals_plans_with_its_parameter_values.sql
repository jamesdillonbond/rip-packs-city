-- audit_20260913_get_allday_sniper_deals_plans_with_its_parameter_values
--
-- ── THE DEFECT, MEASURED ─────────────────────────────────────────────────────
-- `get_allday_sniper_deals` is the fallback the All Day leg of /api/sniper-feed
-- takes when the live GQL pool comes back empty — rarely, but then it IS the
-- whole All Day board, and its history is the 20,145 ms mean and 3 × 504 that
-- the route's own comment records. It is the same shape as the Top Shot
-- function fixed earlier today (`20260913200500`): a `LANGUAGE sql` body with a
-- MATERIALIZED CTE, a LIMIT and `COALESCE(p_x, 'all') = 'all' OR …` filters,
-- which is not inlined and is planned with every parameter UNKNOWN — the
-- generic shape, every call.
--
-- Measured 2026-09-13 ~4:0x PM PT on a QUIET instance (io_waiters 1, active 2,
-- no maintenance op), warm vs warm, same instant:
--   the call, (0, 0, 'all', 'all', 'discount_desc', 200):
--     415 ms · shared hit 130,367 · temp written 424
--   the same body with the six values written in as literals:
--     201 ms · shared hit 19,935 · temp written 423
-- 6.5× the buffers for the same 200 rows. Under saturation that difference is
-- what turns a 2 s read into the 20 s one the route comment remembers.
--
-- ── THE CHANGE ───────────────────────────────────────────────────────────────
-- Same signature, same body, same grants. The body runs through
-- `RETURN QUERY EXECUTE … USING` in plpgsql: a one-shot plan that sees the
-- parameter VALUES. The outer SELECT casts each column to the declared return
-- type (plpgsql is strict where the SQL function coerced silently).
--
-- Verified on the live data before this file was written, on a scratch copy
-- under another name (dropped afterwards via execute_sql): identical row SETS
-- on three parameter sets — see the ledger entry of the same hour for the
-- counts — and the scratch copy's cost against the function it replaces.
--
-- anon-exec: get_allday_sniper_deals -- unchanged (service_role + postgres only; the REVOKE/GRANT below re-assert what was there)

CREATE OR REPLACE FUNCTION public.get_allday_sniper_deals(p_min_discount numeric DEFAULT 0, p_max_price numeric DEFAULT 0, p_rarity text DEFAULT 'all'::text, p_team text DEFAULT 'all'::text, p_sort_by text DEFAULT 'discount_desc'::text, p_limit integer DEFAULT 50)
 RETURNS TABLE(flow_id text, moment_id text, player_name text, team_name text, set_name text, series_name text, tier text, serial_number integer, circulation_count integer, ask_price numeric, fmv_usd numeric, discount_pct numeric, confidence text, buy_url text, thumbnail_url text, listing_resource_id text, source text, listed_at timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  RETURN QUERY EXECUTE $q$
SELECT q.flow_id::text, q.moment_id::text, q.player_name::text, q.team_name::text, q.set_name::text, q.series_name::text, q.tier::text, q.serial_number::integer, q.circulation_count::integer, q.ask_price::numeric, q.fmv_usd::numeric, q.discount_pct::numeric, q.confidence::text, q.buy_url::text, q.thumbnail_url::text, q.listing_resource_id::text, q.source::text, q.listed_at::timestamptz FROM (
  WITH open_l AS MATERIALIZED (
    SELECT cl.listing_resource_id, cl.source, cl.flow_id, cl.edition_id, cl.collection_id, cl.price_usd, cl.listed_at
    FROM cached_listings_v2 cl
    WHERE cl.collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070'::uuid
      AND cl.completed_at IS NULL
      AND (COALESCE($2, 0) = 0 OR cl.price_usd <= $2)
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
    WHERE (COALESCE($3, 'all') = 'all' OR UPPER(e.tier::text) = UPPER($3))
      AND (COALESCE($4, 'all') = 'all' OR e.team_name ILIKE $4)
      AND (
        COALESCE($1, 0) = 0
        OR ROUND(((l.fmv_usd - cl.price_usd) / NULLIF(l.fmv_usd, 0)) * 100, 1) >= $1
      )
    ORDER BY
      CASE WHEN $5 = 'price_asc'  THEN cl.price_usd END ASC  NULLS LAST,
      CASE WHEN $5 = 'price_desc' THEN cl.price_usd END DESC NULLS LAST,
      CASE WHEN $5 = 'fmv_desc'   THEN l.fmv_usd   END DESC NULLS LAST,
      ROUND(((l.fmv_usd - cl.price_usd) / NULLIF(l.fmv_usd, 0)) * 100, 1) DESC NULLS LAST,
      cl.price_usd ASC
    LIMIT COALESCE($6, 50)
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
    CASE WHEN $5 = 'price_asc'  THEN r.price_usd END ASC  NULLS LAST,
    CASE WHEN $5 = 'price_desc' THEN r.price_usd END DESC NULLS LAST,
    CASE WHEN $5 = 'fmv_desc'   THEN r.fmv_usd   END DESC NULLS LAST,
    r.discount_pct DESC NULLS LAST,
    r.price_usd ASC
) q
$q$ USING p_min_discount, p_max_price, p_rarity, p_team, p_sort_by, p_limit;
END;
$function$;

REVOKE ALL ON FUNCTION public.get_allday_sniper_deals(numeric, numeric, text, text, text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_allday_sniper_deals(numeric, numeric, text, text, text, integer) TO service_role, postgres;

COMMENT ON FUNCTION public.get_allday_sniper_deals(numeric, numeric, text, text, text, integer) IS
'AllDay sniper feed. Rewritten 2026-05-17 to read from cached_listings_v2 (the active 30K-row listings cache) instead of the legacy cached_listings table which had drifted to 19 rows. Uses LATERAL latest-FMV subquery for partition-prunable read, adds COALESCE wrappers for NULL-safe filter args. buy_url synthesized from listing_resource_id since v2 doesn''t store it. 2026-09-13: body now runs via RETURN QUERY EXECUTE … USING (plpgsql) so it is planned with the parameter VALUES — the LANGUAGE sql form planned every call as the generic shape at 6.5× the buffers (migration 20260913231500).';

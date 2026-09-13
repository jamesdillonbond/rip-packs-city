-- audit_20260913_get_topshot_sniper_deals_plans_with_its_parameter_values
--
-- ── THE DEFECT, MEASURED ─────────────────────────────────────────────────────
-- `get_topshot_sniper_deals` is the Top Shot leg of /api/market and the
-- sparse-pool augmentation of /api/sniper-feed — the heaviest user-facing RPC
-- on the instance: pg_stat_statements since 08-12 read 8,309 calls · mean
-- 6.2 s · max 30 s · 43,065 blocks/call. /api/market bounds the read at 8 s,
-- so a mean within 2 s of the bound means every cold CDN hit 503s the moment
-- the instance is merely busy (13 of them in the hour to 12:46 PM PT today,
-- AFTER the saturation spell had ended).
--
-- The same query with its parameters written in as literals ran in 848 ms
-- over 7,642 buffers — a 10× gap on the same data, same instant. PREPARE +
-- `plan_cache_mode = force_generic_plan` reproduced the slow shape exactly:
-- 3.7 s, 86,712 buffers, every join estimated at rows=1 (the planner cannot
-- see through `COALESCE($3,'all') = 'all' OR …` with $3 unknown), so it picks
-- nested loops with 13,341 index probes into editions and edition_fmv_current
-- instead of the two hash joins it picks when the values are known. A
-- `LANGUAGE sql` function with CTEs and LIMIT is not inlined, and its body is
-- planned with the parameters as unknowns — the generic shape, every call.
--
-- ── THE CHANGE ───────────────────────────────────────────────────────────────
-- Same signature, same body, same grants. The body now runs through
-- `RETURN QUERY EXECUTE … USING` in plpgsql: a one-shot plan that sees the
-- parameter VALUES, so the planner chooses the hash-join shape with them in
-- hand, every call. The outer SELECT casts each column to the declared return
-- type (plpgsql is strict where the SQL function coerced silently; `external_id`
-- is varchar(100)). The subquery's ORDER BY is preserved by the projection.
--
-- Verified on the live data before this file was written (a scratch copy under
-- another name, dropped afterwards via execute_sql): identical row SETS on three parameter sets —
-- (0,0,'all','all','discount_desc',200) 200 = 200 · (10,500,'RARE','all',
-- 'price_asc',50) 49 = 49 · (0,0,'all','Los Angeles Lakers','fmv_desc',25)
-- 25 = 25 — with 0 rows differing either way; the only ORDER differences were
-- six adjacent tie swaps (equal discount AND equal ask), which the old body
-- orders nondeterministically as well. Cost: 116 ms / 10,291 buffers against
-- 7,374 ms / 89,314 for the function it replaces.
--
-- anon-exec: get_topshot_sniper_deals -- unchanged (service_role only; the REVOKE/GRANT below re-assert what was there)

CREATE OR REPLACE FUNCTION public.get_topshot_sniper_deals(p_min_discount numeric DEFAULT 0, p_max_price numeric DEFAULT 0, p_rarity text DEFAULT 'all'::text, p_team text DEFAULT 'all'::text, p_sort_by text DEFAULT 'discount_desc'::text, p_limit integer DEFAULT 50)
 RETURNS TABLE(flow_id text, moment_id text, player_name text, team_name text, set_name text, series_name text, tier text, subedition_name text, serial_number integer, circulation_count integer, ask_price numeric, fmv_usd numeric, discount_pct numeric, confidence text, buy_url text, thumbnail_url text, listing_resource_id text, source text, listed_at timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  RETURN QUERY EXECUTE $q$
SELECT q.flow_id::text, q.moment_id::text, q.player_name::text, q.team_name::text, q.set_name::text, q.series_name::text, q.tier::text, q.subedition_name::text, q.serial_number::integer, q.circulation_count::integer, q.ask_price::numeric, q.fmv_usd::numeric, q.discount_pct::numeric, q.confidence::text, q.buy_url::text, q.thumbnail_url::text, q.listing_resource_id::text, q.source::text, q.listed_at::timestamptz FROM (
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
      AND (COALESCE($3, 'all') = 'all' OR UPPER(e.tier::text) = UPPER($3))
      AND (COALESCE($4,   'all') = 'all' OR e.team_name ILIKE $4)
      AND (COALESCE($2, 0) = 0    OR be.low_ask <= $2)
      AND (
        COALESCE($1, 0) = 0
        OR ROUND(((COALESCE(CASE WHEN efc.computed_at > now() - interval '90 days' THEN efc.fmv_usd END, lf.fmv_usd) - be.low_ask)
                  / NULLIF(COALESCE(CASE WHEN efc.computed_at > now() - interval '90 days' THEN efc.fmv_usd END, lf.fmv_usd), 0)) * 100, 1) >= $1
      )
    ORDER BY
      CASE WHEN $5 = 'price_asc'  THEN be.low_ask END ASC  NULLS LAST,
      CASE WHEN $5 = 'price_desc' THEN be.low_ask END DESC NULLS LAST,
      CASE WHEN $5 = 'fmv_desc'   THEN COALESCE(CASE WHEN efc.computed_at > now() - interval '90 days' THEN efc.fmv_usd END, lf.fmv_usd) END DESC NULLS LAST,
      ROUND(((COALESCE(CASE WHEN efc.computed_at > now() - interval '90 days' THEN efc.fmv_usd END, lf.fmv_usd) - be.low_ask)
             / NULLIF(COALESCE(CASE WHEN efc.computed_at > now() - interval '90 days' THEN efc.fmv_usd END, lf.fmv_usd), 0)) * 100, 1) DESC NULLS LAST,
      be.low_ask ASC
    LIMIT COALESCE($6, 50)
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
  WHERE COALESCE($1, 0) = 0 OR l.live_discount >= $1
  ORDER BY
    CASE WHEN $5 = 'price_asc'  THEN l.low_ask END ASC  NULLS LAST,
    CASE WHEN $5 = 'price_desc' THEN l.low_ask END DESC NULLS LAST,
    CASE WHEN $5 = 'fmv_desc'   THEN l.live_fmv END DESC NULLS LAST,
    l.live_discount DESC NULLS LAST,
    l.low_ask ASC) q
$q$ USING p_min_discount, p_max_price, p_rarity, p_team, p_sort_by, p_limit;
END
$function$;

COMMENT ON FUNCTION public.get_topshot_sniper_deals(numeric, numeric, text, text, text, integer) IS
  'Top Shot sniper deals: badge_editions asks ranked against edition_fmv_current (90-day) with a live fmv_snapshots fallback, then the freshest snapshot per ranked edition. Since 2026-09-13 the body runs through RETURN QUERY EXECUTE … USING so it is planned with its parameter VALUES: 116 ms / 10k buffers against 7.4 s / 89k for the parameter-blind SQL-function plan it replaced (nested loops on rows=1 estimates). Readers: /api/market (TS leg), /api/sniper-feed (sparse-pool augmentation).';

REVOKE EXECUTE ON FUNCTION public.get_topshot_sniper_deals(numeric, numeric, text, text, text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_topshot_sniper_deals(numeric, numeric, text, text, text, integer) TO postgres, service_role;

-- The scratch copy the equivalence and timing were measured on
-- (public._sniper_deals_probe) was created and dropped through execute_sql
-- as scratch DDL; it never had a migration and needs none.

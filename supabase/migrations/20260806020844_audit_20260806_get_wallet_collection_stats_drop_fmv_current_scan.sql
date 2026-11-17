-- audit_20260806_get_wallet_collection_stats_drop_fmv_current_scan
--
-- /dashboard rendered Total Moments 0 / Portfolio FMV $0 / Collections 0 for the
-- founder wallet while wallet_moments_cache held 19,213 moments (~$72k).
--
-- Root cause: this fn LEFT JOINed public.fmv_current, an UNFILTERED
-- `DISTINCT ON (edition_id) ... ORDER BY edition_id, computed_at DESC` over ALL of
-- fmv_snapshots. Postgres materialised the entire view — Merge Append + Unique over
-- 992,305 rows of fmv_snapshots_2026, 22.3s, 920,205 buffers — purely to read one
-- `confidence` flag for ~19k wallet moments. fmv_snapshots_2026 grows ~50k rows/month
-- (Mar 847 -> May 300k -> Aug 992k), so this was a SLOW-MOTION regression: no code
-- changed, the calendar crossed the fn's statement_timeout=8s -> 57014 ->
-- /api/profile/collection-stats 503 -> the dashboard client swallowed it into a
-- confident FALSE $0.
--
-- NOTE this supersedes audit_20260720_get_wallet_collection_stats_fmv_current, which
-- moved the OTHER way (per-wmc-row LATERAL -> fmv_current) to fix the same $0 symptom.
-- Both directions were right at the time; the durable shape is the one below —
-- probe per DISTINCT HELD EDITION (a few thousand), not per moment (~19k) and not
-- per snapshot in the partition (~992k).
--
-- Fix: resolve holdings first, then probe the latest snapshot per distinct held
-- edition via LATERAL ... ORDER BY computed_at DESC LIMIT 1 (uses
-- fmv_snapshots_<year>_edition_id_computed_at_idx). Also derives top_tier from the
-- already-materialised holdings CTE instead of re-scanning wallet_moments_cache once
-- per collection. statement_timeout 8s -> 20s.
--
-- Equivalence proven BEFORE applying: both directions of EXCEPT = 0 rows across
-- 5 wallets / 19 collection rows.
--
-- Buffers 923,889 -> 69,423 (13x). The remaining floor was a stale visibility map on
-- wallet_moments_cache (an index-only scan on idx_wmc_cohort_cover doing 44,579 heap
-- fetches for 19,213 live rows; manual vacuum 3 weeks stale while the table churns
-- ~3,400 dead tuples/min). A companion `VACUUM (ANALYZE) wallet_moments_cache`
-- (dead tuples 126,895 -> 15,159) took it the rest of the way:
--   before 22-27s  |  rewrite only ~17s  |  rewrite + VACUUM 0.24s warm / 4.1s cold
-- VERIFIED BY RENDERED DOM: /dashboard reads 19,213 / $72,343 / 5.
--
-- Applied to prod via MCP (Cowork) as
-- audit_20260806_get_wallet_collection_stats_drop_fmv_current_scan; this file is
-- repo/rebuild parity, body copied verbatim from live pg_get_functiondef.
--
-- REVERT: CREATE OR REPLACE with the prior body from
-- supabase/migrations/20260720214500_audit_20260720_get_wallet_collection_stats_fmv_current.sql
-- (LEFT JOIN fmv_current + the correlated top_tier subquery) and
-- SET statement_timeout TO '8s'. Nothing to unwind from the VACUUM.

CREATE OR REPLACE FUNCTION public.get_wallet_collection_stats(p_wallet_addr text)
 RETURNS TABLE(collection_id uuid, collection_slug text, collection_label text, moment_count bigint, fmv_total numeric, fmv_stale_total numeric, stale_count bigint, fmv_max numeric, priced_count bigint, locked_count bigint, top_tier text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '20s'
AS $function$
  WITH holdings AS MATERIALIZED (
    SELECT
      wmc.collection_id AS coll_id,
      wmc.fmv_usd,
      wmc.is_locked,
      wmc.tier,
      e.id AS edition_id
    FROM wallet_moments_cache wmc
    LEFT JOIN editions e
      ON e.external_id = wmc.edition_key
     AND e.collection_id = wmc.collection_id
    WHERE wmc.wallet_address = p_wallet_addr
  ),
  held_editions AS MATERIALIZED (
    SELECT DISTINCT edition_id FROM holdings WHERE edition_id IS NOT NULL
  ),
  conf AS MATERIALIZED (
    SELECT he.edition_id, f.confidence
    FROM held_editions he
    CROSS JOIN LATERAL (
      SELECT s.confidence
      FROM fmv_snapshots s
      WHERE s.edition_id = he.edition_id
      ORDER BY s.computed_at DESC
      LIMIT 1
    ) f
  ),
  top_tiers AS (
    SELECT DISTINCT ON (h.coll_id) h.coll_id, h.tier
    FROM holdings h
    WHERE h.tier IS NOT NULL
    ORDER BY
      h.coll_id,
      CASE h.tier
        WHEN 'ULTIMATE'  THEN 5
        WHEN 'LEGENDARY' THEN 4
        WHEN 'RARE'      THEN 3
        WHEN 'FANDOM'    THEN 2
        WHEN 'COMMON'    THEN 1
        ELSE 0
      END DESC,
      h.fmv_usd DESC NULLS LAST
  )
  SELECT
    c.id AS collection_id,
    c.slug::TEXT AS collection_slug,
    c.name::TEXT AS collection_label,
    COUNT(h.*) AS moment_count,
    COALESCE(ROUND(SUM(h.fmv_usd) FILTER (WHERE cf.confidence IS DISTINCT FROM 'STALE')::numeric, 2), 0) AS fmv_total,
    COALESCE(ROUND(SUM(h.fmv_usd) FILTER (WHERE cf.confidence = 'STALE')::numeric, 2), 0) AS fmv_stale_total,
    COUNT(h.*) FILTER (WHERE cf.confidence = 'STALE') AS stale_count,
    COALESCE(ROUND(MAX(h.fmv_usd)::numeric, 2), 0) AS fmv_max,
    COUNT(h.*) FILTER (WHERE h.fmv_usd IS NOT NULL) AS priced_count,
    COUNT(h.*) FILTER (WHERE h.is_locked = TRUE) AS locked_count,
    (SELECT tt.tier FROM top_tiers tt WHERE tt.coll_id = c.id) AS top_tier
  FROM collections c
  LEFT JOIN holdings h
    ON h.coll_id = c.id
  LEFT JOIN conf cf
    ON cf.edition_id = h.edition_id
  WHERE c.is_active = TRUE
  GROUP BY c.id, c.slug, c.name
  ORDER BY fmv_total DESC NULLS LAST, moment_count DESC NULLS LAST;
$function$;

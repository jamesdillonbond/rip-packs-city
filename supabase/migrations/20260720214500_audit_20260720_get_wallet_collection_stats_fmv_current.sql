-- audit_20260720_get_wallet_collection_stats_fmv_current
--
-- Dashboard portfolio tiles read $0 for whale wallets: get_wallet_collection_stats
-- ran a per-moment LATERAL into the year-partitioned fmv_snapshots (once per wmc
-- row — ~19k times for the founder wallet, ~1.8s idle, and — being correlated —
-- serialized badly under daytime IOPS contention, crossing the 8s function /
-- route 30s ceiling -> route 503 -> the client swallowed it -> statsByWallet={}
-- -> all tiles 0). Replace the LATERAL with a single LEFT JOIN to the fmv_current
-- view (DISTINCT ON (edition_id) latest-per-edition, a regular/live view).
--
-- Behavior-preserving: verified byte-identical on the founder wallet — 0 rows
-- differed across fmv_total / fmv_stale_total / stale_count between the LATERAL
-- and the fmv_current join. Everything else (top_tier subquery, grants,
-- statement_timeout 8s) is unchanged.
--
-- Applied to prod via MCP as audit_20260720_get_wallet_collection_stats_fmv_current;
-- this file is repo/rebuild parity.
--
-- REVERT: restore the prior body — swap the `LEFT JOIN fmv_current fc ON
-- fc.edition_id = e.id` back to the per-row
-- `LEFT JOIN LATERAL (SELECT fs.confidence FROM fmv_snapshots fs
--   WHERE fs.edition_id = e.id ORDER BY fs.computed_at DESC LIMIT 1) lf ON true`
-- and rename fc.confidence -> lf.confidence.

CREATE OR REPLACE FUNCTION public.get_wallet_collection_stats(p_wallet_addr text)
 RETURNS TABLE(collection_id uuid, collection_slug text, collection_label text, moment_count bigint, fmv_total numeric, fmv_stale_total numeric, stale_count bigint, fmv_max numeric, priced_count bigint, locked_count bigint, top_tier text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '8s'
AS $function$
  SELECT
    c.id AS collection_id,
    c.slug::TEXT AS collection_slug,
    c.name::TEXT AS collection_label,
    COUNT(wmc.*) AS moment_count,
    COALESCE(ROUND(SUM(wmc.fmv_usd) FILTER (WHERE fc.confidence IS DISTINCT FROM 'STALE')::numeric, 2), 0) AS fmv_total,
    COALESCE(ROUND(SUM(wmc.fmv_usd) FILTER (WHERE fc.confidence = 'STALE')::numeric, 2), 0) AS fmv_stale_total,
    COUNT(wmc.*) FILTER (WHERE fc.confidence = 'STALE') AS stale_count,
    COALESCE(ROUND(MAX(wmc.fmv_usd)::numeric, 2), 0) AS fmv_max,
    COUNT(wmc.*) FILTER (WHERE wmc.fmv_usd IS NOT NULL) AS priced_count,
    COUNT(wmc.*) FILTER (WHERE wmc.is_locked = TRUE) AS locked_count,
    (
      SELECT inner_wmc.tier
      FROM wallet_moments_cache inner_wmc
      WHERE inner_wmc.wallet_address = p_wallet_addr
        AND inner_wmc.collection_id = c.id
        AND inner_wmc.tier IS NOT NULL
      ORDER BY
        CASE inner_wmc.tier
          WHEN 'ULTIMATE'  THEN 5
          WHEN 'LEGENDARY' THEN 4
          WHEN 'RARE'      THEN 3
          WHEN 'FANDOM'    THEN 2
          WHEN 'COMMON'    THEN 1
          ELSE 0
        END DESC,
        inner_wmc.fmv_usd DESC NULLS LAST
      LIMIT 1
    ) AS top_tier
  FROM collections c
  LEFT JOIN wallet_moments_cache wmc
    ON wmc.collection_id = c.id
   AND wmc.wallet_address = p_wallet_addr
  LEFT JOIN editions e
    ON e.external_id = wmc.edition_key
   AND e.collection_id = wmc.collection_id
  LEFT JOIN fmv_current fc
    ON fc.edition_id = e.id
  WHERE c.is_active = TRUE
  GROUP BY c.id, c.slug, c.name
  ORDER BY fmv_total DESC NULLS LAST, moment_count DESC NULLS LAST;
$function$;

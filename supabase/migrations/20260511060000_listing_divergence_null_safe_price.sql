-- Fix compute_listing_divergence's price_mismatch artifact: the prior
-- COALESCE(..., -1) sentinel pattern flagged every matched row whose
-- direct-side price_usd was NULL (which happens whenever the direct vault
-- currency isn't USD-equivalent — DUC, FLOW, FUSD all qualify) as a
-- mismatch, even though Flowty's pre-converted USD prices were a real
-- number on the other side. Replace with proper null-handling so we only
-- count mismatches when both sides have actual prices we can compare.
--
-- Approach (a) from docs/audits/listing-divergence-2026-05.md: skip the
-- mismatch check when either side is NULL. The metric is "are these two
-- sources looking at the same active listings", not "do they happen to
-- agree on a USD conversion." Currency-conversion convergence is out of
-- scope.

CREATE OR REPLACE FUNCTION public.compute_listing_divergence(
  p_collection_id uuid,
  p_write_snapshot boolean DEFAULT false,
  p_notes text DEFAULT NULL::text
)
 RETURNS TABLE(total_flowty integer, total_direct integer, matched integer, flowty_only integer, direct_only integer, price_mismatches integer, divergence_pct numeric)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_flowty INT; v_direct INT; v_matched INT;
  v_f_only INT; v_d_only INT; v_pm INT;
  v_div_pct NUMERIC;
  v_union INT;
BEGIN
  WITH
    f AS (
      SELECT listing_resource_id, price_usd
      FROM cached_listings_v2
      WHERE source = 'flowty' AND collection_id = p_collection_id AND completed_at IS NULL
    ),
    d AS (
      SELECT listing_resource_id, price_usd
      FROM cached_listings_v2
      WHERE source = 'direct' AND collection_id = p_collection_id AND completed_at IS NULL
    )
  SELECT
    (SELECT COUNT(*) FROM f),
    (SELECT COUNT(*) FROM d),
    (SELECT COUNT(*) FROM f INNER JOIN d USING (listing_resource_id)),
    (SELECT COUNT(*) FROM f LEFT JOIN d USING (listing_resource_id) WHERE d.listing_resource_id IS NULL),
    (SELECT COUNT(*) FROM d LEFT JOIN f USING (listing_resource_id) WHERE f.listing_resource_id IS NULL),
    -- price_mismatches: null-safe. Only counted when both sides have a
    -- numeric price_usd to compare. NULL on either side is treated as
    -- "no opinion", NOT as a sentinel-flagged mismatch.
    (SELECT COUNT(*) FROM f INNER JOIN d USING (listing_resource_id)
       WHERE f.price_usd IS NOT NULL
         AND d.price_usd IS NOT NULL
         AND f.price_usd <> d.price_usd)
    INTO v_flowty, v_direct, v_matched, v_f_only, v_d_only, v_pm;

  v_union := v_flowty + v_direct - v_matched;
  v_div_pct := CASE
    WHEN v_union > 0
    THEN (v_f_only + v_d_only)::numeric / v_union * 100
    ELSE 0
  END;

  IF p_write_snapshot THEN
    INSERT INTO listing_divergence_snapshots(
      collection_id, total_flowty, total_direct, matched,
      flowty_only, direct_only, price_mismatches, notes
    ) VALUES (
      p_collection_id, v_flowty, v_direct, v_matched,
      v_f_only, v_d_only, v_pm, p_notes
    );
  END IF;

  RETURN QUERY SELECT v_flowty, v_direct, v_matched, v_f_only, v_d_only, v_pm, v_div_pct;
END;
$function$;

-- DB invariant: public.compute_listing_divergence — cross-source listing
-- reconciliation between the Flowty cache and the direct on-chain cache. Counts
-- flowty-only / direct-only / matched open listings and a NULL-SAFE price
-- mismatch (a NULL price on either side is "no opinion", never a mismatch), and
-- derives a divergence %. DDL below is a VERBATIM copy of the committed migration
-- (supabase/migrations/20260511060000_listing_divergence_null_safe_price.sql);
-- __tests__/db-invariants-drift-guard.test.ts fails CI if this copy drifts.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE public.cached_listings_v2 (
  listing_resource_id text, price_usd numeric, source text,
  collection_id uuid, completed_at timestamptz);
CREATE TABLE public.listing_divergence_snapshots (
  id bigserial PRIMARY KEY, collection_id uuid, total_flowty int, total_direct int,
  matched int, flowty_only int, direct_only int, price_mismatches int, notes text,
  created_at timestamptz DEFAULT now());

-- >>> BEGIN verbatim compute_listing_divergence (byte-identical to the migration) >>>
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
-- <<< END verbatim compute_listing_divergence <<<

DO $seed$
DECLARE
  c uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  other uuid := 'dee28451-5d62-409e-a1ad-a83f763ac070';
BEGIN
  -- R1 matched, same price → no mismatch
  INSERT INTO public.cached_listings_v2 VALUES ('R1',10,'flowty',c,NULL),('R1',10,'direct',c,NULL);
  -- R2 matched, different price → mismatch
  INSERT INTO public.cached_listings_v2 VALUES ('R2',20,'flowty',c,NULL),('R2',25,'direct',c,NULL);
  -- R3 matched, one NULL price → NOT a mismatch (null-safe)
  INSERT INTO public.cached_listings_v2 VALUES ('R3',NULL,'flowty',c,NULL),('R3',30,'direct',c,NULL);
  -- R4 flowty only; R5 direct only
  INSERT INTO public.cached_listings_v2 VALUES ('R4',40,'flowty',c,NULL);
  INSERT INTO public.cached_listings_v2 VALUES ('R5',50,'direct',c,NULL);
  -- R6 completed (excluded); R7 other collection (excluded)
  INSERT INTO public.cached_listings_v2 VALUES ('R6',60,'flowty',c,now());
  INSERT INTO public.cached_listings_v2 VALUES ('R7',70,'flowty',other,NULL);
END $seed$;

-- flowty = R1,R2,R3,R4 = 4; direct = R1,R2,R3,R5 = 4; matched = R1,R2,R3 = 3;
-- flowty_only = R4 = 1; direct_only = R5 = 1; mismatches = R2 only = 1;
-- union = 4+4-3 = 5; divergence = (1+1)/5*100 = 40.
SELECT _assert_eq((SELECT total_flowty::text FROM compute_listing_divergence('95f28a17-224a-4025-96ad-adf8a4c63bfd')), '4', 'open flowty listings (completed + other-collection excluded)');
SELECT _assert_eq((SELECT total_direct::text FROM compute_listing_divergence('95f28a17-224a-4025-96ad-adf8a4c63bfd')), '4', 'open direct listings');
SELECT _assert_eq((SELECT matched::text FROM compute_listing_divergence('95f28a17-224a-4025-96ad-adf8a4c63bfd')), '3', 'matched on listing_resource_id');
SELECT _assert_eq((SELECT flowty_only::text FROM compute_listing_divergence('95f28a17-224a-4025-96ad-adf8a4c63bfd')), '1', 'flowty-only = R4');
SELECT _assert_eq((SELECT direct_only::text FROM compute_listing_divergence('95f28a17-224a-4025-96ad-adf8a4c63bfd')), '1', 'direct-only = R5');
SELECT _assert_eq((SELECT price_mismatches::text FROM compute_listing_divergence('95f28a17-224a-4025-96ad-adf8a4c63bfd')), '1', 'NULL-safe: only R2 (differing non-null prices) is a mismatch');
SELECT _assert_eq((SELECT divergence_pct::text FROM compute_listing_divergence('95f28a17-224a-4025-96ad-adf8a4c63bfd')), '40.00000000000000000000', 'divergence = (flowty_only+direct_only)/union*100');

-- write_snapshot defaults OFF (read-only), and writes exactly one row when ON.
SELECT compute_listing_divergence('95f28a17-224a-4025-96ad-adf8a4c63bfd');  -- default false
SELECT _assert_eq((SELECT count(*)::text FROM listing_divergence_snapshots), '0', 'default call writes no snapshot');
SELECT compute_listing_divergence('95f28a17-224a-4025-96ad-adf8a4c63bfd', true, 'test');
SELECT _assert_eq((SELECT count(*)::text FROM listing_divergence_snapshots), '1', 'p_write_snapshot=true writes one snapshot row');
SELECT _assert_eq((SELECT price_mismatches::text FROM listing_divergence_snapshots), '1', 'snapshot carries the mismatch count');

SELECT '✓ compute_listing_divergence invariants pass' AS result;
ROLLBACK;

-- DB invariant: public.serial_fmv_multiplier_batch -- one fitted serial premium per (edition,
-- serial) for the public /api/fmv (known-issues #18). Claims:
--   1. multiplier = serial_fmv_estimate's estimate_usd / fmv; basis = its serial_bucket;
--   2. the model's NULL (no premium) is 1.0 / 'no_premium';
--   3. an edition whose circulation is NULL, 0 or below the serial is NULL / 'circulation_unknown'
--      -- never a guessed 1.0 (a NULL circulation used to fall through to 1.0 via three-valued logic);
--   4. an item with a NULL serial is skipped; an unknown edition yields no row.
--
-- The function DDL below is VERBATIM from the committed migration
-- (supabase/migrations/20261010185326_audit_20261010_public_fmv_api_prices_serials_with_the_fitted_model.sql).
-- __tests__/db-invariants-drift-guard.test.ts fails CI on drift.

BEGIN;

CREATE TABLE public.editions (id uuid PRIMARY KEY, collection_id uuid, circulation_count int, tier text, jersey_number int);
-- stand-in estimator: #1 -> 9x, serial == circulation -> 3x ('perfect'), anything else -> NULL
CREATE FUNCTION public.serial_fmv_estimate(p_collection_id uuid, p_serial integer, p_circulation integer, p_tier text,
  p_edition_fmv numeric, p_confidence text, p_jersey_number integer, p_edition_id uuid) RETURNS jsonb LANGUAGE sql AS $$
  SELECT CASE WHEN p_serial = 1 THEN jsonb_build_object('estimate_usd', p_edition_fmv * 9, 'serial_bucket', 'first', 'basis', 'power_model')
              WHEN p_serial = p_circulation THEN jsonb_build_object('estimate_usd', p_edition_fmv * 3, 'serial_bucket', 'perfect', 'basis', 'power_model')
         END $$;

CREATE OR REPLACE FUNCTION public.serial_fmv_multiplier_batch(p_items jsonb)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  -- One fitted serial premium per (edition, serial) for the public /api/fmv: the same estimator the
  -- portfolio prices with (serial_fmv_estimate: collection x tier x circulation band; buckets #1,
  -- jersey-match and perfect (last) mint). A NULL estimate is the model saying "no
  -- premium" -> 1.0. An edition whose catalog circulation is missing or below the serial cannot be
  -- placed in a band -> multiplier NULL, basis 'circulation_unknown' (never a guessed 1.0).
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'edition_id', i.edition_id,
           'serial', i.serial,
           'multiplier', CASE
               WHEN NOT x.circ_ok THEN NULL
               WHEN x.est IS NULL OR (x.est->>'estimate_usd') IS NULL THEN 1.0
               ELSE round((x.est->>'estimate_usd')::numeric / i.fmv, 4) END,
           'basis', CASE
               WHEN NOT x.circ_ok THEN 'circulation_unknown'
               WHEN x.est IS NULL THEN 'no_premium'
               ELSE coalesce(x.est->>'serial_bucket', x.est->>'basis') END)), '[]'::jsonb)
    FROM jsonb_to_recordset(p_items) AS i(edition_id uuid, serial integer, fmv numeric, confidence text)
    JOIN public.editions e ON e.id = i.edition_id
    CROSS JOIN LATERAL (
      SELECT coalesce(e.circulation_count > 0 AND e.circulation_count >= i.serial, false) AS circ_ok,
             CASE WHEN e.circulation_count > 0 AND e.circulation_count >= i.serial AND i.fmv > 0 AND i.serial > 0
                  THEN public.serial_fmv_estimate(e.collection_id, i.serial, e.circulation_count, e.tier::text,
                                                  i.fmv, upper(i.confidence), e.jersey_number, e.id)
             END AS est) x
   WHERE i.serial IS NOT NULL;
$function$;

INSERT INTO public.editions VALUES
  ('00000000-0000-0000-0000-0000000000a1', '95f28a17-224a-4025-96ad-adf8a4c63bfd', 500, 'COMMON', NULL),
  ('00000000-0000-0000-0000-0000000000a2', '95f28a17-224a-4025-96ad-adf8a4c63bfd', NULL, 'COMMON', NULL),
  ('00000000-0000-0000-0000-0000000000a3', '95f28a17-224a-4025-96ad-adf8a4c63bfd', 40, 'COMMON', NULL);

SELECT _assert_eq((
  SELECT string_agg((r->>'serial') || '=' || coalesce(r->>'multiplier', 'NULL') || '/' || (r->>'basis'), ',' ORDER BY (r->>'serial')::int, r->>'edition_id')
    FROM jsonb_array_elements(public.serial_fmv_multiplier_batch(jsonb_build_array(
      jsonb_build_object('edition_id', '00000000-0000-0000-0000-0000000000a1', 'serial', 1,   'fmv', 10, 'confidence', 'high'),
      jsonb_build_object('edition_id', '00000000-0000-0000-0000-0000000000a1', 'serial', 7,   'fmv', 10, 'confidence', 'HIGH'),
      jsonb_build_object('edition_id', '00000000-0000-0000-0000-0000000000a1', 'serial', 500, 'fmv', 10, 'confidence', 'HIGH'),
      jsonb_build_object('edition_id', '00000000-0000-0000-0000-0000000000a2', 'serial', 2,   'fmv', 10, 'confidence', 'HIGH'),
      jsonb_build_object('edition_id', '00000000-0000-0000-0000-0000000000a3', 'serial', 41,  'fmv', 10, 'confidence', 'HIGH'),
      jsonb_build_object('edition_id', '00000000-0000-0000-0000-0000000000a1', 'serial', NULL, 'fmv', 10, 'confidence', 'HIGH'),
      jsonb_build_object('edition_id', '00000000-0000-0000-0000-0000000000ff', 'serial', 3,   'fmv', 10, 'confidence', 'HIGH')))) r),
  '1=9.0000/first,2=NULL/circulation_unknown,7=1.0/no_premium,41=NULL/circulation_unknown,500=3.0000/perfect',
  'c1-c4 fitted ratio, no-premium 1.0, unplaceable circulation NULL (incl. a NULL circulation), NULL serial and unknown edition skipped');

ROLLBACK;

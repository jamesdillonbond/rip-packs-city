-- DB invariant: public.check_suppression_count_predicate_drift -- the count/freshness half of
-- known-issues #102 (c): each suppression that states a must-stay-true predicate has it as CODE.
-- Claims:
--   1. all predicates holding -> [] (ban at zero, satisfiable at a population of zero);
--   2. each failing predicate is reported with what it observed;
--   3. an EXPIRED suppression is not checked (its predicate no longer justifies anything);
--   4. an unmeasurable predicate (no rows to measure) does not hold.
--
-- The function DDL below is VERBATIM from the committed migration
-- (supabase/migrations/20261010185858_audit_20261010_suppression_count_predicates_are_code.sql).
-- __tests__/db-invariants-drift-guard.test.ts fails CI on drift.

BEGIN;

CREATE TABLE public.pipeline_alert_suppression (pipeline text, expires_at timestamptz, reason text);
CREATE TABLE public.editions (id uuid DEFAULT gen_random_uuid(), collection_id uuid, updated_at timestamptz);
CREATE TABLE public.challenges (updated_at timestamptz);
CREATE TABLE public.mv_topshot_misattrib_candidates (nft_id text);
CREATE TABLE public.topshot_misattrib_onchain_map (nft_id text);
CREATE TABLE public.event_cursor (id text, last_processed_block bigint, updated_at timestamptz);

CREATE OR REPLACE FUNCTION public.check_suppression_count_predicate_drift()
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  -- The COUNT / FRESHNESS half of known-issues #102 (c): a suppression whose `reason` states a
  -- PREDICATE that must stay true has that predicate here, as CODE (never by executing the reason
  -- text). One arm per suppression, each evaluated only while its suppression is live. Returns a
  -- jsonb ARRAY of the predicates that FAIL -- ban at zero, like
  -- check_suppression_parked_claim_drift(); clean is jsonb_array_length() = 0. A failing row means
  -- the suppression's own justification is false: retire or re-justify it, do not renew it.
  WITH live AS (
    SELECT s.pipeline FROM public.pipeline_alert_suppression s
     WHERE s.expires_at IS NULL OR s.expires_at > now()
  ), checks AS (
    SELECT 'topshot-catalog-backfill'::text AS pipeline,
           'count(Top Shot editions updated in 24 h) >= 500' AS predicate,
           (SELECT count(*) FROM public.editions
             WHERE collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
               AND updated_at > now() - interval '24 hours')::numeric AS observed,
           500::numeric AS threshold, '>='::text AS op
    UNION ALL
    SELECT 'ingest-topshot-challenges',
           'hours since max(challenges.updated_at) <= 168',
           (SELECT round((extract(epoch FROM now() - max(updated_at)) / 3600)::numeric, 1) FROM public.challenges),
           168, '<='
    UNION ALL
    SELECT 'topshot-misattrib-drain',
           'open misattribution candidates (no on-chain map row) <= 500',
           (SELECT count(*) FROM public.mv_topshot_misattrib_candidates c
             WHERE NOT EXISTS (SELECT 1 FROM public.topshot_misattrib_onchain_map m WHERE m.nft_id = c.nft_id))::numeric,
           500, '<='
    UNION ALL
    SELECT 'golazos_offers',
           'event_cursor golazos_offers still frozen at block 159452130 (0 = yes)',
           (SELECT CASE WHEN c.last_processed_block = 159452130 THEN 0 ELSE 1 END FROM public.event_cursor c WHERE c.id = 'golazos_offers')::numeric,
           0, '<='
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'pipeline', k.pipeline, 'predicate', k.predicate, 'observed', k.observed, 'threshold', k.threshold)
           ORDER BY k.pipeline), '[]'::jsonb)
    FROM checks k
    JOIN live l ON l.pipeline = k.pipeline
   WHERE k.observed IS NULL                                   -- an unmeasurable predicate does not hold
      OR (k.op = '>=' AND k.observed < k.threshold)
      OR (k.op = '<=' AND k.observed > k.threshold);
$function$;

INSERT INTO public.pipeline_alert_suppression VALUES
  ('topshot-catalog-backfill', now() + interval '30 days', 'x'), ('ingest-topshot-challenges', NULL, 'x'),
  ('topshot-misattrib-drain', now() + interval '30 days', 'x'), ('golazos_offers', now() + interval '30 days', 'x');
INSERT INTO public.editions (collection_id, updated_at)
  SELECT '95f28a17-224a-4025-96ad-adf8a4c63bfd', now() - interval '1 hour' FROM generate_series(1, 600);
INSERT INTO public.challenges VALUES (now() - interval '2 days');
INSERT INTO public.mv_topshot_misattrib_candidates SELECT g::text FROM generate_series(1, 700) g;
INSERT INTO public.topshot_misattrib_onchain_map SELECT g::text FROM generate_series(1, 300) g;   -- 400 open
INSERT INTO public.event_cursor VALUES ('golazos_offers', 159452130, '2026-07-28');

SELECT _assert_eq(public.check_suppression_count_predicate_drift()::text, '[]', 'c1 all hold -> []');

-- c2: break each one
UPDATE public.editions SET updated_at = now() - interval '3 days' WHERE ctid IN (SELECT ctid FROM public.editions LIMIT 200);  -- 400 fresh
INSERT INTO public.mv_topshot_misattrib_candidates SELECT g::text FROM generate_series(701, 900) g;                          -- 600 open
UPDATE public.event_cursor SET last_processed_block = 160000000;
UPDATE public.challenges SET updated_at = now() - interval '10 days';
SELECT _assert_eq((SELECT string_agg(e->>'pipeline' || '=' || (e->>'observed'), ',' ORDER BY e->>'pipeline')
                     FROM jsonb_array_elements(public.check_suppression_count_predicate_drift()) e),
  'golazos_offers=1,ingest-topshot-challenges=240.0,topshot-catalog-backfill=400,topshot-misattrib-drain=600',
  'c2 every failing predicate reported with its observation');

-- c3: an expired suppression is not checked
UPDATE public.pipeline_alert_suppression SET expires_at = now() - interval '1 day' WHERE pipeline = 'golazos_offers';
SELECT _assert(NOT EXISTS (SELECT 1 FROM jsonb_array_elements(public.check_suppression_count_predicate_drift()) e
                            WHERE e->>'pipeline' = 'golazos_offers'), 'c3 expired suppression not checked');

-- c4: nothing to measure does not hold
TRUNCATE public.challenges;
SELECT _assert_eq((SELECT count(*)::text FROM jsonb_array_elements(public.check_suppression_count_predicate_drift()) e
                    WHERE e->>'pipeline' = 'ingest-topshot-challenges' AND e->'observed' = 'null'::jsonb), '1',
  'c4 unmeasurable -> reported, with observed null (a missing row would count 0)');

ROLLBACK;

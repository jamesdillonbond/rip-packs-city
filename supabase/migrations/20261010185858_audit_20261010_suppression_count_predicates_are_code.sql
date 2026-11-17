-- audit_20261010_suppression_count_predicates_are_code
-- anon-exec: revoked (check_suppression_count_predicate_drift) — new SECDEF reader; REVOKE FROM PUBLIC, anon, authenticated below, GRANT to postgres + service_role.
-- anon-exec: unchanged (rpc_ops_snapshot) — re-created from pg_get_functiondef() by an anchored splice; signature, SECURITY DEFINER, search_path and ACL preserved.
--
-- 2026-10-10 (known-issues #102 (c)). Suppressions in pipeline_alert_suppression justify themselves
-- with a PREDICATE in their `reason` text that nothing evaluates ("a predicate nothing runs is a
-- comment"). The floor-claim class was made code on 09-14 (check_suppression_parked_claim_drift,
-- read by rpc_ops_snapshot). This is the COUNT / FRESHNESS class, the same way: one arm per
-- suppression whose reason states an exact predicate, as CODE -- never by executing the reason text
-- (dynamic SQL over a table column in a SECURITY DEFINER function is the injection surface #102
-- forbids). Arms: topshot-catalog-backfill (>= 500 Top Shot editions updated in 24 h),
-- ingest-topshot-challenges (challenges fresh within 7 days), topshot-misattrib-drain (open backlog
-- <= 500), golazos_offers (cursor still frozen at block 159452130). Only live suppressions are
-- checked; an unmeasurable predicate does not hold. Ban at zero, a jsonb ARRAY like its sibling,
-- surfaced as rpc_ops_snapshot -> 'suppression_count_predicate_drift'.
-- Today it reads ONE failing: topshot-misattrib-drain (1,850 open vs <= 500) -- the #101 backlog the
-- new Atlas resolver (20261010182920) is now draining; the predicate clears as it falls.
--
-- REVERT: re-run the splice below with old/new swapped, then
--   DROP FUNCTION public.check_suppression_count_predicate_drift();

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

REVOKE EXECUTE ON FUNCTION public.check_suppression_count_predicate_drift() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.check_suppression_count_predicate_drift() TO postgres, service_role;

DO $mig$
DECLARE
  v_def text;
  v_md5 text;
  a_old constant text := 'public.check_suppression_parked_claim_drift(),';
  a_new constant text := 'public.check_suppression_parked_claim_drift(),
    -- Added 2026-10-10 (#102 (c)): the count/freshness half, same shape, clean at length 0.
    ''suppression_count_predicate_drift'', public.check_suppression_count_predicate_drift(),';
BEGIN
  SELECT md5(trim(regexp_replace(prosrc, '\s+', ' ', 'g'))) INTO v_md5 FROM pg_proc WHERE proname = 'rpc_ops_snapshot';
  IF v_md5 <> '6989fc87c6b0513f49c4d2e58a09685f' THEN RAISE EXCEPTION 'rpc_ops_snapshot base drifted: %', v_md5; END IF;
  SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p WHERE p.proname = 'rpc_ops_snapshot';
  IF (length(v_def) - length(replace(v_def, a_old, ''))) / length(a_old) <> 1 THEN RAISE EXCEPTION 'anchor not unique'; END IF;
  EXECUTE replace(v_def, a_old, a_new);
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'rpc_ops_snapshot' AND prosrc LIKE '%suppression_count_predicate_drift%') THEN
    RAISE EXCEPTION 'splice did not land';
  END IF;
END
$mig$;

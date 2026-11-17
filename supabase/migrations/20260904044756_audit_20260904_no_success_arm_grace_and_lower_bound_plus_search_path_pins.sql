-- Two follow-ups from the concurrent 2026-09-03 Cowork health pass, both on this session's own work.
--
-- 1/2 Security advisor: `topshot_normalize_circulation` and `trg_topshot_normalize_base_club_circulation`
--     (created tonight in 20260904031944) have a mutable search_path. Neither references another schema
--     unqualified, so pinning is behaviour-neutral. ⛔ The advisor's other two names —
--     `reconcile_all_saved_wallet_stats` and `rpc_trust_health_precompute_refresh_p` — are PROCEDURES
--     that COMMIT inside; a SET clause on a committing procedure breaks it (this repo has shipped that
--     twice), so they are deliberately NOT touched here.
ALTER FUNCTION public.topshot_normalize_circulation(uuid, integer, text, text, integer) SET search_path = public, pg_temp;
ALTER FUNCTION public.trg_topshot_normalize_base_club_circulation() SET search_path = public, pg_temp;

-- 2/2 detect_pipelines_without_success() (20260904012510) fired on `topshot-circulation-onchain` the
--     moment its first (failed) run landed, and by construction it would fire EARLY on any pipeline whose
--     threshold exceeds the ~73 h pipeline_runs retention: "no ok row in retention" was read as "no
--     success", which for a 6-day threshold is a 3-day-old fact at best. Same class as the concurrent
--     `20260904041635` fix to the silent arms (a row alerting ten minutes after it was added). Two
--     changes, both making the arm claim only what it can see:
--       (a) GRACE — a watchlist row younger than its own threshold cannot have failed it yet;
--       (b) a NULL last-ok fires only when a LOWER BOUND on the age exceeds the threshold: the oldest
--           retained run of that pipeline is older than the threshold (so a success, had it happened
--           since, would be in retention). A pipeline with no retained runs at all is the SILENT arm's
--           job, not this one's. The bound is reported as `age_lower_bound_minutes`.
CREATE OR REPLACE FUNCTION public.detect_pipelines_without_success()
RETURNS jsonb
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
SET statement_timeout TO '8s'
AS $function$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'pipeline', w.pipeline,
           'severity', w.severity,
           'max_minutes_without_success', w.max_minutes_without_success,
           'minutes_without_success',
             CASE WHEN ls.last_ok IS NULL THEN NULL
                  ELSE round((extract(epoch from (now() - ls.last_ok)) / 60)::numeric, 0) END,
           'age_lower_bound_minutes',
             CASE WHEN ls.last_ok IS NULL AND lr.first_run IS NOT NULL
                  THEN round((extract(epoch from (now() - lr.first_run)) / 60)::numeric, 0) END,
           'last_ok', ls.last_ok,
           'last_run', lr.last_run,
           'runs_retained', lr.runs_retained,
           'notes', w.notes
         ) ORDER BY (extract(epoch from (now() - ls.last_ok)) / 60) DESC NULLS FIRST), '[]'::jsonb)
  FROM pipeline_cadence_watchlist w
  LEFT JOIN LATERAL (
    SELECT max(pr.started_at) AS last_ok
    FROM pipeline_runs pr
    WHERE pr.pipeline = w.pipeline AND pr.ok
  ) ls ON true
  LEFT JOIN LATERAL (
    SELECT max(pr.started_at) AS last_run, min(pr.started_at) AS first_run, count(*) AS runs_retained
    FROM pipeline_runs pr
    WHERE pr.pipeline = w.pipeline
  ) lr ON true
  WHERE w.is_active
    AND w.max_minutes_without_success IS NOT NULL
    -- (a) grace: a row younger than its own threshold cannot have failed it yet
    AND w.created_at < now() - (w.max_minutes_without_success * interval '1 minute')
    AND (
      -- a known last success older than the threshold
      (ls.last_ok IS NOT NULL
       AND (extract(epoch from (now() - ls.last_ok)) / 60) > w.max_minutes_without_success)
      OR
      -- (b) no retained success, and the pipeline has been running (and failing) for longer than the threshold
      (ls.last_ok IS NULL
       AND lr.first_run IS NOT NULL
       AND (extract(epoch from (now() - lr.first_run)) / 60) > w.max_minutes_without_success)
    );
$function$;

REVOKE EXECUTE ON FUNCTION public.detect_pipelines_without_success() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.detect_pipelines_without_success() TO service_role;
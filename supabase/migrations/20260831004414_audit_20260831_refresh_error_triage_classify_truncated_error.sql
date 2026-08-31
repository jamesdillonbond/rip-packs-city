-- audit_20260831_refresh_error_triage_classify_truncated_error
-- anon-exec: refresh_error_triage — service_role-only admin cron RPC (ACL measured 2026-08-31: postgres=X, service_role=X, NO anon, NO authenticated); CREATE OR REPLACE preserves that hardened ACL, this migration changes only the function body.
--
-- WHY (measured 2026-08-31): refresh-error-triage's fail count rose 0 -> 3 -> 4 -> 7 over 08-27..08-30, every failure
-- "canceling statement due to statement timeout" (PostgREST 8 s). Cause: the dead-host storm (public-api.nbatopshot.com
-- 530 since 08-28) writes the FULL Cloudflare error page into pipeline_runs.error — max/p95 length 192,873 chars — and
-- this function ran classify_pipeline_error's ~30-regex ladder over every full body, detoasting ~92k buffers:
-- 4,643 ms for 1,867 failure rows, trending up with the storm. Every discriminating pattern in the ladder appears in
-- the app-written head of the message (the 530 signature is in the first 50 chars), so classification is run on
-- LEFT(error, 1500): measured 163 ms / 2.4k buffers (LEFT gets slice-detoast), and classify(full) IS NOT DISTINCT FROM
-- classify(LEFT 1500) for ALL 459 distinct (pipeline, error) pairs in the live window — zero divergence. The onchain
-- leg gets the same truncation for symmetry (0 rows in window today). sample_error already stored LEFT(...,500), so
-- stored output is unchanged.
--
-- NOT fixed here (writer-side, route code, needs a code handoff): the dead-host pipelines storing 193 KB HTML bodies
-- in pipeline_runs.error at all — TOAST bloat and a re-read tax on every consumer of that column.
--
-- REVERT: CREATE OR REPLACE with the pre-2026-08-31 body (git history) — the only delta is the two LEFT(...,1500)
--         wrappers in the classified CTEs.

CREATE OR REPLACE FUNCTION public.refresh_error_triage(p_lookback interval DEFAULT '14 days'::interval)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_pipeline_groups INT := 0;
  v_onchain_groups INT := 0;
  v_pipeline_total INT := 0;
  v_onchain_total INT := 0;
BEGIN
  -- Pipeline failures
  WITH classified AS (
    SELECT
      pr.pipeline,
      -- Classification input truncated: the regex ladder's patterns all live in the app-written head of the
      -- message; storm rows append ~193 KB upstream HTML bodies that only cost detoast + regex time
      -- (equivalence measured 2026-08-31: zero divergence across all 459 distinct pairs in the live window).
      LEFT(pr.error, 1500) AS error,
      pr.started_at,
      classify_pipeline_error(pr.pipeline, LEFT(pr.error, 1500)) AS cls
    FROM pipeline_runs pr
    WHERE pr.ok = false
      AND pr.error IS NOT NULL
      AND pr.started_at > NOW() - p_lookback
  ),
  grouped AS (
    SELECT
      cls->>'signature' AS signature,
      MAX(pipeline) AS pipeline,
      MAX(cls->>'category') AS category,
      MAX(cls->>'subcategory') AS subcategory,
      bool_or((cls->>'auto_fixable')::boolean) AS auto_fixable,
      COUNT(*) AS occurrences,
      MIN(started_at) AS first_seen,
      MAX(started_at) AS last_seen,
      (array_agg(LEFT(error,500) ORDER BY started_at DESC))[1] AS sample_error
    FROM classified
    GROUP BY signature
  ),
  upserted AS (
    INSERT INTO public.error_triage (
      source, signature, pipeline, category, subcategory,
      auto_fixable_hint, sample_error,
      occurrence_count, first_seen, last_seen
    )
    SELECT
      'pipeline', signature, pipeline, category, subcategory,
      auto_fixable, sample_error,
      occurrences, first_seen, last_seen
    FROM grouped
    ON CONFLICT (signature) DO UPDATE
      SET occurrence_count = EXCLUDED.occurrence_count,
          last_seen = GREATEST(error_triage.last_seen, EXCLUDED.last_seen),
          first_seen = LEAST(error_triage.first_seen, EXCLUDED.first_seen),
          sample_error = EXCLUDED.sample_error,
          auto_fixable_hint = EXCLUDED.auto_fixable_hint,
          updated_at = NOW()
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_pipeline_groups FROM upserted;

  SELECT COUNT(*) INTO v_pipeline_total
  FROM pipeline_runs WHERE ok=false AND error IS NOT NULL AND started_at > NOW() - p_lookback;

  -- Onchain failures
  WITH classified AS (
    SELECT
      ft.failure_category,
      ft.failure_subcategory,
      LEFT(ft.error_message, 1500) AS error_message,
      ft.proposer,
      ft.sealed_at,
      classify_onchain_error(ft.failure_category, ft.failure_subcategory, LEFT(ft.error_message, 1500)) AS cls
    FROM flowty_transactions ft
    WHERE ft.error_message IS NOT NULL
      AND ft.sealed_at > NOW() - p_lookback
  ),
  grouped AS (
    SELECT
      cls->>'signature' AS signature,
      MAX(cls->>'category') AS category,
      MAX(cls->>'subcategory') AS subcategory,
      bool_or((cls->>'auto_fixable')::boolean) AS auto_fixable,
      COUNT(*) AS occurrences,
      COUNT(DISTINCT proposer) AS unique_addrs,
      MIN(sealed_at) AS first_seen,
      MAX(sealed_at) AS last_seen,
      (array_agg(LEFT(error_message,500) ORDER BY sealed_at DESC))[1] AS sample_error
    FROM classified
    GROUP BY signature
  ),
  upserted AS (
    INSERT INTO public.error_triage (
      source, signature, category, subcategory,
      auto_fixable_hint, sample_error,
      occurrence_count, unique_addresses, first_seen, last_seen
    )
    SELECT
      'onchain', signature, category, subcategory,
      auto_fixable, sample_error,
      occurrences, unique_addrs, first_seen, last_seen
    FROM grouped
    ON CONFLICT (signature) DO UPDATE
      SET occurrence_count = EXCLUDED.occurrence_count,
          unique_addresses = EXCLUDED.unique_addresses,
          last_seen = GREATEST(error_triage.last_seen, EXCLUDED.last_seen),
          first_seen = LEAST(error_triage.first_seen, EXCLUDED.first_seen),
          sample_error = EXCLUDED.sample_error,
          auto_fixable_hint = EXCLUDED.auto_fixable_hint,
          updated_at = NOW()
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_onchain_groups FROM upserted;

  SELECT COUNT(*) INTO v_onchain_total
  FROM flowty_transactions WHERE error_message IS NOT NULL AND sealed_at > NOW() - p_lookback;

  RETURN jsonb_build_object(
    'pipeline_groups_upserted', v_pipeline_groups,
    'onchain_groups_upserted',  v_onchain_groups,
    'pipeline_failures_in_window', v_pipeline_total,
    'onchain_failures_in_window',  v_onchain_total,
    'lookback', p_lookback::text,
    'refreshed_at', NOW()
  );
END;
$function$;

DO $mig$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'refresh_error_triage'
      AND pg_get_functiondef(p.oid) LIKE '%LEFT(pr.error, 1500)%'
  ) THEN
    RAISE EXCEPTION 'POST-STATE FAILED: refresh_error_triage does not carry the truncated-classify body';
  END IF;
END
$mig$;

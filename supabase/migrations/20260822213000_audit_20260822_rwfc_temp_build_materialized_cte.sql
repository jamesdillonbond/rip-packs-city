-- audit_20260822_rwfc_temp_build_materialized_cte
--
-- refresh_wmc_fmv_changed opens by building the _rwfc_recent temp table. That one
-- statement reads ~8,400 buffers to return a few hundred rows, and its cost does not
-- track its output at all -- a zero-row run costs the same as an 897-row run, because
-- the floor is a full walk of the 2026 index. Wrapping the filter in a MATERIALIZED
-- CTE changes only the plan, not the result.
--
-- SCOPE, STATED SO IT IS NOT OVERSOLD: this is ~13% of the function's reads and ~1% of
-- the estate's total shared_blks_read. It is NOT a fix for the 20-hour saturation band.
-- The remaining ~87% is the LOOP, which is unmeasured.
--
-- Origin: docs/overnight/inbox/2026-08-22T0010Z-refresh-wmc-fmv-changed-temp-build-is-120x-its-necessary-cost-and-my-backlog-reading-is-withdrawn.md
-- Re-derived independently 2026-08-22 before this migration was written (563-row sample).
--
-- These are fileless migrations: the pre-change body existed ONLY in pg_proc, so the
-- commented block at the foot is the only copy outside the database. Do not delete it.

-- ── anon-execute decision (guard: __tests__/migration-new-function-states-its-anon-exec-decision.test.ts) ──
-- anon-exec: unchanged — already REVOKED in prod, SECURITY DEFINER, service_role-only caller (refresh_wmc_fmv_changed)
-- Verified live 2026-08-22: has_function_privilege anon=false, authenticated=false, service_role=true.
-- This is a REPLACE of an existing function, and CREATE OR REPLACE does not reset a function ACL, so
-- adding a REVOKE here would be a production ACL change dressed as a no-op. The marker is the correct form.

CREATE OR REPLACE FUNCTION public.refresh_wmc_fmv_changed(p_since_minutes integer DEFAULT 30, p_limit integer DEFAULT 50000)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_total      integer := 0;
  v_batch      integer;
  v_cutoff     timestamptz;
  v_new_cutoff timestamptz;
  v_run_start  timestamptz := clock_timestamp();
  v_timeout_ms bigint;
  v_budget     interval;
  v_deadline   timestamptz;
  -- Sized to fit the SMALLEST caller budget (service_role 30s), never scaled up.
  v_chunk      constant integer := 5;
BEGIN
  SELECT setting::bigint INTO v_timeout_ms FROM pg_settings WHERE name = 'statement_timeout';

  IF v_timeout_ms IS NULL OR v_timeout_ms = 0 THEN
    v_budget := interval '300 seconds';
  ELSE
    v_budget := GREATEST(make_interval(secs => (v_timeout_ms / 1000.0) * 0.6),
                         interval '5 seconds');
  END IF;
  v_deadline := clock_timestamp() + v_budget;

  SELECT last_cutoff INTO v_cutoff FROM public.rwfc_state WHERE id = 1;
  IF v_cutoff IS NULL THEN
    v_cutoff := v_run_start - make_interval(mins => GREATEST(p_since_minutes, 1));
  END IF;

  DROP TABLE IF EXISTS _rwfc_recent;
  -- The filter is wrapped in a MATERIALIZED CTE so the planner cannot use
  -- fmv_snapshots_2026_edition_id_computed_at_idx to supply DISTINCT ON's ordering
  -- for free. That index leads on edition_id while the predicate is on computed_at,
  -- so there is no range to seek and the whole 2026 index is walked -- on a 418x row
  -- overestimate. Materialising first removes the ordering incentive; the planner
  -- then seeks idx_fmv_snapshots_2026_computed_at_desc and pays a tiny quicksort.
  -- Measured 2026-08-22, warm-vs-warm, same 563 output rows: 8,402 buffers / 471 ms
  -- as written vs 29 buffers / 0.98 ms wrapped. Output diffed with EXCEPT in BOTH
  -- directions: 0 rows only-in-incumbent, 0 rows only-in-candidate.
  CREATE TEMP TABLE _rwfc_recent ON COMMIT DROP AS
  WITH recent AS MATERIALIZED (
    SELECT fs.edition_id, fs.computed_at
    FROM public.fmv_snapshots fs
    WHERE fs.computed_at > v_cutoff
      AND fs.fmv_usd IS NOT NULL
  )
  SELECT DISTINCT ON (r.edition_id) r.edition_id, r.computed_at
  FROM recent r
  ORDER BY r.edition_id, r.computed_at DESC;
  CREATE INDEX ON _rwfc_recent (computed_at);
  ANALYZE _rwfc_recent;

  LOOP
    WITH popped AS (
      DELETE FROM _rwfc_recent
       WHERE edition_id IN (
         SELECT edition_id FROM _rwfc_recent ORDER BY computed_at LIMIT v_chunk
       )
      RETURNING edition_id
    ),
    latest_fmv AS MATERIALIZED (
      SELECT e.collection_id, e.external_id,
        (SELECT f.fmv_usd
           FROM public.fmv_snapshots f
          WHERE f.edition_id = e.id
            AND f.fmv_usd IS NOT NULL
          ORDER BY f.computed_at DESC
          LIMIT 1) AS fmv_usd
      FROM popped p
      JOIN public.editions e ON e.id = p.edition_id
    ),
    updated AS (
      UPDATE public.wallet_moments_cache wmc
         SET fmv_usd = lf.fmv_usd
        FROM latest_fmv lf
       WHERE wmc.collection_id = lf.collection_id
         AND wmc.edition_key   = lf.external_id
         AND wmc.edition_key IS NOT NULL
         AND lf.fmv_usd IS NOT NULL
         AND wmc.fmv_usd IS DISTINCT FROM lf.fmv_usd
      RETURNING 1
    )
    SELECT COUNT(*)::int INTO v_batch FROM updated;

    v_total := v_total + COALESCE(v_batch, 0);

    EXIT WHEN NOT EXISTS (SELECT 1 FROM _rwfc_recent);
    EXIT WHEN clock_timestamp() > v_deadline;
    EXIT WHEN v_total >= p_limit;
  END LOOP;

  SELECT MIN(computed_at) - interval '1 microsecond' INTO v_new_cutoff FROM _rwfc_recent;
  v_new_cutoff := COALESCE(v_new_cutoff, v_run_start);

  INSERT INTO public.rwfc_state (id, last_cutoff) VALUES (1, v_new_cutoff)
  ON CONFLICT (id) DO UPDATE SET last_cutoff = EXCLUDED.last_cutoff;

  RETURN v_total;
END;
$function$;

-- ============================================================================
-- REVERT -- uncomment this entire block and apply it to restore the prior body.
-- Captured verbatim via pg_get_functiondef 2026-08-22T14:3xZ, before the change.
-- ============================================================================
-- CREATE OR REPLACE FUNCTION public.refresh_wmc_fmv_changed(p_since_minutes integer DEFAULT 30, p_limit integer DEFAULT 50000)
--  RETURNS integer
--  LANGUAGE plpgsql
--  SECURITY DEFINER
--  SET search_path TO 'public', 'pg_temp'
-- AS $function$
-- DECLARE
--   v_total      integer := 0;
--   v_batch      integer;
--   v_cutoff     timestamptz;
--   v_new_cutoff timestamptz;
--   v_run_start  timestamptz := clock_timestamp();
--   v_timeout_ms bigint;
--   v_budget     interval;
--   v_deadline   timestamptz;
--   -- Sized to fit the SMALLEST caller budget (service_role 30s), never scaled up.
--   v_chunk      constant integer := 5;
-- BEGIN
--   SELECT setting::bigint INTO v_timeout_ms FROM pg_settings WHERE name = 'statement_timeout';
--
--   IF v_timeout_ms IS NULL OR v_timeout_ms = 0 THEN
--     v_budget := interval '300 seconds';
--   ELSE
--     v_budget := GREATEST(make_interval(secs => (v_timeout_ms / 1000.0) * 0.6),
--                          interval '5 seconds');
--   END IF;
--   v_deadline := clock_timestamp() + v_budget;
--
--   SELECT last_cutoff INTO v_cutoff FROM public.rwfc_state WHERE id = 1;
--   IF v_cutoff IS NULL THEN
--     v_cutoff := v_run_start - make_interval(mins => GREATEST(p_since_minutes, 1));
--   END IF;
--
--   DROP TABLE IF EXISTS _rwfc_recent;
--   CREATE TEMP TABLE _rwfc_recent ON COMMIT DROP AS
--   SELECT DISTINCT ON (fs.edition_id) fs.edition_id, fs.computed_at
--   FROM public.fmv_snapshots fs
--   WHERE fs.computed_at > v_cutoff
--     AND fs.fmv_usd IS NOT NULL
--   ORDER BY fs.edition_id, fs.computed_at DESC;
--   CREATE INDEX ON _rwfc_recent (computed_at);
--   ANALYZE _rwfc_recent;
--
--   LOOP
--     WITH popped AS (
--       DELETE FROM _rwfc_recent
--        WHERE edition_id IN (
--          SELECT edition_id FROM _rwfc_recent ORDER BY computed_at LIMIT v_chunk
--        )
--       RETURNING edition_id
--     ),
--     latest_fmv AS MATERIALIZED (
--       SELECT e.collection_id, e.external_id,
--         (SELECT f.fmv_usd
--            FROM public.fmv_snapshots f
--           WHERE f.edition_id = e.id
--             AND f.fmv_usd IS NOT NULL
--           ORDER BY f.computed_at DESC
--           LIMIT 1) AS fmv_usd
--       FROM popped p
--       JOIN public.editions e ON e.id = p.edition_id
--     ),
--     updated AS (
--       UPDATE public.wallet_moments_cache wmc
--          SET fmv_usd = lf.fmv_usd
--         FROM latest_fmv lf
--        WHERE wmc.collection_id = lf.collection_id
--          AND wmc.edition_key   = lf.external_id
--          AND wmc.edition_key IS NOT NULL
--          AND lf.fmv_usd IS NOT NULL
--          AND wmc.fmv_usd IS DISTINCT FROM lf.fmv_usd
--       RETURNING 1
--     )
--     SELECT COUNT(*)::int INTO v_batch FROM updated;
--
--     v_total := v_total + COALESCE(v_batch, 0);
--
--     EXIT WHEN NOT EXISTS (SELECT 1 FROM _rwfc_recent);
--     EXIT WHEN clock_timestamp() > v_deadline;
--     EXIT WHEN v_total >= p_limit;
--   END LOOP;
--
--   SELECT MIN(computed_at) - interval '1 microsecond' INTO v_new_cutoff FROM _rwfc_recent;
--   v_new_cutoff := COALESCE(v_new_cutoff, v_run_start);
--
--   INSERT INTO public.rwfc_state (id, last_cutoff) VALUES (1, v_new_cutoff)
--   ON CONFLICT (id) DO UPDATE SET last_cutoff = EXCLUDED.last_cutoff;
--
--   RETURN v_total;
-- END;
-- $function$

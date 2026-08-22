-- audit_20260821_cross_collection_refresh_lock_window
--
-- ⚠ READY TO APPLY — NOT YET APPLIED. Apply it in the healthy window (20:00–00:00Z),
-- not in the 01:00–19:00Z degraded band, because `apply_migration` costs a ~10–20 s
-- burst of user-facing PGRST002 500s from schema-cache re-introspection.
--
-- WHAT THIS CHANGES, AND WHY IT IS NOT A JUDGEMENT CALL
--
-- Both refresh functions open with `TRUNCATE`, then run the expensive aggregate:
--
--     TRUNCATE public.<mat>;            -- ACCESS EXCLUSIVE taken HERE
--     INSERT INTO public.<mat> SELECT … -- 105–350 s of scanning
--                                       -- lock released only at COMMIT
--
-- A plpgsql function runs inside one transaction and Postgres holds locks until
-- that transaction commits, so the ACCESS EXCLUSIVE taken by TRUNCATE is held for
-- the FULL runtime — 105 s on the last clean run (08-16), 350 s on 08-17. ACCESS
-- EXCLUSIVE blocks readers, and `/insights/cross-collection` is a public,
-- crawlable page that reads these tables.
--
-- That lock is the ONLY reason the 2026-08-21 23:40Z ESCALATION filed moving these
-- jobs into the healthy window (23:10Z / 23:25Z = 4:10 pm PT) as Trevor's decision
-- rather than a chore: the healthy window IS the Pacific afternoon, so the fix
-- traded a permanently-stale board for a daily multi-minute reader stall.
--
-- ⚠ THE TRADE IS AN ARTEFACT OF STATEMENT ORDER, NOT OF THE WORK. Measured
-- 2026-08-21 PT: `cross_collection_cohort_mat` holds **179 rows** and
-- `cross_collection_ts_set_overlap_mat` is likewise tiny. All the cost is the
-- aggregate SCAN over `wallet_moments_cache` (~2,485,628 rows); the WRITE is
-- trivial. Computing into a temp table FIRST and truncating immediately before the
-- insert takes the exclusive lock only for the tiny write, so the reader-visible
-- window drops from 105–350 s to milliseconds. Identical output, identical
-- transactional semantics (still all-or-nothing), no DDL on the live tables.
--
-- ⚠ WHY NOT THE USUAL BUILD-AND-SWAP (`CREATE new; DROP old; RENAME`): measured
-- and rejected. `cross_collection_cohort_mat` has **RLS enabled with 2 policies**,
-- **anon+authenticated SELECT grants**, and a **dependent view**
-- (`cross_collection_cohort_stats`). A rename swap silently drops policies and
-- grants and breaks the view's dependency — the same class of footgun CLAUDE.md
-- records for `CREATE OR REPLACE VIEW` resetting `security_invoker`. The temp-table
-- reorder touches none of that.
--
-- ⚠ WHAT THIS DOES NOT FIX: the queries are not one bit faster, so the 04:10Z runs
-- will keep timing out. This removes the OBJECTION to moving them, it is not a
-- substitute for the move. After applying, the schedule move is a chore:
--     SELECT cron.alter_job(60, schedule := '10 23 * * *');
--     SELECT cron.alter_job(4,  schedule := '25 23 * * *');
-- ⚠ then VERIFY it took — `cron.alter_job(schedule := …)` is recorded as having
-- silently not taken effect once; read `cron.job_run_details.start_time` the next
-- day and, if either still fires at 04:10/04:25Z, `cron.schedule` a fresh job and
-- `cron.unschedule` the old one.
--
-- EQUIVALENCE IS PROVEN, NOT ASSERTED: supabase/tests/refresh_cross_collection_
-- cohort_lock_window.sql runs the OLD body and the NEW body against identical
-- fixtures in one rolled-back transaction and asserts the resulting tables are
-- byte-identical (plus the row counts the functions report).
--
-- ── ANON-EXECUTE DECISION (required by
--    __tests__/migration-new-function-states-its-anon-exec-decision.test.ts) ──
-- Neither function is new and neither ACL changes; `CREATE OR REPLACE FUNCTION`
-- does not reset a function's ACL, so there is deliberately no GRANT/REVOKE here.
-- Measured 2026-08-21 PT: both are `prosecdef = true` and already carry no anon or
-- authenticated EXECUTE.
-- anon-exec: unchanged — already REVOKED in prod, SECURITY DEFINER, pg_cron-only caller (refresh_cross_collection_cohort_step1)
-- anon-exec: unchanged — already REVOKED in prod, SECURITY DEFINER, pg_cron-only caller (refresh_cross_collection_cohort_step2)
--
-- Revert: the EXACT pre-change bodies are reproduced verbatim at the FOOT of this
-- file, captured from prod via pg_get_functiondef. ⚠ They are not recoverable from
-- git history — these two functions are fileless migrations, so before this file
-- their only copy was pg_proc.

CREATE OR REPLACE FUNCTION public.refresh_cross_collection_cohort_step1()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '180s'
AS $function$
DECLARE
  v_cohort_count int := 0;
  v_started timestamptz := NOW();
BEGIN
  -- Expensive scan FIRST, holding no lock on the reader-facing table.
  CREATE TEMP TABLE _ccm_step1_next ON COMMIT DROP AS
  SELECT
    w.wallet_address,
    COUNT(DISTINCT w.collection_id) AS n_collections,
    COUNT(*) AS total_moments,
    COUNT(*) FILTER (WHERE w.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd') AS ts_moments,
    COUNT(*) FILTER (WHERE w.collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070') AS allday_moments,
    COUNT(*) FILTER (WHERE w.collection_id = '06248cc4-b85f-47cd-af67-1855d14acd75') AS golazos_moments,
    COUNT(*) FILTER (WHERE w.collection_id = '7dd9dd11-e8b6-45c4-ac99-71331f959714') AS pinnacle_moments,
    COUNT(*) FILTER (WHERE w.collection_id = '9b4824a8-736d-4a96-b450-8dcc0c46b023') AS ufc_moments,
    ROUND(SUM(COALESCE(w.fmv_usd, 0))::numeric, 2) AS approx_fmv_usd
  FROM wallet_moments_cache w
  GROUP BY w.wallet_address
  HAVING COUNT(DISTINCT w.collection_id) >= 3;

  -- Lock window starts here and ends at COMMIT, a few rows later.
  TRUNCATE TABLE public.cross_collection_cohort_mat;

  INSERT INTO public.cross_collection_cohort_mat (
    wallet_address, n_collections, total_moments,
    ts_moments, allday_moments, golazos_moments, pinnacle_moments, ufc_moments,
    approx_fmv_usd, computed_at
  )
  SELECT
    wallet_address, n_collections, total_moments,
    ts_moments, allday_moments, golazos_moments, pinnacle_moments, ufc_moments,
    approx_fmv_usd, v_started
  FROM _ccm_step1_next;

  GET DIAGNOSTICS v_cohort_count = ROW_COUNT;
  RETURN jsonb_build_object('cohort_size', v_cohort_count, 'computed_at', v_started);
END;
$function$;

CREATE OR REPLACE FUNCTION public.refresh_cross_collection_cohort_step2()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '300s'
AS $function$
DECLARE
  v_set_count int := 0;
  v_started timestamptz := NOW();
BEGIN
  CREATE TEMP TABLE _ccm_step2_next ON COMMIT DROP AS
  SELECT
    e.set_id,
    MAX(e.set_name) AS set_name,
    COUNT(DISTINCT w.wallet_address) AS cohort_holders,
    COUNT(*) AS moments_in_cohort
  FROM public.cross_collection_cohort_mat c
  JOIN wallet_moments_cache w
    ON w.wallet_address = c.wallet_address
   AND w.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
  JOIN editions e
    ON e.external_id::text = w.edition_key
   AND e.collection_id = w.collection_id
  WHERE e.set_id IS NOT NULL
    AND e.set_name IS NOT NULL
  GROUP BY e.set_id;

  TRUNCATE TABLE public.cross_collection_ts_set_overlap_mat;

  INSERT INTO public.cross_collection_ts_set_overlap_mat (set_id, set_name, cohort_holders, moments_in_cohort, computed_at)
  SELECT set_id, set_name, cohort_holders, moments_in_cohort, v_started
  FROM _ccm_step2_next;

  GET DIAGNOSTICS v_set_count = ROW_COUNT;
  RETURN jsonb_build_object('set_overlap_rows', v_set_count, 'computed_at', v_started);
END;
$function$;

-- ═══════════════════════════════════════════════════════════════════════════
-- REVERT — the EXACT pre-change bodies, captured from prod via
-- `pg_get_functiondef` on 2026-08-21 PT (02:34Z on the 22nd) and reproduced
-- byte-for-byte below.
--
-- ⚠ COMMITTED AS EXECUTABLE SQL, NOT AS A DESCRIPTION, ON PURPOSE. CLAUDE.md's
-- ledger rule asks every shipped change for a revert path, and "re-apply the
-- previous bodies" is not one if nobody can produce them at 3am. It also cannot
-- be recovered from the git history of this repo: these two functions are part
-- of the fileless-migration population — applied to prod via MCP with no
-- committed file — so before this block their only copy was in `pg_proc`.
--
-- To revert: run everything between the BEGIN/END markers below. It is a plain
-- `CREATE OR REPLACE`, so it restores the bodies without touching ACLs, and
-- re-running it is idempotent.
--
-- >>> BEGIN revert (verbatim prod bodies, 2026-08-21 PT) >>>
--
-- CREATE OR REPLACE FUNCTION public.refresh_cross_collection_cohort_step1()
--  RETURNS jsonb
--  LANGUAGE plpgsql
--  SECURITY DEFINER
--  SET search_path TO 'public', 'pg_temp'
--  SET statement_timeout TO '180s'
-- AS $function$
-- DECLARE
--   v_cohort_count int := 0;
--   v_started timestamptz := NOW();
-- BEGIN
--   TRUNCATE TABLE public.cross_collection_cohort_mat;
--
--   INSERT INTO public.cross_collection_cohort_mat (
--     wallet_address, n_collections, total_moments,
--     ts_moments, allday_moments, golazos_moments, pinnacle_moments, ufc_moments,
--     approx_fmv_usd, computed_at
--   )
--   SELECT
--     w.wallet_address,
--     COUNT(DISTINCT w.collection_id),
--     COUNT(*),
--     COUNT(*) FILTER (WHERE w.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'),
--     COUNT(*) FILTER (WHERE w.collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070'),
--     COUNT(*) FILTER (WHERE w.collection_id = '06248cc4-b85f-47cd-af67-1855d14acd75'),
--     COUNT(*) FILTER (WHERE w.collection_id = '7dd9dd11-e8b6-45c4-ac99-71331f959714'),
--     COUNT(*) FILTER (WHERE w.collection_id = '9b4824a8-736d-4a96-b450-8dcc0c46b023'),
--     ROUND(SUM(COALESCE(w.fmv_usd, 0))::numeric, 2),
--     v_started
--   FROM wallet_moments_cache w
--   GROUP BY w.wallet_address
--   HAVING COUNT(DISTINCT w.collection_id) >= 3;
--
--   GET DIAGNOSTICS v_cohort_count = ROW_COUNT;
--   RETURN jsonb_build_object('cohort_size', v_cohort_count, 'computed_at', v_started);
-- END;
-- $function$;
--
-- CREATE OR REPLACE FUNCTION public.refresh_cross_collection_cohort_step2()
--  RETURNS jsonb
--  LANGUAGE plpgsql
--  SECURITY DEFINER
--  SET search_path TO 'public', 'pg_temp'
--  SET statement_timeout TO '300s'
-- AS $function$
-- DECLARE
--   v_set_count int := 0;
--   v_started timestamptz := NOW();
-- BEGIN
--   TRUNCATE TABLE public.cross_collection_ts_set_overlap_mat;
--
--   INSERT INTO public.cross_collection_ts_set_overlap_mat (set_id, set_name, cohort_holders, moments_in_cohort, computed_at)
--   SELECT
--     e.set_id,
--     MAX(e.set_name),
--     COUNT(DISTINCT w.wallet_address),
--     COUNT(*),
--     v_started
--   FROM public.cross_collection_cohort_mat c
--   JOIN wallet_moments_cache w
--     ON w.wallet_address = c.wallet_address
--    AND w.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
--   JOIN editions e
--     ON e.external_id::text = w.edition_key
--    AND e.collection_id = w.collection_id
--   WHERE e.set_id IS NOT NULL
--     AND e.set_name IS NOT NULL
--   GROUP BY e.set_id;
--
--   GET DIAGNOSTICS v_set_count = ROW_COUNT;
--   RETURN jsonb_build_object('set_overlap_rows', v_set_count, 'computed_at', v_started);
-- END;
-- $function$;
--
-- <<< END revert <<<

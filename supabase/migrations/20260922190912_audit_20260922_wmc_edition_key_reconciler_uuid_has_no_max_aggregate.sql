-- audit_20260922_wmc_edition_key_reconciler_uuid_has_no_max_aggregate
--
-- Fixes a defect in 20260922190822, applied minutes earlier.
--
-- `SELECT count(*), max(id) ... FROM _wek_win` raises
--   ERROR 42883: function max(uuid) does not exist
-- because Postgres ships no max() aggregate for uuid. wallet_moments_cache.id IS a uuid,
-- so the high-water mark could never be computed and the function failed on EVERY call --
-- it would have errored on every scheduled tick, forever, from the moment it was wired up.
--
-- HOW IT WAS CAUGHT, and the point worth keeping: a plain smoke run could not have found
-- this honestly. The corroborated population had already been filled by 20260922190111, so
-- a normal invocation's expected result was `filled: 0` -- indistinguishable from a
-- function that does nothing. The defect surfaced only under a PLANTED DEFECT: one
-- already-filled, corroborated row was set back to edition_key = NULL and the cursor
-- rewound, giving the run exactly one thing it was obliged to find. That is a positive
-- control; without it this would have shipped green.
--
-- After the fix the same planted-defect run returned `{"window": 3000, "filled": 1}` and
-- restored the victim row to its exact prior key (239:8179), leaving the other 2,999
-- windowed rows untouched -- i.e. it fills what it should and nothing it should not.
--
-- REVERT: as for 20260922190822.
--
-- anon-exec: revoked, NOT anon-reachable — reconcile_wmc_edition_key_from_moments has its ACL set by the defining migration 20260922190822 and corrected to include PUBLIC by 20260922191908
-- Why a marker and not a REVOKE here: this is a CREATE OR REPLACE of an existing
-- function, which does NOT reset a function ACL, so a REVOKE in this file would
-- silently CHANGE production while pretending to be a body-only fix. After 191908,
-- has_function_privilege('anon', ..., 'EXECUTE') is FALSE — verified against
-- pg_proc.proacl ({postgres=X,service_role=X}), not assumed from the green guard.

CREATE OR REPLACE FUNCTION public.reconcile_wmc_edition_key_from_moments(
  p_rows integer DEFAULT 3000,
  p_budget_seconds integer DEFAULT 45
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
SET statement_timeout = '110s'
AS $fn$
DECLARE
  v_ts      constant uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  v_started timestamptz := clock_timestamp();
  v_cursor  uuid;
  v_high    uuid;
  v_avail   integer := 0;
  v_filled  integer := 0;
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtext('reconcile_wmc_edition_key_from_moments')::bigint) THEN
    RETURN jsonb_build_object('skipped', 'concurrent');
  END IF;

  INSERT INTO public.wmc_edition_key_reconcile_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
  SELECT st.cursor_id INTO v_cursor
    FROM public.wmc_edition_key_reconcile_state st WHERE st.id = 1;
  v_high := v_cursor;

  CREATE TEMP TABLE _wek_win ON COMMIT DROP AS
    SELECT w.id, w.moment_id
      FROM public.wallet_moments_cache w
     WHERE w.collection_id = v_ts
       AND w.edition_key IS NULL
       AND w.id > v_cursor
     ORDER BY w.id
     LIMIT GREATEST(p_rows, 1);

  -- uuid has NO max() aggregate in Postgres (42883). Take the window's high-water
  -- mark by ORDER BY ... DESC LIMIT 1 instead. Caught by a planted-defect test
  -- before this was ever scheduled; max(id) failed the whole function every call.
  SELECT count(*) INTO v_avail FROM _wek_win;
  SELECT win.id INTO v_high FROM _wek_win win ORDER BY win.id DESC LIMIT 1;
  IF v_high IS NULL THEN v_high := v_cursor; END IF;

  IF v_avail > 0 THEN
    WITH cand AS (
      SELECT win.id, e.external_id AS proposed_key, win.moment_id,
        (SELECT es.external_id FROM public.sales s
           JOIN public.editions es ON es.id = s.edition_id
          WHERE s.nft_id = win.moment_id AND s.collection_id = v_ts
            AND s.edition_id IS NOT NULL LIMIT 1) AS sales_key,
        (SELECT sub.base_external_id FROM public.topshot_moment_subeditions sub
          WHERE sub.nft_id = win.moment_id LIMIT 1) AS sub_base_key
      FROM _wek_win win
      JOIN public.moments  m ON m.nft_id = win.moment_id AND m.collection_id = v_ts
      JOIN public.editions e ON e.id = m.edition_id
    ),
    ok AS (
      SELECT c.* FROM cand c
       WHERE ( (c.sales_key    IS NOT NULL AND c.sales_key    = c.proposed_key)
            OR (c.sub_base_key IS NOT NULL AND c.sub_base_key = split_part(c.proposed_key,'::',1)) )
         AND NOT (c.sales_key    IS NOT NULL AND c.sales_key    <> c.proposed_key)
         AND NOT (c.sub_base_key IS NOT NULL AND c.sub_base_key <> split_part(c.proposed_key,'::',1))
    ),
    logged AS (
      INSERT INTO public.audit_20260922_wmc_edition_key_backfill
             (id, wallet_address, moment_id, filled_key, sales_key, sub_base_key, filled_at)
      SELECT ok.id, w.wallet_address, ok.moment_id, ok.proposed_key, ok.sales_key, ok.sub_base_key, now()
        FROM ok JOIN public.wallet_moments_cache w ON w.id = ok.id
      ON CONFLICT (id) DO NOTHING
    ),
    upd AS (
      UPDATE public.wallet_moments_cache w
         SET edition_key = ok.proposed_key
        FROM ok
       WHERE w.id = ok.id
         AND w.edition_key IS NULL
      RETURNING 1
    )
    SELECT count(*)::int INTO v_filled FROM upd;
  END IF;

  UPDATE public.wmc_edition_key_reconcile_state
     SET cursor_id  = CASE WHEN v_avail > 0 THEN v_high
                           ELSE '00000000-0000-0000-0000-000000000000'::uuid END,
         cycles     = cycles + CASE WHEN v_avail > 0 THEN 0 ELSE 1 END,
         updated_at = now()
   WHERE id = 1;

  PERFORM public.log_pipeline_run(
    'wmc-edition-key-reconcile', v_started, v_avail, v_filled, GREATEST(v_avail - v_filled, 0),
    true, NULL, 'nba_top_shot', v_cursor::text, v_high::text,
    jsonb_build_object(
      'duration_ms', (extract(epoch FROM clock_timestamp() - v_started) * 1000)::int,
      'window', v_avail, 'filled', v_filled, 'budget_s', p_budget_seconds,
      'via', 'pg_cron', 'no_op', (v_filled = 0)));

  RETURN jsonb_build_object('window', v_avail, 'filled', v_filled, 'cursor', v_high);
END
$fn$;

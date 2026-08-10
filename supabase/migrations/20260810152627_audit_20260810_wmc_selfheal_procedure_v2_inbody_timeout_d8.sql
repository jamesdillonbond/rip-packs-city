-- audit_20260810_wmc_selfheal_procedure_v2_inbody_timeout_d8
--
-- D8 attempt v2 (SUPERSEDED — dropped by 20260810154333): moved the 600s budget
-- into the body as a session-level SET (so post-COMMIT legs re-arm) and made the
-- cron command a bare CALL. ⚠ STILL FAILED "invalid transaction termination" —
-- pg_cron wraps even a single-statement job in a transaction on this instance, so
-- a procedure COMMIT is impossible here regardless of the command shape. Kept as a
-- committed record; the procedure no longer exists in prod.

CREATE OR REPLACE PROCEDURE public.rpc_wmc_metadata_selfheal_all()
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $procedure$
DECLARE
  v_order   text[] := ARRAY['ufc_strike','candy_mlb','laliga_golazos','nfl_all_day','nba_top_shot'];
  v_slug    text;
  v_cid     uuid;
  v_healed  int;
  v_ok      boolean;
  v_err     text;
  v_started timestamptz;
BEGIN
  SET statement_timeout = '600s';

  FOREACH v_slug IN ARRAY v_order LOOP
    SELECT id INTO v_cid FROM public.collections WHERE slug = v_slug;
    IF v_cid IS NULL THEN CONTINUE; END IF;

    v_started := clock_timestamp();
    v_ok := true; v_err := NULL; v_healed := 0;
    BEGIN
      v_healed := public.backfill_wmc_metadata_from_editions(NULL, v_cid);
    EXCEPTION WHEN OTHERS THEN
      v_ok := false; v_err := SQLERRM;
    END;

    PERFORM public.log_pipeline_run(
      'wmc-metadata-selfheal',
      v_started, v_healed, v_healed, 0, v_ok, v_err, v_slug, NULL, NULL,
      jsonb_build_object('scope', v_slug,
                         'elapsed_ms', round(extract(epoch FROM clock_timestamp() - v_started) * 1000))
    );
    COMMIT;
  END LOOP;
END;
$procedure$;

REVOKE EXECUTE ON PROCEDURE public.rpc_wmc_metadata_selfheal_all() FROM PUBLIC, anon, authenticated;

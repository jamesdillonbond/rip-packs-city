-- audit_20261109_wmc_selfheal_skips_candy_and_writes_only_what_it_can_fill
--
-- Daytime-monitor filing 2026-11-09T2211Z, the two lanes that were NOT the player-name heal
-- (Claude Code cloud, ~4:30 PM PT; Trevor: "Do everything, leave nothing unresolved from this thread").
-- Both reported pg_cron `succeeded` at 120 s on 11-09 because they catch their own timeout; their
-- pipeline_runs rows say ok=false, "canceling statement due to statement timeout".
--
-- (1) rpc_wmc_selfheal_recent(3) — pg_cron 726, daily 2:31 AM PT. Its UPDATE matched every wmc row
--     created in the window with ANY NULL label, whether or not the edition could fill it — a COALESCE
--     no-op write for rows whose labels are NULL by design. The 11-08 Candy census put ~1.4M rows in
--     that window; 103,620 of the 105,075 fillable rows created in the last 3 days (measured 4:20 PM PT)
--     are Candy, which candy_wmc_label_fill_step (pg_cron 844, every 4 min, row-budgeted, the SAME
--     fill rule) already owns. Now:
--       * Candy is skipped HERE, on the EDITIONS side (e.collection_id), so its index entries are never
--         probed — the wmc-side filter alone still visited them (timed out at 55 s);
--       * a row is written only when the edition can actually fill one of its NULL labels (the
--         label-fill's fillability test, verbatim).
--     Measured on the same window: 388 ms / 207 k buffers for the 1,420 non-Candy rows to fill.
--     Base: the LIVE body (prosrc md5 de2a5ae6a02fe38b43ea11635771664c), which is the R118 batch's
--     (20260920143546: `EXCEPTION WHEN query_canceled OR OTHERS`), not 20260810162734's.
--
-- (2) reconcile_topshot_map_with_atlas(500) — pg_cron 818, daily 4:47 AM PT. Its candidate scan alone
--     aggregates all 1.93M Atlas nba events and probes 965 k map rows (53 s / 4.67M buffers, measured
--     4:15 PM PT) to find ~30 candidates; it ran 57–62 s on 11-07/08 and passed the 120 s role
--     timeout on 11-09. An incremental rewrite needs a new index on a 2M-row table for a lane that
--     repairs ~83 rows/day, so the proportionate lever is the window: its cron command gets a
--     300 s statement_timeout (precedent: 20261021145526). A `SET …;` prefix runs the command as one
--     transaction, which is what a single function call is anyway.
--
-- anon-exec: unchanged (rpc_wmc_selfheal_recent) — CREATE OR REPLACE of an existing fn, same signature; ACL preserved.
-- REVERT: re-apply rpc_wmc_selfheal_recent from 20260920143546; SELECT cron.alter_job(818, command := 'SELECT public.reconcile_topshot_map_with_atlas(500)');

CREATE OR REPLACE FUNCTION public.rpc_wmc_selfheal_recent(p_days integer DEFAULT 14)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '110s'
AS $function$
DECLARE
  v_started timestamptz := clock_timestamp();
  v_healed  int := 0;
  v_ok      boolean := true;
  v_err     text := NULL;
BEGIN
  BEGIN
    WITH updated AS (
      UPDATE public.wallet_moments_cache wmc
         SET tier        = COALESCE(wmc.tier,        e.tier::text),
             player_name = COALESCE(wmc.player_name, e.player_name, e.team_name),
             set_name    = COALESCE(wmc.set_name,    e.set_name),
             mint_count  = COALESCE(wmc.mint_count,  e.circulation_count),
             team_name   = COALESCE(wmc.team_name,   e.team_name)
        FROM public.editions e
       WHERE e.collection_id = wmc.collection_id
         AND e.external_id   = wmc.edition_key
         -- 2026-11-09: Candy belongs to candy_wmc_label_fill_step (same rule, row-budgeted).
         AND e.collection_id <> '209ade70-32c5-4470-bc7c-4793d660f713'::uuid
         AND wmc.edition_key IS NOT NULL
         AND wmc.created_at > now() - make_interval(days => GREATEST(p_days, 1))
         AND (wmc.tier IS NULL OR wmc.player_name IS NULL OR wmc.set_name IS NULL
              OR wmc.mint_count IS NULL OR wmc.team_name IS NULL)
         -- 2026-11-09: only a row the edition can actually FILL — never a COALESCE no-op write.
         AND (  (wmc.tier IS NULL AND e.tier IS NOT NULL)
             OR (wmc.player_name IS NULL AND COALESCE(e.player_name, e.team_name) IS NOT NULL)
             OR (wmc.set_name IS NULL AND e.set_name IS NOT NULL)
             OR (wmc.mint_count IS NULL AND e.circulation_count IS NOT NULL)
             OR (wmc.team_name IS NULL AND e.team_name IS NOT NULL))
      RETURNING 1
    )
    SELECT count(*) INTO v_healed FROM updated;
  EXCEPTION WHEN query_canceled OR OTHERS THEN
    v_ok := false; v_err := SQLERRM;
  END;

  PERFORM public.log_pipeline_run(
    'wmc-metadata-selfheal',
    v_started, v_healed, v_healed, 0, v_ok, v_err, NULL, NULL, NULL,
    jsonb_build_object('scope', 'recent_' || GREATEST(p_days,1) || 'd',
                       'elapsed_ms', round(extract(epoch FROM clock_timestamp() - v_started) * 1000))
  );
  RETURN v_healed;
END;
$function$;

SELECT cron.alter_job(818, command := 'SET statement_timeout = ''300s''; SELECT public.reconcile_topshot_map_with_atlas(500)');

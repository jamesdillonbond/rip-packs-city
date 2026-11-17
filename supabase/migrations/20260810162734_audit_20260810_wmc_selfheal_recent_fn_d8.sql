-- audit_20260810_wmc_selfheal_recent_fn_d8
--
-- D8 automation, part 1 of 2 (part 2 = the operator index build + the schedule).
-- The scan-everything self-heal times out under saturation (see the 08-10 D8
-- correction). This recent-scoped variant heals only rows CREATED in the last
-- p_days, which — once `idx_wmc_created_at` exists — is a cheap range scan of the
-- few recent rows instead of a 2.2M-row full scan. The register's finding that
-- 47,305 of 47,498 AllDay backlog rows were created within 7 days is exactly why
-- a recent scope catches essentially all regeneration.
--
-- ⚠ INERT until the operator builds the index — without idx_wmc_created_at this
-- still seq-scans wmc and will time out under saturation, so DO NOT schedule it as
-- a cron until the index is `indisvalid = true`. Build (Supabase SQL editor, no
-- 120s pg_cron cap):
--     CREATE INDEX CONCURRENTLY idx_wmc_created_at ON public.wallet_moments_cache (created_at);
-- (created_at is insert-only → the index never disturbs HOT, unlike the vetoed
-- `player_name IS NULL` partial.) Then:
--     SELECT cron.schedule('rpc-wmc-metadata-selfheal-recent','47 10 * * *',
--       $$SELECT public.rpc_wmc_selfheal_recent(14)$$);
-- and drain the pre-index residue once with a wider window: SELECT rpc_wmc_selfheal_recent(400);
--
-- Revert: DROP FUNCTION public.rpc_wmc_selfheal_recent(integer);

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
         AND wmc.edition_key IS NOT NULL
         AND wmc.created_at > now() - make_interval(days => GREATEST(p_days, 1))
         AND (wmc.tier IS NULL OR wmc.player_name IS NULL OR wmc.set_name IS NULL
              OR wmc.mint_count IS NULL OR wmc.team_name IS NULL)
      RETURNING 1
    )
    SELECT count(*) INTO v_healed FROM updated;
  EXCEPTION WHEN OTHERS THEN
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

REVOKE EXECUTE ON FUNCTION public.rpc_wmc_selfheal_recent(integer) FROM PUBLIC, anon, authenticated;

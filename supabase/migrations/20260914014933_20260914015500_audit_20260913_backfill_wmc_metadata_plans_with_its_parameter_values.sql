-- audit_20260913_backfill_wmc_metadata_plans_with_its_parameter_values
-- (full rationale in the committed file of the same name; DDL below is byte-identical to it)
-- anon-exec: backfill_wmc_metadata_from_editions -- unchanged (service_role + postgres only; the REVOKE/GRANT below re-assert what was there)

CREATE OR REPLACE FUNCTION public.backfill_wmc_metadata_from_editions(p_wallet_address text DEFAULT NULL::text, p_collection_id uuid DEFAULT NULL::uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '120s'
AS $function$
DECLARE
  v_updated integer;
BEGIN
  -- ⚠ EXECUTE … USING, not a plain statement: a plain one is planned GENERIC
  -- from the sixth call of a pooled session onward, and the generic plan for
  -- this WHERE clause seq-scans `editions` and probes wmc per edition — 62x the
  -- buffers (measured 2026-09-13; see this migration's header and #113).
  EXECUTE $q$
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
       -- Only rows where at least one NULL can actually be filled. Without the
       -- right-hand IS NOT NULL checks a row whose edition is also NULL in that
       -- column was rewritten with identical values on every run (2026-08-30).
       AND (
         (wmc.tier        IS NULL AND e.tier IS NOT NULL) OR
         (wmc.player_name IS NULL AND COALESCE(e.player_name, e.team_name) IS NOT NULL) OR
         (wmc.set_name    IS NULL AND e.set_name IS NOT NULL) OR
         (wmc.mint_count  IS NULL AND e.circulation_count IS NOT NULL) OR
         (wmc.team_name   IS NULL AND e.team_name IS NOT NULL)
       )
       AND ($1 IS NULL OR wmc.wallet_address = $1)
       AND ($2 IS NULL OR wmc.collection_id  = $2)
    RETURNING 1
  )
  SELECT COUNT(*)::int FROM updated
  $q$
  INTO v_updated
  USING p_wallet_address, p_collection_id;

  RETURN COALESCE(v_updated, 0);
END;
$function$;

REVOKE ALL ON FUNCTION public.backfill_wmc_metadata_from_editions(text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.backfill_wmc_metadata_from_editions(text, uuid) TO service_role, postgres;
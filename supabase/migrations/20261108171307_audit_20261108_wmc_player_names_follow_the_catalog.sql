-- audit_20261108_wmc_player_names_follow_the_catalog
--
-- #221 (known-issues), 2026-11-08 (Claude Code, Trevor's Windows box; Trevor: "keep going and
-- do it all"). wallet_moments_cache.player_name is a denormalised copy; on 11-08 it disagreed with
-- the catalog (editions.player_name, joined on collection_id + edition_key) on 12,446 Top Shot and
-- 6,460 All Day rows. Most of it is LAG, not disagreement: the 11-07 renames made the catalog
-- canonical (Nic Claxton, John Metchie III, OG Anunoby, Enes Freedom ...) and registered the old
-- spelling as a player_name_aliases alias, and the wmc trigger a_normalize_player_name_alias_*
-- applies that alias on INSERT / on a player_name change — so rows written BEFORE the alias existed
-- keep the old spelling forever (nothing rewrites player_name on an existing row). The rest are
-- case / whitespace-only copies of the catalog name ("Demar DeRozan", "Goran Dragić " with a
-- trailing space) that the trigger never sees (same slug, no alias).
--
-- WHAT. New heal_wmc_player_names_from_catalog(p_limit): sets wmc.player_name to the catalog name
-- where (a) the wmc spelling is a REGISTERED ALIAS of the catalog player — exactly what the insert
-- trigger would have done had the alias existed — or (b) the two differ only by case / outer
-- whitespace. Nothing else: accent-only differences are left alone (#221: diacritics are wrong in
-- BOTH directions, "Aleksej Pokuševski" is right in wmc and stripped in editions), "Team Moment"
-- is left alone, Pinnacle (a pin's name is not a person) is excluded. Scheduled daily at
-- 29 10 * * * UTC (3:29 AM PT; off the stagger ban, a free minute) because the Top Shot walker
-- writes the on-chain spelling on every NEW row.
-- Measured 11-08 (EXPLAIN ANALYZE BUFFERS, read side): 10,583 candidates; one seq scan of wmc,
-- 126,531 buffers, 2.8 s. Bounded by p_limit (default 50000) per run.
--
-- PIN: supabase/tests/heal_wmc_player_names_from_catalog.sql. Applied 2026-11-08 ~9:13 AM PT; first run (by hand) rewrote 10,583 rows (9,856 alias, 727 case/space).
-- anon-exec: NOT granted (heal_wmc_player_names_from_catalog) — a pg_cron maintenance writer; EXECUTE revoked from PUBLIC, anon, authenticated and granted to service_role below.
-- REVERT: SELECT cron.unschedule('rpc-wmc-player-names-follow-catalog-daily');
--         DELETE FROM public.pipeline_cadence_watchlist WHERE pipeline = 'wmc-player-names-follow-catalog';
--         DROP FUNCTION public.heal_wmc_player_names_from_catalog(integer);
--         (data: the old spellings are the registered aliases / case variants of the new ones; a
--          rewrite is lossless in meaning and is what the insert trigger already does.)

CREATE OR REPLACE FUNCTION public.heal_wmc_player_names_from_catalog(p_limit integer DEFAULT 50000)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_started timestamptz := clock_timestamp();
  v_pin     constant uuid := '7dd9dd11-e8b6-45c4-ac99-71331f959714';
  v_alias   int := 0;
  v_case    int := 0;
BEGIN
  WITH cand AS (
    SELECT w.id, e.player_name AS cat_name,
           (lower(btrim(w.player_name)) = lower(btrim(e.player_name))) AS case_only
      FROM public.wallet_moments_cache w
      JOIN public.editions e
        ON e.collection_id = w.collection_id AND e.external_id = w.edition_key
     WHERE w.collection_id <> v_pin
       AND w.player_name IS NOT NULL
       AND e.player_name IS NOT NULL AND btrim(e.player_name) <> ''
       AND w.player_name <> e.player_name
       AND (lower(btrim(w.player_name)) = lower(btrim(e.player_name))
            OR EXISTS (SELECT 1
                         FROM public.player_name_aliases a
                         JOIN public.players p ON p.id = a.player_id
                        WHERE a.collection_id = e.collection_id
                          AND p.collection_id = e.collection_id
                          AND p.name = e.player_name
                          AND btrim(a.alias_slug, '-') =
                              btrim(regexp_replace(lower(btrim(extensions.unaccent(w.player_name))), '[^a-z0-9]+', '-', 'g'), '-')))
     LIMIT greatest(coalesce(p_limit, 50000), 0)
  ), upd AS (
    UPDATE public.wallet_moments_cache w
       SET player_name = c.cat_name
      FROM cand c
     WHERE w.id = c.id
    RETURNING c.case_only
  )
  SELECT count(*) FILTER (WHERE NOT case_only), count(*) FILTER (WHERE case_only)
    INTO v_alias, v_case
    FROM upd;

  -- rows_written = rows actually updated (RETURNING), never the candidate count.
  PERFORM public.log_pipeline_run(
    'wmc-player-names-follow-catalog', v_started,
    v_alias + v_case, v_alias + v_case, 0,
    true, NULL, NULL, NULL, NULL,
    jsonb_build_object('alias_rewrites', v_alias, 'case_space_rewrites', v_case, 'limit', p_limit));

  RETURN jsonb_build_object('ok', true, 'alias_rewrites', v_alias, 'case_space_rewrites', v_case);
END
$function$;

REVOKE ALL ON FUNCTION public.heal_wmc_player_names_from_catalog(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.heal_wmc_player_names_from_catalog(integer) TO service_role;

INSERT INTO public.pipeline_cadence_watchlist (pipeline, max_silent_minutes, severity, notes, is_active, max_minutes_without_success)
VALUES ('wmc-player-names-follow-catalog', 1560, 'info',
  'pg_cron rpc-wmc-player-names-follow-catalog-daily (29 10 * * * UTC, postgres) -> heal_wmc_player_names_from_catalog(50000): rewrites wmc.player_name to the catalog name where the wmc spelling is a registered alias of that player or differs only by case/whitespace (#221).',
  true, 3000)
ON CONFLICT (pipeline) DO NOTHING;

SELECT cron.schedule('rpc-wmc-player-names-follow-catalog-daily', '29 10 * * *',
  'SELECT public.heal_wmc_player_names_from_catalog(50000);');

-- 2026-09-23 · Top Shot catalog: new sets and editions come in from Atlas instead
-- of never.
--
-- FINDING (9:55 PM PT, while hydrating today's pack pulls): the chain names pulls
-- in sets 275, 277, 278 and 279, and `sets` / `editions` hold NONE of them — the
-- newest Top Shot edition row was created 09-15. So a freshly opened pack cannot
-- be priced (pull value is all-or-nothing) and its moments render nameless.
--
-- MECHANISM: two closed loops.
--   1. atlas_editions_dispatch() seeds atlas_set_refresh_state ONLY from sets that
--      already have an `editions` row, so Atlas is never asked about a new set.
--   2. atlas_editions_drain() writes badge_editions and ENRICHES existing editions,
--      but never CREATES a `sets` or `editions` row. The dead publisher API
--      (public-api.nbatopshot.com, gone 2026-08-29) used to be the creator.
-- Neither loop can open the other.
--
-- FIX: catalog_topshot_from_atlas(), every 10 min:
--   a. Probe AHEAD: queue set ids (highest set Atlas has returned editions for)+1
--      .. +10 into atlas_set_refresh_state. Bounded by construction: the window
--      only moves when Atlas actually returns a set, and an empty set costs one
--      request per rotation.
--   b. Create a `sets` row for every Atlas set with no set row (name + tier from
--      Atlas; series left NULL rather than guessed).
--   c. Create an `editions` row for every Atlas edition with no edition row,
--      keyed exactly as the rest of the estate keys Top Shot (set:play for the
--      Standard printing, set:play::subedition for a parallel), with player,
--      team, tier and circulation from Atlas.
--   d. Fill player / team / circulation on existing rows where they are NULL
--      (the stub rows ensure_topshot_edition_stub creates), never overwriting.
-- Read-only against Atlas's data: nothing here writes a price.
--
-- REVERT:
--   SELECT cron.unschedule('rpc-catalog-topshot-from-atlas');
--   DELETE FROM public.pipeline_cadence_watchlist WHERE pipeline = 'catalog-topshot-from-atlas';
--   DROP FUNCTION public.run_catalog_topshot_from_atlas(); DROP FUNCTION public.catalog_topshot_from_atlas();
--   Rows it created carry sets.asset_path_prefix = 'atlas-catalog-20260923' (sets) and
--   editions.reward_indicators @> '{atlas-catalog-20260923}' (editions).
--
-- anon-exec: NOT intentional for catalog_topshot_from_atlas / run_catalog_topshot_from_atlas — ops writers, ACL set below.

CREATE OR REPLACE FUNCTION public.catalog_topshot_from_atlas()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_ts constant uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  v_max_seen int;
  v_probed int := 0; v_sets int := 0; v_eds int := 0; v_filled int := 0;
BEGIN
  -- a. probe ahead of the highest set Atlas has actually returned
  SELECT max(split_part(external_id, ':', 1)::int) INTO v_max_seen
    FROM public.badge_editions
   WHERE collection_id = v_ts AND external_id ~ '^[0-9]+:[0-9]+';
  IF v_max_seen IS NOT NULL THEN
    INSERT INTO public.atlas_set_refresh_state (set_id_onchain)
    SELECT g FROM generate_series(v_max_seen + 1, v_max_seen + 10) g
    ON CONFLICT (set_id_onchain) DO NOTHING;
    GET DIAGNOSTICS v_probed = ROW_COUNT;
  END IF;

  -- b. sets Atlas knows and we do not
  WITH a AS (
    SELECT split_part(b.external_id, ':', 1)::int AS set_on,
           min(b.set_name) AS set_name,
           min(b.tier) FILTER (WHERE COALESCE(b.parallel_id, 0) = 0) AS tier
      FROM public.badge_editions b
     WHERE b.collection_id = v_ts AND b.external_id ~ '^[0-9]+:[0-9]+'
     GROUP BY 1
  ), ins AS (
    INSERT INTO public.sets (collection_id, name, tier, series, set_id_onchain, asset_path_prefix)
    SELECT v_ts, a.set_name,
           CASE WHEN upper(a.tier) IN ('ULTIMATE','LEGENDARY','RARE','UNCOMMON','FANDOM','COMMON') THEN upper(a.tier)::tier_type END,
           NULL, a.set_on, 'atlas-catalog-20260923'
      FROM a
     WHERE a.set_name IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM public.sets s WHERE s.collection_id = v_ts AND s.set_id_onchain = a.set_on)
    RETURNING 1
  )
  SELECT count(*) INTO v_sets FROM ins;

  -- c. editions Atlas knows and we do not
  WITH a AS (
    SELECT b.external_id,
           split_part(b.external_id, ':', 1)::int AS set_on,
           split_part(split_part(b.external_id, '::', 1), ':', 2)::int AS play_on,
           NULLIF(b.parallel_id, 0) AS par_id,
           NULLIF(b.parallel_name, '') AS par_name,
           b.player_name, b.team, b.circulation_count,
           CASE WHEN upper(b.tier) IN ('ULTIMATE','LEGENDARY','RARE','UNCOMMON','FANDOM','COMMON') THEN upper(b.tier)::tier_type END AS tier
      FROM public.badge_editions b
     WHERE b.collection_id = v_ts
       AND b.external_id ~ '^[0-9]+:[0-9]+(::[0-9]+)?$'
  ), ins AS (
    INSERT INTO public.editions (external_id, collection_id, set_id, tier, series, edition_kind,
                                 set_id_onchain, play_id_onchain, collection, set_name,
                                 player_name, team_name, circulation_count,
                                 subedition_id, subedition_name, reward_indicators)
    SELECT a.external_id, v_ts, s.id, COALESCE(a.tier, s.tier), s.series,
           CASE WHEN COALESCE(a.tier, s.tier) = 'COMMON' THEN 'CC'::edition_kind ELSE 'LE'::edition_kind END,
           a.set_on, a.play_on, 'nba_top_shot', s.name,
           a.player_name, a.team, NULLIF(a.circulation_count, 0),
           a.par_id::smallint, a.par_name, ARRAY['atlas-catalog-20260923']
      FROM a
      JOIN public.sets s ON s.collection_id = v_ts AND s.set_id_onchain = a.set_on
     WHERE NOT EXISTS (SELECT 1 FROM public.editions e WHERE e.collection_id = v_ts AND e.external_id = a.external_id)
    ON CONFLICT DO NOTHING
    RETURNING 1
  )
  SELECT count(*) INTO v_eds FROM ins;

  -- d. fill the NULLs on stub rows, never overwrite
  WITH upd AS (
    UPDATE public.editions e
       SET player_name       = COALESCE(e.player_name, b.player_name),
           team_name         = COALESCE(e.team_name, b.team),
           circulation_count = COALESCE(e.circulation_count, NULLIF(b.circulation_count, 0)),
           updated_at        = now()
      FROM public.badge_editions b
     WHERE e.collection_id = v_ts AND b.collection_id = v_ts
       AND b.external_id = e.external_id
       AND ((e.player_name IS NULL AND b.player_name IS NOT NULL)
         OR (e.team_name IS NULL AND b.team IS NOT NULL)
         OR (e.circulation_count IS NULL AND COALESCE(b.circulation_count, 0) > 0))
    RETURNING 1
  )
  SELECT count(*) INTO v_filled FROM upd;

  RETURN jsonb_build_object('probed_ahead', v_probed, 'max_atlas_set', v_max_seen,
                            'sets_created', v_sets, 'editions_created', v_eds, 'stubs_filled', v_filled);
END
$fn$;
REVOKE ALL ON FUNCTION public.catalog_topshot_from_atlas() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.catalog_topshot_from_atlas() TO service_role, postgres;

CREATE OR REPLACE FUNCTION public.run_catalog_topshot_from_atlas()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE v_started timestamptz := clock_timestamp(); v jsonb; v_err text;
BEGIN
  BEGIN
    v := public.catalog_topshot_from_atlas();
  EXCEPTION WHEN OTHERS OR query_canceled THEN
    v_err := SQLERRM;
  END;
  PERFORM public.log_pipeline_run('catalog-topshot-from-atlas', v_started, NULL,
    CASE WHEN v IS NULL THEN NULL ELSE (v->>'sets_created')::int + (v->>'editions_created')::int + (v->>'stubs_filled')::int END,
    NULL, v_err IS NULL, v_err, 'nba_top_shot', NULL, NULL, COALESCE(v, '{}'::jsonb));
END
$fn$;
REVOKE ALL ON FUNCTION public.run_catalog_topshot_from_atlas() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.run_catalog_topshot_from_atlas() TO service_role, postgres;

SELECT cron.schedule('rpc-catalog-topshot-from-atlas', '9-59/10 * * * *', 'SELECT public.run_catalog_topshot_from_atlas();');

-- A second head-only hydration tick 2 minutes after the main one: doubles the
-- head budget (still 60 per burst, under the 100 req/s limit). The main tick's
-- drain collects its answers.
SELECT cron.schedule('rpc-topshot-moments-hydrate-head', '1-57/4 * * * *', 'SELECT public.topshot_moment_hydrate_dispatch_head(60);');

INSERT INTO public.pipeline_cadence_watchlist (pipeline, max_silent_minutes, severity, notes, max_minutes_without_success)
VALUES ('catalog-topshot-from-atlas', 60, 'medium', 'Seeded 2026-09-23: pg_cron every 10 min -> 6x silent.', 120)
ON CONFLICT (pipeline) DO NOTHING;

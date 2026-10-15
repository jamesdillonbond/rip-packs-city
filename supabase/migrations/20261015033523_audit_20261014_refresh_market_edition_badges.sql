-- audit_20261014_refresh_market_edition_badges
--
-- Fills public.market_edition_badges (20261015032639) from the canonical badge
-- rule, get_edition_badges_unified — the same function behind
-- get_edition_badge_titles, /api/entity/edition-badges and the edition page, so
-- the Market filter, the Market badge column and the edition page cannot
-- disagree. Verified after the first fill: 400 of 400 sampled listed Top Shot
-- editions (79 badged) carry the same title set in the table as from
-- get_edition_badge_titles. First fill: Top Shot 14,528 editions → 7,346 rows;
-- All Day 6,190 → 5,334.
--
-- No DELETE: every (edition, title) the rule yields is stamped with the run's
-- clock_timestamp(), and market_edition_badges_runs records that stamp per
-- collection. Readers (get_*_v2, get_market_badge_options) join on
-- refreshed_at = last_run_at, so a badge an edition lost stops counting when the
-- next run commits. A failed run rolls back its rows AND its stamp, so readers
-- keep the previous complete run. Scheduled hourly in 20261015033717.
--
-- anon-exec: revoked (refresh_market_edition_badges) — new SECDEF writer; postgres/service_role only (verified has_function_privilege anon=false, authenticated=false).
--
-- REVERT: DROP FUNCTION public.refresh_market_edition_badges(uuid); DROP TABLE public.market_edition_badges_runs;
CREATE TABLE IF NOT EXISTS public.market_edition_badges_runs (
  collection_id uuid PRIMARY KEY,
  last_run_at   timestamptz NOT NULL,
  rows_written  integer NOT NULL
);
ALTER TABLE public.market_edition_badges_runs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.market_edition_badges_runs FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.market_edition_badges_runs TO postgres, service_role;

CREATE FUNCTION public.refresh_market_edition_badges(p_collection_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
SET statement_timeout TO '120s'
AS $fn$
DECLARE
  v_now     timestamptz := clock_timestamp();
  v_slug    text;
  v_scanned int := 0;
  v_written int := 0;
BEGIN
  SELECT slug INTO v_slug FROM collections WHERE id = p_collection_id;
  IF v_slug IS NULL THEN
    RAISE EXCEPTION 'unknown collection %', p_collection_id;
  END IF;

  SELECT count(*) INTO v_scanned FROM editions WHERE collection_id = p_collection_id;

  -- Every (edition, title) the canonical rule yields now is stamped with this
  -- run's clock. Readers count only rows stamped by the collection's latest run
  -- (market_edition_badges_runs.last_run_at), so a badge an edition lost stops
  -- counting the moment the run that no longer yields it commits.
  WITH fresh AS (
    SELECT DISTINCT e.id AS edition_id, btrim(t->>'title') AS title
    FROM editions e
    CROSS JOIN LATERAL jsonb_array_elements(get_edition_badges_unified(e.id)) AS t
    WHERE e.collection_id = p_collection_id
      AND coalesce(btrim(t->>'title'), '') <> ''
  ),
  up AS (
    INSERT INTO market_edition_badges (collection_id, edition_id, title, refreshed_at)
    SELECT p_collection_id, f.edition_id, f.title, v_now FROM fresh f
    ON CONFLICT (edition_id, title) DO UPDATE
      SET refreshed_at = EXCLUDED.refreshed_at, collection_id = EXCLUDED.collection_id
    RETURNING 1
  )
  SELECT count(*) INTO v_written FROM up;

  INSERT INTO market_edition_badges_runs (collection_id, last_run_at, rows_written)
  VALUES (p_collection_id, v_now, v_written)
  ON CONFLICT (collection_id) DO UPDATE
    SET last_run_at = EXCLUDED.last_run_at, rows_written = EXCLUDED.rows_written;

  PERFORM public.log_pipeline_run('market-edition-badges', v_now, v_scanned, v_written, 0, true, NULL,
    v_slug, NULL, NULL, NULL);
  RETURN jsonb_build_object('ok', true, 'collection', v_slug, 'editions', v_scanned, 'rows_written', v_written);
EXCEPTION WHEN query_canceled OR OTHERS THEN
  -- the rows it wrote (and the run stamp) roll back with it, so rows_written is 0
  -- and readers keep using the previous complete run
  PERFORM public.log_pipeline_run('market-edition-badges', v_now, v_scanned, 0, 0, false, left(SQLERRM, 300),
    v_slug, NULL, NULL, NULL);
  RETURN jsonb_build_object('ok', false, 'error', SQLERRM);
END;
$fn$;
REVOKE EXECUTE ON FUNCTION public.refresh_market_edition_badges(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_market_edition_badges(uuid) TO postgres, service_role;

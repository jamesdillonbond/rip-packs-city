-- Snapshot migration: public.refresh_golazos_badge_low_ask().
--
-- pg_cron `rpc-golazos-badge-low-ask-refresh` @ `10,40 * * * *`. Applied to prod
-- via the Supabase MCP with no committed migration file, which made it
-- UNPINNABLE. This commits the CURRENT LIVE definition verbatim
-- (pg_get_functiondef, 2026-08-16, md5 b01f4f4eaec7cda3ddfce710ab7cfd9d).
-- Applying it is a no-op against prod.
--
-- ── WHY IT IS NOT JUST "THE ALLDAY ONE WITH A DIFFERENT UUID" ──────────────
-- It is the same two-phase write/clear shape as refresh_allday_badge_low_ask
-- (pinned 2026-08-16), plus ONE EXTRA STEP that is the whole reason it is worth
-- a separate pin: it calls `resolve_golazos_listing_edition_ids()` FIRST, to
-- self-heal `edition_id` on newly indexed listings before reading the floor-ask
-- view.
--
-- ⚠ That ordering is load-bearing. `golazos_edition_floor_ask` joins on
-- `edition_id`, so a freshly indexed listing whose edition_id is still NULL is
-- INVISIBLE to it — its ask would never reach the badge, and the edition would
-- read as having no ask while a live listing sat on the marketplace. Running the
-- resolve AFTER the read, or dropping it, produces exactly that: a silently
-- incomplete surface, with the job still reporting ok. This is the same class as
-- the Pinnacle NULL-edition_id gap in deep-audit R4.
--
-- CLAUDE.md records that Golazos low_ask sits at ~37% coverage and that the
-- ceiling is LISTING-GATED (only editions with a live Flowty floor get an ask) —
-- not a bug, and NOT something a second cron would fix. This function is that
-- one cron; do not build another.
--
-- ⚠ Same caveat as its AllDay sibling, recorded and deliberately NOT changed:
-- the `EXCEPTION WHEN OTHERS` handler cannot fire on a statement timeout,
-- because PostgreSQL excludes QUERY_CANCELED from OTHERS and this declares
-- `statement_timeout = 60s`. A timeout leaves NO pipeline_runs row at all.
--
-- REVERT: a snapshot of what is already live, so reverting the FILE changes
-- nothing in prod. To remove the function:
--   DROP FUNCTION public.refresh_golazos_badge_low_ask();
-- (plus unscheduling pg_cron `rpc-golazos-badge-low-ask-refresh`).

CREATE OR REPLACE FUNCTION public.refresh_golazos_badge_low_ask()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '60s'
AS $function$
DECLARE
  v_coll uuid := '06248cc4-b85f-47cd-af67-1855d14acd75';
  v_start timestamptz := clock_timestamp();
  v_updated int := 0;
  v_cleared int := 0;
  v_resolved int := 0;
BEGIN
  -- Self-heal edition_id on newly indexed listings before reading the view.
  v_resolved := public.resolve_golazos_listing_edition_ids();

  WITH src AS (
    SELECT e.external_id, gfa.floor_ask
    FROM public.golazos_edition_floor_ask gfa
    JOIN public.editions e ON e.id = gfa.edition_id AND e.collection_id = v_coll
    WHERE gfa.floor_ask > 0
  ),
  upd AS (
    UPDATE public.badge_editions be
    SET low_ask = src.floor_ask, updated_at = now()
    FROM src
    WHERE be.collection_id = v_coll
      AND be.external_id = src.external_id
      AND be.low_ask IS DISTINCT FROM src.floor_ask
    RETURNING 1
  )
  SELECT count(*) INTO v_updated FROM upd;

  WITH present AS (
    SELECT e.external_id
    FROM public.golazos_edition_floor_ask gfa
    JOIN public.editions e ON e.id = gfa.edition_id AND e.collection_id = v_coll
    WHERE gfa.floor_ask > 0
  ),
  cl AS (
    UPDATE public.badge_editions be
    SET low_ask = NULL, updated_at = now()
    WHERE be.collection_id = v_coll
      AND be.low_ask IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM present p WHERE p.external_id = be.external_id)
    RETURNING 1
  )
  SELECT count(*) INTO v_cleared FROM cl;

  INSERT INTO public.pipeline_runs (pipeline, collection_slug, started_at, finished_at, rows_written, ok, extra)
  VALUES ('golazos-badge-low-ask-refresh', 'laliga_golazos', v_start, clock_timestamp(),
          v_updated + v_cleared, true,
          jsonb_build_object('updated', v_updated, 'cleared', v_cleared,
                             'listing_edition_ids_resolved', v_resolved));
EXCEPTION WHEN OTHERS THEN
  INSERT INTO public.pipeline_runs (pipeline, collection_slug, started_at, finished_at, ok, error)
  VALUES ('golazos-badge-low-ask-refresh', 'laliga_golazos', v_start, clock_timestamp(), false, SQLERRM);
  RAISE;
END;
$function$;

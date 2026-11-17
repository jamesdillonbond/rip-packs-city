-- Snapshot migration: two more scheduled SECDEF writers with no committed DDL.
--
--   public.bridge_pinnacle_sales_editions()   pg_cron `41 5 * * *`
--   public.refresh_allday_badge_low_ask()     pg_cron `*/30 * * * *`
--
-- Both were applied to prod via the Supabase MCP with no committed migration
-- file, which made them UNPINNABLE. This commits the CURRENT LIVE definitions
-- verbatim (pg_get_functiondef, 2026-08-16):
--   bridge_pinnacle_sales_editions  md5 67f72658e02dd5399049213b4282efad
--   refresh_allday_badge_low_ask    md5 064d096289b8827d310ae76d289160cb
-- Applying it is a no-op against prod (byte-identical to what already runs).
--
-- ── WHY THESE TWO ──────────────────────────────────────────────────────────
--
-- bridge_pinnacle_sales_editions backfills `pinnacle_sales.edition_id` from the
-- render spine. It sits directly on the deep-audit R4 surface — the Pinnacle
-- sales carrying a NULL edition_id that made the overview's top-sales panel
-- unable to name 2 of its top 5. Its safety property is the HAVING clause: it
-- bridges ONLY where a render maps to exactly ONE edition, so an ambiguous
-- render is left NULL rather than attributed to an arbitrary edition. Attaching
-- a sale to the wrong edition would move that edition's FMV.
--
-- refresh_allday_badge_low_ask is two-phase — it writes low_ask from the live
-- floor-ask source, and then CLEARS low_ask to NULL for editions that no longer
-- have one. The clear phase is the half that is easy to drop and expensive to
-- lose: a stale low_ask is a price that no longer exists, shown as current.
--
-- ⚠ NOTE FOR A FUTURE EDITOR, recorded but deliberately NOT changed here: its
-- `EXCEPTION WHEN OTHERS` handler cannot fire on a statement timeout. PostgreSQL
-- excludes QUERY_CANCELED from OTHERS, and this function declares
-- `statement_timeout = 60s`, so a timeout skips the failure-logging INSERT
-- entirely and the run leaves NO pipeline_runs row at all — indistinguishable
-- from "never scheduled". This is the same defect CLAUDE.md documents on the
-- trust-precompute legs, where the 999 sentinel has never once fired. Changing
-- it is a behaviour change to make deliberately, with the same caveats recorded
-- there (catching the cancel without re-arming the timer trades a bounded
-- failure for an unbounded one).
--
-- REVERT: these are snapshots of what is already live, so reverting the FILE
-- changes nothing in prod. To remove the functions:
--   DROP FUNCTION public.bridge_pinnacle_sales_editions();
--   DROP FUNCTION public.refresh_allday_badge_low_ask();
-- (plus unscheduling pg_cron `rpc-pinnacle-bridge-selfheal` and
-- `rpc-allday-badge-low-ask-refresh`).

CREATE OR REPLACE FUNCTION public.bridge_pinnacle_sales_editions()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '300s'
AS $function$
DECLARE v_total integer := 0;
BEGIN
  WITH map AS (
    SELECT pc.render_id, min(pe.id) AS edition_id
    FROM public.pinnacle_catalog pc
    JOIN public.pinnacle_editions pe ON pe.edition_key = pc.legacy_edition_key
    WHERE pc.legacy_edition_key IS NOT NULL
    GROUP BY pc.render_id
    HAVING count(DISTINCT pe.id) = 1
  ),
  upd AS (
    UPDATE public.pinnacle_sales ps
       SET edition_id = m.edition_id
      FROM map m
     WHERE ps.edition_id IS NULL
       AND ps.render_id = m.render_id
    RETURNING ps.id, ps.render_id, ps.edition_id
  ),
  aud AS (
    INSERT INTO public.audit_20260716_pinnacle_render_bridge (sale_id, render_id, new_edition_id)
    SELECT id, render_id, edition_id FROM upd
    ON CONFLICT (sale_id) DO NOTHING
    RETURNING 1
  )
  SELECT count(*)::int INTO v_total FROM aud;
  RETURN v_total;
END;
$function$;

CREATE OR REPLACE FUNCTION public.refresh_allday_badge_low_ask()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '60s'
AS $function$
DECLARE
  v_coll uuid := 'dee28451-5d62-409e-a1ad-a83f763ac070';
  v_start timestamptz := clock_timestamp();
  v_updated int := 0;
  v_cleared int := 0;
BEGIN
  WITH src AS (
    SELECT e.external_id, afa.floor_ask
    FROM allday_edition_floor_ask afa
    JOIN editions e ON e.id = afa.edition_id AND e.collection_id = v_coll
    WHERE afa.floor_ask > 0
  ),
  upd AS (
    UPDATE badge_editions be
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
    FROM allday_edition_floor_ask afa
    JOIN editions e ON e.id = afa.edition_id AND e.collection_id = v_coll
    WHERE afa.floor_ask > 0
  ),
  cl AS (
    UPDATE badge_editions be
    SET low_ask = NULL, updated_at = now()
    WHERE be.collection_id = v_coll
      AND be.low_ask IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM present p WHERE p.external_id = be.external_id)
    RETURNING 1
  )
  SELECT count(*) INTO v_cleared FROM cl;

  INSERT INTO pipeline_runs (pipeline, collection_slug, started_at, finished_at, rows_written, ok, extra)
  VALUES ('allday-badge-low-ask-refresh', 'nfl_all_day', v_start, clock_timestamp(),
          v_updated + v_cleared, true,
          jsonb_build_object('updated', v_updated, 'cleared', v_cleared));
EXCEPTION WHEN OTHERS THEN
  INSERT INTO pipeline_runs (pipeline, collection_slug, started_at, finished_at, ok, error)
  VALUES ('allday-badge-low-ask-refresh', 'nfl_all_day', v_start, clock_timestamp(), false, SQLERRM);
  RAISE;
END;
$function$;

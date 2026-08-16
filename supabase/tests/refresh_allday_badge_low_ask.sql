-- DB invariant: public.refresh_allday_badge_low_ask — pg_cron
-- `rpc-allday-badge-low-ask-refresh` @ `*/30 * * * *`.
--
-- WHAT IT DOES. Two phases against `badge_editions.low_ask` for NFL All Day:
--   1. WRITE   the current floor ask for every edition that has one.
--   2. ⚠ CLEAR low_ask to NULL for every edition that no longer has one.
--
-- ⚠ PHASE 2 IS THE HALF THAT IS EASY TO DROP AND EXPENSIVE TO LOSE. A low_ask
-- left behind after its listing is gone is a PRICE THAT NO LONGER EXISTS, shown
-- as current on a badge surface. It fails in the reassuring direction — the
-- number looks fine, it is simply no longer true — so nothing downstream
-- reports it. A refactor that keeps only the write phase passes any test that
-- checks "does it write the right price".
--
-- THE OTHER PROPERTIES:
--   • `low_ask IS DISTINCT FROM src.floor_ask` — change-detection, so an
--     unchanged edition is not rewritten. That is what keeps `updated_at`
--     meaningful as "when this price last MOVED" rather than "when the cron last
--     ran"; without it every row's updated_at is refreshed every 30 minutes and
--     the column stops carrying information.
--     ⚠ IS DISTINCT FROM, not `<>` — `<>` is NULL against a NULL low_ask, so a
--     first-time write would be skipped entirely.
--   • `floor_ask > 0` — a zero ask is not a price. It is excluded from BOTH
--     phases, which means a zero-ask edition is treated as having no ask and is
--     CLEARED, not written as 0.
--   • Scoped to the All Day collection_id on both the join and the update.
--   • It logs its own `pipeline_runs` row with updated/cleared counts.
--
-- ⚠ RECORDED, NOT FIXED — ITS FAILURE HANDLER CANNOT FIRE ON A TIMEOUT.
-- The `EXCEPTION WHEN OTHERS` block exists to log an `ok:false` row, but
-- PostgreSQL excludes QUERY_CANCELED from OTHERS, and this function declares
-- `statement_timeout = 60s`. So a timeout — the realistic failure on a
-- saturated instance — skips the failure INSERT entirely and the tick leaves NO
-- pipeline_runs row at all, which is indistinguishable from "never scheduled".
-- This is the same defect CLAUDE.md documents on the trust-precompute legs,
-- where the 999 sentinel has never once fired. Not changed here: catching the
-- cancel without re-arming the timer trades a bounded failure for an unbounded
-- one, exactly as recorded there. The test below pins the SUCCESS-path logging
-- so that, if the handler is ever reworked, the working half is protected.
--
-- The function DDL below is VERBATIM from the committed snapshot migration
-- (supabase/migrations/20260816020000_audit_20260816_snapshot_pinnacle_bridge_and_allday_badge_low_ask.sql),
-- pulled from live prod via pg_get_functiondef on 2026-08-16
-- (md5 064d096289b8827d310ae76d289160cb).
-- __tests__/db-invariants-drift-guard.test.ts fails CI on drift.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE public.editions (
  id            uuid,
  external_id   text,
  collection_id uuid
);

CREATE TABLE public.allday_edition_floor_ask (
  edition_id uuid,
  floor_ask  numeric
);

CREATE TABLE public.badge_editions (
  collection_id uuid,
  external_id   text,
  low_ask       numeric,
  updated_at    timestamptz
);

CREATE TABLE public.pipeline_runs (
  pipeline        text,
  collection_slug text,
  started_at      timestamptz,
  finished_at     timestamptz,
  rows_written    int,
  ok              boolean,
  error           text,
  extra           jsonb
);

-- >>> BEGIN verbatim refresh_allday_badge_low_ask (byte-identical to the migration/prod) >>>
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
-- <<< END verbatim refresh_allday_badge_low_ask <<<

\set AD '''dee28451-5d62-409e-a1ad-a83f763ac070'''
\set TS '''95f28a17-224a-4025-96ad-adf8a4c63bfd'''
\set e1 '''cccccccc-0000-0000-0000-000000000001'''
\set e2 '''cccccccc-0000-0000-0000-000000000002'''
\set e3 '''cccccccc-0000-0000-0000-000000000003'''
\set e4 '''cccccccc-0000-0000-0000-000000000004'''
\set e5 '''cccccccc-0000-0000-0000-000000000005'''

INSERT INTO public.editions (id, external_id, collection_id) VALUES
  (:e1::uuid, 'AD-1', :AD::uuid),   -- new ask         -> written
  (:e2::uuid, 'AD-2', :AD::uuid),   -- ask disappeared -> CLEARED
  (:e3::uuid, 'AD-3', :AD::uuid),   -- ask unchanged   -> not rewritten
  (:e4::uuid, 'AD-4', :AD::uuid),   -- ask is 0        -> treated as none, CLEARED
  (:e5::uuid, 'TS-1', :TS::uuid);   -- another collection -> untouched

INSERT INTO public.allday_edition_floor_ask (edition_id, floor_ask) VALUES
  (:e1::uuid, 12.50),
  (:e3::uuid, 30.00),
  (:e4::uuid, 0),
  (:e5::uuid, 99.00);

INSERT INTO public.badge_editions (collection_id, external_id, low_ask, updated_at) VALUES
  (:AD::uuid, 'AD-1', NULL,  '2026-01-01T00:00:00Z'),
  (:AD::uuid, 'AD-2', 44.00, '2026-01-01T00:00:00Z'),
  (:AD::uuid, 'AD-3', 30.00, '2026-01-01T00:00:00Z'),
  (:AD::uuid, 'AD-4', 77.00, '2026-01-01T00:00:00Z'),
  (:TS::uuid, 'TS-1', 55.00, '2026-01-01T00:00:00Z');

SELECT public.refresh_allday_badge_low_ask();

SELECT _assert_eq(
  (SELECT low_ask::text FROM public.badge_editions WHERE external_id = 'AD-1'), '12.50',
  'a new floor ask is written'
);

-- ⚠ PHASE 2, the half that is easy to drop. A stale low_ask is a price that no
-- longer exists, displayed as current — and it fails in the reassuring
-- direction, so nothing downstream reports it.
SELECT _assert_eq(
  (SELECT coalesce(low_ask::text, 'NULL') FROM public.badge_editions WHERE external_id = 'AD-2'),
  'NULL',
  'an edition whose ask disappeared is CLEARED, not left stale'
);

SELECT _assert_eq(
  (SELECT coalesce(low_ask::text, 'NULL') FROM public.badge_editions WHERE external_id = 'AD-4'),
  'NULL',
  'a ZERO ask is not a price — it is excluded from both phases, so the row clears'
);

-- Change-detection: an unchanged ask must not be rewritten, or updated_at stops
-- meaning "when this price last MOVED" and becomes "when the cron last ran".
SELECT _assert_eq(
  (SELECT (updated_at = '2026-01-01T00:00:00Z')::text FROM public.badge_editions WHERE external_id = 'AD-3'),
  'true',
  'an UNCHANGED ask leaves updated_at alone'
);

SELECT _assert_eq(
  (SELECT low_ask::text FROM public.badge_editions WHERE external_id = 'TS-1'), '55.00',
  'another collection is never touched'
);

-- The run logs itself with a split of the two phases.
SELECT _assert_eq(
  (SELECT ok::text FROM public.pipeline_runs WHERE pipeline = 'allday-badge-low-ask-refresh'),
  'true',
  'the success path writes its own pipeline_runs row'
);

SELECT _assert_eq(
  (SELECT (extra->>'updated') || '/' || (extra->>'cleared')
     FROM public.pipeline_runs WHERE pipeline = 'allday-badge-low-ask-refresh'),
  '1/2',
  'and reports the two phases SEPARATELY — a combined count would hide a dead clear phase'
);

-- ── IS DISTINCT FROM, not <> ────────────────────────────────────────────────
-- ⚠ A first-time write is exactly the case `<>` gets wrong: `NULL <> 12.50` is
-- NULL, not TRUE, so the row would never be written and the edition would sit
-- with no ask forever while the job reported success. AD-1 above starts NULL and
-- is written, which is what pins this — stated here because the reason is
-- invisible from the assertion alone.
SELECT _assert_eq(
  (SELECT (low_ask IS NOT NULL)::text FROM public.badge_editions WHERE external_id = 'AD-1'),
  'true',
  'a NULL -> value transition is written (IS DISTINCT FROM, not <>)'
);

-- ── A second run is a no-op ─────────────────────────────────────────────────
DELETE FROM public.pipeline_runs;
SELECT public.refresh_allday_badge_low_ask();

SELECT _assert_eq(
  (SELECT (extra->>'updated') || '/' || (extra->>'cleared')
     FROM public.pipeline_runs WHERE pipeline = 'allday-badge-low-ask-refresh'),
  '0/0',
  'a second run with unchanged inputs writes nothing — it runs every 30 minutes'
);

ROLLBACK;

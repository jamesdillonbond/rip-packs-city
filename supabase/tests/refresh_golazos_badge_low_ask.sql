-- DB invariant: public.refresh_golazos_badge_low_ask — pg_cron
-- `rpc-golazos-badge-low-ask-refresh` @ `10,40 * * * *`.
--
-- ⚠ WHY THIS IS NOT JUST "THE ALLDAY ONE WITH A DIFFERENT UUID". It is the same
-- two-phase write/clear shape as refresh_allday_badge_low_ask, plus ONE EXTRA
-- STEP that is the entire reason it gets its own pin: it calls
-- `resolve_golazos_listing_edition_ids()` FIRST, self-healing `edition_id` on
-- newly indexed listings BEFORE reading the floor-ask view.
--
-- That ordering is load-bearing. `golazos_edition_floor_ask` joins on
-- `edition_id`, so a freshly indexed listing whose edition_id is still NULL is
-- INVISIBLE to it — the ask never reaches the badge, and the edition reads as
-- having no ask while a live listing sits on the marketplace. Running the
-- resolve AFTER the read, or dropping it, produces exactly that: a silently
-- incomplete surface with the job still reporting ok. Same class as the Pinnacle
-- NULL-edition_id gap in deep-audit R4.
--
-- ⚠ CONTEXT A FUTURE SESSION NEEDS BEFORE "FIXING" THE COVERAGE. CLAUDE.md
-- records Golazos low_ask at ~37%, and that the ceiling is LISTING-GATED — only
-- editions with a live Flowty floor get an ask. That is not a bug and a second
-- cron will not raise it. This function IS that one cron.
--
-- THE OTHER PROPERTIES (shared with the AllDay sibling, asserted here too
-- because the two functions are separate code and can drift apart):
--   • the CLEAR phase — a stale low_ask is a price that NO LONGER EXISTS shown
--     as current, and it fails in the reassuring direction.
--   • a zero ask is not a price: it is excluded from BOTH phases, so such a row
--     CLEARS rather than publishing 0.
--     ⚠ But the function's own `floor_ask > 0` is REDUNDANT and is deliberately
--     NOT asserted. Live `golazos_edition_floor_ask` already carries
--     `price_usd > 0` (verified against pg_get_viewdef 2026-08-16), so a zero ask
--     cannot reach the function at all — relaxing the clause to `>= 0` changes
--     nothing, as a mutation confirmed. The stand-in view below reproduces the
--     real filter, so the assertion pins the END-TO-END behaviour via the layer
--     that actually enforces it. Contriving a fixture that reaches the function's
--     clause would mean asserting a state the view cannot produce. It becomes
--     load-bearing again the moment that view stops filtering.
--   • `IS DISTINCT FROM`, not `<>` — `NULL <> 1.25` is NULL, so `<>` would skip
--     every first-time write while reporting success.
--   • the run reports `updated` / `cleared` / `listing_edition_ids_resolved`
--     SEPARATELY; a combined count would hide a dead clear phase or a dead
--     resolve step.
--
-- ⚠ Same caveat as the sibling, recorded and deliberately NOT changed: the
-- `EXCEPTION WHEN OTHERS` handler cannot fire on a statement timeout, because
-- PostgreSQL excludes QUERY_CANCELED from OTHERS. A timeout leaves NO
-- pipeline_runs row at all — indistinguishable from "never scheduled".
--
-- ⚠ `resolve_golazos_listing_edition_ids` below is a TEST STAND-IN, not the real
-- function — that one has its own pin in
-- supabase/tests/resolve_golazos_listing_edition_ids.sql. It is deliberately
-- OBSERVABLE (it fills a NULL edition_id from a map table and returns the count)
-- so the ORDERING can be asserted: if it ran after the read, or not at all, the
-- newly indexed listing below would never reach the badge.
--
-- The function DDL below is VERBATIM from the committed snapshot migration
-- (supabase/migrations/20260816030000_audit_20260816_snapshot_refresh_golazos_badge_low_ask.sql),
-- pulled from live prod via pg_get_functiondef on 2026-08-16
-- (md5 b01f4f4eaec7cda3ddfce710ab7cfd9d).
-- __tests__/db-invariants-drift-guard.test.ts fails CI on drift.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE public.editions (
  id            uuid,
  external_id   text,
  collection_id uuid
);

-- Stands in for the listing table the real resolver heals.
CREATE TABLE public.golazos_listings (
  listing_id  text,
  edition_key text,
  edition_id  uuid,
  floor_ask   numeric
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

-- The floor-ask view the function reads. Two properties of the LIVE view are
-- reproduced deliberately (checked against pg_get_viewdef 2026-08-16):
--   • it keys on edition_id — which is exactly why an unresolved listing is
--     invisible to it, the whole point of the self-heal ordering below;
--   • it already filters `price_usd > 0`, which is what makes the function's own
--     `floor_ask > 0` redundant (see the header).
CREATE VIEW public.golazos_edition_floor_ask AS
  SELECT edition_id, min(floor_ask) AS floor_ask
  FROM public.golazos_listings
  WHERE edition_id IS NOT NULL AND floor_ask > 0
  GROUP BY edition_id;

-- ⚠ TEST STAND-IN — NOT the pinned production function. Deliberately observable.
CREATE OR REPLACE FUNCTION public.resolve_golazos_listing_edition_ids()
RETURNS integer LANGUAGE plpgsql AS $stub$
DECLARE n integer;
BEGIN
  WITH fixed AS (
    UPDATE public.golazos_listings gl
       SET edition_id = e.id
      FROM public.editions e
     WHERE gl.edition_id IS NULL
       AND e.external_id = gl.edition_key
    RETURNING 1
  )
  SELECT count(*)::int INTO n FROM fixed;
  RETURN n;
END $stub$;

-- >>> BEGIN verbatim refresh_golazos_badge_low_ask (byte-identical to the migration/prod) >>>
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
-- <<< END verbatim refresh_golazos_badge_low_ask <<<

\set GZ '''06248cc4-b85f-47cd-af67-1855d14acd75'''
\set TS '''95f28a17-224a-4025-96ad-adf8a4c63bfd'''
\set e1 '''dddddddd-0000-0000-0000-000000000001'''
\set e2 '''dddddddd-0000-0000-0000-000000000002'''
\set e3 '''dddddddd-0000-0000-0000-000000000003'''
\set e4 '''dddddddd-0000-0000-0000-000000000004'''
\set e5 '''dddddddd-0000-0000-0000-000000000005'''

INSERT INTO public.editions (id, external_id, collection_id) VALUES
  (:e1::uuid, 'GZ-1', :GZ::uuid),   -- NEWLY INDEXED listing, edition_id NULL
  (:e2::uuid, 'GZ-2', :GZ::uuid),   -- ask disappeared  -> CLEARED
  (:e3::uuid, 'GZ-3', :GZ::uuid),   -- ask unchanged    -> not rewritten
  (:e4::uuid, 'GZ-4', :GZ::uuid),   -- ask is 0         -> CLEARED
  (:e5::uuid, 'TS-1', :TS::uuid);   -- another collection

INSERT INTO public.golazos_listings (listing_id, edition_key, edition_id, floor_ask) VALUES
  -- ⚠ THE ONE THAT MATTERS: indexed but not yet resolved. Invisible to the view
  -- until the self-heal runs.
  ('L1', 'GZ-1', NULL,       8.25),
  ('L3', 'GZ-3', :e3::uuid, 30.00),
  ('L4', 'GZ-4', :e4::uuid,  0),
  ('L5', 'TS-1', :e5::uuid, 99.00);

-- ⚠ The last two rows are the point of the collection scope, and without them
-- the scope guard is UNOBSERVABLE (a mutation dropping `be.collection_id =
-- v_coll` from both phases passed until they were added). `editions.external_id`
-- is NOT unique across collections — CLAUDE.md states it outright — so a Top Shot
-- badge row can legitimately carry the same external_id as a Golazos one. An
-- unscoped write would stamp a GOLAZOS ask onto a TOP SHOT badge, and an
-- unscoped clear would wipe a Top Shot ask that is perfectly current. Both are
-- silent: the number stays plausible, it is simply another collection's.
INSERT INTO public.badge_editions (collection_id, external_id, low_ask, updated_at) VALUES
  (:GZ::uuid, 'GZ-1', NULL,  '2026-01-01T00:00:00Z'),
  (:GZ::uuid, 'GZ-2', 44.00, '2026-01-01T00:00:00Z'),
  (:GZ::uuid, 'GZ-3', 30.00, '2026-01-01T00:00:00Z'),
  (:GZ::uuid, 'GZ-4', 77.00, '2026-01-01T00:00:00Z'),
  (:TS::uuid, 'TS-1', 55.00, '2026-01-01T00:00:00Z'),
  (:TS::uuid, 'GZ-1', 999.00, '2026-01-01T00:00:00Z'),   -- colliding key, WRITE phase
  (:TS::uuid, 'GZ-2', 888.00, '2026-01-01T00:00:00Z');   -- colliding key, CLEAR phase

SELECT public.refresh_golazos_badge_low_ask();

-- ── THE SELF-HEAL ORDERING, the property unique to this function ────────────
-- ⚠ If the resolve ran AFTER the read (or not at all), GZ-1's listing would
-- still have a NULL edition_id when the view was queried, the ask would never
-- reach the badge, and the edition would read as having NO ASK while a live
-- 8.25 listing sat on the marketplace — with the job reporting ok.
SELECT _assert_eq(
  (SELECT coalesce(low_ask::text, 'NULL') FROM public.badge_editions
    WHERE collection_id = :GZ::uuid AND external_id = 'GZ-1'),
  '8.25',
  'a NEWLY INDEXED listing reaches the badge in the SAME tick — the resolve runs FIRST'
);

SELECT _assert_eq(
  (SELECT extra->>'listing_edition_ids_resolved'
     FROM public.pipeline_runs WHERE pipeline = 'golazos-badge-low-ask-refresh'),
  '1',
  'the resolve step is reported separately — a dead one would otherwise be invisible'
);

-- ── The shared two-phase behaviour (separate code from the AllDay sibling) ──
SELECT _assert_eq(
  (SELECT coalesce(low_ask::text, 'NULL') FROM public.badge_editions
    WHERE collection_id = :GZ::uuid AND external_id = 'GZ-2'),
  'NULL',
  'an edition whose ask disappeared is CLEARED, not left stale'
);

SELECT _assert_eq(
  (SELECT coalesce(low_ask::text, 'NULL') FROM public.badge_editions
    WHERE collection_id = :GZ::uuid AND external_id = 'GZ-4'),
  'NULL',
  'a ZERO ask is not a price — excluded from both phases, so the row clears'
);

SELECT _assert_eq(
  (SELECT (updated_at = '2026-01-01T00:00:00Z')::text FROM public.badge_editions
    WHERE collection_id = :GZ::uuid AND external_id = 'GZ-3'),
  'true',
  'an UNCHANGED ask leaves updated_at alone (change-detection)'
);

SELECT _assert_eq(
  (SELECT low_ask::text FROM public.badge_editions WHERE external_id = 'TS-1'), '55.00',
  'another collection is never touched'
);

-- ── The collection scope, on BOTH phases ────────────────────────────────────
SELECT _assert_eq(
  (SELECT low_ask::text FROM public.badge_editions
    WHERE collection_id = :TS::uuid AND external_id = 'GZ-1'),
  '999.00',
  'a COLLIDING external_id in another collection is not overwritten by the write phase'
);

SELECT _assert_eq(
  (SELECT coalesce(low_ask::text, 'NULL') FROM public.badge_editions
    WHERE collection_id = :TS::uuid AND external_id = 'GZ-2'),
  '888.00',
  '...and not wiped by the clear phase either — its ask is current, just not ours'
);

SELECT _assert_eq(
  (SELECT (extra->>'updated') || '/' || (extra->>'cleared')
     FROM public.pipeline_runs WHERE pipeline = 'golazos-badge-low-ask-refresh'),
  '1/2',
  'the phases are reported separately — a combined count would hide a dead clear phase'
);

-- ── A second run is a no-op ─────────────────────────────────────────────────
DELETE FROM public.pipeline_runs;
SELECT public.refresh_golazos_badge_low_ask();

SELECT _assert_eq(
  (SELECT (extra->>'updated') || '/' || (extra->>'cleared') || '/' || (extra->>'listing_edition_ids_resolved')
     FROM public.pipeline_runs WHERE pipeline = 'golazos-badge-low-ask-refresh'),
  '0/0/0',
  'a second run with unchanged inputs writes nothing and resolves nothing'
);

ROLLBACK;

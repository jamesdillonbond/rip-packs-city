-- DB invariant: public.raise_impossible_parallel_circ() — the TopShot parallel
-- circulation self-heal. It corrects editions whose recorded circulation_count is
-- below a serial number that has actually SOLD (an impossible, scarcity-inflating
-- state), by raising circulation to the max sold serial. The load-bearing
-- properties: (a) scoped to TopShot PARALLEL editions only (external_id ~ '::'),
-- (b) MONOTONIC — it only ever raises, never lowers, and (c) every raise is
-- audited. A regression here would silently mutate circulation on the wrong
-- editions, poisoning FMV and pack-EV.
--
-- 🚨 RE-POINTED 2026-09-11 (register #82). Until today EVERY assertion in this file
-- was about what the function must NOT touch, and NOT ONE asserted that a raise
-- SURVIVED — so the file guarded BLAST RADIUS and was structurally silent about
-- EFFICACY. It passed while the function did nothing in production: a BEFORE trigger
-- reverts the raise in the same statement for 185 of the 188 editions it has ever
-- claimed to heal, and this fixture had neither that trigger nor the `badge_editions`
-- table it reads. ⭐ A verbatim-copy pin inherits its FIXTURE'S world, not production's.
-- Both objects now exist below (as a labelled stand-in), e5 exercises the revert path,
-- and the function reports `attempted` / `raised` / `reverted_by_trigger` so a reverted
-- attempt can no longer be logged as a repair. The audit-row count is now the
-- anti-fabrication assertion and it can genuinely fail.
--
-- The function DDL below is a VERBATIM copy of the committed migration
-- (supabase/migrations/20260911103459_impossible_parallel_selfheal_audits_only_raises_that_survived.sql),
-- verified byte-exact against live prod on 2026-09-11;
-- __tests__/db-invariants-drift-guard.test.ts fails CI if this copy drifts from it.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE editions (
  id               uuid PRIMARY KEY,
  external_id      text,
  circulation_count integer,
  collection_id    uuid,
  last_updated_at  timestamptz
);
CREATE TABLE sales (
  edition_id    uuid,
  serial_number integer
);
CREATE TABLE impossible_parallel_circ_raises (
  edition_id  uuid,
  external_id text,
  old_circ    integer,
  new_circ    integer
);

-- ─────────────────────────────────────────────────────────────────────────────
-- ⚠ ADDED 2026-09-11 (register #82) — WITHOUT THESE TWO OBJECTS THIS FILE WAS
-- STRUCTURALLY INCAPABLE OF FAILING ON THE DEFECT IT NOW PINS.
--
-- In production a BEFORE trigger, `trg_topshot_normalize_base_club_circulation`,
-- fires on every `editions` write and for a Top Shot PARALLEL overwrites
-- circulation from `badge_editions` — "Atlas is the only per-printing authority,
-- in both directions". So the self-heal's UPDATE is REVERTED inside the same
-- statement for every parallel that has an Atlas row: 185 of the 188 editions it
-- has ever claimed to raise. Measured live and rolled back:
--     before=99 | wrote=140 | after_trigger=99 | badge_editions_atlas=99
--
-- This fixture previously had NEITHER table NOR trigger, so it validated the
-- function in a world where the thing that breaks it does not exist — it asserted
-- `raised = 1` and passed, while production raised nothing. ⭐ Every assertion it
-- carried was about what the function must NOT touch (non-parallels, other
-- collections, within-circ rows); NOT ONE asserted that a raise SURVIVED. It
-- guarded BLAST RADIUS and was silent about EFFICACY.
--
-- ⚠ THIS IS A STAND-IN, NOT THE PRODUCTION TRIGGER. It reproduces only the
-- parallel branch — the one this function collides with — because the real
-- function also calls `topshot_normalize_circulation()` and handles base rows,
-- neither of which is under test here. If the production trigger's PARALLEL
-- behaviour changes, change this with it; the behaviour it encodes is quoted
-- above so a reader can check it against `pg_proc` without leaving this file.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE badge_editions (
  collection_id     uuid,
  external_id       text,
  circulation_count integer
);

CREATE FUNCTION _stand_in_normalize_parallel_circ() RETURNS trigger
LANGUAGE plpgsql AS $trg$
DECLARE v_atlas integer;
BEGIN
  IF NEW.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid
     AND NEW.external_id ~ '::' THEN
    SELECT be.circulation_count INTO v_atlas
      FROM badge_editions be
     WHERE be.collection_id = NEW.collection_id
       AND be.external_id   = NEW.external_id
       AND be.circulation_count IS NOT NULL
       AND be.circulation_count > 0;
    IF v_atlas IS NOT NULL THEN
      NEW.circulation_count := v_atlas;   -- Atlas wins, in both directions
    END IF;
  END IF;
  RETURN NEW;
END $trg$;

CREATE TRIGGER _stand_in_normalize_parallel_circ
BEFORE INSERT OR UPDATE ON editions
FOR EACH ROW EXECUTE FUNCTION _stand_in_normalize_parallel_circ();

-- >>> BEGIN verbatim raise_impossible_parallel_circ (keep byte-identical to the migration) >>>
CREATE OR REPLACE FUNCTION public.raise_impossible_parallel_circ()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '120s'
AS $function$
DECLARE
  v_attempted int := 0;
  v_raised    int := 0;
BEGIN
  WITH offenders AS (
    SELECT e.id, e.external_id, e.circulation_count AS old_circ,
           max(s.serial_number)::int AS new_circ
    FROM public.editions e
    JOIN public.sales s ON s.edition_id = e.id
    WHERE e.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
      AND e.external_id ~ '::'
      AND e.circulation_count > 0
      AND s.serial_number > e.circulation_count
    GROUP BY e.id, e.external_id, e.circulation_count
  ),
  upd AS (
    UPDATE public.editions e
       SET circulation_count = o.new_circ,
           last_updated_at   = now()
      FROM offenders o
     WHERE e.id = o.id
       AND o.new_circ > e.circulation_count   -- MONOTONIC: raise only
    RETURNING e.id, o.external_id, o.old_circ, o.new_circ,
              e.circulation_count AS stored_circ
  ),
  aud AS (
    -- Only a raise that SURVIVED the BEFORE trigger is audited. RETURNING above
    -- reports the row as actually STORED, so stored_circ <> new_circ means the
    -- write was reverted inside the same statement and nothing happened.
    INSERT INTO public.impossible_parallel_circ_raises (edition_id, external_id, old_circ, new_circ)
    SELECT id, external_id, old_circ, new_circ FROM upd
     WHERE stored_circ IS NOT DISTINCT FROM new_circ
    RETURNING 1
  )
  SELECT count(*)::int,
         count(*) FILTER (WHERE stored_circ IS NOT DISTINCT FROM new_circ)::int
    INTO v_attempted, v_raised
  FROM upd;

  RETURN jsonb_build_object(
    'raised',              v_raised,
    'attempted',           v_attempted,
    'reverted_by_trigger', v_attempted - v_raised,
    'at',                  now());
END;
$function$;
-- <<< END verbatim raise_impossible_parallel_circ <<<

-- TopShot collection id the function hard-codes.
-- e1: TS parallel, circ 10, a serial 25 sold → must raise to 25 + audit.
INSERT INTO editions VALUES ('11111111-1111-1111-1111-111111111111', '100:200::3', 10, '95f28a17-224a-4025-96ad-adf8a4c63bfd', NULL);
INSERT INTO sales VALUES ('11111111-1111-1111-1111-111111111111', 25),
                         ('11111111-1111-1111-1111-111111111111', 8);
-- e2: TS NON-parallel (no '::'), circ 5, serial 30 sold → must be LEFT ALONE
--     (the '::' scope guard). This is the key false-positive guard.
INSERT INTO editions VALUES ('22222222-2222-2222-2222-222222222222', '100:200', 5, '95f28a17-224a-4025-96ad-adf8a4c63bfd', NULL);
INSERT INTO sales VALUES ('22222222-2222-2222-2222-222222222222', 30);
-- e3: parallel in a DIFFERENT collection, serial 40 > circ 5 → LEFT ALONE.
INSERT INTO editions VALUES ('33333333-3333-3333-3333-333333333333', '1:2::9', 5, '06248cc4-b85f-47cd-af67-1855d14acd75', NULL);
INSERT INTO sales VALUES ('33333333-3333-3333-3333-333333333333', 40);
-- e4: TS parallel where every serial <= circ → NOT an offender, untouched.
INSERT INTO editions VALUES ('44444444-4444-4444-4444-444444444444', '7:8::1', 50, '95f28a17-224a-4025-96ad-adf8a4c63bfd', NULL);
INSERT INTO sales VALUES ('44444444-4444-4444-4444-444444444444', 12),
                         ('44444444-4444-4444-4444-444444444444', 50);
-- e5 (2026-09-11, #82): TS parallel, circ 10, serial 30 sold — an offender by every
-- test above — but it HAS an Atlas authority row, so the BEFORE trigger overwrites the
-- raise back to 10 inside the same statement. ⭐ THIS IS WHAT 185 OF THE 188 EDITIONS IN
-- PRODUCTION LOOK LIKE, and before today no fixture here had one.
INSERT INTO editions VALUES ('55555555-5555-5555-5555-555555555555', '200:300::4', 10, '95f28a17-224a-4025-96ad-adf8a4c63bfd', NULL);
INSERT INTO sales   VALUES ('55555555-5555-5555-5555-555555555555', 30);
INSERT INTO badge_editions VALUES ('95f28a17-224a-4025-96ad-adf8a4c63bfd', '200:300::4', 10);

-- ── The three-way report, which is the whole point of the 2026-09-11 change ──
-- Before it, `raised` counted UPDATEs ATTEMPTED and the audit row was written from
-- the PRE-trigger value, so BOTH said "2 raised" here and both would have been wrong.
--
-- ⚠ ONE run, captured. The function is not idempotent across calls by design (it
-- heals e1, so a second call finds only e5 still offending) — asserting each key
-- with its own `raise_impossible_parallel_circ()` call would read three DIFFERENT
-- runs and quietly pass on the wrong numbers.
CREATE TEMP TABLE _run1 AS SELECT raise_impossible_parallel_circ() AS j;
SELECT _assert_eq((SELECT j->>'raised' FROM _run1), '1',
  'only the raise that SURVIVED the trigger counts as raised (e1)');
SELECT _assert_eq((SELECT j->>'attempted' FROM _run1), '2',
  'both offenders are still ATTEMPTED — the change narrowed the REPORT, not the work');
SELECT _assert_eq((SELECT j->>'reverted_by_trigger' FROM _run1), '1',
  'and the one the BEFORE trigger reverted is REPORTED, not counted as a success');

-- e5 keeps Atlas's circulation: the self-heal cannot move a parallel the trigger owns.
SELECT _assert_eq((SELECT circulation_count::text FROM editions WHERE id='55555555-5555-5555-5555-555555555555'),
  '10', 'e5 circulation is unchanged — the BEFORE trigger reverted the raise in-statement');

-- e1 raised to the max sold serial.
SELECT _assert_eq((SELECT circulation_count::text FROM editions WHERE id='11111111-1111-1111-1111-111111111111'),
  '25', 'e1 circ raised to max serial 25');
-- e2 (non-parallel) untouched.
SELECT _assert_eq((SELECT circulation_count::text FROM editions WHERE id='22222222-2222-2222-2222-222222222222'),
  '5', 'e2 non-parallel untouched');
-- e3 (other collection) untouched.
SELECT _assert_eq((SELECT circulation_count::text FROM editions WHERE id='33333333-3333-3333-3333-333333333333'),
  '5', 'e3 other-collection untouched');
-- e4 (no serial exceeds circ) untouched.
SELECT _assert_eq((SELECT circulation_count::text FROM editions WHERE id='44444444-4444-4444-4444-444444444444'),
  '50', 'e4 within-circ untouched');

-- ⭐ THE ANTI-FABRICATION ASSERTION, and since 2026-09-11 it can actually fail.
-- e5 was ATTEMPTED and reverted; the pre-2026-09-11 function wrote its audit row from
-- the PRE-trigger CTE value, so it would log TWO raises here and claim one that never
-- happened. In production that is how 274 rows accumulated across 188 editions while
-- 168 of them are not reflected in the data at all. ONE row is the honest answer.
SELECT _assert_eq((SELECT count(*)::text FROM impossible_parallel_circ_raises), '1',
  'ONLY the surviving raise is audited — a reverted attempt must leave NO row, or the '
  'audit table becomes a repair log of repairs that never happened');
SELECT _assert_eq((SELECT count(*)::text FROM impossible_parallel_circ_raises
                    WHERE edition_id='55555555-5555-5555-5555-555555555555'), '0',
  'and specifically NOT the reverted one — the control for the assertion above');
SELECT _assert_eq(
  (SELECT old_circ::text || '->' || new_circ::text FROM impossible_parallel_circ_raises WHERE edition_id='11111111-1111-1111-1111-111111111111'),
  '10->25', 'audit captured old→new');

-- A second run: e1 is healed, but e5 STILL offends and is STILL reverted — so `raised`
-- is 0 while `attempted` stays 1. ⚠ Before this change both read 1 and the run looked
-- productive forever; that is exactly the 6-hourly loop 270:8973::17 has been stuck in
-- since 09-09, logging old_circ = 99 eleven consecutive times.
CREATE TEMP TABLE _run2 AS SELECT raise_impossible_parallel_circ() AS j;
SELECT _assert_eq((SELECT j->>'raised' FROM _run2), '0',
  'second run raises nothing — e1 is healed and e5 cannot be healed by this function');
SELECT _assert_eq((SELECT j->>'attempted' FROM _run2), '1',
  'but it still ATTEMPTS e5 every run — the loop is reported now, not hidden');
SELECT _assert_eq((SELECT count(*)::text FROM impossible_parallel_circ_raises), '1',
  'and the second run adds NO audit row, so the log cannot grow on a no-op');

SELECT '✓ raise_impossible_parallel_circ invariants pass' AS result;
ROLLBACK;

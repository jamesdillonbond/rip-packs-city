-- DB invariant: public.resolve_topshot_subedition_collision_knots(integer) → jsonb
-- — untangles a CONFLATION KNOT: two moments that each need the other's edition
-- at the same serial, so neither can move without transiently colliding.
--
-- This is the function the rest of the family defers TO. The other remappers all
-- detect a knot and skip it (`collisions_skipped`, `moments_deferred_conflict`);
-- this one is the only thing that resolves them, so if it silently stops working
-- the backlog grows while every other sweep keeps reporting success.
--
-- Pins:
--
--   1. THE SWAP IS REAL AND COMPLETE. X ends on Y's edition and Y on X's, with
--      both serials restored exactly (+3000000/-3000000 and +4000000/-4000000 net
--      to zero).
--   2. ⚠ THE TRANSIENT PARKS MUST BE DISTINCT. X parks at +3M and Y at +4M. Both
--      rows share the same real serial, so parking them at the SAME offset makes
--      them collide with each other mid-swap. This test creates the real
--      UNIQUE (edition_id, serial_number) index that prod relies on, which is
--      what makes that mutation fail loudly instead of passing silently — without
--      the index the offsets look interchangeable and the invariant is untestable.
--   3. THE DEFENSIVE RE-CHECK WORKS — asserted as a COMPOSITE, deliberately.
--      Its three OR'd conditions (target slot taken by a third party; X no longer
--      where we left it; Y no longer where we left it) overlap heavily: on a real
--      stale candidate all three tend to trip at once, so disabling any ONE of
--      them changes nothing while the guard as a whole still works. Mutation-
--      checked both ways — removing the whole skip IS caught. Contriving a
--      fixture that trips exactly one disjunct would require mutating state
--      mid-function, which is not reachable from a test, so this file proves the
--      guard rather than each of its clauses.
--      Candidates are materialized up front, so by
--      the time the loop reaches a row the state may have moved (a prior iteration
--      or a live pipeline). Such rows are counted as `knots_skipped`, never
--      applied to stale coordinates. A knot appears in the candidate set TWICE —
--      once as (X,Y) and once as (Y,X) — so this path is exercised on every real
--      resolution, not just in theory.
--   4. SALES AND WMC ARE MIRRORED. Neither has a (edition, serial) unique
--      constraint, so they are updated directly — but they must still follow, or
--      the three tables disagree about the same moment.
--   5. EVERY RESOLUTION IS RECORDED in topshot_collision_knot_resolutions with
--      both from/to editions — the revert path for a two-sided move.
--
-- The function DDL below is a VERBATIM copy of the committed migration
-- (supabase/migrations/20260705223000_audit_20260705_collision_knot_resolver_orchestrator_step.sql),
-- which was verified byte-identical to the LIVE prod definition on 2026-08-15;
-- __tests__/db-invariants-drift-guard.test.ts fails CI if this copy drifts from it.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE editions (
  id            uuid PRIMARY KEY,
  collection_id uuid,
  external_id   text
);

CREATE TABLE moments (
  nft_id        text,
  collection_id uuid,
  edition_id    uuid,
  serial_number integer,
  updated_at    timestamptz
);

-- ⚠ Load-bearing for property 2. Prod enforces one moment per
-- (edition, serial); without it the transient-park offsets are interchangeable
-- and the distinctness invariant cannot be observed.
CREATE UNIQUE INDEX moments_edition_serial_uq ON moments (edition_id, serial_number);

CREATE TABLE topshot_moment_subeditions (
  nft_id           text,
  subedition_id    integer,
  base_external_id text
);

CREATE TABLE sales (
  id            bigint,
  collection_id uuid,
  nft_id        text,
  edition_id    uuid
);

CREATE TABLE wallet_moments_cache (
  wallet_address text,
  collection_id  uuid,
  moment_id      text,
  edition_key    text
);

CREATE TABLE topshot_collision_knot_resolutions (
  x_nft_id          text,
  x_from_edition_id uuid,
  x_to_edition_id   uuid,
  y_nft_id          text,
  y_from_edition_id uuid,
  y_to_edition_id   uuid,
  serial_number     integer
);

-- >>> BEGIN verbatim resolve_topshot_subedition_collision_knots (keep byte-identical to the migration) >>>
CREATE OR REPLACE FUNCTION public.resolve_topshot_subedition_collision_knots(p_limit integer DEFAULT 5)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
SET statement_timeout TO '120s'
AS $function$
DECLARE
  v_ts uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  v_resolved int := 0;
  v_skipped  int := 0;
  rec record;
BEGIN
  -- Materialize candidates first (decouple selection from the in-loop mutation).
  DROP TABLE IF EXISTS _knot_cand;
  CREATE TEMP TABLE _knot_cand ON COMMIT DROP AS
  WITH cur AS (
    SELECT m.nft_id, m.serial_number AS serial_no, m.edition_id AS cur_ed,
           e.external_id AS cur_ext, split_part(e.external_id,'::',1) AS base
    FROM moments m JOIN editions e ON e.id = m.edition_id
    WHERE m.collection_id = v_ts
  ),
  xmis AS (
    SELECT c.nft_id, c.serial_no, c.cur_ed, tgt.id AS correct_ed
    FROM cur c
    JOIN topshot_moment_subeditions s
      ON s.nft_id = c.nft_id AND s.subedition_id IS NOT NULL AND s.base_external_id = c.base
    JOIN editions tgt
      ON tgt.collection_id = v_ts
     AND tgt.external_id = (CASE WHEN s.subedition_id = 0 THEN s.base_external_id
                                 ELSE s.base_external_id || '::' || s.subedition_id END)
    WHERE c.cur_ext <> (CASE WHEN s.subedition_id = 0 THEN s.base_external_id
                             ELSE s.base_external_id || '::' || s.subedition_id END)
  )
  SELECT x.nft_id AS x_nft, x.cur_ed AS x_cur_ed, x.correct_ed AS x_correct_ed, x.serial_no,
         ym.nft_id AS y_nft, ym.edition_id AS y_cur_ed, ysub.correct_ed AS y_correct_ed
  FROM xmis x
  JOIN moments ym
    ON ym.edition_id = x.correct_ed AND ym.serial_number = x.serial_no
   AND ym.nft_id <> x.nft_id AND ym.collection_id = v_ts
  JOIN LATERAL (
    SELECT tgt.id AS correct_ed
    FROM topshot_moment_subeditions s
    JOIN editions tgt
      ON tgt.collection_id = v_ts
     AND tgt.external_id = (CASE WHEN s.subedition_id = 0 THEN s.base_external_id
                                 ELSE s.base_external_id || '::' || s.subedition_id END)
    WHERE s.nft_id = ym.nft_id AND s.subedition_id IS NOT NULL
    LIMIT 1
  ) ysub ON true
  WHERE ysub.correct_ed <> x.correct_ed
    AND NOT EXISTS (
      SELECT 1 FROM moments z
      WHERE z.collection_id = v_ts AND z.edition_id = ysub.correct_ed
        AND z.serial_number = x.serial_no AND z.nft_id NOT IN (x.nft_id, ym.nft_id)
    )
  LIMIT greatest(1, p_limit);

  FOR rec IN SELECT * FROM _knot_cand LOOP
    -- Defensive re-check: state may have shifted (prior iteration / live pipeline).
    IF EXISTS (SELECT 1 FROM moments z WHERE z.collection_id = v_ts
                 AND z.edition_id = rec.y_correct_ed AND z.serial_number = rec.serial_no
                 AND z.nft_id NOT IN (rec.x_nft, rec.y_nft))
       OR NOT EXISTS (SELECT 1 FROM moments z WHERE z.collection_id = v_ts
                        AND z.nft_id = rec.x_nft AND z.edition_id = rec.x_cur_ed)
       OR NOT EXISTS (SELECT 1 FROM moments z WHERE z.collection_id = v_ts
                        AND z.nft_id = rec.y_nft AND z.edition_id = rec.y_cur_ed)
    THEN
      v_skipped := v_skipped + 1;
      CONTINUE;
    END IF;

    -- 2-move permutation via DISTINCT transient serial parks (X +3M, Y +4M): both
    -- share the real serial, so distinct parks free every real slot and each of
    -- the 6 single-row updates lands on an empty (edition_id, serial_number).
    UPDATE moments SET serial_number = serial_number + 3000000 WHERE collection_id = v_ts AND nft_id = rec.x_nft;
    UPDATE moments SET serial_number = serial_number + 4000000 WHERE collection_id = v_ts AND nft_id = rec.y_nft;
    UPDATE moments SET edition_id = rec.x_correct_ed, updated_at = now() WHERE collection_id = v_ts AND nft_id = rec.x_nft;
    UPDATE moments SET edition_id = rec.y_correct_ed, updated_at = now() WHERE collection_id = v_ts AND nft_id = rec.y_nft;
    UPDATE moments SET serial_number = serial_number - 3000000 WHERE collection_id = v_ts AND nft_id = rec.x_nft;
    UPDATE moments SET serial_number = serial_number - 4000000 WHERE collection_id = v_ts AND nft_id = rec.y_nft;

    -- Mirror sales + wmc (neither has a (edition,serial) unique constraint).
    UPDATE sales SET edition_id = rec.x_correct_ed
      WHERE collection_id = v_ts AND nft_id = rec.x_nft AND edition_id IS DISTINCT FROM rec.x_correct_ed;
    UPDATE sales SET edition_id = rec.y_correct_ed
      WHERE collection_id = v_ts AND nft_id = rec.y_nft AND edition_id IS DISTINCT FROM rec.y_correct_ed;
    UPDATE wallet_moments_cache w SET edition_key = ex.external_id
      FROM editions ex WHERE ex.id = rec.x_correct_ed
        AND w.collection_id = v_ts AND w.moment_id = rec.x_nft AND w.edition_key IS DISTINCT FROM ex.external_id;
    UPDATE wallet_moments_cache w SET edition_key = ey.external_id
      FROM editions ey WHERE ey.id = rec.y_correct_ed
        AND w.collection_id = v_ts AND w.moment_id = rec.y_nft AND w.edition_key IS DISTINCT FROM ey.external_id;

    INSERT INTO topshot_collision_knot_resolutions
      (x_nft_id, x_from_edition_id, x_to_edition_id, y_nft_id, y_from_edition_id, y_to_edition_id, serial_number)
    VALUES (rec.x_nft, rec.x_cur_ed, rec.x_correct_ed, rec.y_nft, rec.y_cur_ed, rec.y_correct_ed, rec.serial_no);

    v_resolved := v_resolved + 1;
  END LOOP;

  RETURN jsonb_build_object('knots_resolved', v_resolved, 'knots_skipped', v_skipped);
END
$function$;
-- <<< END verbatim resolve_topshot_subedition_collision_knots <<<

-- ── Fixture: one genuine knot ──────────────────────────────────────────────
-- x1 sits on the BASE but belongs on ::5; y1 sits on ::5 but belongs on the BASE.
-- They share serial 5, so neither can move first — that is the knot.
INSERT INTO editions (id, collection_id, external_id) VALUES
  ('00000000-0000-0000-0000-0000000000b1', '95f28a17-224a-4025-96ad-adf8a4c63bfd', '48:1652'),
  ('00000000-0000-0000-0000-0000000000a5', '95f28a17-224a-4025-96ad-adf8a4c63bfd', '48:1652::5');

INSERT INTO topshot_moment_subeditions (nft_id, subedition_id, base_external_id) VALUES
  ('x1', 5, '48:1652'),   -- belongs on the parallel
  ('y1', 0, '48:1652');   -- belongs on the base

INSERT INTO moments (nft_id, collection_id, edition_id, serial_number, updated_at) VALUES
  ('x1', '95f28a17-224a-4025-96ad-adf8a4c63bfd', '00000000-0000-0000-0000-0000000000b1', 5, NULL),
  ('y1', '95f28a17-224a-4025-96ad-adf8a4c63bfd', '00000000-0000-0000-0000-0000000000a5', 5, NULL);

INSERT INTO sales (id, collection_id, nft_id, edition_id) VALUES
  (1, '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'x1', '00000000-0000-0000-0000-0000000000b1'),
  (2, '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'y1', '00000000-0000-0000-0000-0000000000a5');

INSERT INTO wallet_moments_cache (wallet_address, collection_id, moment_id, edition_key) VALUES
  ('0xaaa', '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'x1', '48:1652'),
  ('0xbbb', '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'y1', '48:1652::5');

-- ── Fixture: an UNRESOLVABLE knot (third party holds Y's target slot) ──────
-- x2 (on ::7, belongs on ::5) and y2 (on ::5, belongs on the base) look like a
-- knot, but z2 already occupies the base at that serial. A 2-move swap cannot
-- free a slot a third moment holds, so the pair must be excluded outright.
--
-- ⚠ This shape is what makes the `z.nft_id NOT IN (x.nft_id, ym.nft_id)` guard
-- observable at all. In the simple knot above, the only moment at Y's target is X
-- itself — excluded by the NOT IN — so dropping the guard changes nothing there.
-- It needs X to be somewhere OTHER than Y's target, which is why this second
-- fixture exists.
INSERT INTO editions (id, collection_id, external_id) VALUES
  ('00000000-0000-0000-0000-0000000000c0', '95f28a17-224a-4025-96ad-adf8a4c63bfd', '48:3000'),
  ('00000000-0000-0000-0000-0000000000c5', '95f28a17-224a-4025-96ad-adf8a4c63bfd', '48:3000::5'),
  ('00000000-0000-0000-0000-0000000000c7', '95f28a17-224a-4025-96ad-adf8a4c63bfd', '48:3000::7');

INSERT INTO topshot_moment_subeditions (nft_id, subedition_id, base_external_id) VALUES
  ('x2', 5, '48:3000'),
  ('y2', 0, '48:3000');
-- z2 deliberately has NO subedition row, so it can never itself become a
-- candidate's Y (the LATERAL finds nothing) — it only ever acts as the blocker.

INSERT INTO moments (nft_id, collection_id, edition_id, serial_number, updated_at) VALUES
  ('x2', '95f28a17-224a-4025-96ad-adf8a4c63bfd', '00000000-0000-0000-0000-0000000000c7', 9, NULL),
  ('y2', '95f28a17-224a-4025-96ad-adf8a4c63bfd', '00000000-0000-0000-0000-0000000000c5', 9, NULL),
  ('z2', '95f28a17-224a-4025-96ad-adf8a4c63bfd', '00000000-0000-0000-0000-0000000000c0', 9, NULL);

-- ── Run ────────────────────────────────────────────────────────────────────
CREATE TEMP TABLE _res AS SELECT resolve_topshot_subedition_collision_knots(5) AS j;

-- The knot is materialized TWICE — as (x1,y1) and as (y1,x1). The first resolves
-- it; the second hits the defensive re-check and is skipped rather than applied
-- to coordinates that no longer hold.
SELECT _assert_eq((SELECT (j->>'knots_resolved') FROM _res), '1', 'the knot is resolved exactly once');
SELECT _assert_eq((SELECT (j->>'knots_skipped') FROM _res), '1', 'the mirrored candidate is SKIPPED by the defensive re-check, not applied to stale state');

-- The blocked trio is excluded at SELECTION time, so it is not even skipped — it
-- never becomes a candidate. All three keep their original editions.
SELECT _assert_eq((SELECT edition_id::text FROM moments WHERE nft_id='x2'), '00000000-0000-0000-0000-0000000000c7', 'x2 untouched — a third party holds the slot the swap would need');
SELECT _assert_eq((SELECT edition_id::text FROM moments WHERE nft_id='y2'), '00000000-0000-0000-0000-0000000000c5', 'y2 untouched');
SELECT _assert_eq((SELECT edition_id::text FROM moments WHERE nft_id='z2'), '00000000-0000-0000-0000-0000000000c0', 'the blocking third party is never disturbed');

-- 1. The swap completed and both serials are restored.
SELECT _assert_eq((SELECT edition_id::text FROM moments WHERE nft_id='x1'), '00000000-0000-0000-0000-0000000000a5', 'x1 moved to the parallel');
SELECT _assert_eq((SELECT edition_id::text FROM moments WHERE nft_id='y1'), '00000000-0000-0000-0000-0000000000b1', 'y1 moved to the base');
SELECT _assert_eq((SELECT serial_number::text FROM moments WHERE nft_id='x1'), '5', 'x1 serial restored — the +3000000 park must net to zero');
SELECT _assert_eq((SELECT serial_number::text FROM moments WHERE nft_id='y1'), '5', 'y1 serial restored — the +4000000 park must net to zero');
SELECT _assert((SELECT count(*) = 0 FROM moments WHERE serial_number > 1000000), 'no moment is left parked at a transient serial');

-- 4. sales and wmc followed.
SELECT _assert_eq((SELECT edition_id::text FROM sales WHERE id=1), '00000000-0000-0000-0000-0000000000a5', 'x1 sale mirrored to the parallel');
SELECT _assert_eq((SELECT edition_id::text FROM sales WHERE id=2), '00000000-0000-0000-0000-0000000000b1', 'y1 sale mirrored to the base');
SELECT _assert_eq((SELECT edition_key FROM wallet_moments_cache WHERE moment_id='x1'), '48:1652::5', 'x1 wmc row mirrored');
SELECT _assert_eq((SELECT edition_key FROM wallet_moments_cache WHERE moment_id='y1'), '48:1652', 'y1 wmc row mirrored');

-- 5. The resolution is recorded with BOTH sides' from/to — the revert path.
SELECT _assert_eq((SELECT count(*)::text FROM topshot_collision_knot_resolutions), '1', 'exactly one resolution row');
SELECT _assert_eq((SELECT x_from_edition_id::text FROM topshot_collision_knot_resolutions), '00000000-0000-0000-0000-0000000000b1', 'records x1 pre-swap edition');
SELECT _assert_eq((SELECT y_from_edition_id::text FROM topshot_collision_knot_resolutions), '00000000-0000-0000-0000-0000000000a5', 'records y1 pre-swap edition');
SELECT _assert_eq((SELECT serial_number::text FROM topshot_collision_knot_resolutions), '5', 'records the shared serial');

-- Idempotence: with the knot untied there is nothing left to do.
SELECT _assert_eq((resolve_topshot_subedition_collision_knots(5)->>'knots_resolved'), '0', 're-running finds no knot (the sweep is idempotent)');

SELECT '✓ resolve_topshot_subedition_collision_knots invariants pass' AS result;
ROLLBACK;

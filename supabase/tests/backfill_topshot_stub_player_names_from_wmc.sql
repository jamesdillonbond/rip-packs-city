-- DB invariant: public.backfill_topshot_stub_player_names_from_wmc — fills a Top Shot
-- edition's missing `player_name` from wallet_moments_cache, which already holds it,
-- instead of re-asking a chain that does not (37 rows written in 74,800 attempts over
-- 36 days before this shipped).
--
-- The behavior that must hold:
--   (a) 🚨 AMBIGUITY IS THE SAFETY, and it is the whole reason this test exists. Only an
--       edition_key for which wmc holds EXACTLY ONE distinct player_name is filled. On
--       edition_keys with more than one, wmc was measured 58.8% WRONG (17 subedition
--       keys checked, 10 naming a different player: "Trae Young" recorded as
--       "Alex Sarr", "John Collins" as "Matas Buzelis", "Julius Randle" as
--       "Andre Drummond"). With the filter, ZERO wrong players in 2,750 checks.
--       A multi-player play legitimately has two names; picking one is a false claim.
--   (b) it NEVER clobbers an edition that already carries a name. ⚠ What is PINNED here
--       is the CANDIDATE SCAN's filter — the assertion below is red if that filter goes.
--       The UPDATE's second `player_name IS NULL OR = ''` re-check is NOT covered, and
--       saying so is the point: deleting it leaves this file GREEN (checked, it does).
--       It cannot be covered from one session, because both halves read the same
--       snapshot — the re-check only earns its keep against a CONCURRENT writer that
--       names the edition between the scan and the write. Do not read its absence from
--       this test as permission to remove it, and do not "fix" this by asserting
--       something weaker that happens to go red.
--   (c) an EMPTY STRING counts as missing, the same as NULL.
--   (d) a blank or NULL wmc player_name is not a source, and does not make an
--       edition_key look ambiguous either.
--   (e) it is COLLECTION-SCOPED on both sides: only Top Shot editions are touched, and
--       only wmc rows under the Top Shot collection are read.
--   (f) it returns the count actually updated, and a second run is a no-op.
--
-- The function DDL below is a VERBATIM copy of the committed migration
-- (supabase/migrations/20260902092542_audit_20260902_topshot_stub_player_names_come_from_wmc_before_the_chain.sql);
-- __tests__/db-invariants-drift-guard.test.ts fails CI if this copy drifts.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE public.editions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  collection_id uuid,
  external_id text,
  player_name text
);
CREATE TABLE public.wallet_moments_cache (
  collection_id uuid,
  edition_key text,
  player_name text
);

-- '95f28a17-…' is the Top Shot collection id the function hardcodes.
-- 'bbbbbbbb-…' is a second collection, present only to prove scoping.
INSERT INTO public.editions (id, collection_id, external_id, player_name) VALUES
  ('60000000-0000-0000-0000-000000000001', '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'unambig',   NULL),
  ('60000000-0000-0000-0000-000000000002', '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'ambig',     NULL),
  ('60000000-0000-0000-0000-000000000003', '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'named',     'Real Name'),
  ('60000000-0000-0000-0000-000000000004', '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'emptystr',  ''),
  ('60000000-0000-0000-0000-000000000005', '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'nowmc',     NULL),
  ('60000000-0000-0000-0000-000000000006', '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'othercoll', NULL),
  ('60000000-0000-0000-0000-000000000007', '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'blankonly', NULL),
  ('60000000-0000-0000-0000-000000000008', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'otherednc', NULL);

INSERT INTO public.wallet_moments_cache (collection_id, edition_key, player_name) VALUES
  -- one distinct name across three holders → fillable
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'unambig',   'Alpha One'),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'unambig',   'Alpha One'),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'unambig',   'Alpha One'),
  -- ⛔ TWO distinct names → must be left alone, this is the wrong-player case
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'ambig',     'Aaa Duo'),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'ambig',     'Zzz Duo'),
  -- unambiguous AND different from the recorded name → must not clobber
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'named',     'Other Name'),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'emptystr',  'Beta Two'),
  -- the wmc row sits under a DIFFERENT collection → not a source
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'othercoll', 'Wrong Collection'),
  -- blank/NULL are not sources, and must not register as a second distinct name
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'blankonly', ''),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'blankonly', NULL),
  -- a fillable-looking row in another collection, on an edition of that collection
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'otherednc', 'Gamma Three');

-- >>> BEGIN verbatim backfill_topshot_stub_player_names_from_wmc (keep byte-identical to the migration) >>>
CREATE OR REPLACE FUNCTION public.backfill_topshot_stub_player_names_from_wmc(p_limit integer DEFAULT 1000)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
SET statement_timeout TO '60s'
AS $function$
DECLARE
  v_updated integer;
BEGIN
  WITH cand AS (
    SELECT e.id AS edition_id, w.one_name AS player_name
    FROM editions e
    JOIN LATERAL (
      -- ⛔ n_names IS THE SAFETY, NOT AN OPTIMISATION. Without it this writes a wrong
      -- player onto multi-player plays; see the three cases in the header.
      SELECT count(DISTINCT wm.player_name) AS n_names,
             min(wm.player_name)            AS one_name
      FROM wallet_moments_cache wm
      WHERE wm.collection_id = e.collection_id
        AND wm.edition_key   = e.external_id
        AND wm.player_name IS NOT NULL
        AND wm.player_name <> ''
    ) w ON true
    WHERE e.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
      AND (e.player_name IS NULL OR e.player_name = '')
      AND w.n_names = 1
    ORDER BY e.id            -- deterministic: a bare LIMIT is physical order, not a batch
    LIMIT p_limit
  )
  UPDATE editions e
     SET player_name = c.player_name
    FROM cand c
   WHERE e.id = c.edition_id
     AND (e.player_name IS NULL OR e.player_name = '');  -- never clobber a real name

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated;
END;
$function$;
-- <<< END verbatim backfill_topshot_stub_player_names_from_wmc <<<

-- (1) Exactly 2 editions are filled: `unambig` and `emptystr`. `ambig` (two names),
-- `named` (already has one), `nowmc` (no source), `othercoll` (source is in another
-- collection), `blankonly` (only blank sources) and the non-Top-Shot edition are all
-- skipped.
SELECT _assert_eq(
  public.backfill_topshot_stub_player_names_from_wmc()::text,
  '2', 'only the 2 unambiguous nameless Top Shot editions are filled');

-- (2) the values landed.
SELECT _assert_eq((SELECT player_name FROM public.editions WHERE external_id='unambig'),
  'Alpha One', 'a single distinct wmc name fills the edition');
SELECT _assert_eq((SELECT player_name FROM public.editions WHERE external_id='emptystr'),
  'Beta Two', 'an EMPTY STRING player_name counts as missing, same as NULL');

-- (3) ⛔ THE LOAD-BEARING ABSENCES. Each of these is a name the function COULD have
-- written and must not: an ambiguous key was measured 58.8% wrong, and clobbering a
-- recorded name replaces ground truth with a guess.
SELECT _assert_eq((SELECT player_name FROM public.editions WHERE external_id='ambig')::text,
  NULL, 'an edition_key with TWO distinct wmc names is left alone — never pick one');
SELECT _assert_eq((SELECT player_name FROM public.editions WHERE external_id='named'),
  'Real Name', 'an edition that already has a name is never clobbered, even by an unambiguous source');
SELECT _assert_eq((SELECT player_name FROM public.editions WHERE external_id='nowmc')::text,
  NULL, 'no wmc row means no source');
SELECT _assert_eq((SELECT player_name FROM public.editions WHERE external_id='othercoll')::text,
  NULL, 'a wmc row under another collection is not a source — the read is collection-scoped');
SELECT _assert_eq((SELECT player_name FROM public.editions WHERE external_id='blankonly')::text,
  NULL, 'blank and NULL wmc names are not sources, and do not make a key look ambiguous');
SELECT _assert_eq((SELECT player_name FROM public.editions WHERE external_id='otherednc')::text,
  NULL, 'an edition outside Top Shot is out of scope even with an unambiguous source');

-- (4) idempotent: a second run changes nothing.
SELECT _assert_eq(
  public.backfill_topshot_stub_player_names_from_wmc()::text,
  '0', 'second run is a no-op');

-- (5) p_limit bounds the batch. Re-open the two filled editions and ask for one.
UPDATE public.editions SET player_name = NULL WHERE external_id IN ('unambig','emptystr');
SELECT _assert_eq(
  public.backfill_topshot_stub_player_names_from_wmc(1)::text,
  '1', 'p_limit bounds the batch');

SELECT '✓ backfill_topshot_stub_player_names_from_wmc invariants pass' AS result;
ROLLBACK;

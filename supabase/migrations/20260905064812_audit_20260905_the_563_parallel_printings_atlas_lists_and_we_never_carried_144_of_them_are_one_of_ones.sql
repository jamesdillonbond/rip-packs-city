-- audit_20260905_the_563_parallel_printings_atlas_lists_and_we_never_carried_144_of_them_are_one_of_ones
--
-- anon-exec: creates no function. Two audit tables (RLS enabled and anon/authenticated
-- REVOKED INLINE -- see the last note) and 563 rows in public.editions.
--
-- THE OTHER HALF OF TONIGHT'S CATALOGUE GAP. Atlas lists 13,921 Top Shot editions; we
-- carried 13,436. 16 of the 579 missing were base rows (`20260905061815`); these are the
-- remaining **563 PARALLEL printings**.
--
-- ⭐ THE MEASUREMENT THAT SEPARATES THEM FROM THE 16: **ZERO of the 563 have a holder in
-- `wallet_moments_cache`.** Nobody is looking at a blank tile. That is the opposite of the
-- Ultimates, five of which were held, and it is why this is catalogue completion rather
-- than an incident.
--
-- ⭐ AND THE MEASUREMENT THAT MADE IT WORTH DOING ANYWAY -- what is missing is not a tail:
--   · 144 **Omega /1**. We carry 140 parallel one-of-ones in total, so MORE 1/1 printings
--     were missing than present.
--   ·  69 Galactic /5 · 51 Diced /10 · 41 Jukebox /10 · 32 Hexwave /25 · 20 Hardcourt /50 …
--   · 409 of the 563 carry a LIVE ASK on Top Shot right now.
--   · **306 base editions gain a parallel rung**, across 29 sets. Sets 273 and 274
--     ("Run It Back: For The Win" / "Run It Back: Origins") had **zero** rungs against
--     Atlas's six, so a Stephen Curry base Moment rendered an EMPTY parallel ladder.
--     Verified live before this ran: `/nba-top-shot/edition/274:9075` and `273:9060`
--     contained none of Omega / Galactic / Hardcourt / Hexwave / Jukebox / Blockchain.
-- Scarcity and serial premium are this product's core surfaces; a missing 1/1 printing is
-- not a cosmetic gap there.
--
-- NOTHING IS INVENTED, and each derivation was checked rather than assumed:
--   · The key already exists -- `badge_editions.external_id` is `<set>:<play>::<sub>`, so the
--     subedition id is not guessed. All 18 parallel names are ALREADY known
--     `subedition_name`s in our catalogue (563 of 563).
--   · `subedition_id` / `subedition_name` / `tier` / `circulation_count` / `team` come from
--     `badge_editions`, which `atlas_editions_drain` keeps current.
--   · `series`, `play_type`, `set_id`, `edition_kind` AND `name` are copied from THE BASE
--     EDITION of the same set+play. A parallel of a play has the same play and series by
--     construction, and taking `name` from the base means this migration makes no naming
--     decision of its own -- it inherits whatever convention the base already uses.
--   · Mints are uniform per parallel name (Omega 1, Galactic 5, Diced 10, Hexwave 25,
--     Hardcourt 50, Blockchain 99, Halftone 100, Bubbled 250, Explosion 500, Torn 1000,
--     Vortex 2500, Rippled 4000 …) -- a consistency check on the source.
--
-- ⭐ THE COUNT ASSERTION EARNED ITS KEEP ON THE FIRST ATTEMPT, and the bug was mine. The
-- first run RAISED at **494 of 563** and rolled back cleanly. The 69 it refused were the rows
-- my predicate dropped for `player_name IS NULL` -- a guard copied from the Ultimates
-- migration, where it was correct. Here it is WRONG: those 69 are **TEAM MOMENTS** (Fit
-- Check, Clamps, 2022-23 Season Rewind), which have no player BY DESIGN and whose subject is
-- the team. Excluding them would have silently re-created the very class the team-Moment href
-- work fixed earlier the same day. The guard is now `COALESCE(player_name, team) IS NOT NULL`.
--
-- ⚠ WHY THIS CANNOT DISTURB TONIGHT'S CIRCULATION WORK. `trg_topshot_normalize_base_club_circulation`
-- takes the Atlas value UNCONDITIONALLY for a parallel and only ever rewrites the row being
-- written -- it cannot reach a sibling. Base circulation is that printing's own mint and is
-- independent of how many parallels exist. **Asserted, not assumed:** the 306 affected base
-- editions' `circulation_count` is frozen BEFORE the insert and the post-condition RAISES if
-- any moved.
--
-- ⚠ A PARALLEL WITH NO SALES IS AN EXISTING SHAPE, not one this introduces: of the 3,937
-- parallels already carried, 337 (8.6%) have no sale. These read NO_DATA until one trades.
--
-- ⚠ RLS IS SET INLINE HERE. Both audit tables enable RLS and revoke anon/authenticated in
-- this file rather than waiting for `selfheal_audit_table_rls()` (jobid 232, `47 * * * *`),
-- because a deploy landing inside that hourly gap is exactly what turned the smoke gate red
-- earlier tonight.
--
-- REVERT:
--   DELETE FROM public.editions e USING public.audit_20260905_parallel_editions_created a
--    WHERE e.id = a.edition_id;
CREATE TABLE IF NOT EXISTS public.audit_20260905_parallel_base_circ_before (
  base_key text PRIMARY KEY,
  circ_before integer,
  captured_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.audit_20260905_parallel_base_circ_before ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.audit_20260905_parallel_base_circ_before FROM anon, authenticated;
GRANT ALL ON public.audit_20260905_parallel_base_circ_before TO postgres, service_role;

CREATE TABLE IF NOT EXISTS public.audit_20260905_parallel_editions_created (
  edition_id uuid PRIMARY KEY,
  external_id text NOT NULL,
  base_key text NOT NULL,
  parallel_name text,
  parallel_id integer,
  mint integer,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.audit_20260905_parallel_editions_created ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.audit_20260905_parallel_editions_created FROM anon, authenticated;
GRANT ALL ON public.audit_20260905_parallel_editions_created TO postgres, service_role;

DO $mig$
DECLARE
  v_ts constant uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  v_n integer;
  v_moved integer;
BEGIN
  -- 1 · Freeze the "before" circulation of every base edition about to gain a rung.
  INSERT INTO public.audit_20260905_parallel_base_circ_before (base_key, circ_before)
  SELECT DISTINCT split_part(be.external_id, '::', 1), e.circulation_count
    FROM public.badge_editions be
    JOIN public.editions e
      ON e.collection_id = v_ts AND e.external_id = split_part(be.external_id, '::', 1)
   WHERE be.collection_id = v_ts
     AND COALESCE(be.parallel_name, '') <> ''
     AND be.external_id ~ '^[0-9]+:[0-9]+::[0-9]+$'
     AND NOT EXISTS (SELECT 1 FROM public.editions e2
                      WHERE e2.collection_id = be.collection_id AND e2.external_id = be.external_id)
  ON CONFLICT (base_key) DO NOTHING;

  -- 2 · Create the parallels.
  WITH cand AS (
    SELECT be.external_id,
           split_part(be.external_id, '::', 1) AS base_key,
           be.player_name, be.team, be.set_name, be.tier, be.parallel_name, be.parallel_id,
           be.circulation_count
      FROM public.badge_editions be
     WHERE be.collection_id = v_ts
       AND COALESCE(be.parallel_name, '') <> ''
       AND be.external_id ~ '^[0-9]+:[0-9]+::[0-9]+$'
       AND COALESCE(be.player_name, be.team) IS NOT NULL   -- a team Moment has no player BY DESIGN
       AND be.circulation_count IS NOT NULL AND be.circulation_count > 0
       AND NOT EXISTS (SELECT 1 FROM public.editions e
                        WHERE e.collection_id = be.collection_id AND e.external_id = be.external_id)
  ),
  withbase AS (
    SELECT c.*, b.series, b.play_type, b.set_id, b.edition_kind, b.name AS base_name
      FROM cand c
      JOIN public.editions b
        ON b.collection_id = v_ts AND b.external_id = c.base_key
  ),
  ins AS (
    INSERT INTO public.editions
      (external_id, collection_id, collection, set_id, set_name, name, player_name, team_name,
       play_type, tier, series, edition_kind, circulation_count, subedition_id, subedition_name,
       created_at, updated_at)
    SELECT w.external_id, v_ts, 'nba_top_shot', w.set_id, w.set_name,
           COALESCE(w.base_name, COALESCE(w.player_name, w.team) || ' — ' || w.set_name),
           w.player_name, w.team, w.play_type, w.tier::tier_type, w.series,
           COALESCE(w.edition_kind, 'LE'::edition_kind), w.circulation_count,
           w.parallel_id, w.parallel_name, now(), now()
      FROM withbase w
    ON CONFLICT DO NOTHING
    RETURNING id, external_id, subedition_name, subedition_id, circulation_count
  )
  INSERT INTO public.audit_20260905_parallel_editions_created
    (edition_id, external_id, base_key, parallel_name, parallel_id, mint)
  SELECT i.id, i.external_id, split_part(i.external_id, '::', 1), i.subedition_name, i.subedition_id, i.circulation_count
    FROM ins i
  ON CONFLICT (edition_id) DO NOTHING;

  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 563 THEN
    RAISE EXCEPTION 'expected to create exactly 563 parallel editions, created % -- the population drifted, refusing to create what was not measured', v_n;
  END IF;

  -- 3 · Post-condition: adding rungs must not have moved a single base edition's number.
  SELECT count(*) INTO v_moved
    FROM public.audit_20260905_parallel_base_circ_before a
    JOIN public.editions e ON e.collection_id = v_ts AND e.external_id = a.base_key
   WHERE e.circulation_count IS DISTINCT FROM a.circ_before;
  IF v_moved <> 0 THEN
    RAISE EXCEPTION 'adding parallel rungs moved % base edition circulation value(s) -- rolling back', v_moved;
  END IF;
END
$mig$;

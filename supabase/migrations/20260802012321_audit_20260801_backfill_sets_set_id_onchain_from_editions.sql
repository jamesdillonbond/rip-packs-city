-- ============================================================================
-- audit_20260801_backfill_sets_set_id_onchain_from_editions
-- Applied to prod via Supabase MCP 2026-08-01 (version 20260802012321).
-- This file is the repo record of that migration.
--
-- CAUSE
--   636 of 911 `public.sets` rows carried a NULL `set_id_onchain`. Top Shot
--   already self-heals this inside `ensure_topshot_edition_stub`, which bridges
--   the TopShot set UUID -> set_id_onchain via a SIBLING edition; no equivalent
--   bridge ever ran for the other collections.
--
-- EVIDENCE (measured live 2026-08-01)
--   sets with NULL set_id_onchain, and whether the sibling-edition bridge can
--   actually resolve it (count(DISTINCT e.set_id_onchain) over the set's own
--   editions):
--       collection      NULL sets   unambiguous   ambiguous   NOT derivable
--       nfl_all_day        363          363           0             0
--       ufc_strike         256            0           0           256
--       nba_top_shot        16            4           0            12
--       candy_mlb            1            0           0             1
--   Root cause of the two undrivable groups: `editions.set_id_onchain` is
--   itself 0/518 populated for UFC and 0/125 for Candy (vs 6190/6190 for
--   AllDay), so there is NO on-chain set id anywhere in our data to bridge
--   from. UFC's Cadence path never exposed one (CLAUDE.md: UFC borrows the
--   generic NonFungibleToken.CollectionPublic, `Traits` fails) and Candy is
--   Solana -- it has no Flow on-chain set id by definition.
--
-- IMPACT TODAY: LATENT, not breaking.
--   Every consumer of `sets.set_id_onchain` is Top-Shot-scoped --
--   ensure_topshot_edition_stub, get_topshot_set_progress, seed_topshot_editions,
--   get_edition_parallels (which actually reads `editions.set_id_onchain`, not
--   the sets column), topshot_set_completers_mv, mv_topshot_set_play_catalog.
--   Nothing reads the column for AllDay / UFC / Candy, so no rendered surface is
--   wrong today. This backfill removes the trap rather than fixing a live break.
--
-- FIX
--   Fill ONLY where the bridge is unambiguous (exactly one distinct non-NULL
--   `editions.set_id_onchain` among the set's editions). UFC (256), Candy (1)
--   and 12 Top Shot sets are left NULL -- the id is genuinely not recoverable
--   from data we hold and inventing one would be fabrication.
--
-- RESULT: 367 rows written (363 nfl_all_day + 4 nba_top_shot).
--   NULL sets 636 -> 269. Post-check: 0 sets disagree with any of their own
--   editions' set_id_onchain.
--
-- REVERT (exact)
--   UPDATE public.sets s SET set_id_onchain = NULL
--    WHERE s.id IN (SELECT id FROM public.sets_set_id_onchain_backfill_20260801);
--   DROP TABLE IF EXISTS public.sets_set_id_onchain_backfill_20260801;
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.sets_set_id_onchain_backfill_20260801 (
  id                 uuid PRIMARY KEY,
  collection_id      uuid,
  set_name           text,
  old_set_id_onchain int,
  new_set_id_onchain int,
  written_at         timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.sets_set_id_onchain_backfill_20260801 ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.sets_set_id_onchain_backfill_20260801 FROM PUBLIC;
REVOKE ALL ON TABLE public.sets_set_id_onchain_backfill_20260801 FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.sets_set_id_onchain_backfill_20260801 TO service_role;

DO $do$
DECLARE
  v_candidates int;
  v_ambiguous  int;
  v_updated    int;
  v_remaining  int;
BEGIN
  -- The bridge must be UNAMBIGUOUS or we do not write it.
  SELECT count(*) FILTER (WHERE d.n = 1),
         count(*) FILTER (WHERE d.n > 1)
    INTO v_candidates, v_ambiguous
    FROM public.sets s
    JOIN LATERAL (
      SELECT count(DISTINCT e.set_id_onchain) AS n
        FROM public.editions e
       WHERE e.set_id = s.id AND e.set_id_onchain IS NOT NULL
    ) d ON true
   WHERE s.set_id_onchain IS NULL;

  RAISE NOTICE 'sets with NULL set_id_onchain: unambiguous=% ambiguous=%', v_candidates, v_ambiguous;

  IF v_ambiguous > 0 THEN
    RAISE EXCEPTION 'refusing to backfill: % NULL sets have MORE THAN ONE distinct editions.set_id_onchain - the bridge is not deterministic for them', v_ambiguous;
  END IF;

  IF v_candidates = 0 THEN
    RAISE NOTICE 'nothing to backfill (already applied)';
    RETURN;
  END IF;

  WITH bridge AS (
    SELECT s.id,
           s.collection_id,
           s.name::text AS set_name,
           (SELECT min(e.set_id_onchain)
              FROM public.editions e
             WHERE e.set_id = s.id AND e.set_id_onchain IS NOT NULL) AS derived
      FROM public.sets s
     WHERE s.set_id_onchain IS NULL
       AND (SELECT count(DISTINCT e2.set_id_onchain)
              FROM public.editions e2
             WHERE e2.set_id = s.id AND e2.set_id_onchain IS NOT NULL) = 1
  ),
  logged AS (
    INSERT INTO public.sets_set_id_onchain_backfill_20260801
      (id, collection_id, set_name, old_set_id_onchain, new_set_id_onchain)
    SELECT b.id, b.collection_id, b.set_name, NULL, b.derived FROM bridge b
    ON CONFLICT (id) DO NOTHING
    RETURNING id
  ),
  upd AS (
    UPDATE public.sets s
       SET set_id_onchain = b.derived,
           updated_at     = now()
      FROM bridge b
     WHERE s.id = b.id
       AND s.set_id_onchain IS NULL
    RETURNING s.id
  )
  SELECT (SELECT count(*) FROM upd) INTO v_updated;

  RAISE NOTICE 'sets.set_id_onchain backfilled: % rows', v_updated;

  IF v_updated <> v_candidates THEN
    RAISE EXCEPTION 'expected to write % rows, wrote % - aborting', v_candidates, v_updated;
  END IF;

  SELECT count(*) INTO v_remaining FROM public.sets WHERE set_id_onchain IS NULL;
  RAISE NOTICE 'sets still NULL (honest gap: UFC + Candy + 12 TS): %', v_remaining;
END
$do$;

COMMENT ON TABLE public.sets_set_id_onchain_backfill_20260801 IS
  'Audit trail for audit_20260801_backfill_sets_set_id_onchain_from_editions: the exact sets rows whose set_id_onchain was derived from an unambiguous sibling edition (old value was NULL in every case). Kept so the migration has an exact revert. Safe to drop once the change is settled.';

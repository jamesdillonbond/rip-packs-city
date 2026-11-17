-- DB invariant: public.update_badge_low_ask_from_cached_listings — sets each
-- badge_editions row's low_ask to the cheapest LIVE listing for its
-- (player, set, tier) group. The floor is the MIN non-zero ask per group
-- (lower(player_name), set_name, tier), the badge match is case-insensitive on
-- player, and it only writes where the value actually DIFFERS (IS DISTINCT FROM),
-- scoped to the passed collection. A regression that dropped the non-zero guard
-- would post a $0 floor; a broadened match would show one player's ask on
-- another's badge. Returns the count updated.
--
-- The function DDL below is VERBATIM from the committed migration
-- (supabase/migrations/20260427020000_badge_low_ask_aggregator.sql), with its
-- body verified byte-identical to live prod via pg_get_functiondef on 2026-07-31.
-- __tests__/db-invariants-drift-guard.test.ts fails CI on drift.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE public.cached_listings (
  collection_id uuid,
  player_name   text,
  set_name      text,
  tier          text,
  ask_price     numeric
);
CREATE TABLE public.badge_editions (
  collection_id uuid,
  player_name   text,
  set_name      text,
  tier          text,
  low_ask       numeric,
  updated_at    timestamptz
);

-- >>> BEGIN verbatim update_badge_low_ask_from_cached_listings (byte-identical to the migration/prod) >>>
CREATE OR REPLACE FUNCTION public.update_badge_low_ask_from_cached_listings(
  p_collection_id uuid
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  rows_affected integer;
BEGIN
  WITH floors AS (
    SELECT
      lower(player_name) AS player_name_lc,
      set_name,
      tier,
      MIN(NULLIF(ask_price, 0)) AS low_ask
    FROM cached_listings
    WHERE collection_id = p_collection_id
      AND ask_price IS NOT NULL AND ask_price > 0
      AND player_name IS NOT NULL
      AND set_name IS NOT NULL
      AND tier IS NOT NULL
    GROUP BY lower(player_name), set_name, tier
  ),
  upd AS (
    UPDATE badge_editions be
    SET
      low_ask = floors.low_ask,
      updated_at = now()
    FROM floors
    WHERE be.collection_id = p_collection_id
      AND lower(be.player_name) = floors.player_name_lc
      AND be.set_name = floors.set_name
      AND be.tier = floors.tier
      AND (be.low_ask IS DISTINCT FROM floors.low_ask)
    RETURNING 1
  )
  SELECT COUNT(*) INTO rows_affected FROM upd;
  RETURN rows_affected;
END;
$$;
-- <<< END verbatim update_badge_low_ask_from_cached_listings <<<

\set ts '''95f28a17-224a-4025-96ad-adf8a4c63bfd'''
\set ad '''dee28451-5d62-409e-a1ad-a83f763ac070'''

INSERT INTO public.cached_listings (collection_id, player_name, set_name, tier, ask_price) VALUES
  (:ts::uuid, 'Player One', 'Set A', 'LEGENDARY', 50),
  (:ts::uuid, 'Player One', 'Set A', 'LEGENDARY', 30),   -- MIN non-zero = 30
  (:ts::uuid, 'player one', 'Set A', 'LEGENDARY', 0),    -- zero ignored (same group, lowercased)
  (:ts::uuid, 'Player Two', 'Set B', 'RARE',      100),
  (:ts::uuid, NULL,         'Set C', 'RARE',      20);   -- null player → ignored

INSERT INTO public.badge_editions (collection_id, player_name, set_name, tier, low_ask) VALUES
  (:ts::uuid, 'Player One',   'Set A', 'LEGENDARY', NULL),  -- NULL -> 30
  (:ts::uuid, 'PLAYER TWO',   'Set B', 'RARE',      100),   -- already 100 = floor → unchanged
  (:ts::uuid, 'Player Three', 'Set D', 'RARE',      5),     -- no floor for this group → unchanged
  (:ad::uuid, 'Player One',   'Set A', 'LEGENDARY', NULL);  -- other collection → untouched

-- ── Only one row actually changes value ─────────────────────────────────────
SELECT _assert_eq(public.update_badge_low_ask_from_cached_listings(:ts::uuid)::text, '1',
  'only Player One changes (NULL -> 30); the already-correct, no-floor, and other-collection rows are not counted');

-- ── MIN non-zero ask, case-insensitive group (the $0 listing is ignored) ────
SELECT _assert_eq((SELECT low_ask::text FROM public.badge_editions
  WHERE player_name='Player One' AND collection_id=:ts::uuid), '30',
  'low_ask = MIN non-zero ask across the case-insensitive (player,set,tier) group');

-- ── DISTINCT FROM guard: an already-correct floor is left as-is ─────────────
SELECT _assert_eq((SELECT low_ask::text FROM public.badge_editions WHERE player_name='PLAYER TWO'),
  '100', 'a badge already at the floor is not rewritten (IS DISTINCT FROM guard) — and matched case-insensitively');

-- ── A group with no live listing is left untouched ──────────────────────────
SELECT _assert_eq((SELECT low_ask::text FROM public.badge_editions WHERE player_name='Player Three'),
  '5', 'a badge whose group has no cached listing keeps its prior value');

-- ── Collection scoping: the AllDay row is never touched ─────────────────────
SELECT _assert(
  (SELECT low_ask FROM public.badge_editions WHERE collection_id=:ad::uuid) IS NULL,
  'a different collection is out of scope — never updated');

SELECT '✓ update_badge_low_ask_from_cached_listings invariants pass' AS result;
ROLLBACK;

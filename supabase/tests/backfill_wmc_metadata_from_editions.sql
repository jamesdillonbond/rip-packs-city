-- DB invariant: public.backfill_wmc_metadata_from_editions — denormalizes an
-- edition's tier / player / set / mint / team onto wallet_moments_cache (wmc),
-- the cache every collector wallet page reads. It fills ONLY missing (NULL)
-- fields (COALESCE, so a captured value is never overwritten), touches only rows
-- that are missing at least one of the five, matches on (collection_id,
-- edition_key = external_id), and honors optional wallet/collection scoping. The
-- player fallback is load-bearing: a team-only edition (no player_name) surfaces
-- its team as the display name rather than blank. Returns the count updated.
--
-- The function DDL below is VERBATIM from the committed migration
-- (supabase/migrations/20260830143540_audit_20260830_wmc_metadata_post_pass_rewrites_rows_it_cannot_fill.sql),
-- with its body verified byte-identical to live prod via pg_get_functiondef on
-- 2026-08-30. Since 2026-08-30 a row is touched only when at least one of its
-- NULLs can actually be filled — a row whose edition is NULL in the same column
-- is neither rewritten nor counted (it used to be, on every child run). __tests__/db-invariants-drift-guard.test.ts fails CI on drift.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE public.editions (
  collection_id     uuid,
  external_id       text,
  tier              text,
  player_name       text,
  set_name          text,
  circulation_count integer,
  team_name         text
);
CREATE TABLE public.wallet_moments_cache (
  wallet_address text,
  collection_id  uuid,
  edition_key    text,
  tier           text,
  player_name    text,
  set_name       text,
  mint_count     integer,
  team_name      text
);

-- >>> BEGIN verbatim backfill_wmc_metadata_from_editions (byte-identical to the migration/prod) >>>
CREATE OR REPLACE FUNCTION public.backfill_wmc_metadata_from_editions(
  p_wallet_address text DEFAULT NULL::text,
  p_collection_id  uuid DEFAULT NULL::uuid
)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '120s'
AS $function$
DECLARE
  v_updated integer;
BEGIN
  WITH updated AS (
    UPDATE public.wallet_moments_cache wmc
       SET tier        = COALESCE(wmc.tier,        e.tier::text),
           player_name = COALESCE(wmc.player_name, e.player_name, e.team_name),
           set_name    = COALESCE(wmc.set_name,    e.set_name),
           mint_count  = COALESCE(wmc.mint_count,  e.circulation_count),
           team_name   = COALESCE(wmc.team_name,   e.team_name)
      FROM public.editions e
     WHERE e.collection_id = wmc.collection_id
       AND e.external_id   = wmc.edition_key
       AND wmc.edition_key IS NOT NULL
       -- Only rows where at least one NULL can actually be filled. Without the
       -- right-hand IS NOT NULL checks a row whose edition is also NULL in that
       -- column was rewritten with identical values on every run (2026-08-30).
       AND (
         (wmc.tier        IS NULL AND e.tier IS NOT NULL) OR
         (wmc.player_name IS NULL AND COALESCE(e.player_name, e.team_name) IS NOT NULL) OR
         (wmc.set_name    IS NULL AND e.set_name IS NOT NULL) OR
         (wmc.mint_count  IS NULL AND e.circulation_count IS NOT NULL) OR
         (wmc.team_name   IS NULL AND e.team_name IS NOT NULL)
       )
       AND (p_wallet_address IS NULL OR wmc.wallet_address = p_wallet_address)
       AND (p_collection_id  IS NULL OR wmc.collection_id  = p_collection_id)
    RETURNING 1
  )
  SELECT COUNT(*)::int INTO v_updated FROM updated;

  RETURN COALESCE(v_updated, 0);
END;
$function$;
-- <<< END verbatim backfill_wmc_metadata_from_editions <<<

\set ts '''95f28a17-224a-4025-96ad-adf8a4c63bfd'''
\set ad '''dee28451-5d62-409e-a1ad-a83f763ac070'''

INSERT INTO public.editions (collection_id, external_id, tier, player_name, set_name, circulation_count, team_name) VALUES
  (:ts::uuid, 'E1', 'LEGENDARY', 'Player One', 'Set A', 100, 'Team X'),
  (:ts::uuid, 'E2', 'RARE',      NULL,         'Set B',  50, 'Team Y'),  -- no player → team fallback
  (:ts::uuid, 'E3', 'RARE',      'Someone',    'Set C',  20, NULL);      -- no team → cannot fill a NULL team_name

INSERT INTO public.wallet_moments_cache (wallet_address, collection_id, edition_key, tier, player_name, set_name, mint_count, team_name) VALUES
  ('0xW1', :ts::uuid, 'E1', NULL,      NULL,      NULL,   NULL, NULL),      -- all filled
  ('0xW1', :ts::uuid, 'E1', 'EXISTING','Keep Me', NULL,   NULL, NULL),      -- keeps tier+player, fills rest
  ('0xW1', :ts::uuid, 'E2', NULL,      NULL,      NULL,   NULL, NULL),      -- player falls back to team
  ('0xW1', :ts::uuid, 'E1', 'X',       'Y',       'Z',    9,    'T'),       -- fully populated → skipped
  ('0xW1', :ts::uuid, 'NOMATCH', NULL, NULL,      NULL,   NULL, NULL),      -- no edition → skipped
  ('0xW2', :ts::uuid, 'E3', 'RARE',    'Someone', 'Set C', 20,   NULL);      -- only team_name NULL, edition has none → NOT rewritten (2026-08-30)

-- ── Count: three rows have a fillable NULL and a matching edition ────────────
SELECT _assert_eq(public.backfill_wmc_metadata_from_editions()::text, '3',
  'updates the 3 rows missing a field with a matching edition; the full row, the no-match row AND the unfillable-NULL row are skipped');

-- ── 2026-08-30: a NULL the edition cannot fill is not a reason to rewrite ────
-- 0xW2/E3 has only team_name NULL and its edition has no team_name either. The
-- old predicate rewrote it with identical values every run and counted it —
-- the phantom count is what kept refresh_seeded_wallet_stats firing.
SELECT _assert_eq(public.backfill_wmc_metadata_from_editions('0xW2')::text, '0',
  'a row whose only NULLs cannot be filled by its edition is not rewritten and not counted');
SELECT _assert_eq((SELECT xmax::text FROM public.wallet_moments_cache WHERE wallet_address='0xW2'), '0',
  'the unfillable row was never touched (xmax = 0: no UPDATE ever locked or rewrote it)');

-- ── Row 1: every NULL filled from the edition ───────────────────────────────
SELECT _assert_eq((SELECT tier||'|'||player_name||'|'||set_name||'|'||mint_count::text||'|'||team_name
  FROM public.wallet_moments_cache WHERE edition_key='E1' AND player_name='Player One'),
  'LEGENDARY|Player One|Set A|100|Team X', 'all five fields denormalized from the edition');

-- ── Row 2: COALESCE preserves the existing tier + player, fills the rest ─────
SELECT _assert_eq((SELECT tier||'|'||player_name||'|'||set_name FROM public.wallet_moments_cache
  WHERE edition_key='E1' AND tier='EXISTING'), 'EXISTING|Keep Me|Set A',
  'captured tier + player_name are NEVER overwritten; only the NULL set_name is filled');

-- ── Row 3: player_name falls back to team when the edition has no player ─────
SELECT _assert_eq((SELECT player_name FROM public.wallet_moments_cache WHERE edition_key='E2'),
  'Team Y', 'a team-only edition surfaces its team as the display name (fallback)');

SELECT '✓ backfill_wmc_metadata_from_editions invariants pass' AS result;
ROLLBACK;

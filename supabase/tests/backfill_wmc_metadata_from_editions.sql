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
-- (supabase/migrations/20260914015500_audit_20260913_backfill_wmc_metadata_plans_with_its_parameter_values.sql),
-- with its body verified byte-identical to live prod via pg_get_functiondef on
-- 2026-08-30. Since 2026-08-30 a row is touched only when at least one of its
-- NULLs can actually be filled — a row whose edition is NULL in the same column
-- is neither rewritten nor counted (it used to be, on every child run). ⚠ Since 2026-09-13 the UPDATE runs through EXECUTE … INTO … USING so it is planned with the PARAMETER VALUES: as a plain statement plpgsql went GENERIC after five calls in a pooled session and the generic plan INVERTED the join (73,414 buffers against 1,175 — register #113). The SQL is otherwise character-identical, the two parameters becoming $1/$2, so every invariant below is unchanged. __tests__/db-invariants-drift-guard.test.ts fails CI on drift.
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
  team_name         text,
  series            smallint   -- 2026-09-25: the body fills wmc.series_number from it
);
CREATE TABLE public.teams_master (team_name text, league text);
INSERT INTO public.teams_master VALUES ('New York Liberty','WNBA'), ('Denver Nuggets','NBA');
CREATE TABLE public.wallet_moments_cache (
  wallet_address text,
  collection_id  uuid,
  edition_key    text,
  tier           text,
  player_name    text,
  set_name       text,
  mint_count     integer,
  team_name      text,
  series_number  integer,
  league         text       -- 2026-10-31 (#219): the body fills it for Top Shot via topshot_league_for
);

-- Dependency of the body under test (its own rule is pinned in topshot_league_for.sql).
-- >>> BEGIN verbatim topshot_league_for (keep byte-identical to the migration) >>>
CREATE OR REPLACE FUNCTION public.topshot_league_for(p_set_name text, p_team_name text)
 RETURNS text
 LANGUAGE sql
 STABLE
AS $function$
  SELECT CASE
    WHEN p_set_name IS NULL THEN NULL
    WHEN p_set_name ILIKE '%WNBA%'
      OR p_set_name = ANY (ARRAY['Rise With Us','Rise With Us 2023','In Her Bag','In Their Bag','Shining Stars','Chasing the Trophy','For the Cup'])
      THEN 'WNBA'
    WHEN p_team_name IS NOT NULL AND (
         p_team_name IN (SELECT tm.team_name FROM public.teams_master tm WHERE tm.league = 'WNBA')
      OR p_team_name = ANY (ARRAY['San Antonio Stars','San Antonio Silver Stars','Utah Starzz','Detroit Shock','Tulsa Shock','Orlando Miracle','Houston Comets','Sacramento Monarchs','Charlotte Sting','Cleveland Rockers','Miami Sol','Team Wilson','Team Stewart']))
      THEN 'WNBA'
    ELSE 'NBA'
  END
$function$;
-- <<< END verbatim topshot_league_for <<<


-- >>> BEGIN verbatim backfill_wmc_metadata_from_editions (byte-identical to the migration/prod) >>>
CREATE OR REPLACE FUNCTION public.backfill_wmc_metadata_from_editions(p_wallet_address text DEFAULT NULL::text, p_collection_id uuid DEFAULT NULL::uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '120s'
AS $function$
DECLARE
  v_updated integer;
BEGIN
  -- ⚠ EXECUTE … USING, not a plain statement: a plain one is planned GENERIC
  -- from the sixth call of a pooled session onward, and the generic plan for
  -- this WHERE clause seq-scans `editions` and probes wmc per edition — 62x the
  -- buffers (measured 2026-09-13; see this migration's header and #113).
  EXECUTE $q$
  WITH updated AS (
    UPDATE public.wallet_moments_cache wmc
       SET tier        = COALESCE(wmc.tier,        e.tier::text),
           player_name = COALESCE(wmc.player_name, e.player_name, e.team_name),
           set_name    = COALESCE(wmc.set_name,    e.set_name),
           mint_count  = COALESCE(wmc.mint_count,  e.circulation_count),
           team_name   = COALESCE(wmc.team_name,   e.team_name),
           -- 2026-09-24: series was the one column this fill skipped (940k NULLs).
           series_number = COALESCE(wmc.series_number, e.series::int),
           -- 2026-10-31 (#219): league was the next one (603k Top Shot NULLs). Top
           -- Shot only; the rule lives in topshot_league_for; NULL stays NULL
           -- when the edition has no set (never fabricated).
           league      = COALESCE(wmc.league,
                           CASE WHEN wmc.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid
                                THEN public.topshot_league_for(e.set_name, e.team_name) END)
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
         (wmc.team_name   IS NULL AND e.team_name IS NOT NULL) OR
         (wmc.series_number IS NULL AND e.series IS NOT NULL) OR
         (wmc.league IS NULL AND e.set_name IS NOT NULL
            AND wmc.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid)
       )
       AND ($1 IS NULL OR wmc.wallet_address = $1)
       AND ($2 IS NULL OR wmc.collection_id  = $2)
    RETURNING 1
  )
  SELECT COUNT(*)::int FROM updated
  $q$
  INTO v_updated
  USING p_wallet_address, p_collection_id;

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

-- 2026-10-31: league is a filled column now, so the rows whose property is "nothing
-- left to fill" carry one explicitly — otherwise the league arm would (correctly)
-- make them fillable and the assertions below would stop exercising their property.
INSERT INTO public.wallet_moments_cache (wallet_address, collection_id, edition_key, tier, player_name, set_name, mint_count, team_name, league) VALUES
  ('0xW1', :ts::uuid, 'E1', NULL,      NULL,      NULL,   NULL, NULL, NULL),      -- all filled (league too)
  ('0xW1', :ts::uuid, 'E1', 'EXISTING','Keep Me', NULL,   NULL, NULL, 'NBA'),     -- keeps tier+player, fills rest
  ('0xW1', :ts::uuid, 'E2', NULL,      NULL,      NULL,   NULL, NULL, 'NBA'),     -- player falls back to team
  ('0xW1', :ts::uuid, 'E1', 'X',       'Y',       'Z',    9,    'T',  'NBA'),     -- fully populated → skipped
  ('0xW1', :ts::uuid, 'NOMATCH', NULL, NULL,      NULL,   NULL, NULL, NULL),      -- no edition → skipped
  ('0xW2', :ts::uuid, 'E3', 'RARE',    'Someone', 'Set C', 20,   NULL, 'NBA');     -- only team_name NULL, edition has none → NOT rewritten (2026-08-30)

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

-- ── 2026-09-24: series was the one column the fill skipped (940k NULLs) ──────
-- Inserted AFTER the global call above so its count stays 3.
INSERT INTO public.editions (collection_id, external_id, tier, player_name, set_name, circulation_count, team_name, series) VALUES
  (:ts::uuid, 'E4', 'COMMON', 'Four', 'Set D', 10, 'Team Z', 2);
INSERT INTO public.wallet_moments_cache (wallet_address, collection_id, edition_key, tier, player_name, set_name, mint_count, team_name, series_number, league) VALUES
  ('0xW3', :ts::uuid, 'E4', 'COMMON', 'Four', 'Set D', 10, 'Team Z', NULL, 'NBA');
SELECT _assert_eq(public.backfill_wmc_metadata_from_editions('0xW3')::text, '1',
  'a row missing ONLY its series is fillable and counted');
SELECT _assert_eq((SELECT series_number::text FROM public.wallet_moments_cache WHERE wallet_address='0xW3'), '2',
  'series_number filled from editions.series');

-- ── Row 1: every NULL filled from the edition ───────────────────────────────
SELECT _assert_eq((SELECT tier||'|'||player_name||'|'||set_name||'|'||mint_count::text||'|'||team_name
  FROM public.wallet_moments_cache WHERE edition_key='E1' AND player_name='Player One'),
  'LEGENDARY|Player One|Set A|100|Team X', 'all five fields denormalized from the edition');
SELECT _assert_eq((SELECT league FROM public.wallet_moments_cache WHERE edition_key='E1' AND player_name='Player One'),
  'NBA', '2026-10-31: and league, from the set/team rule (Set A / Team X → NBA)');

-- ── Row 2: COALESCE preserves the existing tier + player, fills the rest ─────
SELECT _assert_eq((SELECT tier||'|'||player_name||'|'||set_name FROM public.wallet_moments_cache
  WHERE edition_key='E1' AND tier='EXISTING'), 'EXISTING|Keep Me|Set A',
  'captured tier + player_name are NEVER overwritten; only the NULL set_name is filled');

-- ── Row 3: player_name falls back to team when the edition has no player ─────
SELECT _assert_eq((SELECT player_name FROM public.wallet_moments_cache WHERE edition_key='E2'),
  'Team Y', 'a team-only edition surfaces its team as the display name (fallback)');

-- ── 2026-10-31 (#219): league was the next column the fill skipped (603k TS NULLs) ─
-- Inserted AFTER the global call above so its count stays 3. A Liberty edition in a
-- MIXED set (the team arm), an NBA edition, an All Day edition (league has no meaning
-- there — must stay NULL and must NOT be counted), and a Top Shot edition with no set
-- (nothing to derive from — NULL stays NULL, not counted).
INSERT INTO public.editions (collection_id, external_id, tier, player_name, set_name, circulation_count, team_name, series) VALUES
  (:ts::uuid, 'E5', 'RARE',   'Five',  'Vintage Vibes', 10, 'New York Liberty', 8),
  (:ts::uuid, 'E6', 'COMMON', 'Six',   'Base Set',      10, 'Denver Nuggets',   8),
  (:ad::uuid, 'E7', 'COMMON', 'Seven', 'Base Set',      10, 'Denver Broncos',   1),
  (:ts::uuid, 'E8', 'COMMON', 'Eight', NULL,            10, 'New York Liberty', 8);
INSERT INTO public.wallet_moments_cache (wallet_address, collection_id, edition_key, tier, player_name, set_name, mint_count, team_name, series_number, league) VALUES
  ('0xW4', :ts::uuid, 'E5', 'RARE',   'Five',  'Vintage Vibes', 10, 'New York Liberty', 8, NULL),
  ('0xW4', :ts::uuid, 'E6', 'COMMON', 'Six',   'Base Set',      10, 'Denver Nuggets',   8, NULL),
  ('0xW4', :ts::uuid, 'E6', 'COMMON', 'Six',   'Base Set',      10, 'Denver Nuggets',   8, 'WNBA'),  -- a captured league is never overwritten
  ('0xW4', :ad::uuid, 'E7', 'COMMON', 'Seven', 'Base Set',      10, 'Denver Broncos',   1, NULL),
  ('0xW4', :ts::uuid, 'E8', 'COMMON', 'Eight', NULL,            10, 'New York Liberty', 8, NULL);
SELECT _assert_eq(public.backfill_wmc_metadata_from_editions('0xW4')::text, '2',
  'exactly the two Top Shot rows with a NULL league and an edition that has a set are fillable and counted');
SELECT _assert_eq((SELECT league FROM public.wallet_moments_cache WHERE wallet_address='0xW4' AND edition_key='E5'),
  'WNBA', 'a WNBA team label in a MIXED set → WNBA (the team arm, not the set name)');
SELECT _assert_eq((SELECT string_agg(COALESCE(league,'<null>'), ',' ORDER BY league) FROM public.wallet_moments_cache WHERE wallet_address='0xW4' AND edition_key='E6'),
  'NBA,WNBA', 'the NULL E6 row became NBA; the captured-WNBA E6 row is untouched');
SELECT _assert_eq((SELECT count(*)::text FROM public.wallet_moments_cache WHERE wallet_address='0xW4' AND edition_key='E6' AND league='WNBA'),
  '1', 'a captured league survives (COALESCE never overwrites)');
SELECT _assert_eq((SELECT COALESCE(league,'<null>') FROM public.wallet_moments_cache WHERE wallet_address='0xW4' AND edition_key='E7'),
  '<null>', 'an All Day row keeps league NULL — the rule is Top Shot only');
SELECT _assert_eq((SELECT COALESCE(league,'<null>') FROM public.wallet_moments_cache WHERE wallet_address='0xW4' AND edition_key='E8'),
  '<null>', 'a Top Shot edition with no set yields no league — never fabricated');
SELECT _assert_eq(public.backfill_wmc_metadata_from_editions('0xW4')::text, '0',
  'a second pass finds nothing left to fill (the All Day and no-set rows are not phantom counts)');

SELECT '✓ backfill_wmc_metadata_from_editions invariants pass' AS result;
ROLLBACK;

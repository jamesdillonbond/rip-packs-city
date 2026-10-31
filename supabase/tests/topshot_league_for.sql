-- DB invariant: public.topshot_league_for(text, text) — the ONE SQL home of the Top
-- Shot NBA / WNBA rule (#219, 2026-10-31): WNBA when the SET is WNBA-named or on the
-- WNBA-only list, OR the TEAM label is a WNBA franchise (teams_master league = 'WNBA'
-- plus the historic / all-star labels Top Shot still prints); else NBA; NULL when the
-- set is unknown (a league is never fabricated from nothing). The same OR the squeeze
-- views (20261031040755), the Sniper (lib/league.ts leagueForEdition) and
-- upsert_wallet_moments (20261031161800) apply.
--
-- The function DDL below is a VERBATIM copy of the committed migration
-- (supabase/migrations/20261031191751_audit_20261031_wmc_metadata_fill_writes_league.sql);
-- __tests__/db-invariants-drift-guard.test.ts fails CI if this copy drifts from it.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE public.teams_master (team_name text, league text);
INSERT INTO public.teams_master VALUES
  ('New York Liberty','WNBA'), ('Las Vegas Aces','WNBA'), ('Portland Fire','WNBA'),
  ('Denver Nuggets','NBA'), ('Portland Trail Blazers','NBA');

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

-- ── set rule ─────────────────────────────────────────────────────────────────
SELECT _assert_eq(public.topshot_league_for('2024 WNBA Playoffs', NULL), 'WNBA', 'a WNBA-named set → WNBA (no team needed)');
SELECT _assert_eq(public.topshot_league_for('Rise With Us', 'Denver Nuggets'), 'WNBA', 'a WNBA-only set wins even beside an NBA label');
SELECT _assert_eq(public.topshot_league_for('Base Set', 'Denver Nuggets'), 'NBA', 'an NBA team in an NBA set → NBA');
SELECT _assert_eq(public.topshot_league_for('Base Set', NULL), 'NBA', 'no team, ordinary set → NBA (the set rule)');

-- ── team-label arm: the mixed-set case #219 exists for ───────────────────────
SELECT _assert_eq(public.topshot_league_for('Vintage Vibes', 'New York Liberty'), 'WNBA', 'a WNBA registry label in a MIXED set → WNBA');
SELECT _assert_eq(public.topshot_league_for('Vintage Vibes', 'Portland Fire'), 'WNBA', 'a 2026 expansion franchise comes from the registry, not a list');
SELECT _assert_eq(public.topshot_league_for('Vintage Vibes', 'Houston Comets'), 'WNBA', 'a historic label absent from teams_master → WNBA');
SELECT _assert_eq(public.topshot_league_for('Vintage Vibes', 'Portland Trail Blazers'), 'NBA', 'an NBA label in the same mixed set → NBA');
SELECT _assert_eq(public.topshot_league_for('Vintage Vibes', 'No Such Team'), 'NBA', 'an unknown label falls back to the set rule');

-- ── no set = no league ───────────────────────────────────────────────────────
SELECT _assert_eq(COALESCE(public.topshot_league_for(NULL, 'New York Liberty'), '<null>'), '<null>', 'a NULL set yields NULL even with a WNBA label — never fabricated');
SELECT _assert_eq(COALESCE(public.topshot_league_for(NULL, NULL), '<null>'), '<null>', 'NULL/NULL → NULL');

SELECT '✓ topshot_league_for invariants pass' AS result;
ROLLBACK;

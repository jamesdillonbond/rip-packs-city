-- DB invariant: public._norm_player — the canonical player-name normalizer that
-- underpins name matching across challenge-slot resolution and pack-drop pricing
-- (a mis-normalized name silently fails to match an edition). The function DDL
-- below is a VERBATIM copy of the committed migration
-- (supabase/migrations/20260713031000_audit_20260713_resolve_challenge_slots.sql);
-- __tests__/db-invariants-drift-guard.test.ts fails CI if this copy drifts from it.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

-- Supabase installs unaccent in the `extensions` schema; reproduce that so the
-- verbatim DDL (which calls extensions.unaccent) resolves.
CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS unaccent WITH SCHEMA extensions;

-- >>> BEGIN verbatim _norm_player (keep byte-identical to the migration) >>>
CREATE OR REPLACE FUNCTION public._norm_player(p text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path=public,extensions AS $$
  SELECT regexp_replace(
           regexp_replace(lower(extensions.unaccent(coalesce(p,''))),
             '\s+(jr|sr|ii|iii|iv|v)\.?$', '', 'g'),
           '[^a-z0-9]', '', 'g')
$$;
-- <<< END verbatim _norm_player <<<

-- accents folded, spaces + case removed
SELECT _assert_eq(_norm_player('Luka Dončić'), 'lukadoncic', 'accents + spaces + case');
-- generational suffixes stripped (only as a trailing token)
SELECT _assert_eq(_norm_player('Gary Payton II'), 'garypayton', 'roman-numeral suffix');
SELECT _assert_eq(_norm_player('Ken Griffey Jr.'), 'kengriffey', 'Jr. suffix');
SELECT _assert_eq(_norm_player('Otto Porter Jr'), 'ottoporter', 'Jr suffix without dot');
-- punctuation/apostrophes dropped
SELECT _assert_eq(_norm_player('De''Aaron Fox'), 'deaaronfox', 'apostrophe dropped, letters kept');
-- a "III" that is part of the name mid-string is NOT a trailing suffix... but the
-- regex only anchors at the end, so an interior token is preserved via the alnum pass
SELECT _assert_eq(_norm_player('Melvin Ingram III'), 'melviningram', 'trailing III stripped');
-- NULL and empty coalesce to empty string
SELECT _assert_eq(_norm_player(NULL), '', 'null → empty');
SELECT _assert_eq(_norm_player(''), '', 'empty → empty');
-- idempotent: normalizing an already-normalized value is a no-op
SELECT _assert_eq(_norm_player('lukadoncic'), 'lukadoncic', 'idempotent');

SELECT '✓ norm_player invariants pass' AS result;
ROLLBACK;

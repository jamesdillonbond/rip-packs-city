-- DB invariant: public.mark_signal_wallets_fully_enriched() — one-way transition
-- of signal-source seeded wallets to fully_enriched once cached_moment_count
-- reaches the trust threshold GREATEST(50, expected*95/100). Pins: only
-- signal_source-tagged, not-yet-enriched, non-NULL-cached wallets are eligible;
-- the threshold (95% of expected, floor 50) is exact at the boundary; and the
-- transition is idempotent (already-enriched wallets are never re-touched). A
-- threshold regression either lets partially-indexed wallets emit false signals
-- or blocks real wallets from ever qualifying.
--
-- The function DDL below is a VERBATIM copy of the committed migration
-- (supabase/migrations/20260802185500_audit_20260802_snapshot_mark_signal_wallets_fully_enriched.sql);
-- __tests__/db-invariants-drift-guard.test.ts fails CI if this copy drifts from it.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE seeded_wallets (
  wallet_address        text PRIMARY KEY,
  tags                  text[],
  fully_enriched_at     timestamptz,
  cached_moment_count   integer,
  expected_moment_count integer
);

-- >>> BEGIN verbatim mark_signal_wallets_fully_enriched (keep byte-identical to the migration) >>>
CREATE OR REPLACE FUNCTION public.mark_signal_wallets_fully_enriched()
 RETURNS TABLE(wallet_address text, cached_moment_count integer, expected_moment_count integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  RETURN QUERY
  WITH transitioned AS (
    UPDATE seeded_wallets
    SET fully_enriched_at = NOW()
    WHERE 'signal_source' = ANY(seeded_wallets.tags)
      AND seeded_wallets.fully_enriched_at IS NULL
      AND seeded_wallets.cached_moment_count IS NOT NULL
      AND seeded_wallets.cached_moment_count >= GREATEST(
        50,
        COALESCE(seeded_wallets.expected_moment_count, 1) * 95 / 100
      )
    RETURNING seeded_wallets.wallet_address,
              seeded_wallets.cached_moment_count,
              seeded_wallets.expected_moment_count
  )
  SELECT t.wallet_address, t.cached_moment_count, t.expected_moment_count
  FROM transitioned t;
END;
$function$;
-- <<< END verbatim mark_signal_wallets_fully_enriched <<<

INSERT INTO seeded_wallets (wallet_address, tags, fully_enriched_at, cached_moment_count, expected_moment_count) VALUES
  ('W1', ARRAY['signal_source'],          NULL,          190, 200),  -- 190 >= GREATEST(50,190) → YES (exact boundary)
  ('W2', ARRAY['signal_source'],          NULL,          189, 200),  -- 189 <  190              → NO (one below)
  ('W3', ARRAY['signal_source','x'],      NULL,          50,  10),   -- 50  >= GREATEST(50,9)   → YES (floor 50 dominates)
  ('W4', ARRAY['signal_source'],          NULL,          49,  10),   -- 49  <  50               → NO (below floor)
  ('W5', ARRAY['other'],                  NULL,          500, 10),   -- not signal_source       → NO (tag filter)
  ('W6', ARRAY['signal_source'],          '2020-01-01',  500, 10),   -- already enriched        → NO (skip, one-way)
  ('W7', ARRAY['signal_source'],          NULL,          NULL,100);  -- cached NULL             → NO (guard)

-- Capture the returned set (calling the function once performs the transition).
CREATE TEMP TABLE res AS SELECT wallet_address FROM mark_signal_wallets_fully_enriched();

SELECT _assert_eq((SELECT count(*)::text FROM res), '2', 'exactly two wallets transitioned');
SELECT _assert(( EXISTS(SELECT 1 FROM res WHERE wallet_address='W1') ), 'W1 (cached = 95% of expected, exact boundary) transitioned');
SELECT _assert(( EXISTS(SELECT 1 FROM res WHERE wallet_address='W3') ), 'W3 (floor 50 dominates small expected) transitioned');

-- Side effects: exactly W1/W3 gained fully_enriched_at; everyone else unchanged.
SELECT _assert(( (SELECT fully_enriched_at FROM seeded_wallets WHERE wallet_address='W1') IS NOT NULL ), 'W1 marked enriched');
SELECT _assert(( (SELECT fully_enriched_at FROM seeded_wallets WHERE wallet_address='W2') IS NULL ), 'W2 (one below threshold) NOT transitioned');
SELECT _assert(( (SELECT fully_enriched_at FROM seeded_wallets WHERE wallet_address='W4') IS NULL ), 'W4 (below floor 50) NOT transitioned');
SELECT _assert(( (SELECT fully_enriched_at FROM seeded_wallets WHERE wallet_address='W5') IS NULL ), 'W5 (not signal_source) NOT transitioned');
SELECT _assert(( (SELECT fully_enriched_at FROM seeded_wallets WHERE wallet_address='W7') IS NULL ), 'W7 (cached NULL) NOT transitioned');
SELECT _assert_eq((SELECT fully_enriched_at::date::text FROM seeded_wallets WHERE wallet_address='W6'), '2020-01-01', 'W6 (already enriched) NOT re-touched');

-- Idempotent: a second call transitions nothing more.
SELECT _assert_eq((SELECT count(*)::text FROM mark_signal_wallets_fully_enriched()), '0', 'second call transitions nothing (one-way)');

SELECT '✓ mark_signal_wallets_fully_enriched invariants pass' AS result;
ROLLBACK;

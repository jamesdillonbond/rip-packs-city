-- DB invariant: public.record_wallet_backfill_scan(text, text, integer) → jsonb
-- — the bookkeeping write behind wallet_backfill_state, which `skip_cached`
-- reads to decide whether a wallet needs a fresh (expensive) Cadence walk.
--
-- Pins:
--   • VALIDATION, not garbage-in: a blank/whitespace wallet, a negative
--     found_count, and an unknown collection slug each return
--     {ok:false,error:<why>} and write NOTHING. Each error string is distinct
--     because they mean different things to the caller; collapsing them would
--     make a bad slug indistinguishable from a bad wallet.
--   • scan_count INCREMENTS on conflict rather than resetting to 1 — that
--     counter is how a repeatedly-rescanned wallet is told apart from a
--     first-time one.
--   • The wallet is lowercased + trimmed on the way IN. Flow addresses are
--     case-insensitive and the platform stores them lowercase, so a mixed-case
--     write would create a duplicate state row the reader never matches.
--     (This is the opposite of the documented lower()-on-the-COLUMN sargability
--     trap: normalising the INPUT before writing is correct; wrapping a stored
--     column in a query predicate is what defeats the index.)
--   • found_count = 0 is a VALID scan (a wallet that legitimately holds
--     nothing), not an error — only a NEGATIVE count is rejected.
--
-- The function DDL below is a VERBATIM copy of the committed migration
-- (supabase/migrations/20260812033700_audit_20260812_snapshot_record_wallet_backfill_scan.sql);
-- __tests__/db-invariants-drift-guard.test.ts fails CI if this copy drifts.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE collections (
  id   uuid PRIMARY KEY,
  slug text UNIQUE
);
INSERT INTO collections (id, slug) VALUES
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'nba_top_shot'),
  ('dee28451-5d62-409e-a1ad-a83f763ac070', 'nfl_all_day');

CREATE TABLE wallet_backfill_state (
  wallet_address   text,
  collection_id    uuid,
  last_scanned_at  timestamptz,
  last_found_count integer,
  scan_count       integer,
  PRIMARY KEY (wallet_address, collection_id)
);

-- >>> BEGIN verbatim record_wallet_backfill_scan (keep byte-identical to the migration) >>>
CREATE OR REPLACE FUNCTION public.record_wallet_backfill_scan(p_wallet text, p_collection_slug text, p_found_count integer DEFAULT 0)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_wallet text := lower(trim(p_wallet));
  v_collection_id uuid;
BEGIN
  IF v_wallet IS NULL OR v_wallet = '' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_wallet');
  END IF;
  IF p_found_count < 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_found_count');
  END IF;

  SELECT id INTO v_collection_id
    FROM public.collections
   WHERE slug = p_collection_slug;
  IF v_collection_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_collection_slug');
  END IF;

  INSERT INTO public.wallet_backfill_state
    (wallet_address, collection_id, last_scanned_at, last_found_count, scan_count)
  VALUES (v_wallet, v_collection_id, now(), p_found_count, 1)
  ON CONFLICT (wallet_address, collection_id) DO UPDATE SET
    last_scanned_at = now(),
    last_found_count = EXCLUDED.last_found_count,
    scan_count = wallet_backfill_state.scan_count + 1;

  RETURN jsonb_build_object('ok', true);
END;
$function$;
-- <<< END verbatim record_wallet_backfill_scan <<<

-- Happy path.
SELECT _assert_eq(
  public.record_wallet_backfill_scan('0xBD94CADE097E50AC', 'nba_top_shot', 42)->>'ok',
  'true', 'valid scan is recorded'
);
-- THE NORMALISATION INVARIANT: stored lowercase despite mixed-case input.
SELECT _assert_eq(
  (SELECT wallet_address FROM wallet_backfill_state), '0xbd94cade097e50ac',
  'wallet is lowercased on write (a mixed-case row would never match the reader)'
);
SELECT _assert_eq((SELECT scan_count::text FROM wallet_backfill_state), '1', 'first scan → scan_count 1');
SELECT _assert_eq((SELECT last_found_count::text FROM wallet_backfill_state), '42', 'found_count round-trips');

-- Whitespace is trimmed, and the trimmed form hits the SAME row.
SELECT _assert_eq(
  public.record_wallet_backfill_scan('  0xbd94cade097e50ac  ', 'nba_top_shot', 43)->>'ok',
  'true', 'whitespace-padded wallet is accepted'
);
SELECT _assert_eq(
  (SELECT count(*)::text FROM wallet_backfill_state), '1',
  'trimmed wallet updates the existing row rather than creating a duplicate'
);

-- THE COUNTER INVARIANT: scan_count increments, it does not reset.
SELECT _assert_eq(
  (SELECT scan_count::text FROM wallet_backfill_state), '2',
  'a repeat scan INCREMENTS scan_count (reset-to-1 would erase rescan history)'
);
SELECT _assert_eq(
  (SELECT last_found_count::text FROM wallet_backfill_state), '43',
  'last_found_count takes the newest value'
);

-- found_count = 0 is a legitimate scan (wallet genuinely holds nothing).
SELECT _assert_eq(
  public.record_wallet_backfill_scan('0xaaaa000000000002', 'nba_top_shot', 0)->>'ok',
  'true', 'found_count 0 is a valid scan, not an error'
);

-- Rejections, each with its own distinct reason and NO write.
SELECT _assert_eq(
  public.record_wallet_backfill_scan('', 'nba_top_shot', 1)->>'error',
  'invalid_wallet', 'blank wallet is rejected'
);
SELECT _assert_eq(
  public.record_wallet_backfill_scan('   ', 'nba_top_shot', 1)->>'error',
  'invalid_wallet', 'whitespace-only wallet is rejected (trim runs before the blank check)'
);
SELECT _assert_eq(
  public.record_wallet_backfill_scan(NULL, 'nba_top_shot', 1)->>'error',
  'invalid_wallet', 'NULL wallet is rejected'
);
SELECT _assert_eq(
  public.record_wallet_backfill_scan('0xaaaa000000000003', 'nba_top_shot', -1)->>'error',
  'invalid_found_count', 'negative found_count is rejected'
);
SELECT _assert_eq(
  public.record_wallet_backfill_scan('0xaaaa000000000003', 'no_such_collection', 1)->>'error',
  'invalid_collection_slug',
  'unknown slug is rejected with its OWN reason (a NULL collection_id row must never be written)'
);

-- None of the four rejections wrote anything.
SELECT _assert_eq(
  (SELECT count(*)::text FROM wallet_backfill_state), '2',
  'rejected calls wrote nothing (only the two valid wallets exist)'
);

-- Cross-collection: the same wallet in another collection is a distinct row.
SELECT _assert_eq(
  public.record_wallet_backfill_scan('0xbd94cade097e50ac', 'nfl_all_day', 7)->>'ok',
  'true', 'same wallet, different collection is accepted'
);
SELECT _assert_eq(
  (SELECT count(*)::text FROM wallet_backfill_state WHERE wallet_address='0xbd94cade097e50ac'), '2',
  'per-collection scan state is tracked independently'
);

ROLLBACK;

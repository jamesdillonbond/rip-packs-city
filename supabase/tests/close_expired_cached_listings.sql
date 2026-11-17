-- DB invariant: public.close_expired_cached_listings() → jsonb — closes only
-- listings that are still open (completed_at IS NULL) with a non-NULL expiry in
-- the past, marking them completed_status='expired' at completed_at=LEAST(expiry,
-- now). Pins that OPEN future-expiry, NULL-expiry, and already-completed rows are
-- all left untouched (closing any of those would retire live listings or clobber
-- closed ones, corrupting sniper/market freshness). now() is the transaction
-- timestamp here, so LEAST(expiry, now)=expiry for a past-expiry row.
--
-- The function DDL below is a VERBATIM copy of the committed migration
-- (supabase/migrations/20260802184500_audit_20260802_snapshot_close_expired_cached_listings.sql);
-- __tests__/db-invariants-drift-guard.test.ts fails CI if this copy drifts from it.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE cached_listings_v2 (
  id               integer PRIMARY KEY,
  completed_at     timestamptz,
  completed_status text,
  expiry_at        timestamptz
);

-- >>> BEGIN verbatim close_expired_cached_listings (keep byte-identical to the migration) >>>
CREATE OR REPLACE FUNCTION public.close_expired_cached_listings()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '60s'
AS $function$
DECLARE
  v_closed int := 0;
  v_started timestamptz := NOW();
BEGIN
  WITH upd AS (
    UPDATE cached_listings_v2
    SET completed_at = LEAST(expiry_at, NOW()),
        completed_status = 'expired'
    WHERE completed_at IS NULL
      AND expiry_at IS NOT NULL
      AND expiry_at < NOW()
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_closed FROM upd;

  RETURN jsonb_build_object(
    'closed', v_closed,
    'duration_ms', EXTRACT(EPOCH FROM (NOW() - v_started)) * 1000,
    'finished_at', NOW()
  );
END;
$function$;
-- <<< END verbatim close_expired_cached_listings <<<

INSERT INTO cached_listings_v2 (id, completed_at, completed_status, expiry_at) VALUES
  (1, NULL,                 NULL,      now() - interval '1 day'),   -- open + expired → CLOSE
  (2, NULL,                 NULL,      now() + interval '1 day'),   -- open + future  → keep
  (3, NULL,                 NULL,      NULL),                       -- open + no expiry → keep
  (4, now() - interval '2 day', 'sold', now() - interval '1 day'); -- already completed → keep

SELECT _assert_eq(close_expired_cached_listings()->>'closed', '1', 'exactly one expired-open listing closed');

-- The closed row: status expired, completed_at = LEAST(expiry, now) = its past expiry.
SELECT _assert_eq((SELECT completed_status FROM cached_listings_v2 WHERE id=1), 'expired', 'row 1 marked expired');
SELECT _assert_eq((SELECT completed_at::date::text FROM cached_listings_v2 WHERE id=1),
                  (SELECT (now() - interval '1 day')::date::text), 'row 1 completed_at = LEAST(expiry, now) = past expiry');

-- Untouched rows stay open / unchanged.
SELECT _assert(( (SELECT completed_at FROM cached_listings_v2 WHERE id=2) IS NULL ), 'future-expiry listing NOT closed');
SELECT _assert(( (SELECT completed_at FROM cached_listings_v2 WHERE id=3) IS NULL ), 'NULL-expiry listing NOT closed');
SELECT _assert_eq((SELECT completed_status FROM cached_listings_v2 WHERE id=4), 'sold', 'already-completed listing NOT clobbered');

-- Idempotent: a second sweep closes nothing more.
SELECT _assert_eq(close_expired_cached_listings()->>'closed', '0', 'second sweep closes nothing (idempotent)');

SELECT '✓ close_expired_cached_listings invariants pass' AS result;
ROLLBACK;

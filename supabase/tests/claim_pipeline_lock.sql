-- DB invariant: public.claim_pipeline_lock(text, integer) → boolean — the
-- cross-session concurrency guard. A claim succeeds only when the lock is new,
-- previously 'done', or STALE (older than p_stale_seconds); a FRESH in_progress
-- lock is not re-claimable (a second concurrent worker gets false). Pins each
-- arm: fresh-lock rejection is the anti-double-run invariant; stale-lock takeover
-- is the crashed-holder recovery; attempts increments only on a successful
-- (re)claim.
--
-- The function DDL below is a VERBATIM copy of the committed migration
-- (supabase/migrations/20260802190000_audit_20260802_snapshot_claim_pipeline_lock.sql);
-- __tests__/db-invariants-drift-guard.test.ts fails CI if this copy drifts from it.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE pipeline_run_locks (
  lock_key    text PRIMARY KEY,
  status      text,
  claimed_at  timestamptz,
  released_at timestamptz,
  attempts    integer
);

-- >>> BEGIN verbatim claim_pipeline_lock (keep byte-identical to the migration) >>>
CREATE OR REPLACE FUNCTION public.claim_pipeline_lock(p_key text, p_stale_seconds integer DEFAULT 660)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_claimed boolean := false;
BEGIN
  INSERT INTO public.pipeline_run_locks (lock_key, status, claimed_at, released_at, attempts)
  VALUES (p_key, 'in_progress', now(), NULL, 1)
  ON CONFLICT (lock_key) DO UPDATE
     SET status      = 'in_progress',
         claimed_at  = now(),
         released_at = NULL,
         attempts    = public.pipeline_run_locks.attempts + 1
   WHERE public.pipeline_run_locks.status = 'done'
      OR public.pipeline_run_locks.claimed_at < now() - make_interval(secs => p_stale_seconds)
  RETURNING true INTO v_claimed;

  RETURN COALESCE(v_claimed, false);
END;
$function$;
-- <<< END verbatim claim_pipeline_lock <<<

-- New key → claimed, in_progress, attempts 1.
SELECT _assert_eq(claim_pipeline_lock('k1')::text, 'true', 'new key → claimed');
SELECT _assert_eq((SELECT status FROM pipeline_run_locks WHERE lock_key='k1'), 'in_progress', 'new lock is in_progress');
SELECT _assert_eq((SELECT attempts::text FROM pipeline_run_locks WHERE lock_key='k1'), '1', 'new lock attempts = 1');

-- Second claim while FRESH in_progress → rejected, attempts unchanged.
SELECT _assert_eq(claim_pipeline_lock('k1')::text, 'false', 'fresh in_progress lock is NOT re-claimable (anti double-run)');
SELECT _assert_eq((SELECT attempts::text FROM pipeline_run_locks WHERE lock_key='k1'), '1', 'rejected claim did NOT bump attempts');

-- After the holder marks it done → re-claimable, attempts increments.
UPDATE pipeline_run_locks SET status='done', released_at=now() WHERE lock_key='k1';
SELECT _assert_eq(claim_pipeline_lock('k1')::text, 'true', 'done lock → re-claimable');
SELECT _assert_eq((SELECT attempts::text FROM pipeline_run_locks WHERE lock_key='k1'), '2', 'reclaim bumped attempts to 2');
SELECT _assert_eq((SELECT status FROM pipeline_run_locks WHERE lock_key='k1'), 'in_progress', 'reclaim set status back to in_progress');
SELECT _assert(( (SELECT released_at FROM pipeline_run_locks WHERE lock_key='k1') IS NULL ), 'reclaim cleared released_at');

-- STALE in_progress lock (claimed 20 min ago, default stale = 660s = 11 min) →
-- taken over (crashed-holder recovery).
UPDATE pipeline_run_locks SET status='in_progress', claimed_at = now() - interval '20 minutes' WHERE lock_key='k1';
SELECT _assert_eq(claim_pipeline_lock('k1')::text, 'true', 'stale in_progress lock → taken over');
SELECT _assert_eq((SELECT attempts::text FROM pipeline_run_locks WHERE lock_key='k1'), '3', 'stale takeover bumped attempts to 3');

-- Not-yet-stale under a LARGER threshold → rejected (threshold is honoured).
UPDATE pipeline_run_locks SET status='in_progress', claimed_at = now() - interval '5 minutes' WHERE lock_key='k1';
SELECT _assert_eq(claim_pipeline_lock('k1', 3600)::text, 'false', '5-min-old lock under a 1h stale window is still held');

SELECT '✓ claim_pipeline_lock invariants pass' AS result;
ROLLBACK;

-- DB invariant: public.purge_old_fcl_auth_nonces — the retention sweep for the
-- FCL wallet-auth nonce table. It deletes nonces whose expires_at is older than
-- `retention_days`, returning the count removed. The guard that matters: a row
-- with a NULL expires_at is NEVER purged by age (only truly-expired rows go), and
-- rows still inside the retention window are kept — over-deletion here would drop
-- live auth challenges.
--
-- The function DDL below is VERBATIM from the committed migration
-- (supabase/migrations/20260517140000_backfill_pack_pull_source_rip_id_and_nonces_cleanup.sql),
-- with its body verified byte-identical to live prod via pg_get_functiondef on
-- 2026-07-31. __tests__/db-invariants-drift-guard.test.ts fails CI on drift.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE public.fcl_auth_nonces (
  nonce      text,
  expires_at timestamptz
);

-- >>> BEGIN verbatim purge_old_fcl_auth_nonces (byte-identical to the migration/prod) >>>
CREATE OR REPLACE FUNCTION public.purge_old_fcl_auth_nonces(
  retention_days int DEFAULT 7
)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_deleted int;
BEGIN
  DELETE FROM public.fcl_auth_nonces
   WHERE expires_at IS NOT NULL
     AND expires_at < now() - (retention_days || ' days')::interval;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$function$;
-- <<< END verbatim purge_old_fcl_auth_nonces <<<

INSERT INTO public.fcl_auth_nonces (nonce, expires_at) VALUES
  ('old1',   now() - interval '30 days'),  -- expired well past retention → purge
  ('old2',   now() - interval '8 days'),   -- expired > 7 days ago → purge
  ('recent', now() - interval '1 day'),    -- expired < 7 days ago → keep (window)
  ('future', now() + interval '1 hour'),   -- not yet expired → keep
  ('nullexp', NULL);                       -- NULL expires_at → never age-purged

-- Default retention (7 days): drops old1 + old2 only.
SELECT _assert_eq(public.purge_old_fcl_auth_nonces()::text, '2',
  'default 7-day retention deletes exactly the two rows expired > 7 days ago');
SELECT _assert_eq((SELECT count(*)::text FROM public.fcl_auth_nonces), '3',
  'recent, future, and NULL-expiry rows survive');
SELECT _assert(
  EXISTS (SELECT 1 FROM public.fcl_auth_nonces WHERE nonce='nullexp'),
  'a NULL expires_at is never purged by age (expires_at IS NOT NULL guard)');
SELECT _assert(
  EXISTS (SELECT 1 FROM public.fcl_auth_nonces WHERE nonce='recent'),
  'a row inside the retention window is kept');

-- A tighter retention (0 days) now also drops the "recent" (1-day-old) row.
SELECT _assert_eq(public.purge_old_fcl_auth_nonces(0)::text, '1',
  'retention_days=0 purges everything already past its expires_at');
SELECT _assert(
  EXISTS (SELECT 1 FROM public.fcl_auth_nonces WHERE nonce='future') AND
  EXISTS (SELECT 1 FROM public.fcl_auth_nonces WHERE nonce='nullexp'),
  'the not-yet-expired and NULL-expiry rows are still never touched');

SELECT '✓ purge_old_fcl_auth_nonces invariants pass' AS result;
ROLLBACK;

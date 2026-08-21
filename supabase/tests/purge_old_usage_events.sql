-- DB invariant: public.purge_old_usage_events — the 31-day retention sweep for
-- the feature-usage event stream, called by run_weekly_log_purges() with an
-- explicit 31 (pg_cron `rpc-weekly-log-purges`, daily 09:40Z).
--
-- ⚠ WHY THIS ONE IS WORTH A PIN despite being four lines. `usage_events` is the
-- table behind the ACTIVE-USER COUNT, and the roadmap gates monetization on
-- "50+ weekly active users". Over-deletion here does not error, does not warn,
-- and does not look like a bug: it makes the headline metric read LOWER than
-- reality, which is the direction that reads as "we are not ready yet" and so
-- nobody questions it. A retention bug on a growth metric is invisible in
-- exactly the way this repo's honesty canon describes.
--
-- Deletion volume is real: `weekly-db-maintenance` reported usage_events_deleted
-- 44 (08-19) and 31 (08-18).
--
-- ⚠ NO COMMITTED MIGRATION DEFINES THIS FUNCTION (fileless-migration class). DDL
-- is VERBATIM from live prod via pg_get_functiondef on 2026-08-20, snapshotted
-- into supabase/migrations/20260821021000_audit_20260820_snapshot_retention_purges.sql
-- for the drift guard. That snapshot is a no-op CREATE OR REPLACE.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

-- Types per information_schema: id uuid NOT NULL, wallet_address text NOT NULL,
-- occurred_at timestamptz NOT NULL.
CREATE TABLE public.usage_events (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_address text NOT NULL,
  occurred_at    timestamptz NOT NULL
);

-- >>> BEGIN verbatim purge_old_usage_events (byte-identical to prod) >>>
CREATE OR REPLACE FUNCTION public.purge_old_usage_events(p_days_keep integer DEFAULT 31)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_deleted integer;
BEGIN
  DELETE FROM usage_events
  WHERE occurred_at < NOW() - (p_days_keep || ' days')::interval;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$function$;
-- <<< END verbatim purge_old_usage_events <<<

-- ⚠ The row EXACTLY on the cutoff is what makes `<` → `<=` observable. `NOW()`
-- is transaction-stable, so `now() - interval '31 days'` lands precisely on it.
INSERT INTO public.usage_events (wallet_address, occurred_at) VALUES
  ('0xaaa', now() - interval '400 days'),  -- ancient            → purge
  ('0xaaa', now() - interval '32 days'),   -- outside the window → purge
  ('0xbbb', now() - interval '31 days'),   -- EXACTLY the cutoff → keep (`<`)
  ('0xbbb', now() - interval '30 days'),   -- inside the window  → keep
  ('0xccc', now() - interval '1 day'),     -- recent             → keep
  ('0xccc', now());                        -- right now          → keep

SELECT _assert_eq(public.purge_old_usage_events()::text, '2',
  'default 31-day retention deletes exactly the two rows older than the cutoff');

SELECT _assert_eq((SELECT count(*)::text FROM public.usage_events), '4',
  'the boundary row and everything inside the window survive');

SELECT _assert(
  (SELECT count(*) FROM public.usage_events
    WHERE occurred_at BETWEEN now() - interval '31 days' - interval '1 second'
                          AND now() - interval '31 days' + interval '1 second') = 1,
  'a row EXACTLY on the 31-day cutoff is kept (the < vs <= boundary)');

-- ⚠ THE PROPERTY THE METRIC ACTUALLY DEPENDS ON, asserted directly rather than
-- inferred from a count: the distinct-wallet count inside the retention window
-- must be unchanged by the sweep. A count-only assertion passes if the sweep
-- deletes the right NUMBER of rows from the wrong wallets.
SELECT _assert_eq(
  (SELECT count(DISTINCT wallet_address)::text FROM public.usage_events), '2',
  'the sweep removes only 0xaaa-era rows; the wallets active inside the window are intact');

-- Driven with a non-default argument so a body that hardcodes 31 and ignores
-- p_days_keep cannot pass. run_weekly_log_purges passes 31 explicitly, so the
-- parameter is load-bearing rather than decorative.
SELECT _assert_eq(public.purge_old_usage_events(2)::text, '2',
  'a 2-day window reaches the 31- and 30-day rows that the default sweep left behind');
SELECT _assert_eq((SELECT count(*)::text FROM public.usage_events), '2',
  'the 1-day-old row is INSIDE a 2-day window and survives, as does the just-now row');

ROLLBACK;

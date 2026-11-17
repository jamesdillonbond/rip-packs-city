-- DB invariant: public.purge_old_wallet_holdings_snapshots — the 90-day
-- retention sweep for per-wallet daily holdings snapshots, called by
-- run_weekly_log_purges() with an explicit 90 (pg_cron `rpc-weekly-log-purges`,
-- daily 09:40Z).
--
-- ⚠ THIS ONE'S CUTOFF IS SHAPED DIFFERENTLY FROM EVERY OTHER PURGE, AND THAT IS
-- CORRECT — pinned so nobody "harmonises" it. Its siblings all compare a
-- timestamptz against `NOW() - (n || ' days')::interval`. This one compares
-- against `CURRENT_DATE - p_days_keep`, which is DATE arithmetic:
--   * `wallet_holdings_snapshot.snapshot_at` is a `date`, not a timestamptz
--     (information_schema, not intuition), so a date cutoff is the type-correct
--     comparison and `NOW() - interval` would force an implicit cast.
--   * the cutoff is therefore MIDNIGHT-ALIGNED, not now-aligned. A refactor to
--     `NOW() - interval '90 days'` moves the boundary by up to 24h and silently
--     changes what one day's worth of snapshots means.
-- A reviewer seeing three purges written one way and this one written another
-- would reasonably "fix" it. This test is why they shouldn't.
--
-- ⚠ `CURRENT_DATE` is session-TimeZone dependent. scripts/run-db-tests.sh pins
-- `PGTZ=UTC` precisely so this kind of assertion matches production rather than
-- the developer's box (Trevor's is PT). Do not resolve a future failure here by
-- editing the expectation to a local offset.
--
-- Over-deletion loses portfolio history, which is not re-derivable: the
-- snapshots ARE the record of what a wallet held on a past day.
--
-- ⚠ NO COMMITTED MIGRATION DEFINES THIS FUNCTION (fileless-migration class). DDL
-- is VERBATIM from live prod via pg_get_functiondef on 2026-08-20, snapshotted
-- into supabase/migrations/20260821021000_audit_20260820_snapshot_retention_purges.sql
-- for the drift guard. That snapshot is a no-op CREATE OR REPLACE.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

-- Types per information_schema: id uuid NOT NULL, wallet_address text NOT NULL,
-- snapshot_at DATE NOT NULL. ⚠ Typing snapshot_at as timestamptz here would
-- WIDEN it and test a shape production cannot produce.
CREATE TABLE public.wallet_holdings_snapshot (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_address text NOT NULL,
  snapshot_at    date NOT NULL
);

-- >>> BEGIN verbatim purge_old_wallet_holdings_snapshots (byte-identical to prod) >>>
CREATE OR REPLACE FUNCTION public.purge_old_wallet_holdings_snapshots(p_days_keep integer DEFAULT 90)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_deleted integer;
BEGIN
  DELETE FROM wallet_holdings_snapshot
  WHERE snapshot_at < CURRENT_DATE - p_days_keep;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$function$;
-- <<< END verbatim purge_old_wallet_holdings_snapshots <<<

-- The boundary row sits exactly on `CURRENT_DATE - 90`. Under `<` it is KEPT;
-- `<=` deletes it. Because the column is a date, "exactly on the cutoff" is
-- expressible without any sub-second ambiguity — which is the one way this
-- purge is easier to pin than its timestamptz siblings.
INSERT INTO public.wallet_holdings_snapshot (wallet_address, snapshot_at) VALUES
  ('0xaaa', CURRENT_DATE - 365),  -- ancient              → purge
  ('0xaaa', CURRENT_DATE - 91),   -- one day past cutoff  → purge
  ('0xbbb', CURRENT_DATE - 90),   -- EXACTLY the cutoff   → keep (`<`)
  ('0xbbb', CURRENT_DATE - 89),   -- inside the window    → keep
  ('0xccc', CURRENT_DATE);        -- today                → keep

SELECT _assert_eq(public.purge_old_wallet_holdings_snapshots()::text, '2',
  'default 90-day retention deletes exactly the two snapshots older than the cutoff');

SELECT _assert_eq((SELECT count(*)::text FROM public.wallet_holdings_snapshot), '3',
  'the boundary snapshot, the in-window snapshot and today survive');

SELECT _assert(
  EXISTS (SELECT 1 FROM public.wallet_holdings_snapshot WHERE snapshot_at = CURRENT_DATE - 90),
  'a snapshot EXACTLY on the 90-day cutoff is kept (the < vs <= boundary)');

SELECT _assert(
  EXISTS (SELECT 1 FROM public.wallet_holdings_snapshot WHERE snapshot_at = CURRENT_DATE),
  'today''s snapshot is never touched');

-- ⚠ Pins the DATE arithmetic itself, and the mutation run tells us EXACTLY which
-- rewrite it catches — stated precisely rather than as a general claim, because
-- the first version of this comment overclaimed and a survivor proved it:
--
--   CAUGHT   `WHERE snapshot_at < NOW() - (p_days_keep || ' days')::interval`
--            (uncast). The date column widens to midnight, the cutoff sits at
--            the current TIME OF DAY, so the row dated exactly CURRENT_DATE - 90
--            is strictly before it and gets deleted. This is the harmonisation a
--            reviewer would actually write, and it silently loses a day.
--
--   NOT CAUGHT — and correctly so — `WHERE snapshot_at < (NOW() - (p_days_keep
--            || ' days')::interval)::date`. Casting back to date truncates to the
--            same value (measured: both yield 2026-05-22), so it is EQUIVALENT,
--            not a defect. A test that reddened on it would be punishing a
--            correct rewrite.
--
-- Asserting the surviving row's exact DATE is what separates the first from the
-- original — an outcome count alone cannot.
SELECT _assert_eq(
  (SELECT min(snapshot_at)::text FROM public.wallet_holdings_snapshot),
  (CURRENT_DATE - 90)::text,
  'the oldest surviving snapshot is exactly the midnight-aligned cutoff date');

-- Non-default argument, so a body that hardcodes 90 and ignores p_days_keep
-- cannot pass. run_weekly_log_purges passes 90 explicitly.
SELECT _assert_eq(public.purge_old_wallet_holdings_snapshots(89)::text, '1',
  'tightening to 89 days reaches the row that was previously exactly on the cutoff');
SELECT _assert_eq((SELECT count(*)::text FROM public.wallet_holdings_snapshot), '2',
  'only the 89-day row and today remain');

ROLLBACK;

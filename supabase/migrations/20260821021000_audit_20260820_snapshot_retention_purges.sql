-- audit_20260820_snapshot_retention_purges
--
-- ⚠ THIS MIGRATION IS A PROVENANCE SNAPSHOT. DO NOT APPLY IT EXPECTING A CHANGE.
-- Every statement is a `CREATE OR REPLACE FUNCTION` whose body is BYTE-IDENTICAL
-- to what is already live in prod, captured via `pg_get_functiondef` on
-- 2026-08-20. Applying it is a no-op; it exists so the three functions have a
-- committed source of truth. (⚠ And `apply_migration` costs a ~10-20s burst of
-- user-facing PGRST002 500s from schema-cache re-introspection, so there is no
-- reason to pay that for a no-op.)
--
-- WHY IT WAS NEEDED. These three are part of the fileless-migration population
-- `scripts/check-migration-parity.mjs` reports — applied to production via MCP
-- with the file never committed, so they had no revert path and no source to
-- diff against. `__tests__/db-invariants-drift-guard.test.ts` requires BOTH a
-- `supabase/tests/*.sql` pin and a source migration, so a fileless function
-- cannot be pinned at all until one exists. This is the same pattern the
-- 2026-08-12 `..._snapshot_log_pipeline_run` / `..._snapshot_upsert_wmc_batch` /
-- `..._snapshot_record_wallet_backfill_scan` migrations established.
--
-- WHAT THEY ARE. Three retention deleters, all called by
-- `run_weekly_log_purges()` (pg_cron `rpc-weekly-log-purges`, daily 09:40Z),
-- each with an explicit argument. Their pins are:
--   supabase/tests/purge_old_support_conversations.sql
--   supabase/tests/purge_old_usage_events.sql
--   supabase/tests/purge_old_wallet_holdings_snapshots.sql
--
-- Chosen deleters-first, per the rule that over-deletion produces an ABSENCE
-- rather than an error: nothing raises, the rows are simply gone, and every
-- downstream reader silently agrees with the smaller number.
--
-- ── ANON-EXECUTE DECISION (required by
--    __tests__/migration-new-function-states-its-anon-exec-decision.test.ts) ──
--
-- ⚠ NO REVOKE HERE, DELIBERATELY, and the guard's own message says why:
-- `CREATE OR REPLACE FUNCTION` does NOT reset a function's ACL, so a revoke in a
-- snapshot migration would be the one statement in this file that CHANGES
-- production — the opposite of a provenance no-op.
--
-- MEASURED 2026-08-20 rather than assumed. All three are already locked down in
-- prod — `has_function_privilege(...)` reports anon=false and authenticated=false
-- for each, and all three are `prosecdef = true`. So there is nothing to revoke,
-- and stating the decision is the correct and complete action:
--
-- ⚠ Each marker must sit on ONE line with its function name — the guard matches
-- `anon-exec:` and the name on the SAME line, so a wrapped comment does not count.
-- anon-exec: intentional — already REVOKED in prod (anon=false, authenticated=false, measured 2026-08-20); SECURITY DEFINER retention deleter reached only from run_weekly_log_purges() (purge_old_support_conversations)
-- anon-exec: intentional — already REVOKED in prod (anon=false, authenticated=false, measured 2026-08-20); SECURITY DEFINER retention deleter, no user-facing caller (purge_old_usage_events)
-- anon-exec: intentional — already REVOKED in prod (anon=false, authenticated=false, measured 2026-08-20); SECURITY DEFINER retention deleter, no user-facing caller (purge_old_wallet_holdings_snapshots)
--
-- Revert: none required — re-running any statement here restores the identical
-- body it already has.

-- ── purge_old_support_conversations ────────────────────────────────────────
-- 90-day sweep over concierge history. The load-bearing clause is
-- `feedback_type IS NULL`: a conversation the user gave feedback on is kept
-- forever, and that feedback is not re-derivable from anywhere.
CREATE OR REPLACE FUNCTION public.purge_old_support_conversations(p_days_keep integer DEFAULT 90)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_deleted integer;
BEGIN
  DELETE FROM support_conversations
  WHERE created_at < NOW() - (p_days_keep || ' days')::interval
    AND feedback_type IS NULL;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$function$;

-- ── purge_old_usage_events ─────────────────────────────────────────────────
-- 31-day sweep over the feature-usage stream that the active-user count reads.
-- Over-deletion moves the headline growth metric DOWN, the direction nobody
-- questions.
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

-- ── purge_old_wallet_holdings_snapshots ────────────────────────────────────
-- 90-day sweep over per-wallet daily holdings. ⚠ Its cutoff is DATE arithmetic
-- (`CURRENT_DATE - p_days_keep`), not `NOW() - interval` like its siblings,
-- because `wallet_holdings_snapshot.snapshot_at` is a `date`. That is correct
-- and deliberate; harmonising it to an uncast timestamptz comparison moves the
-- boundary by up to 24h. The pin catches exactly that rewrite.
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

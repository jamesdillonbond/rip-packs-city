-- audit_20261102_prune_stale_wmc_spares_saved_wallets
--
-- #227 — the CAUSE of the weekly partial portfolio snapshot.
--
-- prune_stale_wmc() (pg_cron jobid 199, `20 10 * * 0` = Sunday 3:20 AM PDT / 2:20 AM PST)
-- deletes wallet_moments_cache rows whose last_seen_at is > 14 days old, on every
-- wallet that is not an ACTIVE seeded wallet. A collector's saved wallet is usually
-- not seeded (12 of 37 on 2026-11-02), and the Top Shot walk runs skip_cached: rows
-- already cached are skipped and their last_seen_at is NOT refreshed (measured
-- 2026-11-02: 0x0d79… walk at 00:02 UTC found 50 of 1,109 on-chain moments still
-- cached, re-wrote 1,059, and the 50 survivors kept last_seen_at 2026-10-26). So 14
-- days after a held moment was first cached, the Sunday prune deleted it; the next
-- snapshot (Sunday 11:46 PM PT, dated Monday UTC) summed the hole (10-26: 356 vs
-- 3,164 / 3,167; 9 owner-days in 60), and the next walk re-created the rows.
-- On 11-02 the next prune would have deleted 10,775 held rows across 9 saved wallets.
--
-- Fix: saved wallets are exempt, like active seeded wallets. Sold moments on them
-- are retired by the walk's own delete-not-seen (lib/chains/flow/wmc-unseen-delete.ts).
-- Base: 20261004030511 (live prosrc md5 dca942b93fe7f49817e3b50c21e4b18b verified
-- 2026-11-02 immediately before writing). Only the second NOT EXISTS is new.
--
-- anon-exec: unchanged (revoked) — CREATE OR REPLACE preserves the ACL (prune_stale_wmc)
--
-- REVERT: re-apply the prune_stale_wmc block of
--   supabase/migrations/20261004030511_audit_20261003_run_durations_no_longer_wrap_at_60_seconds.sql

CREATE OR REPLACE FUNCTION public.prune_stale_wmc()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '600s'
AS $function$
DECLARE
  v_started timestamptz := clock_timestamp();
  v_stale_cache_deleted integer := 0;
  v_wallets_pruned integer := 0;
  v_wallet text;
  v_chunk integer;
BEGIN
  -- Belt-and-suspenders: robust even if invoked by a role with a tighter default
  -- (service_role 30s); cron_heavy already defaults to 600s.
  PERFORM set_config('statement_timeout', '600000', true);

  FOR v_wallet IN
    SELECT DISTINCT w.wallet_address
    FROM public.wallet_moments_cache w
    WHERE w.last_seen_at < now() - interval '14 days'
      AND NOT EXISTS (
        SELECT 1 FROM seeded_wallets sw
        WHERE sw.wallet_address = w.wallet_address
          AND sw.is_active = true
      )
      -- 2026-11-02 (#227): a collector's SAVED wallet is never pruned either. A
      -- skip-cached walk does not refresh last_seen_at on rows it already holds,
      -- so 14 days after a moment was first cached this sweep deleted it while it
      -- was still held, and the portfolio snapshot read the hole (356 of 3,164).
      -- Sold moments on a saved wallet are retired by the walk's delete-not-seen.
      AND NOT EXISTS (
        SELECT 1 FROM saved_wallets sv
        WHERE sv.wallet_addr = w.wallet_address
      )
  LOOP
    DELETE FROM public.wallet_moments_cache
    WHERE wallet_address = v_wallet
      AND last_seen_at < now() - interval '14 days';
    GET DIAGNOSTICS v_chunk = ROW_COUNT;
    v_stale_cache_deleted := v_stale_cache_deleted + v_chunk;
    IF v_chunk > 0 THEN
      v_wallets_pruned := v_wallets_pruned + 1;
    END IF;
  END LOOP;

  PERFORM public.log_pipeline_run(
    p_pipeline := 'weekly-wmc-prune',
    p_started_at := v_started,
    p_rows_written := v_stale_cache_deleted,
    p_extra := jsonb_build_object(
      'stale_cache_deleted', v_stale_cache_deleted,
      'wallets_pruned',      v_wallets_pruned
    )
  );

  RETURN jsonb_build_object(
    'ok', true,
    'stale_cache_deleted', v_stale_cache_deleted,
    'wallets_pruned',      v_wallets_pruned,
    'duration_ms', (EXTRACT(EPOCH FROM (clock_timestamp() - v_started)) * 1000)::integer
  );
END;
$function$;

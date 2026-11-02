-- RUN IN THE SUPABASE SQL EDITOR (2026-11-02, Cowork cloud): the Supabase MCP holds any body
-- carrying DELETE for an interactive confirmation that a cloud session cannot give, so this
-- was NOT applied. After running it, record it: commit this file as
-- supabase/migrations/<version>_audit_20261102_prune_trade_block.sql with the version the
-- editor run gets (or insert the schema_migrations row by hand, as 20261031194500 did).
--
-- 2026-11-02 (PT) — Trade Block housekeeping (features/trading.md §3 "Next"; Trevor: "Keep
-- going"). Listings expire by `expires_at` at READ time and nothing deleted them, so every
-- closed or expired listing — with its lines, its proposals and their lines — and every
-- daily match-notice claim would sit forever. This prunes, daily:
--   • listings CLOSED more than p_days ago (closed_at), and listings still 'open' whose
--     expires_at passed more than p_days ago — EXCEPT a listing with an ACCEPTED proposal,
--     which is kept as trade history (it may name the trade room that sealed it);
--   • match-notice claims older than p_notice_days (a claim only matters on its own day).
-- Items, proposals and proposal items cascade from trade_block_listings (ON DELETE CASCADE,
-- 20261102162558). Proven accounts (trade_block_wallets) are NOT touched — the account
-- deletion walk owns those. Returns counts; a run that deletes nothing is a normal day.
--
-- anon-exec: no — prune_trade_block is a writer; REVOKE … FROM PUBLIC, anon, authenticated
--   below; postgres / service_role only. Scheduled pg_cron `rpc-prune-trade-block` 04:57 UTC
--   daily, beside rpc-prune-trade-rooms (04:53).
-- Revert: SELECT cron.unschedule('rpc-prune-trade-block'); DROP FUNCTION public.prune_trade_block(int, int);

CREATE OR REPLACE FUNCTION public.prune_trade_block(p_days int DEFAULT 60, p_notice_days int DEFAULT 30)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
SET statement_timeout TO '60s'
AS $$
DECLARE
  v_closed   bigint;
  v_expired  bigint;
  v_notices  bigint;
  v_cutoff   timestamptz := now() - make_interval(days => greatest(p_days, 1));
  v_note_cut date := (now() AT TIME ZONE 'America/Los_Angeles')::date - greatest(p_notice_days, 1);
BEGIN
  DELETE FROM public.trade_block_match_notices WHERE day < v_note_cut;
  GET DIAGNOSTICS v_notices = ROW_COUNT;

  DELETE FROM public.trade_block_listings l
   WHERE l.status = 'closed' AND l.closed_at < v_cutoff
     AND NOT EXISTS (SELECT 1 FROM public.trade_block_proposals p WHERE p.listing_id = l.id AND p.status = 'accepted');
  GET DIAGNOSTICS v_closed = ROW_COUNT;

  DELETE FROM public.trade_block_listings l
   WHERE l.status = 'open' AND l.expires_at < v_cutoff
     AND NOT EXISTS (SELECT 1 FROM public.trade_block_proposals p WHERE p.listing_id = l.id AND p.status = 'accepted');
  GET DIAGNOSTICS v_expired = ROW_COUNT;

  RETURN jsonb_build_object(
    'listings_closed_deleted', v_closed,
    'listings_expired_deleted', v_expired,
    'notices_deleted', v_notices,
    'cutoff', v_cutoff,
    'notice_cutoff', v_note_cut,
    'listings_remaining', (SELECT count(*) FROM public.trade_block_listings)
  );
END;
$$;

COMMENT ON FUNCTION public.prune_trade_block(int, int) IS
  'Daily Trade Block housekeeping: deletes listings closed > p_days ago and open listings expired > p_days ago (items/proposals cascade) unless a proposal on them was accepted (kept as history), and match-notice claims older than p_notice_days. pg_cron rpc-prune-trade-block.';

REVOKE ALL ON FUNCTION public.prune_trade_block(int, int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.prune_trade_block(int, int) TO service_role;

SELECT cron.schedule('rpc-prune-trade-block', '57 4 * * *', $cmd$SELECT public.prune_trade_block(60, 30)$cmd$);

-- Records the migration and reads it back in the same paste (added 2026-11-02 ~12:20 PM PT).
-- Commit this file afterwards as supabase/migrations/20261102201500_audit_20261102_prune_trade_block.sql.
INSERT INTO supabase_migrations.schema_migrations(version,name,statements) VALUES ('20261102201500','audit_20261102_prune_trade_block',ARRAY[]::text[]) ON CONFLICT (version) DO NOTHING;
SELECT (select count(*) from pg_proc where proname='prune_trade_block') fn,
       (select schedule from cron.job where jobname='rpc-prune-trade-block') job,
       (select count(*) from supabase_migrations.schema_migrations where version='20261102201500') mig,
       public.prune_trade_block(60,30) first_run;

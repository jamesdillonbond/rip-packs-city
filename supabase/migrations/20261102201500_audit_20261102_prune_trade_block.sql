-- APPLIED 2026-11-02 ~12:16 PM PT via the Supabase SQL editor (Chrome, Trevor's go-ahead); schema_migrations row
-- 20261102201500 inserted by hand in the same run. Read-back: fn=1, job '57 4 * * *', first run deleted 0.
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


-- 2026-10-31 (PT) — trade-room housekeeping (features/trading.md open item 2; Trevor: "keep
-- going"). Rooms expire by `expires_at` at READ time and nothing deleted them, so every
-- abandoned or cancelled room — and every relay row, which holds a FCL signable — would sit
-- forever. This prunes, daily:
--   • rooms CANCELLED more than p_days ago (updated_at: the cancel is the room's last write), and
--   • rooms never sealed whose `expires_at` passed more than p_days ago
--     (open / building / accepted / signing — an abandoned proposal, nothing signed),
--   • relay rows older than p_relay_days on ANY room (a signable is transient; the
--     co-signer reads it within minutes or not at all; the swap_test_relay is untouched).
-- SEALED rooms are KEPT: they are the collector's trade history (tx_id, where each Moment
-- landed). sides / items / relay cascade from trade_rooms (ON DELETE CASCADE, 20261031174000).
-- Returns counts; a run that deletes nothing is a normal day, not a failure.
--
-- anon-exec: no — prune_trade_rooms is a writer; REVOKE … FROM PUBLIC, anon, authenticated
--   below; postgres / service_role only. Scheduled pg_cron `rpc-prune-trade-rooms` 04:53 UTC
--   daily (9:53 PM PT in PDT), beside rpc-cron-log-retention (04:47).
-- Revert: SELECT cron.unschedule('rpc-prune-trade-rooms'); DROP FUNCTION public.prune_trade_rooms(int, int);

CREATE OR REPLACE FUNCTION public.prune_trade_rooms(p_days int DEFAULT 30, p_relay_days int DEFAULT 7)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
SET statement_timeout TO '60s'
AS $$
DECLARE
  v_cancelled bigint;
  v_expired   bigint;
  v_relay     bigint;
  v_cutoff    timestamptz := now() - make_interval(days => greatest(p_days, 1));
  v_relay_cut timestamptz := now() - make_interval(days => greatest(p_relay_days, 1));
BEGIN
  DELETE FROM public.trade_room_relay WHERE created_at < v_relay_cut;
  GET DIAGNOSTICS v_relay = ROW_COUNT;

  DELETE FROM public.trade_rooms
   WHERE status = 'cancelled' AND updated_at < v_cutoff;
  GET DIAGNOSTICS v_cancelled = ROW_COUNT;

  DELETE FROM public.trade_rooms
   WHERE status IN ('open', 'building', 'accepted', 'signing') AND expires_at < v_cutoff;
  GET DIAGNOSTICS v_expired = ROW_COUNT;

  RETURN jsonb_build_object(
    'rooms_cancelled_deleted', v_cancelled,
    'rooms_expired_deleted', v_expired,
    'relay_deleted', v_relay,
    'cutoff', v_cutoff,
    'relay_cutoff', v_relay_cut,
    'rooms_remaining', (SELECT count(*) FROM public.trade_rooms),
    'sealed_kept', (SELECT count(*) FROM public.trade_rooms WHERE status = 'sealed')
  );
END;
$$;

COMMENT ON FUNCTION public.prune_trade_rooms(int, int) IS
  'Daily trade-room housekeeping: deletes rooms cancelled > p_days ago and never-sealed rooms whose expires_at passed > p_days ago (sides/items/relay cascade), and relay rows (FCL signables) older than p_relay_days. Sealed rooms are kept as trade history. pg_cron rpc-prune-trade-rooms.';

REVOKE ALL ON FUNCTION public.prune_trade_rooms(int, int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.prune_trade_rooms(int, int) TO service_role;

SELECT cron.schedule('rpc-prune-trade-rooms', '53 4 * * *', $cmd$SELECT public.prune_trade_rooms(30, 7)$cmd$);

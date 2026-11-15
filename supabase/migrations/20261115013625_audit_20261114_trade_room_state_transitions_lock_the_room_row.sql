-- 2026-11-14 (Claude Code cloud, ~5:55 PM PT) — known-issues #250: trade-room state races.
--
-- Each transition below was a READ of the room in TypeScript followed by a separate WRITE, and two
-- of them raced a transition on ANOTHER row:
--   (a) cancel vs co-sign — cancelRoom checked "no co-signature" on its snapshot, then wrote
--       `cancelled` with .neq('status','sealed') (not conditional on what it checked), while relay_sign
--       checked `signing` on its own snapshot and postSignature (trade_room_relay) did not require the
--       room to still be signing. Interleaved, the trade could SEAL after the counterparty was emailed
--       "cancelled … Nothing moved".
--   (b) unaccept vs markSigning — unaccept nulled accepted_version after markSigning had moved the room
--       to `signing`; after signing_ended the room read `accepted` with one side NOT accepted, and
--       relay_post checked only the status.
-- Fix: every one of these transitions takes the trade_rooms row FOR UPDATE first, re-reads what it
-- decides on under that lock, and returns a verdict the route maps to its existing errors. Two
-- transitions on one room now serialize; a decision can no longer be made on a stale snapshot.
-- The co-signature window matches lib/swap-test/relay.ts RELAY_TTL_MS (passed in, not duplicated).
-- anon-exec: none — new SECURITY INVOKER functions, EXECUTE revoked FROM PUBLIC, anon, authenticated; service_role only (the trade-room route uses supabaseAdmin).
-- Revert: DROP FUNCTION the five below and revert the commit that calls them (the TS paths it replaced
-- are in git history).

-- (a1) cancel: only from the status the caller saw, and never with a co-signature in the window.
CREATE OR REPLACE FUNCTION public.trade_room_cancel_locked(
  p_room_id uuid, p_expected_status text, p_cancelled_by uuid, p_reason text, p_relay_ttl_seconds integer)
RETURNS text
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE
  v_status text;
BEGIN
  SELECT status INTO v_status FROM public.trade_rooms WHERE id = p_room_id FOR UPDATE;
  IF NOT FOUND THEN RETURN 'not_found'; END IF;
  IF v_status = 'sealed' THEN RETURN 'sealed'; END IF;
  IF v_status = 'cancelled' THEN RETURN 'ok'; END IF;
  IF v_status IS DISTINCT FROM p_expected_status THEN RETURN 'stale'; END IF;
  IF v_status = 'signing' AND EXISTS (
       SELECT 1 FROM public.trade_room_relay r
        WHERE r.room_id = p_room_id AND r.signed_at IS NOT NULL
          AND r.created_at > now() - make_interval(secs => p_relay_ttl_seconds)) THEN
    RETURN 'cosigned';
  END IF;
  UPDATE public.trade_rooms
     SET status = 'cancelled', cancelled_by = p_cancelled_by, cancel_reason = p_reason, updated_at = now()
   WHERE id = p_room_id;
  RETURN 'ok';
END;
$function$;

-- (a2) a co-signature lands only while the room is still `signing`.
CREATE OR REPLACE FUNCTION public.trade_room_post_signature_locked(
  p_room_id uuid, p_relay_id uuid, p_signature text, p_key_id integer)
RETURNS text
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE
  v_status text;
  v_n integer;
BEGIN
  SELECT status INTO v_status FROM public.trade_rooms WHERE id = p_room_id FOR UPDATE;
  IF NOT FOUND THEN RETURN 'not_found'; END IF;
  IF v_status IS DISTINCT FROM 'signing' THEN RETURN 'not_signing'; END IF;
  UPDATE public.trade_room_relay
     SET signature = p_signature, key_id = p_key_id, signed_at = now()
   WHERE id = p_relay_id AND room_id = p_room_id AND signature IS NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 1 THEN RETURN 'already_signed'; END IF;
  RETURN 'ok';
END;
$function$;

-- (b1) signing starts only from this version, with BOTH sides accepted at it.
CREATE OR REPLACE FUNCTION public.trade_room_mark_signing_locked(p_room_id uuid, p_version integer)
RETURNS text
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE
  v_room record;
  v_accepted integer;
BEGIN
  SELECT status, version INTO v_room FROM public.trade_rooms WHERE id = p_room_id FOR UPDATE;
  IF NOT FOUND THEN RETURN 'not_found'; END IF;
  IF v_room.version IS DISTINCT FROM p_version OR v_room.status NOT IN ('accepted', 'signing') THEN RETURN 'stale'; END IF;
  SELECT count(*) INTO v_accepted FROM public.trade_room_sides
   WHERE room_id = p_room_id AND side IN ('a', 'b') AND accepted_version = p_version;
  IF v_accepted <> 2 THEN RETURN 'not_accepted'; END IF;
  UPDATE public.trade_rooms SET status = 'signing', updated_at = now() WHERE id = p_room_id;
  RETURN 'ok';
END;
$function$;

-- (b2) withdrawing acceptance is refused once signing has begun (the room is not editable then).
CREATE OR REPLACE FUNCTION public.trade_room_unaccept_locked(p_room_id uuid, p_side text)
RETURNS text
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE
  v_status text;
BEGIN
  SELECT status INTO v_status FROM public.trade_rooms WHERE id = p_room_id FOR UPDATE;
  IF NOT FOUND THEN RETURN 'not_found'; END IF;
  IF v_status NOT IN ('open', 'building', 'accepted') THEN RETURN v_status; END IF;
  UPDATE public.trade_room_sides SET accepted_version = NULL, updated_at = now()
   WHERE room_id = p_room_id AND side = p_side;
  IF v_status = 'accepted' THEN
    UPDATE public.trade_rooms SET status = 'building', updated_at = now() WHERE id = p_room_id;
  END IF;
  RETURN 'ok';
END;
$function$;

-- (a3) the way back out of `signing` is refused while a co-signature exists (same window).
CREATE OR REPLACE FUNCTION public.trade_room_signing_ended_locked(p_room_id uuid, p_relay_ttl_seconds integer)
RETURNS text
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE
  v_status text;
BEGIN
  SELECT status INTO v_status FROM public.trade_rooms WHERE id = p_room_id FOR UPDATE;
  IF NOT FOUND THEN RETURN 'not_found'; END IF;
  IF v_status IS DISTINCT FROM 'signing' THEN RETURN 'ok'; END IF;
  IF EXISTS (
       SELECT 1 FROM public.trade_room_relay r
        WHERE r.room_id = p_room_id AND r.signed_at IS NOT NULL
          AND r.created_at > now() - make_interval(secs => p_relay_ttl_seconds)) THEN
    RETURN 'cosigned';
  END IF;
  UPDATE public.trade_rooms SET status = 'accepted', updated_at = now() WHERE id = p_room_id;
  RETURN 'ok';
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.trade_room_cancel_locked(uuid, text, uuid, text, integer) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.trade_room_post_signature_locked(uuid, uuid, text, integer) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.trade_room_mark_signing_locked(uuid, integer) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.trade_room_unaccept_locked(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.trade_room_signing_ended_locked(uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.trade_room_cancel_locked(uuid, text, uuid, text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.trade_room_post_signature_locked(uuid, uuid, text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.trade_room_mark_signing_locked(uuid, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.trade_room_unaccept_locked(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.trade_room_signing_ended_locked(uuid, integer) TO service_role;

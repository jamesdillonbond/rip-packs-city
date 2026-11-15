-- DB invariant: the trade-room locked state transitions (known-issues #250, 2026-11-14).
-- The function DDL below is a VERBATIM copy of the committed migration
-- (supabase/migrations/20261115013625_audit_20261114_trade_room_state_transitions_lock_the_room_row.sql);
-- __tests__/db-invariants-drift-guard.test.ts fails CI if this copy drifts.
-- Concurrency itself cannot be exercised in one session; what is pinned is each
-- verdict the lock decides on. Runs in a rolled-back transaction.

BEGIN;

CREATE TABLE trade_rooms (id uuid PRIMARY KEY, status text, version integer, cancelled_by uuid, cancel_reason text, updated_at timestamptz);
CREATE TABLE trade_room_sides (room_id uuid, side text, accepted_version integer, updated_at timestamptz);
CREATE TABLE trade_room_relay (id uuid PRIMARY KEY, room_id uuid, signature text, key_id integer, signed_at timestamptz, created_at timestamptz DEFAULT now());

-- >>> BEGIN verbatim trade_room_*_locked (keep byte-identical to the migration) >>>
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
-- <<< END verbatim trade_room_*_locked <<<

INSERT INTO trade_rooms (id, status, version) VALUES
  ('00000000-0000-0000-0000-0000000000a1', 'signing', 3), ('00000000-0000-0000-0000-0000000000a2', 'signing', 3), ('00000000-0000-0000-0000-0000000000a3', 'accepted', 3),
  ('00000000-0000-0000-0000-0000000000a4', 'sealed', 3), ('00000000-0000-0000-0000-0000000000a5', 'accepted', 3), ('00000000-0000-0000-0000-0000000000a6', 'signing', 3);
INSERT INTO trade_room_sides VALUES
  ('00000000-0000-0000-0000-0000000000a3','a',3,now()), ('00000000-0000-0000-0000-0000000000a3','b',3,now()),
  ('00000000-0000-0000-0000-0000000000a5','a',3,now()), ('00000000-0000-0000-0000-0000000000a5','b',NULL,now());
-- a1: a relay already SIGNED in the window; a2: an unsigned relay; a6: an old signed relay (outside 900 s).
INSERT INTO trade_room_relay (id, room_id, signature, signed_at, created_at) VALUES
  ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000a1', 'sig', now(), now()),
  ('00000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-0000000000a2', NULL, NULL, now()),
  ('00000000-0000-0000-0000-0000000000b6', '00000000-0000-0000-0000-0000000000a6', 'sig', now() - interval '2 hours', now() - interval '2 hours');

-- CANCEL
SELECT _assert_eq(trade_room_cancel_locked('00000000-0000-0000-0000-0000000000a1', 'signing', NULL, 'r', 900), 'cosigned', 'a co-signed room in the window cannot be cancelled');
SELECT _assert_eq((SELECT status FROM trade_rooms WHERE id = '00000000-0000-0000-0000-0000000000a1'), 'signing', 'and its status is untouched');
SELECT _assert_eq(trade_room_cancel_locked('00000000-0000-0000-0000-0000000000a3', 'building', NULL, 'r', 900), 'stale', 'a cancel decided on a stale status is refused');
SELECT _assert_eq((SELECT status FROM trade_rooms WHERE id = '00000000-0000-0000-0000-0000000000a3'), 'accepted', 'and changes nothing');
SELECT _assert_eq(trade_room_cancel_locked('00000000-0000-0000-0000-0000000000a4', 'sealed', NULL, 'r', 900), 'sealed', 'a sealed room is never cancelled');
SELECT _assert_eq(trade_room_cancel_locked('00000000-0000-0000-0000-0000000000a6', 'signing', NULL, 'r', 900), 'ok', 'a co-signature OUTSIDE the window does not block');
SELECT _assert_eq((SELECT status FROM trade_rooms WHERE id = '00000000-0000-0000-0000-0000000000a6'), 'cancelled', 'that cancel landed');

-- POST SIGNATURE
SELECT _assert_eq(trade_room_post_signature_locked('00000000-0000-0000-0000-0000000000a6', '00000000-0000-0000-0000-0000000000b6', 'x', 0), 'not_signing', 'a signature never lands on a room that left signing (the cancel above)');
SELECT _assert_eq(trade_room_post_signature_locked('00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000b2', 'abc', 1), 'ok', 'a signature lands while the room is signing');
SELECT _assert_eq((SELECT signature FROM trade_room_relay WHERE id = '00000000-0000-0000-0000-0000000000b2'), 'abc', 'the signature was written');
SELECT _assert_eq(trade_room_post_signature_locked('00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000b2', 'zzz', 1), 'already_signed', 'never overwrites a signature');
SELECT _assert_eq(trade_room_post_signature_locked('00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000b1', 'zzz', 1), 'already_signed', 'a relay of ANOTHER room matches nothing');

-- MARK SIGNING
SELECT _assert_eq(trade_room_mark_signing_locked('00000000-0000-0000-0000-0000000000a5', 3), 'not_accepted', 'signing needs BOTH sides accepted at this version');
SELECT _assert_eq(trade_room_mark_signing_locked('00000000-0000-0000-0000-0000000000a3', 2), 'stale', 'a different version is stale');
SELECT _assert_eq(trade_room_mark_signing_locked('00000000-0000-0000-0000-0000000000a3', 3), 'ok', 'both accepted at v3 -> signing');
SELECT _assert_eq((SELECT status FROM trade_rooms WHERE id = '00000000-0000-0000-0000-0000000000a3'), 'signing', 'the room is signing');

-- UNACCEPT
SELECT _assert_eq(trade_room_unaccept_locked('00000000-0000-0000-0000-0000000000a3', 'b'), 'signing', 'acceptance cannot be withdrawn once signing began');
SELECT _assert_eq((SELECT accepted_version::text FROM trade_room_sides WHERE room_id = '00000000-0000-0000-0000-0000000000a3' AND side = 'b'), '3', 'and the side keeps its acceptance');
SELECT _assert_eq(trade_room_unaccept_locked('00000000-0000-0000-0000-0000000000a5', 'a'), 'ok', 'an accepted room can be withdrawn from');
SELECT _assert_eq((SELECT status FROM trade_rooms WHERE id = '00000000-0000-0000-0000-0000000000a5'), 'building', 'back to building');

-- SIGNING ENDED
SELECT _assert_eq(trade_room_signing_ended_locked('00000000-0000-0000-0000-0000000000a1', 900), 'cosigned', 'no way out of signing with a co-signature in the window');
SELECT _assert_eq(trade_room_signing_ended_locked('00000000-0000-0000-0000-0000000000a3', 900), 'ok', 'an unsigned attempt ends');
SELECT _assert_eq((SELECT status FROM trade_rooms WHERE id = '00000000-0000-0000-0000-0000000000a3'), 'accepted', 'back to accepted');

SELECT '✓ trade-room locked transitions invariants pass' AS result;
ROLLBACK;

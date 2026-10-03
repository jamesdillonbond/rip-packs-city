-- internal_session_ids_are_tests_for_every_writer
-- anon-exec: revoked (tag_internal_session_as_test) — NEW trigger fn; REVOKE FROM PUBLIC, anon, authenticated in one statement below (a trigger fn needs no caller grant).
--
-- 2026-10-03. Internal check sessions (cowork-/smoke-/qa-/test-/internal- session ids) must never
-- count as collectors. /api/support-chat tags them since this morning (lib/concierge/visit-link.ts),
-- but support_conversations has more than one writer: the log_bug/log_feedback tool path inserted
-- row 10367 (`qa-teamchecklist-probe-…`, a HIGH "bug") as real at 11:08 AM PT, three minutes before
-- another session patched that path. A route-level rule covers only the writers that remember it.
-- This trigger covers EVERY writer, present and future, on both tables the flag lives on.
--
-- DATA (same day, execute_sql, before this migration): 35 support_conversations rows (ids
-- 9621..10367; 09-25 qa-/cowork-qa- probes + 10367) and 461 chat_sessions rows (425 smoke- from
-- 2026-05, 31 qa- from 09-25, 5 cowork-) set is_smoke_test=true by the same regex. No real
-- collector session id matches it.
--
-- REVERT:
--   DROP TRIGGER trg_tag_internal_session_as_test ON public.support_conversations;
--   DROP TRIGGER trg_tag_internal_session_as_test ON public.chat_sessions;
--   DROP FUNCTION public.tag_internal_session_as_test();

CREATE OR REPLACE FUNCTION public.tag_internal_session_as_test()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $function$
BEGIN
  -- Same prefix rule as lib/concierge/visit-link.ts isInternalCheckSessionId(): the in-product
  -- widget only sends rpc_<uuid> (or the route's anon-<uuid>), the bot bridge tg:/dc:, so an
  -- internal prefix is by construction not a collector. Only ever sets the flag, never clears it.
  IF NEW.session_id ~* '^(cowork|smoke|qa|test|internal)[-_:]' THEN
    NEW.is_smoke_test := true;
  END IF;
  RETURN NEW;
END
$function$;

REVOKE EXECUTE ON FUNCTION public.tag_internal_session_as_test() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE TRIGGER trg_tag_internal_session_as_test
  BEFORE INSERT OR UPDATE OF session_id, is_smoke_test ON public.support_conversations
  FOR EACH ROW EXECUTE FUNCTION public.tag_internal_session_as_test();

CREATE OR REPLACE TRIGGER trg_tag_internal_session_as_test
  BEFORE INSERT OR UPDATE OF session_id, is_smoke_test ON public.chat_sessions
  FOR EACH ROW EXECUTE FUNCTION public.tag_internal_session_as_test();

-- DB invariant: public.tag_internal_session_as_test — the BEFORE INSERT/UPDATE trigger that marks
-- internal check sessions as tests on support_conversations and chat_sessions (2026-10-03). Claims:
--   1. a cowork-/smoke-/qa-/test-/internal- session id is stored is_smoke_test=true even when the
--      writer said false (the row-10367 path) or said nothing;
--   2. a collector's rpc_<uuid> / anon-<uuid> / tg: session keeps whatever the writer said;
--   3. an UPDATE cannot clear the flag on an internal session;
--   4. a prefix word mid-string is not a prefix.
--
-- The function DDL below is VERBATIM from the committed migration
-- (supabase/migrations/20261003183547_internal_session_ids_are_tests_for_every_writer.sql).
-- __tests__/db-invariants-drift-guard.test.ts fails CI on drift.

BEGIN;

CREATE TABLE public.support_conversations (id bigserial PRIMARY KEY, session_id text, is_smoke_test boolean DEFAULT false);

-- >>> BEGIN verbatim >>>
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
-- <<< END verbatim <<<

CREATE TRIGGER trg_tag_internal_session_as_test
  BEFORE INSERT OR UPDATE OF session_id, is_smoke_test ON public.support_conversations
  FOR EACH ROW EXECUTE FUNCTION public.tag_internal_session_as_test();

INSERT INTO public.support_conversations (id, session_id, is_smoke_test) VALUES
  (1, 'qa-teamchecklist-probe-20261003', false),
  (2, 'cowork-billing-check-20261002', NULL),
  (3, 'Smoke_degradation_1', false),
  (4, 'rpc_1b4e28ba-2fa1-11d2-883f-0016d3cca427', false),
  (5, 'anon-1b4e28ba-2fa1-11d2-883f-0016d3cca427', false),
  (6, 'tg:12345', false),
  (7, 'rpc_qa-not-a-prefix', false),
  (8, 'rpc_real-but-writer-flagged', true);
INSERT INTO public.support_conversations (id, session_id) VALUES (9, 'internal:check');

DO $$
BEGIN
  PERFORM _assert_eq((SELECT string_agg(id::text, ',' ORDER BY id) FROM public.support_conversations WHERE is_smoke_test), '1,2,3,8,9',
    'internal prefixes are tests whatever the writer said (claim 1); collectors keep the writer''s value, incl. an explicit true (claim 2); mid-string is not a prefix (claim 4)');
  UPDATE public.support_conversations SET is_smoke_test = false WHERE id IN (1, 8);
  PERFORM _assert_eq((SELECT string_agg(id::text || ':' || is_smoke_test, ',' ORDER BY id) FROM public.support_conversations WHERE id IN (1, 8)), '1:true,8:false',
    'an UPDATE cannot clear an internal session''s flag (claim 3); a collector''s can be cleared');
END $$;

ROLLBACK;

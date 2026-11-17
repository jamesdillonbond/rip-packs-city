-- 2026-11-07 (PT) — the extra-trophy-case cap is enforced by the database.
--
-- POST /api/profile/trophy-cases counted the collector's cases and then
-- inserted, so two concurrent POSTs (a double-click) both read 9 and both
-- inserted: an 11th case past MAX_EXTRA_CASES = 10 (lib/trophy/cases.ts).
-- Fresh-eyes review of the trophy-case batch, 2026-11-07, queued as handoff item
-- 11 and fixed here. The route remains the only writer (grep: one
-- `.from("trophy_cases").insert`); it keeps its count for the friendly message
-- and maps this trigger's refusal (SQLSTATE 23514, message
-- 'trophy_case_cap_reached') to the same 409.
--
-- The trigger takes a per-user transaction-scoped advisory lock before counting,
-- so concurrent inserts for ONE user serialise and the second sees the first's
-- row; other users never wait on each other. Live at apply: 1 row in the table
-- (max per user 1), so nothing existing violates the cap.
--
-- ⚠ The 10 here MUST equal MAX_EXTRA_CASES; __tests__/trophy-cases-cap-enforced-in-db.test.ts
-- pins the two together.
--
-- Revert:
--   DROP TRIGGER IF EXISTS trophy_cases_extra_cap ON public.trophy_cases;
--   DROP FUNCTION IF EXISTS public.trophy_cases_enforce_extra_cap();

-- anon-exec: not granted — trophy_cases_enforce_extra_cap is a trigger function (REVOKE ALL below); it fires on INSERT and is never called as an RPC.

CREATE OR REPLACE FUNCTION public.trophy_cases_enforce_extra_cap()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  n integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('trophy_cases:' || NEW.user_id::text, 0));
  SELECT count(*) INTO n FROM public.trophy_cases WHERE user_id = NEW.user_id;
  IF n >= 10 THEN
    RAISE EXCEPTION 'trophy_case_cap_reached' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.trophy_cases_enforce_extra_cap() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trophy_cases_extra_cap ON public.trophy_cases;
CREATE TRIGGER trophy_cases_extra_cap
  BEFORE INSERT ON public.trophy_cases
  FOR EACH ROW EXECUTE FUNCTION public.trophy_cases_enforce_extra_cap();

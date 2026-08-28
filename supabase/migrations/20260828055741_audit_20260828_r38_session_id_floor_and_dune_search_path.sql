-- audit_20260828_r38_session_id_floor_and_dune_search_path
-- Deep-audit run 4 (2026-08-27 PT). Two hygiene fixes, batched to pay one PGRST002 window.
--
-- (1) R38: the anon INSERT policy on support_conversations allowed length(session_id) >= 1,
--     while the SELECT policy quals on session_id = request.headers->>'x-session-id' — so a
--     short or reused id is enumerable and reads back its rows (incl. user_email).
--     Active writers measured 2026-08-27 PT: smoke suite = 28 chars (449 rows, newest 08-27),
--     real clients 31–35 chars, server default 41 chars. Everything below 20 chars is inactive
--     (13-char fixture id ×34, newest 08-16; one 16-char row 08-17). Floor set to 20.
--
-- (2) Supabase advisor function_search_path_mutable on dune_budget_status(text) and
--     dune_spend_report(): both prokind='f' (FUNCTIONS, not procedures), no COMMIT in body —
--     the R14 outage class (attached SET on a COMMIT-ing procedure) does NOT apply. Both are
--     SECURITY INVOKER with no anon/authenticated EXECUTE and no cron.job caller.
--     ALTER ... SET preserves body and ACL (only CREATE OR REPLACE resets grants).
--
-- Revert:
--   ALTER POLICY anon_insert_support_conversations ON public.support_conversations
--     WITH CHECK ( same expression with (length(session_id) >= 1) );
--   ALTER FUNCTION public.dune_budget_status(text) RESET search_path;
--   ALTER FUNCTION public.dune_spend_report() RESET search_path;

ALTER POLICY anon_insert_support_conversations ON public.support_conversations
WITH CHECK (
  ((length(session_id) >= 20) AND (length(session_id) <= 128))
  AND ((length(user_message) >= 1) AND (length(user_message) <= 4096))
  AND ((length(bot_response) >= 0) AND (length(bot_response) <= 16384))
  AND ((escalation_reason IS NULL) OR (length(escalation_reason) <= 256))
  AND ((category IS NULL) OR (length(category) <= 64))
  AND ((user_wallet IS NULL) OR (length(user_wallet) <= 32))
  AND ((page_context IS NULL) OR (length(page_context) <= 256))
  AND ((feedback IS NULL) OR (length(feedback) <= 64))
  AND ((owner_key IS NULL) OR (length(owner_key) <= 64))
  AND ((feedback_type IS NULL) OR (length(feedback_type) <= 32))
  AND ((feedback_summary IS NULL) OR (length(feedback_summary) <= 512))
  AND ((feedback_details IS NULL) OR (length(feedback_details) <= 4096))
  AND ((feedback_status IS NULL) OR (length(feedback_status) <= 32))
  AND ((admin_note IS NULL) OR (length(admin_note) = 0))
  AND ((user_email IS NULL) OR (length(user_email) <= 320))
);

ALTER FUNCTION public.dune_budget_status(text) SET search_path = public, pg_temp;
ALTER FUNCTION public.dune_spend_report() SET search_path = public, pg_temp;

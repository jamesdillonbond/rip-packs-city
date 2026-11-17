-- Item 1 of the 2026-07-20 security-advisor cleanup handoff.
-- Advisor: function_search_path_mutable. Both fns had proconfig=(none); neither is SECDEF.
-- ALTER FUNCTION preserves grants (unlike CREATE OR REPLACE), so no re-grant needed.
-- Revert: ALTER FUNCTION ... RESET search_path; on both.
ALTER FUNCTION public.panini_editions_touch_updated_at() SET search_path = public, pg_temp;
ALTER FUNCTION public.panini_serial_premium_mult(p_is_jersey boolean, p_is_perfect boolean, p_is_num1 boolean) SET search_path = public, pg_temp;

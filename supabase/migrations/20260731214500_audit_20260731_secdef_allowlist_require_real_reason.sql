-- The 2026-07-20 hole was not a broken sentinel -- it was 49 allowlist rows
-- accepted in bulk under one note ('baseline 2026-07-20 (handoff item 4)'), which
-- let an UNAUTHORIZED writer sit inside a permanently-green drift check. The
-- sentinel answers "has this changed since the baseline?"; nothing answered "was
-- the baseline safe?". Make the second question unskippable at write time.
--
-- Every row must now carry a substantive, per-function reason. This blocks the
-- exact failure mode: a bulk import that rubber-stamps a batch under one label.
--
-- Revert: ALTER TABLE public.secdef_anon_exec_allowlist DROP CONSTRAINT secdef_allowlist_note_is_a_real_reason;

ALTER TABLE public.secdef_anon_exec_allowlist
  ADD CONSTRAINT secdef_allowlist_note_is_a_real_reason CHECK (
    note IS NOT NULL
    AND length(btrim(note)) >= 40
    AND btrim(lower(note)) NOT LIKE 'baseline%'
  );

COMMENT ON CONSTRAINT secdef_allowlist_note_is_a_real_reason ON public.secdef_anon_exec_allowlist IS
  'Each acceptance must state WHY this SECDEF fn is client-executable: which client reaches it (anon / session / indirectly via a SECURITY INVOKER caller) and why that is safe. Bulk "baseline" labels are rejected -- they are how the 2026-07-20 surface went unvalidated for 11 days.';

COMMENT ON TABLE public.secdef_anon_exec_allowlist IS
  'Accepted anon/authenticated-EXECUTABLE SECURITY DEFINER functions. check_secdef_anon_exec_drift() flags any client-executable SECDEF fn NOT listed here (-> get_pipeline_alerts -> Telegram/email at HIGH). Before adding a row, resolve every caller''s CLIENT BINDING, not the identifier name: in this repo `supabase` is usually the SERVICE-ROLE client (9+ files import `supabaseAdmin as supabase`). If every caller is service_role, REVOKE instead of allowlisting. Also check INVOKER-mode callers (functions and views), which execute the callee as the caller.';

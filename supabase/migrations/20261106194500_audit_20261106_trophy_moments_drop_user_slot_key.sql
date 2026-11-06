-- audit_20261106_trophy_moments_drop_user_slot_key
--
-- Follow-up to audit_20261106_multiple_trophy_cases_and_challenges. Apply ONLY
-- AFTER the route change that upserts `onConflict: "user_id,case_id,slot"` is
-- live in production (the previously deployed route upserted on
-- "user_id,slot", which needs this constraint as its arbiter — dropping it first
-- would make every main-case pin fail with 42P10 until the deploy lands).
--
-- Why it must go: (user_id, slot) allows ONE slot 1 per user across ALL cases,
-- so a pin into a challenge case's slot 1 collides with the main case's slot 1.
-- trophy_moments_user_case_slot_key (user_id, case_id, slot) NULLS NOT DISTINCT,
-- added by the previous migration, is the uniqueness rule from here on — the
-- main case (case_id NULL) still holds exactly one row per slot.
--
-- Revert (only while no case has a pin in a slot number the main case also uses):
--   alter table public.trophy_moments add constraint trophy_moments_user_slot_key unique (user_id, slot);

alter table public.trophy_moments drop constraint trophy_moments_user_slot_key;

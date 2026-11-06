-- audit_20261106_allowlist_trophy_cases_public_reads
--
-- The two public SECDEF reads added by 20261106194000 (multiple trophy cases)
-- are anon-executable by design — app/api/public/trophy-cases and
-- app/api/public/trophy-challenges/[slug] call them through the anon client,
-- exactly like get_trophy_slab_data_by_username (allowlisted 2026-07-21). The
-- handoff expected check_secdef_anon_execute_violations() = [] after apply; it
-- read these two until this row pair landed. Revert: DELETE the two rows by identity.

INSERT INTO public.secdef_anon_exec_allowlist (identity, note) VALUES
 ('get_trophy_cases_by_username(text)', 'anon REQUIRED: read through the anon client by app/api/public/trophy-cases (public profile extra cases). Same posture as get_trophy_slab_data_by_username — returns only pins trophy_moments_select_public already exposes, keyed by the username the caller supplied. 2026-11-06, multiple trophy cases.'),
 ('get_trophy_challenge_entries(text,integer)', 'anon REQUIRED: read through the anon client by app/api/public/trophy-challenges/[slug] (the public challenge board). Exposes usernames + their pinned trophies, both already public on each profile. 2026-11-06, Dame Time challenge.')
ON CONFLICT DO NOTHING;

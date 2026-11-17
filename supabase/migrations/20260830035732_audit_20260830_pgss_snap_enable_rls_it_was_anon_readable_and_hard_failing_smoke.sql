-- audit_20260830_pgss_snap_enable_rls_it_was_anon_readable_and_hard_failing_smoke
--
-- FIXES A HARD FAIL ON MAIN. The production smoke suite's security arm
-- ("public base tables: RLS on + no anon write") has been red on every commit
-- since ~03:5xZ with exactly one violation:
--     rls_off_base_table:audit_20260830_pgss_snap
--
-- WHAT IT ACTUALLY EXPOSED, measured rather than assumed: anon and
-- authenticated BOTH held SELECT on this table
-- (has_table_privilege('anon', ..., 'SELECT') = true), so a pg_stat_statements
-- snapshot -- internal query TEXT, call counts and IO figures for ~4,759
-- statements -- was readable through PostgREST by anyone. No user PII, but it
-- publishes the shape of the whole query surface, and it is the kind of thing
-- an attacker reads before probing. anon INSERT was already false.
--
-- WHY *ENABLE RLS* AND NOT *DROP*: this is another session's in-flight
-- measurement table (created ~03:2xZ, 4,759 rows, no cron writer -- a one-off
-- snapshot, not a live sampler). Dropping it would destroy a baseline somebody
-- is mid-way through using. Enabling RLS is non-destructive, cannot break the
-- owning session (service_role and postgres BYPASS RLS; only anon/authenticated
-- lose the read), and is EXACTLY the convention every one of its ~100 sibling
-- audit_* tables already follows -- several of them say so in their own COMMENT:
-- "RLS on, no policies: service_role only." This table is the ONLY audit_*
-- base table in public with relrowsecurity = false.
--
-- ⚠ NOT A WILDCARD. Named explicitly. Other sessions write into the same
-- audit_20260830_ date prefix and a prefix-drop would take their work with it.
--
-- REVERT: ALTER TABLE public.audit_20260830_pgss_snap DISABLE ROW LEVEL SECURITY;
--         (which re-opens the anon read -- prefer dropping the table instead
--          once its owner is done with it.)

ALTER TABLE public.audit_20260830_pgss_snap ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.audit_20260830_pgss_snap IS
  'pg_stat_statements snapshot (one-off, 2026-08-30). RLS on, no policies: service_role only -- the standing convention for audit_* tables here. RLS was ENABLED after the fact by a sibling session because the table was anon/authenticated SELECTable and hard-failed the smoke suite''s "public base tables: RLS on" arm on every commit. Owner: drop it when the measurement is finished; do not wildcard-drop the audit_20260830_ prefix, other sessions share it.';

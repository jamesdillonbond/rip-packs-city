-- audit_20260919_r110_edge_lane_observability_registry
--
-- ── R110's EXIT CONDITION ─────────────────────────────────────────────────────
-- Five of the twelve active cron jobs that POST to `/functions/v1/` write NO
-- `pipeline_runs` row, so every sentinel pipeline arm is out of scope for them
-- BY CONSTRUCTION (all are scoped to `pipeline_cadence_watchlist` over
-- `pipeline_runs`, and the key never appears). Two of those five were DEAD for
-- 6 and 7 days on 2026-09-19 with pg_cron recording 955 `succeeded` dispatches a
-- day, because `net.http_post` succeeds when the POST is ENQUEUED.
--
-- ⭐ THE SHAPE THAT SCALES IS A BAN AT ZERO, NOT AN ALLOWLIST OF PROBLEMS.
-- So this registry does not enumerate broken lanes - it enumerates KNOWN ones,
-- and `check_edge_lane_observability()` reports any ACTIVE edge-function cron
-- job that is NOT in it. A new edge lane is UNOBSERVED-BY-DEFAULT and says so.
--
-- ⚠ A registry row may legitimately carry NO outcome check. Those are REPORTED
-- SEPARATELY as `unchecked` rather than counted clean, so "nobody wired a check"
-- never reads as "the check passes". The CHECK constraint forces a `note`.
--
-- ⚠ THE FUNCTION ASSERTS THE COUNT IT INSPECTED. `inspected: 0` (a rebuilt
-- database with no pg_cron estate, or a renamed job set) must be read as
-- UNMEASURED - a verdict from zero lanes is not a verdict.
--
-- ⚠ Dynamic SQL is built with `format('%I')` on IDENTIFIERS ONLY. The registry
-- holds table/column NAMES, never SQL text - a column holding an executable
-- predicate would be an injection surface inside a SECURITY DEFINER function.
--
-- ⚠ SUPERSEDED IN PART by `20260919181934`, which adds `observed_via` /
-- `pipeline_name` and rewrites the function. This file is the repo's record of
-- what was applied first; read both.
--
-- REVERT:
--   DROP FUNCTION public.check_edge_lane_observability();
--   DROP TABLE public.edge_lane_watch;

CREATE TABLE IF NOT EXISTS public.edge_lane_watch (
  jobname        text PRIMARY KEY,
  fn_name        text        NOT NULL,
  outcome_table  text,
  outcome_column text,
  max_age_hours  numeric,
  severity       text        NOT NULL DEFAULT 'warn',
  is_active      boolean     NOT NULL DEFAULT true,
  note           text        NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT edge_lane_watch_severity_ck
    CHECK (severity IN ('info','warn','critical')),
  -- An outcome check is all-or-nothing: a table without a column or an age
  -- bound would silently check nothing.
  CONSTRAINT edge_lane_watch_outcome_complete_ck
    CHECK ( (outcome_table IS NULL AND outcome_column IS NULL AND max_age_hours IS NULL)
         OR (outcome_table IS NOT NULL AND outcome_column IS NOT NULL AND max_age_hours IS NOT NULL) )
);

COMMENT ON TABLE public.edge_lane_watch IS
  'Registry of pg_cron jobs that POST to a Supabase edge function. Those lanes '
  'write no pipeline_runs row, so no sentinel pipeline arm can see them. '
  'check_edge_lane_observability() reports any ACTIVE edge-function cron job '
  'absent from this table - unobserved-by-default. See register R110.';

COMMENT ON COLUMN public.edge_lane_watch.outcome_table IS
  'Table whose freshness stands in for "this lane did work". NULL means no '
  'outcome check exists; the row is then reported as `unchecked`, never as '
  'clean, and `note` must say why.';

ALTER TABLE public.edge_lane_watch ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.edge_lane_watch FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.edge_lane_watch TO postgres, service_role;

-- The function body applied here is superseded by 20260919181934; see that file
-- for the current definition (this migration's version differed only in that it
-- had no observed_via / pipeline_name handling).

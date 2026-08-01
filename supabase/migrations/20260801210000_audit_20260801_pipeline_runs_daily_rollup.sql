-- audit_20260801_pipeline_runs_daily_rollup
--
-- Durable daily rollup of pipeline_runs.
--
-- WHY: prune_pipeline_runs(3) keeps ~73h of raw rows, but real defects on this
-- platform are typically noticed days-to-weeks after onset (AllDay serial supply
-- ~18d; the 07-28 /api/wallet/seed event ~4d; three stale DB pins, weeks-months).
-- Measured 2026-08-01: 39,245 rows / 133 pipelines / 73.4h / ~12.8k rows per day.
-- Only 1 of 5 findings in the 07-31→08-01 wave was still inside that window, so
-- "no matching record in pipeline_runs" kept reading as a finding when it was an
-- artifact of retention.
--
-- Forensics never needed individual run rows from weeks ago -- only "what did this
-- pipeline's day look like, and when did it change". So: keep the raw window short,
-- retain the daily SHAPE indefinitely (~133 rows/day, ~48k/yr -- negligible).
--
-- NOTE: this CANNOT be backfilled beyond the raw retention window that existed at
-- creation time. History starts 2026-07-29 and the 07-29 row is permanently partial.
--
-- NOTE: the migration as applied also created a first version of
-- rollup_pipeline_runs() which failed immediately (pipeline_runs.duration_ms is a
-- GENERATED column and cannot be supplied on INSERT). It was superseded within the
-- same session by audit_20260801_rollup_pipeline_runs_fix_generated_duration, which
-- holds the live definition. Only the table DDL from this migration survives here.

CREATE TABLE IF NOT EXISTS public.pipeline_runs_daily (
  pipeline          text        NOT NULL,
  day               date        NOT NULL,           -- UTC day of started_at
  runs              integer     NOT NULL,
  ok_count          integer     NOT NULL,
  fail_count        integer     NOT NULL,
  rows_found        bigint,
  rows_written      bigint,
  rows_skipped      bigint,
  duration_ms_avg   integer,
  duration_ms_p95   integer,
  duration_ms_max   integer,
  first_run_at      timestamptz,
  last_run_at       timestamptz,
  collection_slugs  text[],
  last_error        text,
  extra_key_counts  jsonb,                          -- {extra_key: n} -- payload-shape drift
  refreshed_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (pipeline, day)
);

COMMENT ON TABLE public.pipeline_runs_daily IS
  'Indefinite daily rollup of public.pipeline_runs (which is pruned to ~3 days). One row per (pipeline, UTC day). Written by rollup_pipeline_runs(); cron rpc-pipeline-runs-daily-rollup. Cannot be backfilled beyond the raw retention window at creation time (2026-07-29).';
COMMENT ON COLUMN public.pipeline_runs_daily.day IS
  'UTC calendar day of started_at (DB runs UTC; PT is -7/-8).';
COMMENT ON COLUMN public.pipeline_runs_daily.extra_key_counts IS
  'Per-day count of each pipeline_runs.extra JSONB key. Catches payload-shape changes (e.g. a pipeline starting to emit terminated_reason) without pinning 627 heterogeneous keys to columns.';

-- Ops table: service_role only. RLS on with NO policies = deny-all to anon/authenticated
-- (matches sibling public.pipeline_run_locks). The Supabase linter reports this as an
-- INFO rls_enabled_no_policy; that is the intended posture, not a defect.
ALTER TABLE public.pipeline_runs_daily ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.pipeline_runs_daily FROM anon, authenticated;

CREATE INDEX IF NOT EXISTS pipeline_runs_daily_day_idx
  ON public.pipeline_runs_daily (day DESC);

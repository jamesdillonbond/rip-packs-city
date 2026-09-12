-- rpc_trust_health_history — the series the go-live gates are read from, which
-- until now did not exist.
--
-- WHY. `rpc_trust_health_precompute` has PRIMARY KEY (metric) — ONE row per
-- metric, overwritten every leg. It is a latest-value store, so it CANNOT
-- produce a series, and every historical reading in
-- docs/strategy/go-live-2026-09.md was captured by hand by whoever happened to
-- be looking at that leg.
--
-- 🚨 THAT IS WHY THE HEADLINE GATES KEEP BEING MISREAD. The doc's own rule is
-- "no single leg is a level for M2 while the sweep is mid-cycle" and "a go-live
-- gate that swings 5 points on cursor position cannot be read from one leg —
-- quote a full-sweep reading or a matched comparison, never a leg". That rule is
-- UNFOLLOWABLE against a table with no history: M2 has gone 22.59 → 24.07 → 28.3
-- → 23.0 inside nine hours, the 28.3 was recorded as a +4.9-point gain and then
-- RETRACTED, and M1's "two consecutive readings below 50" trigger was evaluated
-- from two hand-noted numbers. A reader arriving later has one number and no way
-- to tell where in the sweep it was taken.
--
-- WHAT THIS DOES, and deliberately NOTHING ELSE: an append-only copy, captured
-- by a pg_cron job that reads the precompute. ⭐ The precompute itself, the
-- function that writes it, and every existing reader are UNTOUCHED — this adds a
-- new object beside them rather than changing one, which is also the only shape
-- of DB change a no-push session can safely make (CLAUDE.md).
--
-- ⭐ PRIMARY KEY (metric, computed_at) IS THE DESIGN, not bookkeeping. It makes
-- the capture IDEMPOTENT: the job may run far more often than the legs and every
-- repeat is a no-op via ON CONFLICT DO NOTHING. So the capture cadence only has
-- to be FASTER than the fastest metric's refresh — it never has to match it, and
-- there is no de-duplication logic to get wrong. It also gives "the last N legs
-- of one metric" a backward index scan for free, so no second index is needed.
--
-- CADENCE: every 10 minutes. Metrics here refresh at different rates (seen in one
-- sample: most at 07:48Z, `pinnacle_fmv_high_med_share_pct` at 03:55Z), so the
-- interval is set by the FASTEST of them and not by the ~6-hourly headline legs.
-- Cost is 29 rows read and at most 29 written, against an estate already
-- dispatching ~9,134 pg_cron runs per 24 h.
--
-- ⚠ SENTINELS ARE STORED AS PUBLISHED, NOT CLEANED. `-1` means "the share has no
-- denominator" and `999` means "the leg threw" (migration 20260910230812). A
-- history that silently dropped them would make a broken leg look like a missing
-- one, which is the same absence-vs-zero confusion recorded against
-- `pipeline_runs` in register #79.
--
-- ⚠ NO RETENTION POLICY, ON PURPOSE. 29 metrics × ~4 legs/day is ~42k rows a
-- year; a long series is the entire point, and a retention window would recreate
-- the problem this table exists to solve. Revisit if it ever passes ~1M rows.
--
-- SECURITY: mirrors the precompute exactly — RLS enabled (not forced), zero
-- policies, anon and authenticated hold nothing, `service_role` holds ALL. The
-- capture job runs as `postgres`, the table owner (83 of the 139 pg_cron jobs
-- already do), so RLS does not block it and no SECURITY DEFINER function is
-- needed. ⭐ Deliberately NO new function at all: putting the INSERT inline in
-- the cron command avoids a SECDEF grant to get wrong, a DB-invariant pin to
-- keep, and a `check_secdef_anon_exec_drift()` entry to re-verify.
-- anon-exec: n/a — this migration creates no function.
--
-- REVERT (two statements, no data loss elsewhere):
--   SELECT cron.unschedule('rpc-trust-health-history');
--   DROP TABLE public.rpc_trust_health_history;

CREATE TABLE IF NOT EXISTS public.rpc_trust_health_history (
  metric      text        NOT NULL,
  value       numeric,
  computed_at timestamptz NOT NULL,
  captured_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rpc_trust_health_history_pkey PRIMARY KEY (metric, computed_at)
);

ALTER TABLE public.rpc_trust_health_history ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.rpc_trust_health_history FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.rpc_trust_health_history TO service_role;

COMMENT ON TABLE public.rpc_trust_health_history IS
  'Append-only history of rpc_trust_health_precompute, which is keyed on metric alone and therefore keeps none. Exists because the go-live gates (M1/M2) cannot be read from a single leg — M2 swung 22.59 -> 24.07 -> 28.3 -> 23.0 in nine hours on sweep position and the 28.3 was recorded as a gain and retracted. PK (metric, computed_at) makes capture idempotent, so the 10-minute job may run far faster than the legs. Sentinels are stored as published: -1 = no denominator, 999 = the leg threw.';

COMMENT ON COLUMN public.rpc_trust_health_history.computed_at IS
  'The leg''s own stamp, copied from the precompute — NOT when this row was captured. Half of the PK, so re-capturing the same leg is a no-op.';
COMMENT ON COLUMN public.rpc_trust_health_history.captured_at IS
  'When this snapshotter observed the leg. captured_at - computed_at is the capture lag; a lag approaching a metric''s refresh interval means the job is too slow and a leg could be missed.';

-- Seed from the current values so the series starts now rather than at the next
-- leg. ON CONFLICT makes this safe to re-run.
INSERT INTO public.rpc_trust_health_history (metric, value, computed_at)
SELECT metric, value, computed_at
  FROM public.rpc_trust_health_precompute
 WHERE computed_at IS NOT NULL
ON CONFLICT (metric, computed_at) DO NOTHING;

-- ── THE CAPTURE JOB ─────────────────────────────────────────────────────────
-- Applied via execute_sql rather than in the apply_migration transaction above,
-- because cron.schedule is not DDL. Recorded here so the file reproduces the
-- whole change: cron.schedule UPSERTS BY JOBNAME, so re-running it is idempotent
-- exactly like the INSERT above. Created as jobid 488, owner `postgres`.
SELECT cron.schedule(
  'rpc-trust-health-history',
  '*/10 * * * *',
  $job$INSERT INTO public.rpc_trust_health_history (metric, value, computed_at)
SELECT metric, value, computed_at FROM public.rpc_trust_health_precompute
 WHERE computed_at IS NOT NULL
ON CONFLICT (metric, computed_at) DO NOTHING$job$
);

-- ── VERIFICATION, run against production 2026-09-12 02:3x PT ────────────────
-- 1. SEEDED: 29 rows / 29 distinct metrics / 8 distinct legs (the precompute
--    refreshes different metrics at different times, so "one leg" is per-metric).
-- 2. SECURITY mirrors the precompute exactly: RLS true, anon SELECT false,
--    authenticated false, service_role true.
-- 3. JOB: `rpc-trust-health-history | */10 * * * * | active=true | as=postgres`.
-- 4. ⭐ IDEMPOTENCE, measured rather than argued: re-running the capture against
--    an unchanged precompute inserted **0 rows** and left the count at 29.
-- 5. ⭐ POSITIVE CONTROL, because an idempotence test alone would also pass for a
--    capture that writes NOTHING: inserting a synthetic new (metric, computed_at)
--    did land, and was then deleted (0 `zz_%` rows remain).
--    ⚠ Worth recording how that control misled me first: I wrote insert, verify
--    and delete as three CTEs of ONE statement, and the verify and delete read
--    the pre-statement snapshot, so they reported "not visible, nothing deleted"
--    while the row had in fact been inserted and left behind. **CTEs in one
--    statement do not see each other's writes** — the probe row had to be cleaned
--    up in a separate statement. A self-cleaning probe needs separate statements,
--    or it is neither self-cleaning nor a probe.

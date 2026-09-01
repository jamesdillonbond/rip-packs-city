-- audit_20260901_catalog_comments_lock_check_fanout_and_smoke_clock_gate
--
-- COMMENT-ONLY migration. No DDL that changes behaviour, no function bodies, no ACLs.
-- (No `-- anon-exec:` marker is required or appropriate: this migration does not CREATE OR REPLACE
--  any function, it only attaches COMMENT metadata.)
--
-- WHY: two findings from 2026-09-01 that a future reader will meet at the DB, not in the repo.
-- CLAUDE.md's own lesson is that a finding living only in a transcript is lost; a COMMENT is the
-- one channel that travels with the object itself, so `\df+` / pg_description carries the warning
-- to whoever opens the function next — including a session with no repo access.
--
-- ⓘ This migration is ALSO the live end-to-end test of the commit-and-push branch of
-- .github/workflows/migration-autorecover.yml. That branch had never executed until today: the
-- dry-run dispatch skipped it (it is gated on recovered != 0) and its first two real scheduled runs
-- failed on a self-inflicted stray-file guard (fixed in the preceding commit). Applying a genuinely
-- useful migration via apply_migration leaves it fileless by construction, which is exactly the
-- condition the workflow exists to clear. If you are reading this file in git, the workflow
-- committed it and the branch works.
--
-- REVERT: COMMENT ON ... IS NULL for each object below.

COMMENT ON FUNCTION public.get_lock_check_batch(text, integer, integer) IS
  'Lock-check queue picker. MEASURED 2026-09-01 — the #5 consumer on this instance at ~21,261 '
  'shared_blks_read and ~16.5 s per call, ~97 calls/day (~17 GB/day of disk reads). '
  'THE COST IS THE PRIORITY LEG, NOT THE BASE LEG: the `hot` CTE (seeded_wallets UNION '
  'saved_wallets UNION both linked_accounts sides) resolved to 584 wallets, and the second branch '
  'of the CROSS JOIN LATERAL runs one further LATERAL per hot wallet PER COLLECTION — 584 x 7 = '
  '~4,088 index probes, each allowed up to p_limit rows, materialising up to ~29k rows per '
  'collection before the outer ORDER BY / LIMIT throws nearly all of them away to return 50. '
  'The base leg is cheap (idx_wmc_lockcheck_order serves it directly) and 76%% of wallet_moments_cache '
  '(1,907,838 of 2,506,641) is due, so the base leg never has to look far. '
  '⛔ DO NOT simply lower the inner LIMIT: in the worst case a single hot wallet legitimately supplies '
  'all p_limit output rows, so the inner limit is load-bearing for correctness. A real fix has to '
  'change the SHAPE (e.g. one ordered pass over (collection_id, lock_checked_at) restricted to hot '
  'wallets) and must be measured on BUFFERS, not wall-clock — and note this is LANGUAGE sql, so it is '
  'planned param-blind: EXPLAIN the FUNCTION, never the body with literals.';

COMMENT ON FUNCTION public.analytics_smoke_run() IS
  'Public-surface smoke suite. Called by cron-job.org "RPC Analytics Smoke" (13,43 — 48x/day) via '
  '/api/admin/analytics-smoke. '
  'The integrity_fmv_snapshots_collection_drift check is CLOCK-GATED (2026-09-01): the 08:13Z tick '
  'runs the full-history sweep over all of fmv_snapshots; every other tick runs the same predicate '
  'bounded to computed_at > now() - 2h. Measured: 28,862 buffers / 1,496 ms full vs 310 buffers / '
  '12.8 ms bounded, and at a 30-minute cadence a 2-hour window covers every write 4x. '
  '⚠ The gate is a CLOCK gate and not merely a window on purpose: computed_at is BUSINESS time and '
  'is also the partition key, and this table has no insert-time column, so a backfill writing rows '
  'with old computed_at would never enter a bounded window. Do not "simplify" it to the window alone. '
  '⚠ To tell which branch ran, read the check''s `ms` in pipeline_runs.extra->checks (~15 ms bounded, '
  '~500-1500 ms full) — the route stores only {name,severity,ms} and DROPS `detail`, so the `scope` '
  'key the function emits is NOT visible there. '
  '⚠ SLOT RISK, measured and NOT yet fixed: whole runs of this suite are recorded as '
  '{"inconclusive": true, "checks": []} when the DB is saturated — 72.7%% / 46.8%% / 2.1%% / 7.5%% of '
  'runs on 08-29 / 08-30 / 08-31 / 09-01. The 09-01 08:13Z run was one of them, so that day got NO '
  'full-history sweep. This is a pre-existing saturation class, NOT caused by the clock gate (cheap-branch '
  'slots 01:13Z and 13:13Z were inconclusive the same day), but it does mean once-daily coverage is '
  'only as reliable as one slot. Prefer making the full check exact-and-cheap over moving the slot.';

DO $mig$
DECLARE v_a text; v_b text;
BEGIN
  SELECT obj_description('public.get_lock_check_batch(text, integer, integer)'::regprocedure, 'pg_proc') INTO v_a;
  SELECT obj_description('public.analytics_smoke_run()'::regprocedure, 'pg_proc') INTO v_b;
  IF v_a IS NULL OR v_a NOT LIKE '%4,088 index probes%' THEN
    RAISE EXCEPTION 'POST-STATE FAILED: get_lock_check_batch comment missing';
  END IF;
  IF v_b IS NULL OR v_b NOT LIKE '%CLOCK-GATED%' THEN
    RAISE EXCEPTION 'POST-STATE FAILED: analytics_smoke_run comment missing';
  END IF;
END
$mig$;
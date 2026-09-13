-- Register #103: `portfolio_snapshots` is missing every row for 8 of the last 30
-- days (~22 owners each) — a user-facing value-over-time chart with eight holes in
-- a month. ⭐ NOT a detection failure: each missing day shows `runs = 1, ok = 0`.
-- The lane ran, failed, and said so. Nothing acted on it.
--
-- THE DEFECT IS THE ABSENCE OF A RETRY. `snapshot_all_user_portfolios()` writes for
-- CURRENT_DATE only and the lane fires once a day at 00:05 PT, so a single
-- transient failure costs that day PERMANENTLY — the next day's run writes the next
-- day and nothing ever revisits. Eight statement timeouts became eight holes.
--
-- ⭐ WHY A RETRY IS SAFE, verified rather than assumed:
--   · The function ends `ON CONFLICT DO NOTHING` — STRICTLY IDEMPOTENT. A second
--     run on a day the primary already wrote inserts nothing and cannot overwrite.
--   · It takes no arguments and is SECURITY DEFINER; `has_function_privilege
--     ('postgres', …, 'EXECUTE')` = true.
--   · pg_cron calls it DIRECTLY — no HTTP, no pg_net. That matters: pg_net answers
--     a batch when its slowest member finishes, which is what made jobid 55
--     head-of-line block the platform (2026-09-03). A direct SQL call cannot.
--
-- ⭐ WHY 11:17 UTC, and it is not arbitrary. CURRENT_DATE is evaluated in the
-- server's zone (UTC), so any run in the same UTC day fills the same row. The
-- primary fires 07:05 UTC (00:05 PT) — which is INSIDE a wallet-backfill wave hour
-- (waves run hours 0/1 and 12/13 PT), and register #104 measures that unrelated
-- lanes run materially slower under that fan-out. The 2026-09-12 failure was
-- `canceling statement due to statement timeout` at 120,572 ms, i.e. the global
-- cap. So the retry is placed in a QUIET hour rather than beside the primary:
-- 11:17 UTC = 04:17 PT. Slot verified free (0 jobs at 11:17; minute 17 avoids the
-- documented 0/1/20/21/40/41 stagger ban).
--
-- ⚠ EXPECTED EFFECT, stated so it is falsifiable: the observed primary failure rate
-- is 1 day in 14 (~7%). One independent retry should take the permanent-hole rate
-- to roughly 0.5%. FALSIFIED if a day still ends with no `portfolio_snapshots` row
-- while this job reports success, which would mean the retry runs but does not
-- cover the same date — check `snapshot_date` against the job's UTC run time first.
--
-- ⚠ It costs a full extra execution (~10 s normally) every day, including days the
-- primary succeeded, because DO NOTHING still evaluates the query. That is the
-- price of the guarantee and is accepted deliberately.
--
-- REVERT: SELECT cron.unschedule('rpc-portfolio-snapshot-retry');

SELECT cron.schedule(
  'rpc-portfolio-snapshot-retry',
  '17 11 * * *',
  $$SELECT public.snapshot_all_user_portfolios();$$
);

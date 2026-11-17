-- audit_20260822_dune_walk_cost_measured_not_inferred
--
-- Corrects the sizing in audit_20260822_dune_min_start_must_exceed_the_walk,
-- which I applied twenty minutes ago. The correction came from running that
-- migration's OWN re-derivation query, which is the only reason it was caught.
--
-- 🚨 TWO NUMBERS, AND NEITHER IS THE ONE I USED.
--   `pipeline_runs.rows_found` on the last walks:            114,083 rows
--   `count(*) from topshot_ownership where source='dune'`:   146,100 rows
-- They measure different things. The first is what the EXECUTION returned — the
-- rows actually bought. The second is the TABLE, which accumulates across
-- executions and keeps rows that a later, smaller execution no longer carries.
-- The walk pays for the first. My migration told the next operator to re-derive
-- from the second, which overstates by 28%.
--
-- ⚠ But the overstatement is the SAFE direction and the table count is the right
-- SIZING bound, for a reason that is not obvious: the reservation has to cover
-- the largest execution that might arrive, not the last one that did. A "current
-- ownership" result set grows with mints, and this lane's own history shows it
-- moving (the dune leg has been at 149,527 rows). Sizing to the last sample
-- would put the lane back into the failure this whole budget exists to prevent —
-- a walk that starts and cannot finish.
--
-- 🚨 THE CONSEQUENCE, STATED PLAINLY BECAUSE IT IS THE HEADLINE. At 146,100 rows
-- x 6 columns a full walk is **876,600 datapoints — 87.7% of the 1,000,000-per-
-- cycle plan.** Not 68%. ONE walk is very nearly the entire month, and there is
-- no configuration of this table that changes that. The allocation below is
-- therefore sized to let ownership take one walk and leave ~100,000 datapoints
-- (10%) for everything else, which is the operator's stated priority — ownership
-- first, the remainder is a shared pool — carried to its arithmetic conclusion.
--
-- ⚠ THIS IS A CONFIGURATION, NOT A FIX. A lane that needs 88% of a monthly
-- budget per run cannot be run weekly, and the budget will now say so (three of
-- four weekly ticks will log `budget_stopped`) instead of discovering it as a
-- 402. The actual fixes are outside SQL and are the operator's call:
--   1. INCREMENTAL MODE — the route already supports it (`DUNE_OWNERSHIP_INCREMENTAL`
--      + `DUNE_OWNERSHIP_BATCH_SETS`), but the Dune query needs a `{{set_ids}}`
--      parameter. Each run then buys a bounded slice and coverage advances every
--      week instead of once a month.
--   2. CADENCE — move the cron-job.org schedule from weekly to monthly, which
--      matches what the plan can actually buy. The on-chain walk
--      (`ownership-onchain-walk`, free) is the daily freshness leg; Dune is the
--      parity bootstrap.
--   3. FEWER COLUMNS — datapoints are rows x COLUMNS, so dropping one of the six
--      is a flat 16.7% saving. All six are used by the mapper today.
--
-- ⚠ RE-DERIVE FROM THE LEDGER, WHICH NOW EXISTS AND KEEPS INDEFINITELY:
--   select occurred_at::date, sum(datapoints_est) as walk_datapoints, sum(rows_returned) as rows
--     from public.dune_api_usage
--    where pipeline = 'ownership-sync-dune' and endpoint = 'results'
--    group by 1 order by 1 desc;
-- That is the measured cost of each real walk. Until a walk has run under the
-- ledger, `count(*) * 6` from topshot_ownership is the upper-bound stand-in used
-- here.

update public.dune_budget_allocation
   set reserved_datapoints  = 900000,
       cap_datapoints       = 900000,
       min_start_datapoints = 880000,
       note = 'MEASURED 2026-08-22: 146,100 dune-sourced rows x 6 columns = 876,600 dp = 87.7% of the 1,000,000/cycle plan. Sized to the TABLE (the bound on the largest execution that might arrive), not to the last execution''s 114,083 rows, because a reservation that the workload outgrows fails as a lane that stops starting. One walk per cycle is all this plan buys; incremental mode or a monthly cadence is the way out. Re-derive from dune_api_usage, not from pipeline_runs.',
       updated_at = now()
 where pipeline = 'ownership-sync-dune';

-- The backfill lanes share what one ownership walk leaves. Stated explicitly so
-- nobody reads the earlier 300,000 and plans a backfill around it.
update public.dune_budget_allocation
   set cap_datapoints = 100000,
       note = note || ' Cap cut to 100,000 on 2026-08-22: one ownership walk is 87.7% of the cycle, so this is what remains.',
       updated_at = now()
 where pipeline in ('sales-ingest-dune', 'sales-seller-recovery-dune');

update public.dune_budget_state
   set day_datapoint_cap = 900000,
       updated_at = now()
 where id = 1;

-- REVERT (to the state after audit_20260822_dune_min_start_must_exceed_the_walk):
--   update public.dune_budget_allocation
--      set reserved_datapoints = 750000, cap_datapoints = 750000, min_start_datapoints = 700000
--    where pipeline = 'ownership-sync-dune';
--   update public.dune_budget_allocation set cap_datapoints = 300000
--    where pipeline in ('sales-ingest-dune', 'sales-seller-recovery-dune');
--   update public.dune_budget_state set day_datapoint_cap = 800000 where id = 1;

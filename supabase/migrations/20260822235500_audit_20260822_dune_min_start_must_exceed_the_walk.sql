-- audit_20260822_dune_min_start_must_exceed_the_walk
--
-- Correction to the allocation seeded minutes earlier in
-- audit_20260822_dune_two_meter_budget_and_allocation.
--
-- 🚨 THE GATE WAS SET BELOW THE THING IT GATES. `min_start_datapoints` exists so
-- `ownership-sync-dune` never starts a walk it cannot finish — a partial walk
-- spends datapoints AND leaves the table capped at the offset reached, because
-- the walk restarts at offset 0 every run. It was seeded at **600,000** against
-- a walk that costs **684,498** (114,083 rows x 6 columns). A run beginning with
-- 650,000 available would have passed the gate and stopped at ~95% of the walk —
-- the exact outcome the gate was written to prevent, permitted by the gate.
--
-- ⚠ The same off-by-a-margin sat in the reservation: 700,000 reserved against a
-- 684,498 walk is only 2.3% of headroom, and the walk GROWS with the ownership
-- table (it was 149,527 rows in an earlier era). A reservation that the workload
-- outgrows fails silently — as a budget stop that looks like ordinary pacing.
--
-- New numbers, all against the 1,000,000-datapoint cycle:
--   reserved / cap  750,000  (75% of the cycle; ~9.6% headroom over today's walk)
--   min_start       700,000  (above the walk, below the reservation)
--   day cap         800,000  (one walk plus probes fits; two do not)
-- That leaves 250,000/cycle for the backfill lanes and ad-hoc work, which is the
-- operator's stated allocation: ownership first, the rest is a shared pool.
--
-- ⚠ RE-DERIVE, DO NOT QUOTE. 684,498 is a 2026-08-17 sample. When the ownership
-- table grows past ~125,000 rows the walk exceeds the reservation, and the first
-- symptom is a lane that stops starting. The check is one query:
--   select count(*) * 6 as walk_datapoints from topshot_ownership where source = 'dune';

update public.dune_budget_allocation
   set reserved_datapoints  = 750000,
       cap_datapoints       = 750000,
       min_start_datapoints = 700000,
       note = 'One full walk = 114,083 rows x 6 cols = 684,498 dp (68.4% of the 1M cycle), sampled 2026-08-17 and GROWING with the table. Reserved 750,000 so the backfill lanes cannot eat it, with ~9.6% headroom; min_start 700,000 is ABOVE the walk cost, because a partial walk spends AND leaves the table capped at the offset reached. Re-derive: select count(*) * 6 from topshot_ownership where source = ''dune''.',
       updated_at = now()
 where pipeline = 'ownership-sync-dune';

update public.dune_budget_state
   set day_datapoint_cap = 800000,
       updated_at = now()
 where id = 1;

-- REVERT:
--   update public.dune_budget_allocation
--      set reserved_datapoints = 700000, cap_datapoints = 700000, min_start_datapoints = 600000
--    where pipeline = 'ownership-sync-dune';
--   update public.dune_budget_state set day_datapoint_cap = 750000 where id = 1;

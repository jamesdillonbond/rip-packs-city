-- audit_20261023_zero_yield_suppress_ufc_enrichment_drain_retired
-- Applied to prod 2026-10-23 ~7:59 AM PT from a Cowork cloud session via the Supabase MCP
-- (version 20261023145928). Repo copy written the same session; land it in supabase/migrations/.
--
-- Why: check_zero_yield_lanes() flagged ufc-enrichment-drain in the 10-23 overnight handoff
-- (queue item 4). Measured before writing:
--   * last pipeline_runs row 2026-10-18 14:07Z (7:07 AM PT); 0 rows since (cron-job.org caller
--     disabled 10-18 - the lane is retired).
--   * it flags only because the arm's 7-day window still holds 125 pre-retirement runs
--     (48 on 10-16, 48 on 10-17, 29 on 10-18), every one rows_written 0.
--   * in the week before retirement it found 96 rows/day and wrote none (rows_skipped =
--     rows_found, cadence_errors = rows_found) - a non-writing lane, which is why it was retired.
-- Effect: check_zero_yield_lanes() offenders 2 -> 1 (candy-sales-indexer only), suppressed 8 -> 9.
-- candy-sales-indexer is deliberately NOT suppressed: its zero is #58 (OpenSea key / Magic Eden
-- feed silent since 10-11) and must stay visible.
-- Companion: 20261023132818 (Claude Code, 6:28 AM PT) suppressed resolve-topshot-stubs,
-- topshot-stub-resolver and allday-unmapped-resolver-tail.
-- Revert: remove the ufc-enrichment-drain row from public.pipeline_zero_yield_suppressions
-- (dashboard SQL editor - the MCP write gate refuses delete-bearing text).

insert into public.pipeline_zero_yield_suppressions (pipeline, reason, added_by)
values ('ufc-enrichment-drain',
 'RETIRED, measured 2026-10-23 ~8:10 AM PT. The lane''s cron-job.org caller was disabled 2026-10-18; last pipeline_runs row 2026-10-18 14:07Z (7:07 AM PT), 0 runs since (5 days). It flags only because its 7-day window still holds 125 pre-retirement runs (10-16..10-18), every one rows_written 0 - in the week before retirement it found 96 rows/day and wrote none (all skipped, cadence_errors = rows_found), i.e. it was a non-writing lane, which is why it was retired. RE-CHECK CONDITION: remove this row the day ufc-enrichment-drain writes any new pipeline_runs row (the lane was re-enabled) - from then on a zero IS a stall. candy-sales-indexer is deliberately NOT suppressed: its zero is #58 (OpenSea key / Magic Eden feed) and must stay visible.',
 'cowork-cloud 2026-10-23 attended (Trevor: "look for any sql work")')
on conflict (pipeline) do nothing;

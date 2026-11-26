-- audit_20261125_zero_yield_retire_orphan_unlatch_and_note_rearm
--
-- 2026-11-25 ~8:15 PM PT (Claude Code cloud; Sentinel 7:04 PM PT WARN "Zero-Yield Lanes: atlas-rearm-minted-dists
-- (168 runs, last find 2026-11-18); head-sweep-cursor-unlatch (168 runs, last find 2026-11-18)").
--
-- (1) head-sweep-cursor-unlatch (pg_cron rpc-head-sweep-cursor-unlatch, `29 * * * *`) — ORPHANED, PAUSED HERE.
--     unlatch_head_sweep_cursors() resets exactly three cursors: golazos_pack_sales_cursor, golazos_pack_opens_cursor,
--     pinnacle_pack_opens_cursor. Their only writers are the edge functions backfill-golazos-pack-sales,
--     ingest-golazos-pack-opens and ingest-pinnacle-pack-opens, whose pg_cron jobs (rpc-golazos-pack-sales-backfill,
--     rpc-golazos-pack-opens-ingest, rpc-pinnacle-pack-opens-ingest) were PAUSED on 2026-11-18 by
--     20261119080000_audit_20261118_retire_dead_studio_lanes (Studio GraphQL dead since 11-17). Read 11-25: all three
--     cursors done=false, last updated 11-17 4:11 / 4:29 / 7:29 PM PT. Nothing can latch them, so the job can never
--     find work: it is a lane on the lane budget (strategy-2026-11-22 Move 4) guarding retired lanes.
--     Paused the same way as the 11-18 retirement (active := false; command kept, re-enable is one call). Its
--     Pipeline Silence watch row is set is_active=false in the same statement block, or it would fire in 3 h.
--     If any of the three Studio lanes is ever re-activated, re-activate this job and its watch row with it.
--
-- (2) atlas-rearm-minted-dists (pg_cron rpc-atlas-rearm-minted-dists, `29 * * * *`) — CORRECT ZERO, suppression row.
--     It re-arms a Top Shot Atlas distribution read empty (total_pack_count 0) whose packs were minted after that read.
--     Independent count 11-25 ~8:10 PM PT: 39 Top Shot distributions minted packs in the last 30 days (newest mint
--     2:21 PM PT 11-25); 0 of them have total_pack_count 0, 0 are missing from topshot_atlas_dists, 0 would qualify
--     under the lane's own predicate with next_due_at ignored. Positive control: its 11-18 runs re-armed distributions
--     (last find 11-18). RE-CHECK CONDITION: remove this row if a new Top Shot drop shows total_pack_count 0 for
--     more than an hour while pack_nft_mints holds mints for it.
--
-- Lane budget: -1 active pg_cron job (rpc-head-sweep-cursor-unlatch), no job added.
--
-- REVERT:
--   SELECT cron.alter_job(jobid, active := true) FROM cron.job WHERE jobname = 'rpc-head-sweep-cursor-unlatch';
--   UPDATE public.pipeline_cadence_watchlist SET is_active = true WHERE pipeline = 'head-sweep-cursor-unlatch';
--   DELETE FROM public.pipeline_zero_yield_suppressions
--    WHERE pipeline IN ('head-sweep-cursor-unlatch', 'atlas-rearm-minted-dists');

SELECT cron.alter_job(jobid, active := false) FROM cron.job WHERE jobname = 'rpc-head-sweep-cursor-unlatch';

UPDATE public.pipeline_cadence_watchlist SET is_active = false WHERE pipeline = 'head-sweep-cursor-unlatch';

INSERT INTO public.pipeline_zero_yield_suppressions (pipeline, reason, added_by) VALUES
  ('head-sweep-cursor-unlatch',
   'RETIRED, measured 2026-11-25 ~8:10 PM PT. It resets only golazos_pack_sales_cursor, golazos_pack_opens_cursor and pinnacle_pack_opens_cursor, whose writers (rpc-golazos-pack-sales-backfill, rpc-golazos-pack-opens-ingest, rpc-pinnacle-pack-opens-ingest) were paused 2026-11-18 with the dead Studio lanes (20261119080000). All three cursors done=false, untouched since 11-17. Job paused by 20261126 audit_20261125_zero_yield_retire_orphan_unlatch_and_note_rearm; this row covers the 7-day window it already filled. RE-CHECK CONDITION: remove if any of those three lanes is re-activated.',
   'claude-code-cloud 2026-11-25'),
  ('atlas-rearm-minted-dists',
   'CORRECT ZERO, measured 2026-11-25 ~8:10 PM PT. Its population (Top Shot Atlas dists read with total_pack_count 0 whose packs were minted after that read) is 0 by an independent count: 39 Top Shot dists minted packs in 30 d (newest 11-25 2:21 PM PT), 0 with total_pack_count 0, 0 missing from topshot_atlas_dists. Positive control: it re-armed dists through 11-18. RE-CHECK CONDITION: remove if a new Top Shot drop sits at total_pack_count 0 for more than an hour while pack_nft_mints holds its mints.',
   'claude-code-cloud 2026-11-25');

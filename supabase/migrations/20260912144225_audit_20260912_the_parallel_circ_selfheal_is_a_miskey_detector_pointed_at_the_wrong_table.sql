-- audit_20260912_the_parallel_circ_selfheal_is_a_miskey_detector_pointed_at_the_wrong_table
--
-- ⛔⛔ UNSCHEDULES pg_cron job `rpc-selfheal-impossible-parallel-circ` (jobid 219,
-- `43 0,6,12,18 * * *`, owned by `cron_heavy`). The FUNCTION IS LEFT IN PLACE and its pin
-- (`supabase/tests/raise_impossible_parallel_circ.sql`) still runs in CI, so the whole
-- analysis below stays inspectable and one documented statement puts the schedule back.
--
-- ⚠ MECHANISM: `postgres` cannot touch a `cron_heavy`-owned job — `cron.alter_job` fails with
-- "Job 219 does not exist or you don't own it". `postgres` IS a member of `cron_heavy`, which
-- CAN unschedule, so the working path is `SET LOCAL ROLE cron_heavy` first. Proven in a
-- rolled-back DO block before this migration was written, exactly as cron-and-schedulers.md
-- prescribes, and `RESET ROLE` follows so apply_migration's own bookkeeping row is not
-- written as cron_heavy.
--
-- 🚨 WHY: THE FUNCTION'S PREMISE IS REFUTED. It reads `sales.serial_number >
-- editions.circulation_count` on a Top Shot PARALLEL as "circulation is stale, raise it".
-- Measured 2026-09-12, that condition is a MIS-KEYED SALE, not a stale circulation:
--
--   * `moments.nft_id -> edition_id` is the CANONICAL map for Top Shot, and on the two
--     adjudicable offenders it DISAGREES with the sale, naming the BASE printing:
--       nft 52643519  serial 2042  sale says 258:9009::16  moments says 258:9009
--       nft 52549592  serial  140  sale says 270:8973::17  moments says 270:8973
--   * EVERY offender's serial fits inside its BASE edition's circulation (6/6):
--       258:8892::16 circ 99 wanted 3002, base 4000 · 90:4055::1 circ 500 wanted 2048,
--       base 8000 · 258:9009::16 99/2042/4000 · 250:8813::18 50/829/1000 ·
--       258:8904::16 99/688/4000 · 270:8973::17 99/140/1000
--   * Atlas (`badge_editions`) is INTERNALLY CONSISTENT on each of them
--     (effective_supply + burned = circulation: 492+8=500, 99+0=99, 24+1=25, 92+7=99),
--     so there is no evidence its number is the wrong one.
--
-- ⭐ So the function wanted to inflate a 99-print parallel to 3,002 — a 30x corruption of an
-- Atlas-verified circulation — to accommodate a sale row that belongs to another edition.
-- The BEFORE trigger `trg_topshot_normalize_base_club_circulation` ("Parallel: Atlas is the
-- only per-printing authority, in both directions") has been silently preventing that.
-- THE TRIGGER IS THE PROTECTION; THE SELF-HEAL IS THE BUG.
--
-- 🚨 AND IT IS NOT HYPOTHETICAL: where Atlas has NO row there is nothing to clamp, and one
-- raise LANDED — `171:5972::16` now reads circulation_count = 1270, raised from 93 by this
-- function, with atlas_circ NULL and its nft absent from `moments` (so it cannot be
-- adjudicated either way). Its serial 1270 fits the base's 4,000: the same signature as the
-- six confirmed mis-keys. ⛔ Repairing that row, and the mis-keyed `sales` rows behind all of
-- this, is a bulk UPDATE on `sales`/`editions` — the destructive class — and is Trevor's call.
--
-- ⚠ WHY NOT JUST GUARD IT instead of switching it off. The obvious guard is to require the
-- canonical map to corroborate the serial. It discriminates correctly — positive control on
-- 249 hash-sampled recent Top Shot sales: 121 nfts present in `moments`, 120 AGREE, 1
-- disagrees — but `moments` covers only ~49% of sale nfts, so the guard fails closed on
-- roughly half of them. Combined with the trigger reverting every raise on an Atlas-covered
-- edition, a guarded function is a more elaborate way of doing nothing. 274 audited attempts,
-- ZERO legitimate repairs.
--
-- ⭐ WHAT THE SIGNAL IS ACTUALLY GOOD FOR, and this is the part to keep: the trust metric
-- `topshot_impossible_parallel_serials` is CORRECT and should be re-read as a MIS-KEYED SALES
-- detector, not as "circulation needs raising". It stays breached (5) either way —
-- unscheduling this job does not change it, because the job never moved a single sales row.
--
-- REVERT (puts the schedule back, jobid may differ, 600s budget preserved by the role):
--   SET LOCAL ROLE cron_heavy;
--   SELECT cron.schedule('rpc-selfheal-impossible-parallel-circ', '43 0,6,12,18 * * *',
--                        'SELECT public.raise_impossible_parallel_circ();');
--   RESET ROLE;

SET LOCAL ROLE cron_heavy;

SELECT cron.unschedule('rpc-selfheal-impossible-parallel-circ');

RESET ROLE;

COMMENT ON FUNCTION public.raise_impossible_parallel_circ() IS
  'UNSCHEDULED 2026-09-12 (was pg_cron jobid 219, 43 0,6,12,18 * * *). Its premise is '
  'refuted: serial_number > circulation_count on a Top Shot parallel is a MIS-KEYED SALE '
  '(the canonical moments.nft_id->edition_id map names the BASE printing), not a stale '
  'circulation. Raising circulation to match would corrupt an Atlas-verified figure by up '
  'to 30x; the BEFORE trigger trg_topshot_normalize_base_club_circulation has been '
  'preventing that, and where Atlas had no row one raise did land (171:5972::16, 93->1270). '
  '274 audited attempts, zero legitimate repairs. The trust metric '
  'topshot_impossible_parallel_serials is correct and should be read as a mis-keyed-sales '
  'detector. Repairing the mis-keyed sales rows is a destructive-class change and is '
  'Trevor''s call. Full evidence: migration audit_20260912_the_parallel_circ_selfheal_is_a_'
  'miskey_detector_pointed_at_the_wrong_table.';
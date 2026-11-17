-- audit_20260829_sales_2026_insert_autovacuum_sized_from_measured_vm_decay
--
-- ⚠ SCOPE OF THE NO-PUSH NOTE: the session that applied this could not push
-- (cloud git proxy: "not in this session's authorized repository set"). That is a
-- fact about THAT session. Trevor's machine and Claude Code push normally via the
-- PAT in remote.origin.pushurl. COMMIT THIS FILE AS USUAL.
--
-- ============================================================================
-- WHY. Two things measured 2026-08-29 10:20-11:15Z.
--
-- (1) pg_cron jobid 380 `maint-vacuum-sales-hot-partition` -- the hedge shipped
--     with c26ae1981 / migration 20260829002812 -- FAILED ITS FIRST-EVER RUN:
--       start 10:20:00.386Z  end 10:22:00.471Z  120.1 s  status failed
--       "ERROR: canceling statement due to statement timeout
--        CONTEXT: while scanning relation public.sales_2026"
--     Cause: `cron.schedule` was called as `postgres`, and `postgres` carries NO
--     statement_timeout rolconfig, so the job inherits the CLUSTER-WIDE
--     statement_timeout = 120000 (pg_settings source = 'configuration file').
--     Every heavy job in this DB instead runs as `cron_heavy` (rolconfig
--     statement_timeout=600s), reached via the documented
--     `SET LOCAL ROLE cron_heavy; PERFORM cron.schedule(...)` path.
--     ⛔ jobid 380 is NOT touched by this migration (standing instruction: do not
--     unschedule it). Its repair needs a MAINTAIN grant + a re-own and is queued
--     for Trevor -- see the handoff.
--     ⓘ This exact failure mode is already in the ledger: the wallet_moments_cache
--     entry records "the manual pg_cron VACUUM attempt itself died at the role's
--     120 s timeout", and the fix used there was durable autovacuum reloptions.
--
-- (2) THE MECHANISM THAT 20260829002812 RECORDED AS "NOT ESTABLISHED" NOW IS.
--     Shape-matched probe (single-process, collection pinned), the same one the
--     07:12Z pass registered, against sales_2026's last VACUUM at 00:22:38Z:
--
--       +6.7 h (07:05Z)   Heap Fetches 3,363   buffers 13,029 hit + 3,211 read   1,797 ms
--      +10.9 h (11:12Z)   Heap Fetches 5,793   buffers 14,863 hit + 2,298 read  24,239 ms
--
--     => ~502 and ~579 heap fetches/h; call it ~550/h, roughly linear.
--     n_ins_since_vacuum over the same span = 1,107 => ~5.2 heap fetches per insert.
--
--     The CURRENT trigger is autovacuum_vacuum_insert_threshold 2000 +
--     insert_scale_factor 0.01 x n_live_tup 1,041,708 = 12,417 inserts, i.e. one
--     insert-triggered vacuum every ~5 days (last autovacuum 08-24 20:02Z).
--     TWO INDEPENDENT PROJECTIONS OF WHAT THAT CEILING COSTS:
--       by time    98.9 h x ~550/h            = ~54,400 heap fetches
--       by inserts 12,417 inserts x ~5.2      = ~64,600 heap fetches
--     MEASURED PRE-FIX (2026-08-28 23:00Z, leaderboard's parallel scan): 66,218.
--     Both land on the measured figure. The trigger is ~8x too large for a
--     visibility map that rots at ~550 heap fetches/h.
--     ⛔ "Autovacuum never fires here" stays REFUTED -- it fires, ~8x too rarely.
--
-- ============================================================================
-- WHAT. insert_scale_factor -> 0, insert_threshold -> 1500.
--   Sizing is rate-free and anchored on the registered falsifier (~10,000 heap
--   fetches): at ~5.2 fetches/insert, 1,500 inserts => ceiling ~7,800, a ~22%
--   margin. The largest round threshold that stays under the falsifier.
--   Cadence: 1,107 inserts / 10.85 h = 102/h => a vacuum every ~14.7 h
--   (~1.6/day, vs ~0.2/day today).
--   Cost per pass: 300 MB heap (mostly SKIPPED once the map is warm) + 925 MB of
--   index cleanup across 21 indexes ~= 42 s of IO at this instance's ~22 MB/s
--   floor ~= 0.05% of its daily IO budget. Autovacuum is cost-throttled
--   (cost_limit 200 / cost_delay 2 ms) and is NOT subject to statement_timeout --
--   which is the whole point, given (1).
--
-- ⭐ NO VACUUM STORM ON APPLY. n_ins_since_vacuum = 1,107 < 1,500, so nothing
--    fires inside the 60 s autovacuum_naptime; the first trigger is ~4 h out.
--    This is deliberate -- see inbox/2026-08-29T0241Z, which found that setting
--    this class in one batch fires nine vacuums at once because every table was
--    already past its new trigger. sales_2026 is not.
--
-- ⭐ WHY scale_factor 0 AND NOT A SMALLER SCALE FACTOR: insert_scale_factor is
--    proportional to table SIZE; map staleness is driven by insert RATE. Same rule
--    as inbox/2026-08-29T0241Z derived for pack_rips.
--
-- PRECEDENT IN THIS DB: pack_purchases, migration 20260829010609 (heap fetches
-- 28,203/29,658 -> 0/0, buffers 51,124 -> 30,079); wallet_moments_cache (ledger).
--
-- ============================================================================
-- FALSIFIER, 24-48 h. Re-run the shape-matched probe:
--   EXPLAIN (ANALYZE, BUFFERS) SELECT collection, sold_at, price_usd,
--     buyer_address, seller_address FROM public.sales_2026
--     WHERE collection='nba_top_shot' AND sold_at >= now() - interval '30 days';
-- Expect Heap Fetches to SAWTOOTH under ~8,000 and pg_stat_all_tables.
-- last_autovacuum on sales_2026 to advance roughly every ~15 h.
-- IF Heap Fetches still climbs past ~10,000, the insert path is not the driver
-- (scattered UPDATEs would be the next suspect, since the dead-tuple trigger sits
-- at 50 + 0.05 x 1,041,708 = 52,135 and n_dead_tup is only ~2,500) -- and the
-- next lever is autovacuum_vacuum_scale_factor, NOT a bigger hammer on inserts.
-- ⚠ COMPARE THE TREND ON THIS PROBE ONLY. Its absolute buffer counts are NOT
-- comparable to the leaderboard function's PARALLEL scan figures (66,218 -> 0).
-- ⚠ AND relallvisible IS A FROZEN STATISTIC (migration 20260829070701): it is
-- written only by VACUUM/ANALYZE and does not track the VM in between. Do not
-- measure decay with it.
--
-- REVERT (restores the exact pre-migration values, which were 2000 / 0.01):
--   ALTER TABLE public.sales_2026 SET (
--     autovacuum_vacuum_insert_threshold = 2000,
--     autovacuum_vacuum_insert_scale_factor = 0.01);
--
-- NO data is read, written or destroyed. No schema object, no grant, no view, no
-- function, no cron job. Storage parameters only; ALTER TABLE ... SET
-- (autovacuum_*) takes SHARE UPDATE EXCLUSIVE, which does not block readers or
-- writers (it does conflict with a concurrent VACUUM/ANALYZE, hence lock_timeout).
-- ============================================================================

SET LOCAL lock_timeout = '5s';

DO $$
DECLARE
  v_opts   text[];
  v_ins    bigint;
  v_live   bigint;
BEGIN
  IF to_regclass('public.sales_2026') IS NULL THEN
    RAISE EXCEPTION 'public.sales_2026 does not exist -- refusing to proceed';
  END IF;

  SELECT c.reloptions INTO v_opts FROM pg_class c WHERE c.oid = 'public.sales_2026'::regclass;

  -- Guard: assert the EXACT pre-state this migration was derived against. If a
  -- concurrent session already changed these, stop rather than clobber.
  IF NOT (v_opts @> ARRAY['autovacuum_vacuum_insert_threshold=2000']
      AND v_opts @> ARRAY['autovacuum_vacuum_insert_scale_factor=0.01']) THEN
    RAISE EXCEPTION
      'pre-state mismatch on public.sales_2026: expected insert_threshold=2000 and insert_scale_factor=0.01, found %',
      v_opts;
  END IF;

  SELECT n_ins_since_vacuum, n_live_tup INTO v_ins, v_live
    FROM pg_stat_all_tables WHERE relid = 'public.sales_2026'::regclass;

  RAISE NOTICE 'pre: reloptions=% n_ins_since_vacuum=% n_live_tup=% old_trigger=%',
    v_opts, v_ins, v_live, (2000 + 0.01 * v_live)::bigint;

  -- Disclosed, not asserted: if inserts have already passed 1500 between the
  -- derivation and now, an autovacuum fires within one naptime. That is the same
  -- repair, just sooner -- not a reason to abort -- but it must not be silent.
  IF v_ins >= 1500 THEN
    RAISE NOTICE 'NOTE: n_ins_since_vacuum=% is already >= 1500, so an insert-triggered autovacuum will fire within ~60 s', v_ins;
  END IF;

  EXECUTE 'ALTER TABLE public.sales_2026 SET ('
       || 'autovacuum_vacuum_insert_threshold = 1500, '
       || 'autovacuum_vacuum_insert_scale_factor = 0)';

  SELECT c.reloptions INTO v_opts FROM pg_class c WHERE c.oid = 'public.sales_2026'::regclass;

  IF NOT (v_opts @> ARRAY['autovacuum_vacuum_insert_threshold=1500']
      AND v_opts @> ARRAY['autovacuum_vacuum_insert_scale_factor=0']) THEN
    RAISE EXCEPTION 'post-state readback failed on public.sales_2026: %', v_opts;
  END IF;

  RAISE NOTICE 'post: reloptions=% new_trigger=1500', v_opts;
END $$;
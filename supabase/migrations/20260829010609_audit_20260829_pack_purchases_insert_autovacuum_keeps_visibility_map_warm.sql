-- audit_20260829_pack_purchases_insert_autovacuum_keeps_visibility_map_warm
--
-- WHY: public.pack_purchases carried NO insert-driven autovacuum settings, so the
-- defaults applied: 1000 + 0.2 * n_live_tup = 66,705 inserts before an insert-triggered
-- autovacuum. With n_ins_since_vacuum = 15,115 and last_autovacuum 2026-08-22, the
-- newest slice of the table stayed NOT all-visible for weeks, and every Index Only Scan
-- over a recent window degraded into a heap scan.
--
-- MEASURED 2026-08-29 01:05Z, wallet_usernames_unresolved() body, EXPLAIN (ANALYZE, BUFFERS):
--   idx_pack_purchases_buyer  Heap Fetches 28,203 · 16,494 ms · 14,454 buffers
--   idx_pack_purchases_seller Heap Fetches 29,658 ·  8,210 ms · 10,780 buffers
--   total execution 28,851 ms
-- After a manual VACUUM (ANALYZE) public.pack_purchases at 01:12Z, re-measured 01:14Z:
--   buyer  Heap Fetches 0 · 2,390 ms · 1,905 buffers
--   seller Heap Fetches 0 · 5,684 ms · 2,066 buffers
--   total execution 15,624 ms   (buffers 51,124 -> 30,079)
--
-- The VACUUM is the one-time repair; THIS migration is the durable half -- it makes
-- autovacuum keep the map warm instead of the map rotting again in ~7 weeks.
-- Values match the settings already carried by public.sales_2026 (precedent).
--
-- SCOPE: applied live from a cloud Cowork session that CANNOT push. Trevor's machine and
-- Claude Code push normally via the PAT in remote.origin.pushurl -- commit this file as usual.
--
-- REVERT:
--   ALTER TABLE public.pack_purchases
--     RESET (autovacuum_vacuum_insert_threshold, autovacuum_vacuum_insert_scale_factor);

DO $mig$
DECLARE
  v_before text;
  v_after  text;
BEGIN
  -- Guard 1: the target must exist and be an ordinary table.
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'pack_purchases' AND c.relkind = 'r'
  ) THEN
    RAISE EXCEPTION 'ABORT: public.pack_purchases is not an ordinary table (or does not exist)';
  END IF;

  -- Guard 2: assert we are not overwriting insert settings someone else already tuned.
  SELECT coalesce(array_to_string(c.reloptions, ','), '')
    INTO v_before
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relname = 'pack_purchases';

  IF v_before LIKE '%insert_threshold%' OR v_before LIKE '%insert_scale_factor%' THEN
    RAISE EXCEPTION 'ABORT: pack_purchases already carries insert autovacuum settings (%) -- re-read before changing', v_before;
  END IF;

  EXECUTE 'ALTER TABLE public.pack_purchases SET ('
       || 'autovacuum_vacuum_insert_threshold = 2000, '
       || 'autovacuum_vacuum_insert_scale_factor = 0.01)';

  -- Post-condition: both settings are present with the intended values.
  SELECT coalesce(array_to_string(c.reloptions, ','), '')
    INTO v_after
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relname = 'pack_purchases';

  IF v_after NOT LIKE '%autovacuum_vacuum_insert_threshold=2000%'
     OR v_after NOT LIKE '%autovacuum_vacuum_insert_scale_factor=0.01%' THEN
    RAISE EXCEPTION 'ABORT: post-condition failed, reloptions now = %', v_after;
  END IF;

  RAISE NOTICE 'pack_purchases reloptions: % -> %', v_before, v_after;
END
$mig$;

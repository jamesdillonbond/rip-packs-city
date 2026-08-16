-- audit_20260815_collection_stats_prune_future_fmv_partitions
--
-- CAUSE
--   get_collection_stats(text) computes `sniper_deals` with a correlated LATERAL
--   over the PARTITIONED fmv_snapshots, once per candidate edition:
--       SELECT fmv_usd, confidence FROM fmv_snapshots
--       WHERE edition_id = e.id AND fmv_usd > 0
--       ORDER BY computed_at DESC LIMIT 1
--   With no predicate on the partition key the planner must probe EVERY partition
--   on every loop. fmv_snapshots_2025 and _2027 hold 0 rows / 0 bytes, but an empty
--   partition's index root still costs ~2 buffers per probe.
--
-- EVIDENCE (measured live 2026-08-15, Top Shot branch, EXPLAIN ANALYZE BUFFERS)
--   769 LATERAL loops; total 7,763 buffers (hit 7,080 / read 683); Execution 5,847 ms.
--   Of that, fmv_snapshots_2027 = 1,538 buffers and _2025 = 6 buffers, returning
--   0 rows on every single loop -- ~20% of the whole leg spent on provably empty
--   partitions. This leg is inside the function that Sweep D measured throwing
--   57014 at `PL/pgSQL ... line 176` for nba_top_shot and nfl_all_day, which the
--   overview page then renders as the FALSE claim "No sales in the last 24h"
--   (live: Top Shot 8,332 sales / All Day 240 in the same 24h).
--   Both the TopShot branch (line ~196) and the All Day branch (line ~232) carry
--   the byte-identical LATERAL -- exactly the two collections observed failing.
--
-- FIX
--   Add `AND computed_at <= now()` so the planner has the partition key and prunes
--   at runtime (Subplans Removed). Mirrors the shipped, verified precedent
--   audit_20260814_pack_detail_bundle_prune_future_fmv_partitions.
--
-- EQUIVALENCE (proven, not sampled)
--   An FMV snapshot cannot be computed in the future, and
--   `SELECT count(*) FROM fmv_snapshots WHERE computed_at > now()` = 0 table-wide
--   (verified 2026-08-15). The result set therefore cannot change for any input.
--   It DEGRADES rather than breaks: when 2027 begins it simply stops pruning.
--
-- ⚠ NOT A RESCUE. This cuts the constant factor on one leg; it does not make the
--   page honest. The user-facing defect is app/(collections)/[collection]/overview/
--   page.tsx lines 331 and 444, which use `?? 0` on a NULL `stats` and so convert a
--   database timeout into a market assertion. That is a CODE fix and is handed off.
--
-- PRE-IMAGE  md5(prosrc) = 8086744dce041410f8e62610a3bdc9aa
-- REVERT
--   Re-apply the previous definition, which differs ONLY by the absence of
--   ` AND computed_at <= now()` in the two LATERAL WHERE clauses. Equivalent
--   guarded inverse:
--     DO $r$
--     DECLARE d text; BEGIN
--       SELECT pg_get_functiondef(p.oid) INTO d FROM pg_proc p
--         JOIN pg_namespace n ON n.oid=p.pronamespace
--        WHERE n.nspname='public' AND p.proname='get_collection_stats'
--          AND p.proargtypes[0]='text'::regtype;
--       EXECUTE replace(d,
--         'WHERE edition_id = e.id AND fmv_usd > 0 AND computed_at <= now()',
--         'WHERE edition_id = e.id AND fmv_usd > 0');
--     END $r$;
--
DO $mig$
DECLARE
  v_def  text;
  v_old  text := 'WHERE edition_id = e.id AND fmv_usd > 0';
  v_new  text := 'WHERE edition_id = e.id AND fmv_usd > 0 AND computed_at <= now()';
  v_hits int;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = 'get_collection_stats'
     AND p.proargtypes[0] = 'text'::regtype;

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'get_collection_stats(text) not found -- refusing to patch';
  END IF;

  -- Guard: refuse unless the pattern appears EXACTLY twice (TopShot + All Day).
  v_hits := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
  IF v_hits <> 2 THEN
    RAISE EXCEPTION
      'expected exactly 2 occurrences of the LATERAL predicate, found % -- refusing to patch', v_hits;
  END IF;

  -- Guard: refuse if already patched (idempotence / no double-append).
  IF position('computed_at <= now()' in v_def) > 0 THEN
    RAISE EXCEPTION 'function already carries computed_at <= now() -- refusing to patch';
  END IF;

  EXECUTE replace(v_def, v_old, v_new);
END
$mig$;
-- ─────────────────────────────────────────────────────────────────────────────
-- 🚨 A FAILED RE-READ OVERWROTE A COMPLETE SNAPSHOT WITH A PARTIAL ONE, and the
-- result reads as a 98% one-day collapse that never happened.
--
-- THE ROW: wallet_holdings_snapshot, 0x4d2c9216f1dca098 (NBATopShotCommunity),
-- nba_top_shot, snapshot_at 2026-09-13 — moment_count 1,000 / total_fmv_usd 410,
-- sitting between 52,120 / $16,804.81 on 09-12 and 52,120 / $16,349.42 on 09-14.
-- Live wallet_moments_cache holds 52,120 rows for that (wallet, collection).
--
-- ⭐ THE CAUSE IS IN pipeline_runs AND IT IS EXACT, not inferred:
--   2026-09-13 10:07:10Z  ok=true   moments_snapshotted 64,093, pages_walked 257
--                                   -> the COMPLETE 09-13 snapshot was written.
--   2026-09-13 12:46:32Z  ok=false  "wmc_load_page_4 exhausted retries:
--                                   canceling statement due to statement timeout",
--                                   wallet_hint 0x4d2c9216f1dca098.
-- A SECOND run the same day got pages 0-3 (4 x PAGE_SIZE 250 = exactly 1,000
-- rows), failed on page 4, and wrote that partial read anyway. The table is
-- UNIQUE (wallet_address, collection_id, snapshot_at) and the edge function
-- UPSERTs on that key, so the partial overwrote the complete one.
--
-- ⛔ THIS IS CLAUDE.md's WORST SUB-CLASS VERBATIM: *"a page that LOADS state and
-- WRITES IT BACK — a failed read there is a DELETE."* The function does collect
-- the error (captureSnapshot pushes `load: ...` into errors and the run logs
-- ok=false), so the failure was RECORDED — and the corrupt row was written all
-- the same. **Recording an error is not the same as refusing to publish one.**
--
-- ⚠ BLAST RADIUS, MEASURED RATHER THAN ASSUMED — it is smaller than the 2026-08-16
-- incident this function's own header documents. compute_institutional_wallet_diff
-- inserts into topshot_insider_buybacks ONLY with a matching sale_id (verified:
-- 100% of rows in the last 10 days carry one), so the ~51,120 phantom departures
-- on 09-13 and phantom arrivals on 09-14 could not mass-fabricate buybacks;
-- 09-14 inserted 0. **What IS wrong is the holdings series itself**, which shows
-- this whale dumping 98% of its collection and buying it all back the next day.
--
-- ── 1. THE ROW IS DELETED, NOT REPAIRED ──────────────────────────────────────
-- The complete 10:07Z row cannot be recovered — its moment_ids array was
-- overwritten. Reconstructing 09-13 from 09-14's cache would FABRICATE a day's
-- holdings from another day's data, which is the defect, not the fix. An absent
-- day is how this table already represents a failed run: 2026-09-11 has no row
-- at all because that run never got far enough to write one. So 09-13 joins it.
--
-- ── 2. AND THE SAME-DAY COLLAPSE IS NOW REFUSED AT WRITE TIME ────────────────
-- ⭐ Enforcement, not detection, and deliberately on the DB side: the edge
-- function `snapshot-institutional-wallets` is in the CONTENT-DRIFTED set (#23 /
-- R63) — its deployed build is NOT this repo's source — so redeploying it to fix
-- the writer would ship an unknown diff. A trigger fixes the invariant without
-- touching a function nobody can currently diff.
--
-- THE INVARIANT: within ONE snapshot_at, an UPDATE may not cut moment_count by
-- more than half when the existing row already holds >= 100 moments. A real
-- holdings change appears as a NEW DAY, never as a same-day revision downward;
-- a same-day 98% cut is the partial-read bug every time.
--
-- ⚠ THE 100-MOMENT FLOOR IS A REAL EXCLUSION AND IT IS NAMED. Four rows in this
-- table are V-shaped collapses below it — 0x4d2c9216f1dca098 / nfl_all_day going
-- 7 -> 1 -> 5 (08-16), 7 -> 2 -> 5 (08-20), 7 -> 3 -> 4 (08-24) and 5 -> 1 -> 5
-- (07-08) on a 4-7 moment holding. Those are NOT this defect (a partial page read
-- returns a multiple of 250, or everything) — they look like wallet_moments_cache
-- freshness churn, and they are LEFT ALONE and UNEXPLAINED rather than swept into
-- this fix. Whoever looks at them should treat them as their own question.
--
-- ⚠ IT FAILS LOUD. The upsert raises, withRetry burns its 3 attempts, and the
-- function writes a `whs_upsert_<collection>` exhaustion row — which is strictly
-- better than today, where the write succeeds and the series lies.
-- OVERRIDE, if a legitimate same-day downward correction is ever needed:
--   ALTER TABLE public.wallet_holdings_snapshot DISABLE TRIGGER trg_whs_refuse_same_day_collapse;
--   -- ... the correcting UPDATE ...
--   ALTER TABLE public.wallet_holdings_snapshot ENABLE TRIGGER trg_whs_refuse_same_day_collapse;
--
-- REVERT (all three parts):
--   INSERT INTO public.wallet_holdings_snapshot SELECT * FROM public.audit_20260914_whs_partial_write_backup;
--   DROP TRIGGER trg_whs_refuse_same_day_collapse ON public.wallet_holdings_snapshot;
--   DROP FUNCTION public.whs_refuse_same_day_collapse();
-- ─────────────────────────────────────────────────────────────────────────────

-- 1 ── back up, then delete ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.audit_20260914_whs_partial_write_backup
  (LIKE public.wallet_holdings_snapshot INCLUDING DEFAULTS);
ALTER TABLE public.audit_20260914_whs_partial_write_backup ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.audit_20260914_whs_partial_write_backup FROM PUBLIC, anon, authenticated;

COMMENT ON TABLE public.audit_20260914_whs_partial_write_backup IS
  'The wallet_holdings_snapshot row deleted 2026-09-14: a partial (1,000-row = 4 x PAGE_SIZE) '
  'read that a same-day failed re-run upserted over a complete 52,120-row snapshot. Kept verbatim '
  'so the deletion is reversible, NOT because the row is trustworthy.';

INSERT INTO public.audit_20260914_whs_partial_write_backup
SELECT * FROM public.wallet_holdings_snapshot
 WHERE wallet_address = '0x4d2c9216f1dca098'
   AND collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
   AND snapshot_at = '2026-09-13'
   AND moment_count = 1000;

DELETE FROM public.wallet_holdings_snapshot
 WHERE wallet_address = '0x4d2c9216f1dca098'
   AND collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
   AND snapshot_at = '2026-09-13'
   AND moment_count = 1000;

-- 2 ── refuse the shape at write time ─────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.whs_refuse_same_day_collapse()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
BEGIN
  -- Same snapshot_at only. A different day is a new observation and is never blocked.
  IF NEW.snapshot_at IS DISTINCT FROM OLD.snapshot_at THEN
    RETURN NEW;
  END IF;

  IF OLD.moment_count >= 100
     AND NEW.moment_count < OLD.moment_count / 2
  THEN
    RAISE EXCEPTION
      'refusing a same-day collapse on wallet_holdings_snapshot: % / % / % would go from % moments to % in one day. '
      'A real holdings change appears as a NEW snapshot_at, never as a same-day revision downward; this shape is a '
      'PARTIAL READ being written over a complete one (see migration 20260914180000). '
      'If this is a legitimate correction, DISABLE TRIGGER trg_whs_refuse_same_day_collapse around it.',
      NEW.wallet_address, NEW.collection_id, NEW.snapshot_at, OLD.moment_count, NEW.moment_count
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$function$;

-- anon-exec: NOT applicable for whs_refuse_same_day_collapse — a trigger function returns trigger and is not callable over PostgREST; revoked anyway on the next line.
REVOKE EXECUTE ON FUNCTION public.whs_refuse_same_day_collapse() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_whs_refuse_same_day_collapse ON public.wallet_holdings_snapshot;
CREATE TRIGGER trg_whs_refuse_same_day_collapse
  BEFORE UPDATE ON public.wallet_holdings_snapshot
  FOR EACH ROW
  EXECUTE FUNCTION public.whs_refuse_same_day_collapse();

COMMENT ON FUNCTION public.whs_refuse_same_day_collapse() IS
  'BEFORE UPDATE on wallet_holdings_snapshot: refuses a same-snapshot_at cut of more than half '
  'when the existing row holds >= 100 moments. Installed 2026-09-14 after a failed re-read upserted '
  'a 1,000-row partial over a complete 52,120-row snapshot. Fails LOUD (the edge function logs a '
  'whs_upsert exhaustion row) rather than letting the series lie.';

-- 3 ── verification, same transaction ─────────────────────────────────────────
DO $verify$
DECLARE
  v_backed int;
  v_left   int;
  v_vshape int;
BEGIN
  SELECT count(*) INTO v_backed FROM public.audit_20260914_whs_partial_write_backup;
  IF v_backed <> 1 THEN
    RAISE EXCEPTION 'expected exactly 1 backed-up row, found % — the delete is not reversible', v_backed;
  END IF;

  SELECT count(*) INTO v_left FROM public.wallet_holdings_snapshot
   WHERE wallet_address = '0x4d2c9216f1dca098'
     AND collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
     AND snapshot_at = '2026-09-13';
  IF v_left <> 0 THEN
    RAISE EXCEPTION 'the corrupt 2026-09-13 row is still present (% rows)', v_left;
  END IF;

  -- BAN AT ZERO over the whole table, above the stated floor: no V-shaped
  -- one-day collapse-and-recovery should remain anywhere.
  WITH s AS (
    SELECT wallet_address, collection_id, snapshot_at, moment_count,
           lag(moment_count)  OVER w AS prev_count,
           lead(moment_count) OVER w AS next_count
      FROM public.wallet_holdings_snapshot
    WINDOW w AS (PARTITION BY wallet_address, collection_id ORDER BY snapshot_at)
  )
  SELECT count(*) INTO v_vshape
    FROM s
   WHERE prev_count >= 100
     AND moment_count > 0
     AND moment_count < prev_count / 2
     AND next_count  > moment_count * 2;
  IF v_vshape <> 0 THEN
    RAISE EXCEPTION 'V-shaped one-day collapses remain above the 100-moment floor: %', v_vshape;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid = 'public.wallet_holdings_snapshot'::regclass
       AND tgname = 'trg_whs_refuse_same_day_collapse'
       AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'the guard trigger is not installed';
  END IF;
END
$verify$;

-- audit 2026-11-14 (#248) — refresh_wmc_fmv_changed drops an edition only when the
-- new (price, confidence) equals what THIS LANE LAST APPLIED, carries confidence,
-- and re-reads a 5-minute overlap behind its cursor.
--
-- WHY. Measured 2026-11-14 ~7:45 AM PT (5 % tablesample, Top Shot + All Day wmc):
-- on editions whose newest snapshot is 30 min – 6 h old — i.e. the fast lane has
-- had its chance and the 6-hour-min-age backstop has not — 113 of 6,760 editions
-- (1.7 %) still had holder rows off the newest price, 573 of 72,288 rows (0.8 %).
-- 81 of those 113 (72 %) are ONE mechanism:
--   * fmv-recalc writes delete-then-insert per DAY (`purge_fmv_snapshots_today*`),
--     so an intraday price that reached wmc (e.g. 39 MEDIUM) is ERASED from
--     fmv_snapshots by the next recalc of the same day;
--   * the 08-30 drop rule compared the new price to the newest snapshot AT OR
--     BEFORE the cursor — after the purge that is the DAY-BEFORE price (17.11), which
--     equals the new one (17.11), so the edition was dropped as "unchanged";
--   * the holder rows keep the erased intraday price until resync_stuck_wmc_fmv
--     (2-hourly, p_min_age 6 h) reaches them: 6–8 h of a wrong portfolio value.
--   The 08-30 note's soundness argument — "wmc already holds the <= v_cutoff value"
--   — is false exactly when that value was purged. Case: edition f54ee01f…,
--   16 holder rows at 39.00 MEDIUM (written by the backstop at 12:33 AM PT from an
--   intraday 39 MEDIUM snapshot that the 1:08 AM recalc purged) while every
--   surviving snapshot reads 17.11 LOW.
-- FIX. rwfc_applied remembers, per edition, the (fmv_usd, confidence) this lane last
-- pushed into wmc; the drop compares against THAT. Same probe count as before (one
-- PK lookup replaces one fmv_snapshots index probe), and correct by construction for
-- the lane's own writes. Seeded from edition_fmv_current, which reproduces the 08-30
-- rule's assumption at switch-over; the backstop repairs any edition stale at seed
-- time within its normal window, and the table is truthful from the first apply on.
-- CONFIDENCE (#248 lever (b)). The lane wrote fmv_usd only, so a confidence-only move
-- reached wmc via the backstop alone (16 of 33,731 sampled rows on 11-13). It now sets
-- fmv_confidence with the price; snapshots carry no NULL confidence (0 of 38,834 priced
-- rows in 24 h, 11-14), and the backstop already writes the same column the same way.
-- OVERLAP. fmv-recalc stamps its snapshots with its transaction's start (~15 s in) and
-- commits ~50 s later; the lane's cursor advanced to its own run start. Both observed
-- batches (07:48 PM 11-13, 01:08 AM 11-14) cleared that race by 2–3 s — a tick
-- starting inside the window would lose the whole batch to the backstop. The cursor
-- now stops 5 minutes behind the run start; re-read editions already applied are
-- dropped by the rule above, so the overlap costs probes, not holder scans.
--
-- Revert: re-apply supabase/migrations/20260830144724_audit_20260830_rwfc_skips_editions_whose_price_did_not_move.sql
-- (CREATE OR REPLACE of the 08-30 body); rwfc_applied is then unread and may stay.
-- anon-exec: unchanged (refresh_wmc_fmv_changed) — CREATE OR REPLACE of an existing fn; ACL preserved, read back 2026-11-14 9:14 AM PT has_function_privilege('anon', …, 'EXECUTE') = false.

DO $guard$
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.refresh_wmc_fmv_changed(integer,integer)'::regprocedure)
     IS DISTINCT FROM '80f0461843d1b5105a0a3aed193eeb9d' THEN
    RAISE EXCEPTION 'refresh_wmc_fmv_changed changed since this migration was written — re-read the live body';
  END IF;
END
$guard$;

CREATE TABLE IF NOT EXISTS public.rwfc_applied (
  edition_id uuid PRIMARY KEY,
  fmv_usd    numeric NOT NULL,
  confidence public.fmv_confidence,
  applied_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.rwfc_applied ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.rwfc_applied FROM anon, authenticated;
COMMENT ON TABLE public.rwfc_applied IS
  'refresh_wmc_fmv_changed: the (fmv_usd, confidence) it last pushed into wallet_moments_cache per edition. Its drop rule compares a new snapshot to THIS, not to the newest pre-cursor snapshot, which purge_fmv_snapshots_today can erase (#248, 2026-11-14).';

INSERT INTO public.rwfc_applied (edition_id, fmv_usd, confidence, applied_at)
SELECT l.edition_id, l.fmv_usd, l.confidence, now()
  FROM public.edition_fmv_current l
 WHERE l.fmv_usd IS NOT NULL
ON CONFLICT (edition_id) DO NOTHING;

CREATE OR REPLACE FUNCTION public.refresh_wmc_fmv_changed(p_since_minutes integer DEFAULT 30, p_limit integer DEFAULT 50000)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_total      integer := 0;
  v_batch      integer;
  v_cutoff     timestamptz;
  v_new_cutoff timestamptz;
  v_run_start  timestamptz := clock_timestamp();
  v_timeout_ms bigint;
  v_budget     interval;
  v_deadline   timestamptz;
  -- Sized to fit the SMALLEST caller budget (service_role 30s), never scaled up.
  v_chunk      constant integer := 5;
  -- 2026-11-14 (#248): how far behind its run start the cursor stops. fmv-recalc stamps
  -- snapshots with its transaction start and commits ~50 s later; a tick inside that
  -- window must not advance past a batch it could not yet see.
  v_overlap    constant interval := interval '5 minutes';
BEGIN
  -- Two callers run this same non-reentrant drain: pg_cron jobid 303 (`7-57/10`, median 240 s)
  -- and app/api/wmc-fmv-populate/route.ts (every 5 min, ~18 s budget). The route's tick one
  -- minute after jobid 303 used to block on wmc row locks and die -- 83 of 84 lock timeouts in
  -- 48 h landed on :08/:18/:28/:38/:48/:58. Skip instead of blocking; the other instance is
  -- draining the same rwfc_state cursor, so nothing is lost.
  -- ⚠ _xact_ is required: Supabase pools connections, so a leaked session-level advisory lock
  -- would be inherited by an unrelated request and wedge this function permanently.
  -- 🚨 NULL, not 0 -- `rows_written = 0` already means three different things here and a skip
  -- must not become the fourth. The route reads NULL as `skipped_concurrent_refresh`.
  IF NOT pg_try_advisory_xact_lock(hashtext('refresh_wmc_fmv_changed')::bigint) THEN
    RETURN NULL;
  END IF;

  SELECT setting::bigint INTO v_timeout_ms FROM pg_settings WHERE name = 'statement_timeout';

  IF v_timeout_ms IS NULL OR v_timeout_ms = 0 THEN
    v_budget := interval '300 seconds';
  ELSE
    v_budget := GREATEST(make_interval(secs => (v_timeout_ms / 1000.0) * 0.6),
                         interval '5 seconds');
  END IF;
  v_deadline := clock_timestamp() + v_budget;

  SELECT last_cutoff INTO v_cutoff FROM public.rwfc_state WHERE id = 1;
  IF v_cutoff IS NULL THEN
    v_cutoff := v_run_start - make_interval(mins => GREATEST(p_since_minutes, 1));
  END IF;

  DROP TABLE IF EXISTS _rwfc_recent;
  -- The filter is wrapped in a MATERIALIZED CTE so the planner cannot use
  -- fmv_snapshots_2026_edition_id_computed_at_idx to supply DISTINCT ON's ordering
  -- for free. That index leads on edition_id while the predicate is on computed_at,
  -- so there is no range to seek and the whole 2026 index is walked -- on a 418x row
  -- overestimate. Materialising first removes the ordering incentive; the planner
  -- then seeks idx_fmv_snapshots_2026_computed_at_desc and pays a tiny quicksort.
  -- Measured 2026-08-22, warm-vs-warm, same 563 output rows: 8,402 buffers / 471 ms
  -- as written vs 29 buffers / 0.98 ms wrapped. Output diffed with EXCEPT in BOTH
  -- directions: 0 rows only-in-incumbent, 0 rows only-in-candidate.
  CREATE TEMP TABLE _rwfc_recent ON COMMIT DROP AS
  WITH recent AS MATERIALIZED (
    SELECT fs.edition_id, fs.computed_at
    FROM public.fmv_snapshots fs
    WHERE fs.computed_at > v_cutoff
      AND fs.fmv_usd IS NOT NULL
  )
  SELECT DISTINCT ON (r.edition_id) r.edition_id, r.computed_at
  FROM recent r
  ORDER BY r.edition_id, r.computed_at DESC;
  CREATE INDEX ON _rwfc_recent (computed_at);
  ANALYZE _rwfc_recent;

  -- 2026-08-30: drop editions whose newest price is the price wmc already has --
  -- fmv-recalc writes a row per recalculated edition whether or not the number moved
  -- (74 % of snapshots), and without this every one of them read every holder row.
  -- 2026-11-14 (#248): "the price wmc already has" is now the (fmv_usd, confidence)
  -- this lane last APPLIED (rwfc_applied), NOT the newest snapshot at or before the
  -- cursor. fmv-recalc purges an edition's earlier same-day snapshot before inserting
  -- the next, so after an intraday move the pre-cursor snapshot is the DAY-BEFORE
  -- price: a move back to it was dropped as "unchanged" and the holder rows kept the
  -- erased intraday price for 6–8 h (72 % of the lane's measured misses). An edition
  -- with no rwfc_applied row has nothing to compare against and stays queued.
  DELETE FROM _rwfc_recent
   WHERE edition_id IN (
     SELECT r.edition_id
       FROM _rwfc_recent r
       JOIN LATERAL (
         SELECT f.fmv_usd, f.confidence FROM public.fmv_snapshots f
          WHERE f.edition_id = r.edition_id AND f.computed_at > v_cutoff AND f.fmv_usd IS NOT NULL
          ORDER BY f.computed_at DESC LIMIT 1
       ) cur ON true
       JOIN public.rwfc_applied a ON a.edition_id = r.edition_id
      WHERE cur.fmv_usd = a.fmv_usd
        AND cur.confidence IS NOT DISTINCT FROM a.confidence
   );

  LOOP
    WITH popped AS (
      DELETE FROM _rwfc_recent
       WHERE edition_id IN (
         SELECT edition_id FROM _rwfc_recent ORDER BY computed_at LIMIT v_chunk
       )
      RETURNING edition_id
    ),
    latest_fmv AS MATERIALIZED (
      SELECT e.id AS edition_id, e.collection_id, e.external_id, s.fmv_usd, s.confidence
      FROM popped p
      JOIN public.editions e ON e.id = p.edition_id
      LEFT JOIN LATERAL (
        SELECT f.fmv_usd, f.confidence
          FROM public.fmv_snapshots f
         WHERE f.edition_id = e.id
           AND f.fmv_usd IS NOT NULL
         ORDER BY f.computed_at DESC
         LIMIT 1
      ) s ON true
    ),
    updated AS (
      UPDATE public.wallet_moments_cache wmc
         SET fmv_usd = lf.fmv_usd,
             fmv_confidence = lf.confidence
        FROM latest_fmv lf
       WHERE wmc.collection_id = lf.collection_id
         AND wmc.edition_key   = lf.external_id
         AND wmc.edition_key IS NOT NULL
         AND lf.fmv_usd IS NOT NULL
         AND (wmc.fmv_usd IS DISTINCT FROM lf.fmv_usd
              OR wmc.fmv_confidence IS DISTINCT FROM lf.confidence)
      RETURNING 1
    ),
    -- 2026-11-14 (#248): remember what was pushed, in the same statement as the push,
    -- so the record and the wmc write commit (or roll back) together.
    recorded AS (
      INSERT INTO public.rwfc_applied (edition_id, fmv_usd, confidence, applied_at)
      SELECT lf.edition_id, lf.fmv_usd, lf.confidence, now()
        FROM latest_fmv lf
       WHERE lf.fmv_usd IS NOT NULL
      ON CONFLICT (edition_id) DO UPDATE
        SET fmv_usd = EXCLUDED.fmv_usd, confidence = EXCLUDED.confidence, applied_at = EXCLUDED.applied_at
      RETURNING 1
    )
    SELECT COUNT(*)::int INTO v_batch FROM updated;

    v_total := v_total + COALESCE(v_batch, 0);

    EXIT WHEN NOT EXISTS (SELECT 1 FROM _rwfc_recent);
    EXIT WHEN clock_timestamp() > v_deadline;
    EXIT WHEN v_total >= p_limit;
  END LOOP;

  SELECT MIN(computed_at) - interval '1 microsecond' INTO v_new_cutoff FROM _rwfc_recent;
  -- 2026-11-14 (#248): never further forward than v_overlap behind this run's start.
  v_new_cutoff := LEAST(COALESCE(v_new_cutoff, v_run_start), v_run_start - v_overlap);

  INSERT INTO public.rwfc_state (id, last_cutoff) VALUES (1, v_new_cutoff)
  ON CONFLICT (id) DO UPDATE SET last_cutoff = EXCLUDED.last_cutoff;

  RETURN v_total;
END;
$function$;

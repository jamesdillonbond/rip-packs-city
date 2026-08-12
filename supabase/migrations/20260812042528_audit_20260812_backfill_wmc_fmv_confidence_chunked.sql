-- Bounded, resumable backfill for wallet_moments_cache.fmv_confidence.
--
-- WHY A SEPARATE FUNCTION rather than p_force:
-- populate_wmc_fmv_from_snapshots(p_force => true) builds a `latest_fmv` CTE
-- with DISTINCT ON over EVERY edition x snapshot in the collection, so its
-- cost scales with COLLECTION size, not with how much work is left. That is
-- fine for Golazos (21,492 rows, ran in seconds) and UFC/Candy, but it blew
-- the 120s statement_timeout on NFL All Day (448k) and would be far worse on
-- Top Shot (1.67M). This mirrors the proven chunked path instead: a
-- CROSS JOIN LATERAL ... LIMIT 1 per candidate row, so cost scales with
-- p_limit and each call is a short, safely-retryable transaction.
--
-- IT WRITES BOTH FIELDS, deliberately. A label-only backfill would be cheaper
-- and could never move a displayed price, but it would break the invariant
-- that makes this column meaningful: if wmc.fmv_usd has drifted from the
-- latest snapshot, stamping that snapshot's confidence onto the older value
-- would describe a number that did not come from that row -- a subtler version
-- of the exact defect this work exists to fix. Value and label are always
-- taken from the SAME snapshot row. (Drift is not hypothetical: measured on
-- NFL All Day, only 124 of a 1,000-row sample still matched their latest
-- snapshot, so ~88% would have been mislabeled by a label-only pass.)
--
-- COST, measured 2026-08-12: ~59 ms/row. wallet_moments_cache carries 15
-- indexes (~1.5 GB) and its HOT-update ratio is 1.8% (9,155 of 503,748), so
-- essentially every row update maintains every index -- idx_wmc_cohort_cover
-- INCLUDEs fmv_usd, which alone disqualifies HOT on any value change. That is
-- why this is drained by a paced pg_cron job rather than run inline.
--
-- FOR UPDATE SKIP LOCKED for the same reason the cron path uses it: this
-- races the wallet-backfill writers on the same rows, and a skipped row is
-- simply retried on the next call.
--
-- Residue: rows whose edition has no snapshot with a non-NULL fmv_usd are
-- dropped by the CROSS JOIN and stay candidates forever, so the remaining
-- count converges to that small residue rather than to zero (AllDay ~104,
-- UFC ~1,719). Callers should stop when a call returns 0, not when the
-- candidate count reaches 0. For the same reason the drain job names its
-- collections explicitly instead of passing NULL: Disney Pinnacle's FMV lives
-- in pinnacle_fmv_history (not fmv_snapshots) and its editions live in
-- pinnacle_editions (not editions), so all 51,198 Pinnacle rows would be
-- permanent non-matching candidates consuming the chunk quota every tick.
--
-- Revert: DROP FUNCTION public.backfill_wmc_fmv_confidence(uuid, integer);
--         SELECT cron.unschedule('rpc-backfill-wmc-fmv-confidence');

CREATE OR REPLACE FUNCTION public.backfill_wmc_fmv_confidence(
  p_collection_id uuid DEFAULT NULL::uuid,
  p_limit integer DEFAULT 25000
)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '120s'
AS $function$
DECLARE
  v_updated integer;
BEGIN
  WITH targets AS (
    SELECT wmc.id, wmc.collection_id, wmc.edition_key
    FROM public.wallet_moments_cache wmc
    WHERE wmc.fmv_confidence IS NULL
      AND wmc.edition_key IS NOT NULL
      AND (p_collection_id IS NULL OR wmc.collection_id = p_collection_id)
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  ),
  snapped AS (
    SELECT t.id AS wmc_id, fs.fmv_usd, fs.confidence
    FROM targets t
    JOIN public.editions e
      ON e.collection_id = t.collection_id
     AND e.external_id   = t.edition_key
    CROSS JOIN LATERAL (
      SELECT fmv_usd, confidence
      FROM public.fmv_snapshots
      WHERE edition_id = e.id
        AND fmv_usd IS NOT NULL
      ORDER BY computed_at DESC
      LIMIT 1
    ) fs
  ),
  updated AS (
    UPDATE public.wallet_moments_cache wmc
       SET fmv_usd        = s.fmv_usd,
           fmv_confidence = s.confidence
      FROM snapped s
     WHERE wmc.id = s.wmc_id
     RETURNING 1
  )
  SELECT COUNT(*)::int INTO v_updated FROM updated;

  RETURN COALESCE(v_updated, 0);
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.backfill_wmc_fmv_confidence(uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.backfill_wmc_fmv_confidence(uuid, integer) TO service_role;

-- Paced drain for the two large collections. ~500+500 rows per 5 min at
-- ~59 ms/row is roughly a 20% duty cycle and clears the remaining ~2.1M rows
-- in ~9 days without a sustained write storm on a disk-IO-throttled instance.
-- Applied via execute_sql, not this migration (apply_migration cannot touch
-- cron.job -- 42501):
--
--   SELECT cron.schedule('rpc-backfill-wmc-fmv-confidence', '2-59/5 * * * *',
--     $$SELECT public.backfill_wmc_fmv_confidence('dee28451-5d62-409e-a1ad-a83f763ac070'::uuid, 500);
--       SELECT public.backfill_wmc_fmv_confidence('95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid, 500);$$);
--
-- Live as jobid 302.

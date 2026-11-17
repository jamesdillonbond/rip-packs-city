-- audit_20261110_backfill_wmc_fmv_confidence_limits_after_the_priced_join
--
-- Claude Code cloud, 2026-11-10 ~1:18 PM PT (DB clock). backfill_wmc_fmv_confidence (pg_cron 302, every 5 min,
-- rotating Top Shot / All Day / UFC / Golazos, p_limit 1000) takes its batch LIMIT over rows that CAN be labelled.
--
-- WHY: the LIMIT sat in a `targets` CTE before the join to an edition with a priced snapshot. The pin recorded the
-- consequence as "the limit bounds EXAMINED, not written": an unresolvable row (no edition in the collection, or no
-- priced snapshot) spent a batch slot on every tick forever, and a resolvable row behind enough of them was never
-- reached. Measured 1:15 PM PT: Top Shot 4,216 unlabelled rows, 1,189 with an edition, 1,090 resolvable, 585 older
-- than 6 h, the oldest from April. Same class as populate_wmc_image the same afternoon (20261110210433).
-- New shape on Top Shot: 19k buffers / 205 ms for a 1,000-row batch (the planner-chosen single-statement form drove
-- from all 9,240 editions instead: 92k buffers / 2.5 s, hence the MATERIALIZED steps).
--
-- Pin (supabase/tests/backfill_wmc_fmv_confidence.sql): every property kept — value and label from ONE snapshot row,
-- a NULL-priced latest snapshot skipped, fill-only, collection-scoped join, keyless rows skipped, zero limit honoured,
-- unresolvable rows stay unlabelled. The "limit bounds EXAMINED" block is INVERTED with a discriminating case (a
-- resolvable row behind unresolvable ones, batch of 1): new body 1, old body 0 — run locally against both
-- (scripts/lib/local-postgres.mjs): new exit 0; old body planted, exit 3 on exactly that assertion.
--
-- anon-exec: unchanged (backfill_wmc_fmv_confidence) — CREATE OR REPLACE of an existing fn; ACL preserved, verified has_function_privilege anon=false, authenticated=false (job 302 runs as postgres).
--
-- REVERT: re-apply the CREATE OR REPLACE block of
--   supabase/migrations/20260816080000_audit_20260816_snapshot_remaining_scheduled_mv_and_rollup_writers.sql
--   and point the pin + drift-guard registry back at it.

DO $$
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.backfill_wmc_fmv_confidence(uuid,integer)'::regprocedure) <> '03d0bbeb867ef0c499d5214588762d85' THEN
    RAISE EXCEPTION 'backfill_wmc_fmv_confidence changed since it was read (expected md5 03d0bbeb...); re-derive before replacing';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.backfill_wmc_fmv_confidence(p_collection_id uuid DEFAULT NULL::uuid, p_limit integer DEFAULT 25000)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '120s'
AS $function$
DECLARE
  v_updated integer;
BEGIN
  -- 2026-11-10: the batch LIMIT is taken over rows that CAN be labelled (an edition in the same collection
  -- with a priced snapshot), not over every unlabelled row. Taken before that join, an unresolvable row spent
  -- a batch slot on every tick forever, so a resolvable row behind enough of them was never reached (Top Shot:
  -- 1,090 resolvable of 4,216 unlabelled, the oldest since April). Value and label still come from ONE snapshot
  -- row; the job always passes a collection (pg_cron 302 rotates four), so `cand` stays small.
  WITH cand AS MATERIALIZED (
    SELECT w.id, e.id AS edition_id
    FROM public.wallet_moments_cache w
    JOIN public.editions e
      ON e.collection_id = w.collection_id
     AND e.external_id   = w.edition_key
    WHERE w.fmv_confidence IS NULL
      AND w.edition_key IS NOT NULL
      AND (p_collection_id IS NULL OR w.collection_id = p_collection_id)
  ),
  priced AS MATERIALIZED (
    SELECT c.id AS wmc_id, fs.fmv_usd, fs.confidence
    FROM cand c
    CROSS JOIN LATERAL (
      SELECT fmv_usd, confidence
      FROM public.fmv_snapshots
      WHERE edition_id = c.edition_id
        AND fmv_usd IS NOT NULL
      ORDER BY computed_at DESC
      LIMIT 1
    ) fs
    LIMIT p_limit
  ),
  targets AS (
    SELECT w.id
    FROM public.wallet_moments_cache w
    JOIN priced p ON p.wmc_id = w.id
    WHERE w.fmv_confidence IS NULL
    FOR UPDATE OF w SKIP LOCKED
  ),
  updated AS (
    UPDATE public.wallet_moments_cache wmc
       SET fmv_usd        = p.fmv_usd,
           fmv_confidence = p.confidence
      FROM priced p
      JOIN targets t ON t.id = p.wmc_id
     WHERE wmc.id = p.wmc_id
     RETURNING 1
  )
  SELECT COUNT(*)::int INTO v_updated FROM updated;

  RETURN COALESCE(v_updated, 0);
END;
$function$;

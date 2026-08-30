-- audit_20260830: backfill_pack_rip_metadata summed a rip's pull value through
-- the fmv_current DISTINCT ON view -- a full 1.31M-row pass per hourly call.
--
-- MEASURED 2026-08-30 15:3xZ. Caller: /api/cron/backfill-pack-rip-metadata
-- (cron-job.org, hourly :53, p_limit 500). pg_stat_statements lifetime: 231
-- calls, 22,488 ms mean. EXPLAIN ANALYZE of one call (p_limit 500) before this
-- migration: 1,313,808 buffer hits + 5,123 reads, 4.5 s on a warm cache --
-- the same 1.31M-row Merge Append that 20260830152806 removed from the pack
-- pricing core: `LEFT JOIN public.fmv_current fc ON fc.edition_id =
-- m.edition_id AND fc.collection_id = m.collection_id` in the pull_values
-- CTE. The planner cannot push the candidates' edition ids into DISTINCT ON,
-- so it materialises the view to price <= 500 rips' moments.
--
-- CHANGE: that one join becomes a per-moment LATERAL (newest snapshot for the
-- moment's edition regardless of collection, then the collection must match
-- or the moment contributes nothing) -- the view's exact two steps. Every
-- other CTE (candidate split, dist voting, best_dist tie-break, the UPDATE
-- and its RETURNING accounting) is untouched. Not pinned before; not pinned
-- now (the function is not in any migration -- pre-migration DDL); the
-- previous pull_values CTE is quoted in the REVERT note below.
--
-- anon-exec: backfill_pack_rip_metadata -- unchanged (CREATE OR REPLACE keeps
-- the existing grants; service_role caller).
--
-- Exit (24 h): the hourly call's mean falls from ~22 s toward ~1 s and its
-- buffer hits from ~1.3M toward the low thousands; pipeline_runs
-- backfill-pack-rip-metadata processed/value_resolved per run unchanged.
-- Falsifier: hits unchanged -> the cost is in the moment_acquisitions /
-- moments joins, not the FMV lookup.
-- REVERT: replace the LATERAL with
--   LEFT JOIN public.fmv_current fc ON fc.edition_id = m.edition_id AND fc.collection_id = m.collection_id
-- (everything else below is the pre-migration body verbatim).

CREATE OR REPLACE FUNCTION public.backfill_pack_rip_metadata(p_limit integer DEFAULT 500)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '60s'
AS $function$
DECLARE
  v_processed int := 0;
  v_dist_resolved int := 0;
  v_value_resolved int := 0;
  v_safe_limit int := LEAST(GREATEST(COALESCE(p_limit, 500), 1), 5000);
  v_stale_share int;
BEGIN
  v_stale_share := GREATEST(1, (v_safe_limit * 4) / 10);

  WITH stale_valued AS MATERIALIZED (
    SELECT pr.id, pr.pack_nft_id, pr.collection_id, pr.dist_id AS cur_dist
    FROM public.pack_rips pr
    WHERE pr.pull_value_usd IS NOT NULL
      AND pr.metadata_updated_at < now() - interval '7 days'
    ORDER BY pr.metadata_updated_at ASC
    LIMIT v_stale_share
  ),
  null_drain AS MATERIALIZED (
    SELECT pr.id, pr.pack_nft_id, pr.collection_id, pr.dist_id AS cur_dist
    FROM public.pack_rips pr
    WHERE pr.metadata_updated_at IS NULL
    ORDER BY pr.sealed_at DESC
    LIMIT (v_safe_limit - v_stale_share)
  ),
  candidates AS MATERIALIZED (
    SELECT * FROM stale_valued
    UNION ALL
    SELECT * FROM null_drain
  ),
  rip_editions AS MATERIALIZED (
    SELECT c.id AS rip_id, c.collection_id, m.edition_id
    FROM candidates c
    JOIN public.moment_acquisitions ma ON ma.source_pack_rip_id = c.id
    JOIN public.moments m ON m.nft_id = ma.nft_id AND m.collection_id = c.collection_id
    WHERE m.edition_id IS NOT NULL
    GROUP BY 1, 2, 3
  ),
  rip_counts AS (
    SELECT rip_id, count(*) AS n_ed FROM rip_editions GROUP BY 1
  ),
  votes AS (
    SELECT re.rip_id, pdp.dist_id, count(*) AS matched
    FROM rip_editions re
    JOIN public.pack_drop_pool pdp ON pdp.edition_id = re.edition_id AND pdp.collection_id = re.collection_id
    GROUP BY 1, 2
  ),
  full_matches AS (
    SELECT v.rip_id, v.dist_id
    FROM votes v
    JOIN rip_counts rc ON rc.rip_id = v.rip_id
    WHERE v.matched = rc.n_ed
  ),
  best_dist AS (
    SELECT DISTINCT ON (fm.rip_id) fm.rip_id, fm.dist_id
    FROM full_matches fm
    JOIN candidates c ON c.id = fm.rip_id
    ORDER BY fm.rip_id, (fm.dist_id = c.cur_dist) DESC, fm.dist_id
  ),
  pull_values AS (
    SELECT c.id AS rip_id,
           COALESCE(SUM(fc.fmv_usd), 0)::numeric(14,2) AS pull_value_usd
    FROM candidates c
    JOIN public.moment_acquisitions ma ON ma.source_pack_rip_id = c.id
    LEFT JOIN public.moments m  ON m.nft_id = ma.nft_id AND m.collection_id = c.collection_id
    -- 2026-08-30: newest snapshot per moment's edition, looked up per row,
    -- instead of LEFT JOIN fmv_current (the DISTINCT ON view, a full pass
    -- over every snapshot per call). Same two steps as the view join.
    LEFT JOIN LATERAL (
      SELECT s.fmv_usd, s.collection_id
      FROM public.fmv_snapshots s
      WHERE s.edition_id = m.edition_id
      ORDER BY s.computed_at DESC
      LIMIT 1
    ) fc ON fc.collection_id = m.collection_id
    GROUP BY c.id
  ),
  upd AS (
    UPDATE public.pack_rips pr
    SET dist_id              = COALESCE(bd.dist_id, pr.dist_id),
        pull_value_usd       = pv.pull_value_usd,
        metadata_updated_at  = now()
    FROM candidates c
    LEFT JOIN best_dist bd  ON bd.rip_id = c.id
    LEFT JOIN pull_values pv ON pv.rip_id = c.id
    WHERE pr.id = c.id
    RETURNING pr.id, pr.dist_id IS NOT NULL AS dist_resolved, pr.pull_value_usd > 0 AS value_resolved
  )
  SELECT
    COUNT(*),
    COUNT(*) FILTER (WHERE dist_resolved),
    COUNT(*) FILTER (WHERE value_resolved)
  INTO v_processed, v_dist_resolved, v_value_resolved
  FROM upd;

  RETURN jsonb_build_object(
    'processed', v_processed,
    'dist_resolved', v_dist_resolved,
    'value_resolved', v_value_resolved,
    'finished_at', now()
  );
END;
$function$;

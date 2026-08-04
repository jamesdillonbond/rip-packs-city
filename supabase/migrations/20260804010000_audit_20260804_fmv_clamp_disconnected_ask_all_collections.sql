-- audit_20260804_fmv_clamp_disconnected_ask_all_collections
--
-- Generalise the disconnected-ASK clamp beyond Top Shot.
--
-- THE DEFECT. public.fmv_clamp_disconnected_ask_topshot(boolean) hardcoded
--     c_ts uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
-- in BOTH of its CTEs (the `latest` snapshot pick and the `s90` sales rollup), so
-- the guard that pulls an inflated LOW/ASK_ONLY FMV back to a sales-anchored level
-- ran for exactly one collection out of five. Everything else about it was sound.
--
-- Running its EXACT predicate — thresholds untouched — against the non-Top-Shot
-- collections on 2026-08-03 returned 5 editions, all NFL All Day, $48.24 of
-- published FMV standing on nothing:
--
--   Landon Collins   COMMON    circ 10,000  10 sales  med $0.37  FMV $24.75 -> $0.81
--   Jared Goff       COMMON    circ 10,000  19 sales  med $0.25  FMV $14.30 -> $0.66
--   David Montgomery RARE      circ    262   5 sales  med $2.00  FMV  $9.90 -> $3.00
--   Brock Purdy      UNCOMMON  circ    500  10 sales  med $1.00  FMV  $3.60 -> $1.50
--   Kalif Raymond    RARE      circ    499   9 sales  med $1.00  FMV  $3.60 -> $1.94
--
-- No scarcity story anywhere in that list — circulation 262 to 10,000 with tight
-- real order books. Goff's 19 sales all landed between $0.20 and $0.30. These are
-- precisely the population the clamp was written for; they escaped only because of
-- the hardcoded UUID. Golazos, UFC, Candy and Pinnacle return zero under the same
-- predicate, so this is All-Day-only in practice today.
--
-- WHAT CHANGED — SCOPE ONLY. Not one threshold moved. The selection predicate is
-- still `confidence IN ('LOW','ASK_ONLY') AND n_real >= 5 AND fmv > med*3 AND
-- fmv > p90*1.5`, the clamp floor is still `GREATEST(p90*1.5, med)`, the
-- `_p90clamp` algo_version tag is still idempotent, and the pipeline_runs INSERT
-- is still gated on `v_clamped > 0` so a no-op run stays silent.
--
--   * new signature fmv_clamp_disconnected_ask(p_collection_id uuid DEFAULT NULL,
--     p_dry_run boolean DEFAULT false). NULL = every collection.
--   * Pinnacle is excluded. Its FMV is render-keyed and lives in
--     pinnacle_fmv_history, not fmv_snapshots (verified live: fmv_snapshots holds
--     ZERO Pinnacle rows), so the exclusion is defensive rather than load-bearing
--     — it keeps a future writer from quietly dragging Pinnacle into a clamp whose
--     median is computed off the wrong table.
--   * `extra.scope` is added to the pipeline_runs payload so a scoped inline call
--     is distinguishable from the full-scope nightly one.
--
-- ⚠ SARGABILITY — the collection filter is `= ANY(v_ids)`, never
-- `(p_collection_id IS NULL OR collection_id = p_collection_id)`. The OR-form is
-- non-sargable: the planner cannot prune `sales` partitions or use
-- sales_YYYY_collection_id_sold_at_idx through it, which is the exact trap that
-- cost 42.9s vs 3.5s in classify-acquisitions on 2026-08-03. Verified on this
-- shape: `= ANY(array)` still plans as
--   Index Cond: ((collection_id = ANY (...)) AND (sold_at >= ...))
-- with `Subplans Removed: 6`.
--
-- MEASURED COST (2026-08-03, live prod):
--   scoped to Top Shot   4.0s /   823k buffers   (what runs today)
--   full scope, NULL    15.7s / 1,240k buffers
-- Both sit well inside the function's 120s statement_timeout. The full-scope form
-- is for the daily pg_cron backstop; /api/fmv-recalc calls it SCOPED to the
-- collections it actually wrote, because that route already averages 181s against
-- a 300s wall with ~23.6% of invocations killed — a blanket +11.7s inline would
-- have bought correctness for All Day by pushing more runs over the wall.
--
-- ROLLBACK:
--   SELECT cron.alter_job(69, command =>
--     'SELECT public.fmv_clamp_disconnected_ask_topshot(false)');
--   -- then re-apply 20260731210000_..._fmv_clamp_and_pack_ev.sql to restore the
--   -- Top-Shot-only function, and revert the commit for the route + pin.
-- The clamp overwrites fmv_usd in place and does not retain the prior value, so
-- the 5 affected snapshot rows were baselined to
-- audit_20260804_ask_clamp_baseline before the first live run. It is self-healing
-- regardless: the next fmv-recalc recomputes the ASK_ONLY price and the clamp
-- re-applies, so a bad clamp cannot compound.

CREATE OR REPLACE FUNCTION public.fmv_clamp_disconnected_ask(p_collection_id uuid DEFAULT NULL, p_dry_run boolean DEFAULT false)
 RETURNS TABLE(rows_examined bigint, rows_clamped bigint, dollars_removed numeric)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '120s'
AS $function$
DECLARE
  c_pinnacle uuid := '7dd9dd11-e8b6-45c4-ac99-71331f959714';
  v_ids uuid[];
  v_started timestamptz := clock_timestamp();
  v_examined bigint := 0;
  v_clamped  bigint := 0;
  v_dollars  numeric := 0;
BEGIN
  -- Resolve the collection scope into an ARRAY so every downstream predicate can
  -- stay an index condition. Pinnacle never participates: its FMV is render-keyed
  -- in pinnacle_fmv_history, so a median taken from fmv_snapshots would be wrong.
  IF p_collection_id IS NOT NULL THEN
    IF p_collection_id = c_pinnacle THEN
      RETURN QUERY SELECT 0::bigint, 0::bigint, 0::numeric;
      RETURN;
    END IF;
    v_ids := ARRAY[p_collection_id];
  ELSE
    SELECT array_agg(c.id) INTO v_ids FROM public.collections c WHERE c.id <> c_pinnacle;
  END IF;

  IF v_ids IS NULL OR array_length(v_ids, 1) IS NULL THEN
    RETURN QUERY SELECT 0::bigint, 0::bigint, 0::numeric;
    RETURN;
  END IF;

  IF p_dry_run THEN
    WITH latest AS (
      SELECT DISTINCT ON (fs.edition_id) fs.id, fs.edition_id, fs.fmv_usd, fs.confidence
      FROM public.fmv_snapshots fs
      WHERE fs.collection_id = ANY(v_ids)
      ORDER BY fs.edition_id, fs.computed_at DESC
    ),
    s90 AS (
      SELECT s.edition_id,
        count(*) FILTER (WHERE s.price_usd > 0.10) AS n_real,
        percentile_cont(0.9) WITHIN GROUP (ORDER BY s.price_usd) FILTER (WHERE s.price_usd > 0.10) AS p90,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY s.price_usd) FILTER (WHERE s.price_usd > 0.10) AS med
      FROM public.sales s
      WHERE s.collection_id = ANY(v_ids) AND s.sold_at >= now() - interval '90 days'
      GROUP BY s.edition_id
    ),
    targets AS (
      SELECT l.id AS snapshot_id, l.fmv_usd AS old_fmv,
             ROUND(GREATEST(s.p90 * 1.5, s.med)::numeric, 2) AS new_fmv
      FROM latest l
      JOIN s90 s ON s.edition_id = l.edition_id
      JOIN public.editions e ON e.id = l.edition_id
      WHERE l.confidence IN ('LOW','ASK_ONLY')
        AND s.n_real >= 5 AND s.p90 > 0
        AND l.fmv_usd > s.med * 3
        AND l.fmv_usd > s.p90 * 1.5
        AND l.fmv_usd > ROUND(GREATEST(s.p90 * 1.5, s.med)::numeric, 2)
    )
    SELECT count(*), COALESCE(sum(old_fmv - new_fmv), 0) INTO v_examined, v_dollars FROM targets;
    v_clamped := v_examined;
  ELSE
    WITH latest AS (
      SELECT DISTINCT ON (fs.edition_id) fs.id, fs.edition_id, fs.fmv_usd, fs.confidence
      FROM public.fmv_snapshots fs
      WHERE fs.collection_id = ANY(v_ids)
      ORDER BY fs.edition_id, fs.computed_at DESC
    ),
    s90 AS (
      SELECT s.edition_id,
        count(*) FILTER (WHERE s.price_usd > 0.10) AS n_real,
        percentile_cont(0.9) WITHIN GROUP (ORDER BY s.price_usd) FILTER (WHERE s.price_usd > 0.10) AS p90,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY s.price_usd) FILTER (WHERE s.price_usd > 0.10) AS med
      FROM public.sales s
      WHERE s.collection_id = ANY(v_ids) AND s.sold_at >= now() - interval '90 days'
      GROUP BY s.edition_id
    ),
    targets AS (
      SELECT l.id AS snapshot_id, l.fmv_usd AS old_fmv,
             ROUND(GREATEST(s.p90 * 1.5, s.med)::numeric, 2) AS new_fmv
      FROM latest l
      JOIN s90 s ON s.edition_id = l.edition_id
      JOIN public.editions e ON e.id = l.edition_id
      WHERE l.confidence IN ('LOW','ASK_ONLY')
        AND s.n_real >= 5 AND s.p90 > 0
        AND l.fmv_usd > s.med * 3
        AND l.fmv_usd > s.p90 * 1.5
        AND l.fmv_usd > ROUND(GREATEST(s.p90 * 1.5, s.med)::numeric, 2)
    ),
    upd AS (
      UPDATE public.fmv_snapshots fs
      SET fmv_usd = t.new_fmv,
          algo_version = CASE WHEN RIGHT(COALESCE(fs.algo_version,''),9) = '_p90clamp'
                              THEN fs.algo_version
                              ELSE COALESCE(fs.algo_version,'') || '_p90clamp' END
      FROM targets t
      WHERE fs.id = t.snapshot_id
      RETURNING (t.old_fmv - t.new_fmv) AS delta
    )
    SELECT count(*), COALESCE(sum(delta), 0) INTO v_clamped, v_dollars FROM upd;
    v_examined := v_clamped;

    IF v_clamped > 0 THEN
      INSERT INTO public.pipeline_runs (pipeline, started_at, finished_at, ok, extra)
      VALUES ('fmv-clamp-disconnected-ask', v_started, clock_timestamp(), true,
              jsonb_build_object('rows_clamped', v_clamped, 'dollars_removed', round(v_dollars, 2),
                                 'scope', COALESCE(p_collection_id::text, 'all')));
    END IF;
  END IF;

  RETURN QUERY SELECT v_examined, v_clamped, round(v_dollars, 2);
END;
$function$;

COMMENT ON FUNCTION public.fmv_clamp_disconnected_ask(uuid, boolean) IS
  'Clamps LOW/ASK_ONLY FMVs disconnected from the edition''s own 90d sale distribution (fmv > med*3 AND > p90*1.5) down to GREATEST(p90*1.5, med). p_collection_id NULL = all collections except Pinnacle (render-keyed FMV, different table). Supersedes fmv_clamp_disconnected_ask_topshot, which hardcoded Top Shot.';

-- ⚠ CREATE OR REPLACE with a CHANGED SIGNATURE creates a NEW function whose
-- default EXECUTE grant is to PUBLIC. The ACL then carries BOTH the PUBLIC default
-- and any explicit role rows, so revoking only one of them leaves
-- has_function_privilege('anon', ...) TRUE. Revoke both. (This exact class shipped
-- an anon-executable SECDEF writer on 2026-08-03, commit a4105fc6.)
REVOKE ALL ON FUNCTION public.fmv_clamp_disconnected_ask(uuid, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fmv_clamp_disconnected_ask(uuid, boolean) TO service_role, postgres;

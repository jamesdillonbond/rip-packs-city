-- audit_20260830_clamp_for_editions_s90_reads_only_the_low_ask_only_editions
--
-- FOLLOW-UP to 20260830040739 (fmv_clamp_disconnected_ask_for_editions). That migration
-- scoped the inline clamp to the edition list /api/fmv-recalc just wrote, and its own header
-- records why the scoping is value-preserving: "the clamp's s90 is GROUP BY edition, so
-- restricting the edition set changes no value". The same argument goes one step further and
-- this migration takes it: `targets` only ever joins s90 rows to `latest` rows whose
-- confidence is LOW or ASK_ONLY, so the 90-day sales aggregate over every OTHER edition in the
-- list was computed and thrown away.
--
-- MEASURED 2026-08-30 05:0xZ against the ids the 04:46-04:56Z recalc wrote (1,138 editions,
-- 272 of them LOW/ASK_ONLY = 24 %), EXPLAIN (ANALYZE, BUFFERS) of the dry-run body as raw SQL,
-- new shape run FIRST (so any cache warmth favours the old shape):
--     old: s90 over 1,138 editions -> 36,191 sales rows, 46,208 buffers (12,149 disk reads), 7.2 s
--     new: s90 over   272 editions ->  3,765 sales rows, 14,380 buffers ( 2,481 disk reads), 1.6 s
--     both: 0 targets, 84 rows removed by the same join filter -- identical result.
-- pg_stat_statements since deploy (04:07-05:01Z): 5 calls, 15.2 s mean, 56k disk reads total --
-- the whole cost is this sales read. LOW/ASK_ONLY editions are by definition the thin-sales
-- ones, so the rows cut is larger than the edition-count cut (9.6x vs 4.2x).
--
-- SEMANTICS: identical. s90 for an edition depends only on that edition's sales, never on which
-- other editions are in the list; `targets` = latest(LOW|ASK_ONLY) JOIN s90 either way. The
-- confidence predicate moves from `targets` into `latest`; every other predicate, multiplier,
-- the Pinnacle exclusion, the UPDATE, the pipeline_runs row and the return shape are unchanged.
-- Signature unchanged (uuid[], boolean) -> no new overload; ACL restated anyway.
--
-- anon-exec: NOT granted — write function; service_role only, unchanged from 20260830040739.
--
-- REVERT: re-apply the body from 20260830040739_audit_20260830_haircut_and_clamp_for_editions_
--         scope_the_inline_fmv_recalc_step_to_what_it_just_wrote.sql (s90 over `ids`, the
--         confidence predicate back in `targets`). No table, index or schedule changed.

CREATE OR REPLACE FUNCTION public.fmv_clamp_disconnected_ask_for_editions(p_edition_ids uuid[], p_dry_run boolean DEFAULT false)
 RETURNS TABLE(rows_examined bigint, rows_clamped bigint, dollars_removed numeric)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '110s'
AS $function$
DECLARE
  c_pinnacle uuid := '7dd9dd11-e8b6-45c4-ac99-71331f959714';
  v_started timestamptz := clock_timestamp();
  v_examined bigint := 0;
  v_clamped  bigint := 0;
  v_dollars  numeric := 0;
BEGIN
  IF p_edition_ids IS NULL OR cardinality(p_edition_ids) = 0 THEN
    RETURN QUERY SELECT 0::bigint, 0::bigint, 0::numeric;
    RETURN;
  END IF;

  IF p_dry_run THEN
    WITH ids AS (
      SELECT DISTINCT u.id FROM unnest(p_edition_ids) AS u(id)
      JOIN public.editions e ON e.id = u.id AND e.collection_id <> c_pinnacle
    ),
    -- latest = each edition's newest snapshot, kept ONLY when it is a clamp candidate; s90 is
    -- then read for those editions alone (the join below could never use the others).
    latest AS (
      SELECT lf.id, lf.edition_id, lf.fmv_usd, lf.confidence
      FROM ids
      JOIN LATERAL (
        SELECT fs.id, fs.edition_id, fs.fmv_usd, fs.confidence FROM public.fmv_snapshots fs
        WHERE fs.edition_id = ids.id ORDER BY fs.computed_at DESC LIMIT 1
      ) lf ON true
      WHERE lf.confidence IN ('LOW','ASK_ONLY')
    ),
    s90 AS (
      SELECT s.edition_id,
        count(*) FILTER (WHERE s.price_usd > 0.10) AS n_real,
        percentile_cont(0.9) WITHIN GROUP (ORDER BY s.price_usd) FILTER (WHERE s.price_usd > 0.10) AS p90,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY s.price_usd) FILTER (WHERE s.price_usd > 0.10) AS med
      FROM public.sales s
      WHERE s.edition_id = ANY(ARRAY(SELECT edition_id FROM latest)) AND s.sold_at >= now() - interval '90 days'
      GROUP BY s.edition_id
    ),
    targets AS (
      SELECT l.id AS snapshot_id, l.fmv_usd AS old_fmv,
             ROUND(GREATEST(s.p90 * 1.5, s.med)::numeric, 2) AS new_fmv
      FROM latest l
      JOIN s90 s ON s.edition_id = l.edition_id
      WHERE s.n_real >= 5 AND s.p90 > 0
        AND l.fmv_usd > s.med * 3
        AND l.fmv_usd > s.p90 * 1.5
        AND l.fmv_usd > ROUND(GREATEST(s.p90 * 1.5, s.med)::numeric, 2)
    )
    SELECT count(*), COALESCE(sum(old_fmv - new_fmv), 0) INTO v_examined, v_dollars FROM targets;
    v_clamped := v_examined;
  ELSE
    WITH ids AS (
      SELECT DISTINCT u.id FROM unnest(p_edition_ids) AS u(id)
      JOIN public.editions e ON e.id = u.id AND e.collection_id <> c_pinnacle
    ),
    latest AS (
      SELECT lf.id, lf.edition_id, lf.fmv_usd, lf.confidence
      FROM ids
      JOIN LATERAL (
        SELECT fs.id, fs.edition_id, fs.fmv_usd, fs.confidence FROM public.fmv_snapshots fs
        WHERE fs.edition_id = ids.id ORDER BY fs.computed_at DESC LIMIT 1
      ) lf ON true
      WHERE lf.confidence IN ('LOW','ASK_ONLY')
    ),
    s90 AS (
      SELECT s.edition_id,
        count(*) FILTER (WHERE s.price_usd > 0.10) AS n_real,
        percentile_cont(0.9) WITHIN GROUP (ORDER BY s.price_usd) FILTER (WHERE s.price_usd > 0.10) AS p90,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY s.price_usd) FILTER (WHERE s.price_usd > 0.10) AS med
      FROM public.sales s
      WHERE s.edition_id = ANY(ARRAY(SELECT edition_id FROM latest)) AND s.sold_at >= now() - interval '90 days'
      GROUP BY s.edition_id
    ),
    targets AS (
      SELECT l.id AS snapshot_id, l.fmv_usd AS old_fmv,
             ROUND(GREATEST(s.p90 * 1.5, s.med)::numeric, 2) AS new_fmv
      FROM latest l
      JOIN s90 s ON s.edition_id = l.edition_id
      WHERE s.n_real >= 5 AND s.p90 > 0
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
                                 'scope', 'editions:' || cardinality(p_edition_ids)));
    END IF;
  END IF;

  RETURN QUERY SELECT v_examined, v_clamped, round(v_dollars, 2);
END;
$function$;

REVOKE ALL ON FUNCTION public.fmv_clamp_disconnected_ask_for_editions(uuid[], boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fmv_clamp_disconnected_ask_for_editions(uuid[], boolean) TO postgres, service_role;

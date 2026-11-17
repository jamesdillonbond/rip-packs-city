-- Snapshot migration: the LAST FOUR unpinned scheduled SECDEF writers.
--
--   public.fill_ts_artless_from_rep_moments()        pg_cron `37 5 * * *`
--   public.refresh_cross_collection_cohort_step1()   pg_cron `10 4 * * *`
--   public.refresh_cross_collection_cohort_step2()   pg_cron `25 4 * * *`
--   public.refresh_insights_new_collectors()         pg_cron `45 9 * * *`
--
-- All four were applied to prod via the Supabase MCP with no committed migration
-- file, which made them UNPINNABLE. This commits the CURRENT LIVE definitions
-- verbatim (pg_get_functiondef, 2026-08-16):
--   fill_ts_artless_from_rep_moments       md5 fc6d9223050d72fcaba35b43a865b064
--   refresh_cross_collection_cohort_step1  md5 c7b10e7813129ceaf4bd56b00497779c
--   refresh_cross_collection_cohort_step2  md5 285f3041a7d5b20a766df594290b76a5
--   refresh_insights_new_collectors        md5 2b9e76fbe4e9ddd1a47420c98c613a81
-- Applying it is a no-op against prod (byte-identical to what already runs).
--
-- ⚠ THESE FOUR CLOSE THE POPULATION I MEASURED — AND RE-MEASURING SHOWED THAT
-- POPULATION WAS TOO SMALL. The 2026-08-15 sweep found "33 scheduled SECDEF
-- writers, 14 unpinned" using a predicate matching `insert into` / `update ` /
-- `delete from` / `truncate `. Adding `refresh materialized view` to that
-- predicate finds **52**, of which **14 are still unpinned** — a different 14,
-- almost entirely MV refreshers (refresh_mv_pack_ev_latest,
-- refresh_sets_summary, refresh_topshot_special_serial_owners_mv,
-- refresh_players_current_team, the pack-sales aggregates, ...).
--
-- A function whose whole body is `REFRESH MATERIALIZED VIEW` contains none of
-- the four DML verbs, so the original sweep was silent about that entire
-- CATEGORY by construction — the same guard-scope blind spot this repo keeps
-- documenting, met on a measurement rather than a test. An MV refresher is very
-- much a writer: `refresh_sets_summary` is the one CLAUDE.md singles out for
-- running as a rolbypassrls role under pg_cron, so its collection gating has to
-- live in the VIEW rather than in RLS.
--
-- So: 38 of 52 scheduled SECDEF writers are pinned as of 2026-08-16. The
-- remaining 14 are the next tranche, not a finished job.
--
-- ── WHY EACH MATTERS ───────────────────────────────────────────────────────
--
-- fill_ts_artless_from_rep_moments FABRICATES A CDN URL. It fills a missing
-- Top Shot `thumbnail_url` by borrowing a REPRESENTATIVE moment's asset path,
-- chosen by a three-tier COALESCE (a wallet's cached moment_id, then the most
-- recent sale's nft_id, then a subedition sibling). ⚠ Its `WHERE r.rep IS NOT
-- NULL` is what stops a URL being built around a NULL — and it is fill-only
-- TWICE (in the candidate CTE and again in the UPDATE), so a concurrently
-- written real thumbnail is never clobbered, and `video_url` is COALESCEd so an
-- existing video always wins.
--
-- The cohort pair both TRUNCATE and rebuild in one transaction. step1 defines
-- the cohort as `COUNT(DISTINCT collection_id) >= 3` — the threshold IS the
-- product definition of a cross-collection collector. step2 reads step1's table
-- 15 minutes later, so it is the DOWNSTREAM half of an ordered pair: if step1
-- fails, step2 rebuilds from a table that step1 already truncated.
--
-- refresh_insights_new_collectors refreshes five materialized views IN ORDER,
-- `mv_ts_buyer_first_buy` first because the other four read it. ⚠ Its
-- `EXCEPTION WHEN OTHERS` logs an ok:false row and does NOT re-raise, so a
-- failure is visible in pipeline_runs but does not surface to the caller. (And,
-- as everywhere in this repo, OTHERS cannot catch a statement timeout.)
--
-- REVERT: these are snapshots of what is already live, so reverting the FILE
-- changes nothing in prod. To remove them:
--   DROP FUNCTION public.fill_ts_artless_from_rep_moments();
--   DROP FUNCTION public.refresh_cross_collection_cohort_step1();
--   DROP FUNCTION public.refresh_cross_collection_cohort_step2();
--   DROP FUNCTION public.refresh_insights_new_collectors();
-- (plus unscheduling pg_cron `rpc-ts-artless-selfheal`, `rpc-ccm-step1`,
-- `rpc-ccm-step2`, `rpc-refresh-new-collectors`).

CREATE OR REPLACE FUNCTION public.fill_ts_artless_from_rep_moments()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '300s'
AS $function$
DECLARE v_total integer := 0;
BEGIN
  WITH t AS (
    SELECT e.id, e.external_id, e.collection_id, e.video_url,
           split_part(e.external_id,'::',1) AS base_ext,
           NULLIF(split_part(e.external_id,'::',2),'')::int AS sub
    FROM public.editions e
    WHERE e.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
      AND e.thumbnail_url IS NULL
      AND e.external_id ~ '^[0-9]+:[0-9]+(::[0-9]+)?$'
  ),
  reps AS (
    SELECT t.id AS edition_id, t.video_url AS old_video, COALESCE(
      (SELECT w.moment_id FROM public.wallet_moments_cache w
        WHERE w.collection_id = t.collection_id AND w.edition_key = t.external_id
          AND w.moment_id IS NOT NULL LIMIT 1),
      (SELECT s.nft_id FROM public.sales s
        WHERE s.edition_id = t.id AND s.nft_id IS NOT NULL
        ORDER BY s.sold_at DESC LIMIT 1),
      (SELECT ms.nft_id::text FROM public.topshot_moment_subeditions ms
        JOIN public.sales s ON s.nft_id = ms.nft_id
        JOIN public.editions b ON b.id = s.edition_id
        WHERE t.sub IS NOT NULL AND ms.subedition_id = t.sub
          AND b.collection_id = t.collection_id AND b.external_id = t.base_ext
        LIMIT 1)
    ) AS rep
    FROM t
  ),
  ins AS (
    INSERT INTO public.audit_20260716_ts_artless_cdn_fill
      (edition_id, old_thumbnail_url, new_thumbnail_url, old_video_url, new_video_url)
    SELECT r.edition_id, NULL,
           'https://assets.nbatopshot.com/media/' || r.rep || '/image?width=400',
           r.old_video,
           CASE WHEN r.old_video IS NULL
                THEN 'https://assets.nbatopshot.com/media/' || r.rep || '/video' END
    FROM reps r WHERE r.rep IS NOT NULL
    ON CONFLICT (edition_id) DO NOTHING
    RETURNING edition_id, new_thumbnail_url, new_video_url
  ),
  upd AS (
    UPDATE public.editions e
       SET thumbnail_url = i.new_thumbnail_url,
           video_url = COALESCE(e.video_url, i.new_video_url),
           updated_at = now()
      FROM ins i
     WHERE e.id = i.edition_id AND e.thumbnail_url IS NULL
    RETURNING 1
  )
  SELECT count(*)::int INTO v_total FROM upd;
  RETURN v_total;
END;
$function$;

CREATE OR REPLACE FUNCTION public.refresh_cross_collection_cohort_step1()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '180s'
AS $function$
DECLARE
  v_cohort_count int := 0;
  v_started timestamptz := NOW();
BEGIN
  TRUNCATE TABLE public.cross_collection_cohort_mat;

  INSERT INTO public.cross_collection_cohort_mat (
    wallet_address, n_collections, total_moments,
    ts_moments, allday_moments, golazos_moments, pinnacle_moments, ufc_moments,
    approx_fmv_usd, computed_at
  )
  SELECT
    w.wallet_address,
    COUNT(DISTINCT w.collection_id),
    COUNT(*),
    COUNT(*) FILTER (WHERE w.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'),
    COUNT(*) FILTER (WHERE w.collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070'),
    COUNT(*) FILTER (WHERE w.collection_id = '06248cc4-b85f-47cd-af67-1855d14acd75'),
    COUNT(*) FILTER (WHERE w.collection_id = '7dd9dd11-e8b6-45c4-ac99-71331f959714'),
    COUNT(*) FILTER (WHERE w.collection_id = '9b4824a8-736d-4a96-b450-8dcc0c46b023'),
    ROUND(SUM(COALESCE(w.fmv_usd, 0))::numeric, 2),
    v_started
  FROM wallet_moments_cache w
  GROUP BY w.wallet_address
  HAVING COUNT(DISTINCT w.collection_id) >= 3;

  GET DIAGNOSTICS v_cohort_count = ROW_COUNT;
  RETURN jsonb_build_object('cohort_size', v_cohort_count, 'computed_at', v_started);
END;
$function$;

CREATE OR REPLACE FUNCTION public.refresh_cross_collection_cohort_step2()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '300s'
AS $function$
DECLARE
  v_set_count int := 0;
  v_started timestamptz := NOW();
BEGIN
  TRUNCATE TABLE public.cross_collection_ts_set_overlap_mat;

  INSERT INTO public.cross_collection_ts_set_overlap_mat (set_id, set_name, cohort_holders, moments_in_cohort, computed_at)
  SELECT
    e.set_id,
    MAX(e.set_name),
    COUNT(DISTINCT w.wallet_address),
    COUNT(*),
    v_started
  FROM public.cross_collection_cohort_mat c
  JOIN wallet_moments_cache w
    ON w.wallet_address = c.wallet_address
   AND w.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
  JOIN editions e
    ON e.external_id::text = w.edition_key
   AND e.collection_id = w.collection_id
  WHERE e.set_id IS NOT NULL
    AND e.set_name IS NOT NULL
  GROUP BY e.set_id;

  GET DIAGNOSTICS v_set_count = ROW_COUNT;
  RETURN jsonb_build_object('set_overlap_rows', v_set_count, 'computed_at', v_started);
END;
$function$;

CREATE OR REPLACE FUNCTION public.refresh_insights_new_collectors()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_start timestamptz := clock_timestamp();
  v_rows int;
BEGIN
  REFRESH MATERIALIZED VIEW public.mv_ts_buyer_first_buy;
  REFRESH MATERIALIZED VIEW public.mv_insights_new_collectors_summary;
  REFRESH MATERIALIZED VIEW public.mv_insights_new_collectors_spend;
  REFRESH MATERIALIZED VIEW public.mv_insights_new_collectors_gateway;
  REFRESH MATERIALIZED VIEW public.mv_insights_new_collectors_cohorts;
  SELECT count(*) INTO v_rows FROM public.mv_ts_buyer_first_buy;
  INSERT INTO public.pipeline_runs (pipeline, collection_slug, started_at, finished_at, ok, rows_written, extra)
  VALUES ('refresh-new-collectors', 'nba_top_shot', v_start, clock_timestamp(), true, v_rows,
          jsonb_build_object('buyers', v_rows));
EXCEPTION WHEN OTHERS THEN
  INSERT INTO public.pipeline_runs (pipeline, collection_slug, started_at, finished_at, ok, error)
  VALUES ('refresh-new-collectors', 'nba_top_shot', v_start, clock_timestamp(), false, SQLERRM);
END;
$function$;

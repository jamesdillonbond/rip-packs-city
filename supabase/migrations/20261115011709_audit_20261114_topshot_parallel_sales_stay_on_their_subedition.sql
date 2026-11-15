-- audit_20261114_topshot_parallel_sales_stay_on_their_subedition
--
-- WHAT (Trevor 11-14, "Figure out how this remains fixed long term"): the 2-hourly follow-up
-- (20261114215605) cleared the backlog, but a read 2.5 h later (4:20 PM PT) found it could NOT keep
-- the class at zero, for two measured reasons:
--   1. A WRITER BYPASSES THE GATE. promote_unmapped_sales() (jobid 474, :54) writes a parked sale on
--      the edition from its set:play hint / nft_edition_map / wmc and never reads
--      topshot_moment_subeditions — so a moment the chain resolved to a parallel WEEKS ago still lands
--      on its base (4 sales today, map resolved 09-15 and 10-04). Only /api/sales-indexer consults the
--      map; every other writer, present or future, inherits the gap.
--   2. THE FOLLOW-UP'S WINDOWS KEY ON THE WRONG CLOCK. Its re-key looks only at map rows resolved in
--      the last 3 days, so (1)'s rows — old resolution, new sale — are never moved; and its queue keys
--      on sold_at, so a sale ingested late (an offer-fill backfill wrote one 2 days after it sold) is
--      never queued. 5 unmoved + 7 unqueued at 4:20 PM PT.
--
-- WHAT THIS DOES
--   A. topshot_sales_follow_subedition_trg() — BEFORE INSERT on public.sales: a Top Shot sale written
--      on a BASE edition whose NFT the chain map says is a parallel (subedition_id > 0, same base)
--      lands on `<base>::<sub>` when that edition exists. Same shape as sales_candy_canonical_edition_id_trg.
--      Every writer is covered at write time, including ones not yet written. Cost: one PK probe of
--      topshot_moment_subeditions per Top Shot insert (~3.3k/day); the editions read runs only for
--      the ~parallels. No EXCEPTION block: a per-row subtransaction on a 1,000-row promote insert is
--      a subxact-overflow hazard, and the two reads are plain index lookups.
--   B. topshot_parallel_sales_followup() v2 — the safety net for what (A) cannot see (a sale written
--      BEFORE the chain answered):
--        queue  = sold in p_days OR INGESTED in p_days (30-day sold_at floor bounds the scan);
--        re-key = map resolved in p_resolved_days (as before) UNION any sale INGESTED in p_days,
--                 whenever its map row resolved.
--   C. check_topshot_parallel_sales_on_base(p_days) — every 6 h, logs 'topshot-parallel-on-base-watch'
--      with ok=false when, among sales sold in p_days on a base edition that has parallels:
--        resolved_unmoved > 0  (chain says parallel, target exists, still on base, both the sale and the
--                               resolution older than 3 h — the trigger + follow-up should make this 0)
--        unqueued > 0          (ingested > 3 h ago, no subedition row — the queue step should make this 0)
--        pending_oldest_hours > 96 (the chain lane stopped draining; ~10k/day against today's 13.5k)
--      Atlas-labelled parallels still on base (pending the chain) ride along in extra as a number, not
--      an alarm: Atlas is a change-only feed, and those rows are the chain lane's to settle.
--      Watchlist: the check (high, like topshot-dupe-sales-watch) and the follow-up (medium).
--
-- REVERT:
--   DROP TRIGGER IF EXISTS sales_topshot_follow_subedition_trg ON public.sales;
--   DROP FUNCTION IF EXISTS public.topshot_sales_follow_subedition_trg();
--   SELECT cron.unschedule('rpc-topshot-parallel-on-base-watch');
--   DELETE FROM public.pipeline_cadence_watchlist WHERE pipeline IN ('topshot-parallel-on-base-watch','topshot-parallel-sales-followup');
--   DROP FUNCTION IF EXISTS public.check_topshot_parallel_sales_on_base(integer);
--   follow-up v1: re-apply its body from 20261114215605.
--   (sales the trigger re-keyed are not logged; they were never on the base edition.)

CREATE OR REPLACE FUNCTION public.topshot_sales_follow_subedition_trg()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_sub    smallint;
  v_base   text;
  v_target uuid;
BEGIN
  IF NEW.collection_id IS DISTINCT FROM '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid
     OR NEW.nft_id IS NULL OR NEW.edition_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT m.subedition_id, m.base_external_id INTO v_sub, v_base
    FROM public.topshot_moment_subeditions m
   WHERE m.nft_id = NEW.nft_id AND m.subedition_id > 0;
  IF v_sub IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT te.id INTO v_target
    FROM public.editions be
    JOIN public.editions te ON te.collection_id = be.collection_id
                           AND te.external_id = be.external_id || '::' || v_sub
   WHERE be.id = NEW.edition_id
     AND be.collection_id = NEW.collection_id
     AND be.external_id = v_base;
  IF v_target IS NOT NULL THEN
    NEW.edition_id := v_target;
  END IF;
  RETURN NEW;
END
$function$;

REVOKE ALL ON FUNCTION public.topshot_sales_follow_subedition_trg() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS sales_topshot_follow_subedition_trg ON public.sales;
CREATE TRIGGER sales_topshot_follow_subedition_trg
  BEFORE INSERT ON public.sales
  FOR EACH ROW EXECUTE FUNCTION public.topshot_sales_follow_subedition_trg();

CREATE OR REPLACE FUNCTION public.topshot_parallel_sales_followup(p_days integer DEFAULT 2, p_resolved_days integer DEFAULT 3)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '120s'
AS $function$
DECLARE
  v_started timestamptz := clock_timestamp();
  v_ts      constant uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  v_floor   timestamptz := now() - make_interval(days => GREATEST(p_days, 30));
  v_since   timestamptz := now() - make_interval(days => p_days);
  v_queued  integer;
  v_moved   integer;
  v_err     text;
BEGIN
  BEGIN
    -- 1. QUEUE unmapped NFTs sold OR ingested in the window on a base edition that has parallels.
    WITH par AS MATERIALIZED (
      SELECT DISTINCT split_part(external_id, '::', 1) AS base
        FROM editions
       WHERE collection_id = v_ts AND external_id LIKE '%::%'
    ), cand AS (
      SELECT DISTINCT ON (s.nft_id) s.nft_id, e.external_id AS base
        FROM sales s
        JOIN editions e ON e.id = s.edition_id
        JOIN par ON par.base = e.external_id
       WHERE s.collection_id = v_ts
         AND s.sold_at > v_floor
         AND (s.sold_at > v_since OR s.ingested_at > v_since)
         AND s.nft_id IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM topshot_moment_subeditions m WHERE m.nft_id = s.nft_id)
       ORDER BY s.nft_id, s.sold_at DESC
    ), ins AS (
      INSERT INTO topshot_moment_subeditions (nft_id, base_external_id, subedition_id, queued_at)
      SELECT nft_id, base, NULL, now() FROM cand
      ON CONFLICT (nft_id) DO NOTHING
      RETURNING 1
    )
    SELECT count(*) INTO v_queued FROM ins;

    -- 2. RE-KEY sales of chain-confirmed parallels off their base edition (logged first):
    --    a. every sale of an NFT the chain answered for in the last p_resolved_days;
    --    b. every sale INGESTED in the last p_days, whenever its NFT was answered.
    WITH par AS MATERIALIZED (
      SELECT DISTINCT split_part(external_id, '::', 1) AS base
        FROM editions
       WHERE collection_id = v_ts AND external_id LIKE '%::%'
    ), recent AS MATERIALIZED (
      SELECT s.id, s.sold_at, s.nft_id, s.edition_id, e.external_id AS base
        FROM sales s
        JOIN editions e ON e.id = s.edition_id
        JOIN par ON par.base = e.external_id
       WHERE s.collection_id = v_ts
         AND s.sold_at > v_floor
         AND s.ingested_at > v_since
         AND s.nft_id IS NOT NULL
    ), mv AS (
      SELECT s.id, s.sold_at, s.nft_id, s.edition_id AS old_id, te.id AS new_id, ms.subedition_id
        FROM topshot_moment_subeditions ms
        JOIN sales s     ON s.nft_id = ms.nft_id AND s.collection_id = v_ts
        JOIN editions be ON be.id = s.edition_id
                        AND be.external_id NOT LIKE '%::%'
                        AND be.external_id = ms.base_external_id
        JOIN editions te ON te.collection_id = v_ts
                        AND te.external_id = be.external_id || '::' || ms.subedition_id
       WHERE ms.subedition_id > 0
         AND ms.resolved_at > now() - make_interval(days => p_resolved_days)
      UNION
      SELECT r.id, r.sold_at, r.nft_id, r.edition_id, te.id, ms.subedition_id
        FROM recent r
        JOIN topshot_moment_subeditions ms ON ms.nft_id = r.nft_id
                                          AND ms.subedition_id > 0
                                          AND ms.base_external_id = r.base
        JOIN editions te ON te.collection_id = v_ts
                        AND te.external_id = r.base || '::' || ms.subedition_id
    ), logged AS (
      INSERT INTO topshot_parallel_sales_rekey_log (sale_id, sold_at, nft_id, old_edition_id, new_edition_id, subedition_id)
      SELECT id, sold_at, nft_id, old_id, new_id, subedition_id FROM mv
      RETURNING sale_id, sold_at, old_edition_id, new_edition_id
    ), upd AS (
      UPDATE sales s SET edition_id = l.new_edition_id
        FROM logged l
       WHERE s.id = l.sale_id AND s.sold_at = l.sold_at AND s.edition_id = l.old_edition_id
      RETURNING 1
    )
    SELECT count(*) INTO v_moved FROM upd;
  EXCEPTION WHEN query_canceled OR OTHERS THEN
    v_err := SQLERRM;
  END;

  PERFORM log_pipeline_run(
    'topshot-parallel-sales-followup', v_started,
    NULL,
    CASE WHEN v_err IS NULL THEN v_moved END,
    NULL,
    v_err IS NULL, v_err, 'nba_top_shot', NULL, NULL,
    jsonb_build_object('queued', CASE WHEN v_err IS NULL THEN v_queued END, 'sales_rekeyed', CASE WHEN v_err IS NULL THEN v_moved END,
                       'p_days', p_days, 'p_resolved_days', p_resolved_days, 'version', 2));

  IF v_err IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', v_err);
  END IF;
  RETURN jsonb_build_object('ok', true, 'queued', v_queued, 'sales_rekeyed', v_moved);
END
$function$;

REVOKE ALL ON FUNCTION public.topshot_parallel_sales_followup(integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.topshot_parallel_sales_followup(integer, integer) TO service_role;

CREATE OR REPLACE FUNCTION public.check_topshot_parallel_sales_on_base(p_days integer DEFAULT 7)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_started   timestamptz := clock_timestamp();
  v_ts        constant uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  v_unmoved   int;
  v_unqueued  int;
  v_atlas     int;
  v_pending   int;
  v_oldest_h  numeric;
  v_sample    jsonb;
  v_err       text;
  v_bad       text[] := '{}';
BEGIN
  PERFORM set_config('statement_timeout', '90000', true);

  BEGIN
    WITH par AS MATERIALIZED (
      SELECT DISTINCT split_part(external_id, '::', 1) AS base
        FROM editions WHERE collection_id = v_ts AND external_id LIKE '%::%'
    ), s AS MATERIALIZED (
      SELECT s.id, s.nft_id, s.sold_at, s.ingested_at, s.source, e.external_id AS base
        FROM sales s
        JOIN editions e ON e.id = s.edition_id
        JOIN par ON par.base = e.external_id
       WHERE s.collection_id = v_ts
         AND s.sold_at > now() - make_interval(days => p_days)
         AND s.nft_id IS NOT NULL
    ), unmoved AS (
      SELECT s.nft_id, s.base, ms.subedition_id, s.source, s.ingested_at
        FROM s
        JOIN topshot_moment_subeditions ms ON ms.nft_id = s.nft_id AND ms.subedition_id > 0
                                          AND ms.base_external_id = s.base
                                          AND ms.resolved_at < now() - interval '3 hours'
        JOIN editions te ON te.collection_id = v_ts AND te.external_id = s.base || '::' || ms.subedition_id
       WHERE s.ingested_at < now() - interval '3 hours'
    )
    SELECT (SELECT count(*) FROM unmoved),
           (SELECT count(*) FROM s
             WHERE s.ingested_at < now() - interval '3 hours'
               AND NOT EXISTS (SELECT 1 FROM topshot_moment_subeditions m WHERE m.nft_id = s.nft_id)),
           (SELECT count(*) FROM s
             WHERE EXISTS (SELECT 1 FROM topshot_atlas_market_events a
                            WHERE a.nft_id = s.nft_id AND a.parallel IS NOT NULL AND a.parallel <> 'Standard')),
           (SELECT jsonb_agg(u) FROM (SELECT * FROM unmoved LIMIT 5) u)
      INTO v_unmoved, v_unqueued, v_atlas, v_sample;

    SELECT count(*), round(extract(epoch FROM now() - min(queued_at)) / 3600, 1)
      INTO v_pending, v_oldest_h
      FROM topshot_moment_subeditions WHERE subedition_id IS NULL;

    IF v_unmoved > 0 THEN v_bad := v_bad || (v_unmoved || ' chain-confirmed parallel sale(s) still on the base edition'); END IF;
    IF v_unqueued > 0 THEN v_bad := v_bad || (v_unqueued || ' sale(s) on a base with parallels never queued for the chain'); END IF;
    IF COALESCE(v_oldest_h, 0) > 96 THEN v_bad := v_bad || ('oldest pending subedition row is ' || v_oldest_h || ' h old'); END IF;
  EXCEPTION WHEN query_canceled OR OTHERS THEN
    v_err := left(SQLERRM, 300);
  END;

  -- ok = FALSE on any arm, so the failure_rate arm of get_pipeline_alerts() reports it.
  PERFORM public.log_pipeline_run(
    'topshot-parallel-on-base-watch', v_started, v_unmoved, 0, 0,
    (v_err IS NULL AND cardinality(v_bad) = 0),
    COALESCE(v_err, CASE WHEN cardinality(v_bad) > 0
      THEN array_to_string(v_bad, '; ') || ' — known-issue #250: a writer is filing parallel sales on the Standard edition again; see extra.sample' END),
    'nba_top_shot', NULL, NULL,
    jsonb_build_object('resolved_unmoved', v_unmoved, 'unqueued', v_unqueued,
                       'atlas_parallel_on_base', v_atlas, 'pending', v_pending, 'pending_oldest_hours', v_oldest_h,
                       'window_days', p_days, 'sample', v_sample, 'issue', 'known-issue #250', 'via', 'pg_cron',
                       'duration_ms', (extract(epoch from clock_timestamp() - v_started) * 1000)::int));

  RETURN jsonb_build_object('resolved_unmoved', v_unmoved, 'unqueued', v_unqueued,
                            'atlas_parallel_on_base', v_atlas, 'pending', v_pending,
                            'pending_oldest_hours', v_oldest_h, 'sample', v_sample, 'error', v_err);
END
$function$;

REVOKE ALL ON FUNCTION public.check_topshot_parallel_sales_on_base(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.check_topshot_parallel_sales_on_base(integer) TO service_role;

SELECT cron.schedule('rpc-topshot-parallel-on-base-watch', '27 1,7,13,19 * * *',
                     'SELECT public.check_topshot_parallel_sales_on_base(7);');

INSERT INTO public.pipeline_cadence_watchlist (pipeline, max_silent_minutes, max_minutes_without_success, severity, notes)
VALUES
  ('topshot-parallel-on-base-watch', 480, 1440, 'high',
   'pg_cron rpc-topshot-parallel-on-base-watch (27 1,7,13,19 * * *) -> check_topshot_parallel_sales_on_base(7): ok=false when a chain-confirmed Top Shot parallel sale sits on its base edition, a sale on a base with parallels was never queued for the chain, or the oldest pending subedition row passes 96 h. Known-issue #250. Added 2026-11-14 (Claude Code cloud, Trevor: "Figure out how this remains fixed long term").'),
  ('topshot-parallel-sales-followup', 300, 300, 'medium',
   'pg_cron rpc-topshot-parallel-sales-followup (41 */2 * * *) -> topshot_parallel_sales_followup(2, 3): queues unmapped NFTs for the chain lane and re-keys parallel sales off their base edition. Logs every run. Known-issue #250. Added 2026-11-14.')
ON CONFLICT (pipeline) DO NOTHING;

-- Clear what v1 could not reach: everything ingested in the last 30 days.
SELECT public.topshot_parallel_sales_followup(30, 3);

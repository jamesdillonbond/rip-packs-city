-- 2026-11-25: price the Top Shot rips the at-rip hydrator (20261126032027, pg_cron 932) makes priceable.
--
-- price_recent_topshot_rips (pg_cron 599) only looks at the last 14 days, and the hourly
-- backfill_pack_rip_metadata unpriced leg takes ~75 rips an hour. The hydrator is filling the moments rows of
-- ~86K pulls whose rips are mostly older than 14 days (34.4K unpriced rips in April-May 2026, 12.5K in
-- September-November) -- at 75 an hour those would take ~4 weeks to price after their moments exist.
--
-- price_topshot_rips_backlog(p_limit): the SAME whole-pack, all-or-nothing rule as price_recent_topshot_rips
-- (sum of each pulled Moment's latest FMV; priced only when every pulled Moment resolves). Candidates are
-- driven FROM THE HYDRATOR'S OUTPUT, not from a scan of pack_rips: the rips of every Moment an at-height
-- request wrote in the last day. Measured 11-25: scanning unpriced rips sealed 2026-04-01..14 days ago
-- costs 370K buffers / 10.6 s cold per tick (the include column is not index-only); the request-driven set is
-- bounded by what the hydrator wrote (<= ~22K a day). Written requests are pruned after 2 days by
-- topshot_moment_hydrate_tick, so a 1-day lookback at a 10-minute cadence sees each one many times.
-- Logs 'topshot-rip-pricing-backlog' with candidates / priced.
--
-- Revert: SELECT cron.unschedule('rpc-topshot-rip-pricing-backlog'); DROP FUNCTION
-- public.price_topshot_rips_backlog(integer). Rips it priced carry the same value the recent lane would have
-- written and stay.

CREATE OR REPLACE FUNCTION public.price_topshot_rips_backlog(p_limit integer DEFAULT 1500)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '110s'
AS $function$
DECLARE
  v_ts uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  v_lim int := LEAST(GREATEST(COALESCE(p_limit, 1500), 1), 5000);
  v_cand int := 0; v_priced int := 0; v_err text;
BEGIN
  BEGIN
    DROP TABLE IF EXISTS _prtb;
    CREATE TEMP TABLE _prtb ON COMMIT DROP AS
    SELECT DISTINCT pr.id, pr.collection_id, pr.moments_pulled
      FROM public.topshot_moment_hydrate_requests q
      JOIN public.moment_acquisitions ma ON ma.nft_id = q.nft_id AND ma.collection_id = v_ts
      JOIN public.pack_rips pr ON pr.id = ma.source_pack_rip_id
     WHERE q.at_block_height IS NOT NULL
       AND q.outcome = 'written'
       AND q.drained_at > now() - interval '1 day'
       AND pr.pull_value_usd IS NULL
     LIMIT v_lim;
    GET DIAGNOSTICS v_cand = ROW_COUNT;

    -- The whole-pack, all-or-nothing rule of price_recent_topshot_rips, verbatim.
    WITH pv AS (
      SELECT c.id AS rip_id, SUM(fc.fmv_usd)::numeric(14,2) AS pull_value_usd
        FROM _prtb c
        JOIN public.moment_acquisitions ma ON ma.source_pack_rip_id = c.id
        LEFT JOIN public.moments m ON m.nft_id = ma.nft_id AND m.collection_id = c.collection_id
        LEFT JOIN LATERAL (
          SELECT s.fmv_usd, s.collection_id
            FROM public.fmv_snapshots s
           WHERE s.edition_id = m.edition_id
           ORDER BY s.computed_at DESC
           LIMIT 1
        ) fc ON fc.collection_id = m.collection_id
       GROUP BY c.id, c.moments_pulled
      HAVING count(*) = count(fc.fmv_usd)
         AND count(*) = c.moments_pulled
    ), upd AS (
      UPDATE public.pack_rips pr SET pull_value_usd = pv.pull_value_usd
        FROM pv
       WHERE pr.id = pv.rip_id AND pr.pull_value_usd IS NULL AND pv.pull_value_usd > 0
      RETURNING 1
    )
    SELECT count(*) INTO v_priced FROM upd;

  EXCEPTION WHEN query_canceled OR OTHERS THEN
    v_err := left(SQLERRM, 300);
  END;
  PERFORM public.log_pipeline_run('topshot-rip-pricing-backlog', v_err IS NULL,
    jsonb_build_object('candidates', v_cand, 'priced', v_priced, 'error', v_err, 'via', 'pg_cron'));
  RETURN jsonb_build_object('candidates', v_cand, 'priced', v_priced, 'error', v_err);
END $function$;
REVOKE ALL ON FUNCTION public.price_topshot_rips_backlog(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.price_topshot_rips_backlog(integer) TO service_role;

INSERT INTO public.pipeline_cadence_watchlist (pipeline, max_silent_minutes, severity, notes, is_active, max_minutes_without_success)
VALUES ('topshot-rip-pricing-backlog', 60, 'info',
 'Added 2026-11-25: price_topshot_rips_backlog() (pg_cron, every 10 min) prices the Top Shot rips whose pulled Moments the at-rip hydrator (pg_cron 932) wrote in the last day, once every pulled Moment resolves. extra.priced falls to ~0 once the hydrator backlog is drained. If silent, those rips stay unpriced; no page shows a wrong number.',
 true, 120)
ON CONFLICT (pipeline) DO NOTHING;

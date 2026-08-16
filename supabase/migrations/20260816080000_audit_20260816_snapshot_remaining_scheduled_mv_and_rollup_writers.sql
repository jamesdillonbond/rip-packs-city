-- Snapshot migration: the remaining 14 unpinned scheduled SECDEF writers.
--
-- All were applied to prod via the Supabase MCP with no committed migration
-- file, which made them UNPINNABLE. This commits the CURRENT LIVE definitions
-- verbatim (pg_get_functiondef, 2026-08-16). Applying it is a no-op.
--
-- ⚠ WHY THIS TRANCHE WAS MISSED UNTIL NOW. The sweep that enumerated "scheduled
-- SECDEF writers" matched `insert into` / `update ` / `delete from` /
-- `truncate `. A function whose entire body is `REFRESH MATERIALIZED VIEW`
-- contains none of those verbs, so that whole CATEGORY was invisible to it by
-- construction. Ten of the fourteen below are exactly that shape.
--
-- With these fourteen the population is CLOSED: 52 of 52 scheduled SECDEF
-- writers are pinned as of 2026-08-16, measured with the corrected predicate.
-- ⚠ "Closed" means closed AGAINST THIS PREDICATE. The lesson of this very
-- migration is that the predicate was the thing that was wrong, not the count —
-- so before trusting the number, ask what shape of writer it is still silent
-- about (a function calling another function that writes; a DO block; a trigger
-- reached only from a scheduled statement). Re-derive it; do not quote it.
--
--   refresh_sets_summary                      `50 7 * * *`
--   refresh_mv_pack_ev_latest                 `3,33 * * * *`
--   refresh_allday_pack_realized              `35 */6 * * *`
--   refresh_allday_pack_sales_agg             `20 */6 * * *`
--   refresh_topshot_pack_sales_agg            `50 */6 * * *`
--   refresh_topshot_pack_rip_values           `5 */6 * * *`
--   refresh_topshot_edition_median            `10 */6 * * *`
--   refresh_mv_topshot_set_play_catalog       `52 */3 * * *`
--   refresh_topshot_misattrib_candidates      `35 15 * * *`
--   refresh_topshot_special_serial_owners_mv  `13 4,16 * * *`
--   sync_allday_pack_dist_totals              `24 * * * *`
--   refresh_players_current_team              `40 9 * * *`
--   rollup_allday_rip_pull_value              `14 * * * *`
--   backfill_wmc_fmv_confidence               `2-59/5 * * * *`
--
-- ── WHAT IS ACTUALLY AT STAKE IN A ONE-LINE REFRESH WRAPPER ────────────────
--
-- ⚠ `CONCURRENTLY` is the load-bearing word, and it has a HARD DEPENDENCY that
-- lives outside the function: a concurrent refresh REQUIRES a unique index on
-- the materialized view. Drop that index and every one of these crons starts
-- failing at runtime with `cannot refresh materialized view ... concurrently` —
-- a break introduced by a change to a DIFFERENT object. Without CONCURRENTLY
-- the refresh takes an ACCESS EXCLUSIVE lock and blocks every reader of the view
-- for its whole duration; `mv_pack_ev_latest` is refreshed twice an hour behind
-- the public pack-EV surface, so that is a user-visible stall, on an instance
-- CLAUDE.md already documents as disk-IO saturated.
--
-- ⚠ `refresh_topshot_misattrib_candidates` deliberately does NOT use
-- CONCURRENTLY. That is not an oversight to "fix": it is an internal candidates
-- MV with no public read path, so the exclusive lock costs nothing, and a
-- non-concurrent refresh does not need the unique index the others do.
--
-- ── THE FOUR SUBSTANTIAL ONES ──────────────────────────────────────────────
--
-- rollup_allday_rip_pull_value writes a rip's total pull value ONLY when EVERY
-- pull in it is priced (`valued_pulls = total_pulls`). A partial sum would be a
-- smaller number that reads as a real one. Its watermark is captured BEFORE the
-- read and `updated_at >= w` is inclusive, so a row changed mid-run is
-- re-processed next tick rather than skipped.
--
-- refresh_players_current_team derives "current team" from the most recent game
-- within 18 months OF THE CATALOGUE'S OWN MAX GAME DATE — not of now(). That is
-- what stops an offseason (or an ingest stall) sliding the window off the end of
-- the data and blanking every player's team.
--
-- sync_allday_pack_dist_totals refuses to write a zero total
-- (`coalesce(i.packnft_total,0) > 0`), because 0 minted is a claim about the
-- pack rather than an absence of data.
--
-- backfill_wmc_fmv_confidence is the job CLAUDE.md records as the #1 disk reader
-- on the instance (113 GB) — fixed by a cron ARGUMENT, not a code change. Note
-- its `CROSS JOIN LATERAL`: an edition with no priced snapshot is dropped, so
-- its wmc rows keep `fmv_confidence` NULL and are re-selected every tick forever.
--
-- REVERT: these are snapshots of what is already live, so reverting the FILE
-- changes nothing in prod. To remove any of them, DROP FUNCTION and unschedule
-- the matching pg_cron job.

CREATE OR REPLACE FUNCTION public.refresh_sets_summary()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '300s'
AS $function$
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY sets_summary;
END;
$function$;

CREATE OR REPLACE FUNCTION public.refresh_mv_pack_ev_latest()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '120s'
AS $function$
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY public.mv_pack_ev_latest;
END;
$function$;

CREATE OR REPLACE FUNCTION public.refresh_allday_pack_realized()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '600s'
AS $function$
begin
  refresh materialized view concurrently public.mv_allday_pack_realized;
end;
$function$;

CREATE OR REPLACE FUNCTION public.refresh_allday_pack_sales_agg()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '600s'
AS $function$
begin
  refresh materialized view concurrently public.mv_allday_pack_sales_agg;
end;
$function$;

CREATE OR REPLACE FUNCTION public.refresh_topshot_pack_sales_agg()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '600s'
AS $function$
begin
  refresh materialized view concurrently public.mv_topshot_pack_sales_agg;
end;
$function$;

CREATE OR REPLACE FUNCTION public.refresh_topshot_pack_rip_values()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '600s'
AS $function$
begin
  refresh materialized view concurrently public.mv_topshot_pack_rip_values;
end;
$function$;

CREATE OR REPLACE FUNCTION public.refresh_topshot_edition_median()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '600s'
AS $function$
begin
  refresh materialized view concurrently public.mv_topshot_edition_median_180d;
end;
$function$;

CREATE OR REPLACE FUNCTION public.refresh_mv_topshot_set_play_catalog()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '180s'
AS $function$
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY public.mv_topshot_set_play_catalog;
END;
$function$;

CREATE OR REPLACE FUNCTION public.refresh_topshot_misattrib_candidates()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '600s'
AS $function$
DECLARE n integer;
BEGIN
  REFRESH MATERIALIZED VIEW public.mv_topshot_misattrib_candidates;
  SELECT count(*) INTO n FROM public.mv_topshot_misattrib_candidates;
  RETURN n;
END;
$function$;

CREATE OR REPLACE FUNCTION public.refresh_topshot_special_serial_owners_mv()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '200s'
 SET enable_nestloop TO 'off'
AS $function$
DECLARE
  v_started timestamptz := clock_timestamp();
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY public.topshot_special_serial_owners_mv;
  REFRESH MATERIALIZED VIEW CONCURRENTLY public.allday_special_serial_owners_mv;
  PERFORM public.log_pipeline_run(
    p_pipeline   => 'refresh-special-serial-owners-mv',
    p_started_at => v_started,
    p_ok         => true,
    p_extra      => jsonb_build_object(
      'duration_ms', round(extract(epoch FROM clock_timestamp() - v_started) * 1000)::int,
      'logged_by', 'fn',
      'mvs', 'topshot+allday'
    )
  );
EXCEPTION WHEN OTHERS THEN
  PERFORM public.log_pipeline_run(
    p_pipeline   => 'refresh-special-serial-owners-mv',
    p_started_at => v_started,
    p_ok         => false,
    p_error      => SQLERRM,
    p_extra      => jsonb_build_object(
      'duration_ms', round(extract(epoch FROM clock_timestamp() - v_started) * 1000)::int,
      'logged_by', 'fn'
    )
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.sync_allday_pack_dist_totals()
 RETURNS integer
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH upd AS (
    UPDATE pack_distributions pd
    SET total_minted = i.packnft_total,
        total_opened = i.opened_count,
        updated_at = now()
    FROM v_allday_pack_info i
    WHERE pd.collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070'
      AND pd.dist_id::text = i.dist_id
      AND coalesce(i.packnft_total,0) > 0
      AND (pd.total_minted IS DISTINCT FROM i.packnft_total
        OR pd.total_opened IS DISTINCT FROM i.opened_count)
    RETURNING 1
  ) SELECT count(*)::integer FROM upd;
$function$;

CREATE OR REPLACE FUNCTION public.refresh_players_current_team(p_collection_id uuid DEFAULT '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_updated int;
BEGIN
  IF p_collection_id IS NULL THEN
    RETURN 0;
  END IF;

  WITH h AS (
    SELECT max(game_date) AS mg FROM public.editions
     WHERE collection_id = p_collection_id AND game_date IS NOT NULL
  ), r AS (
    SELECT DISTINCT ON (e.player_name) e.player_name, e.team_name
      FROM public.editions e, h
     WHERE e.collection_id = p_collection_id
       AND e.team_name IS NOT NULL
       AND e.game_date IS NOT NULL
       AND e.game_date >= h.mg - interval '18 months'
     ORDER BY e.player_name, e.game_date DESC
  ), upd AS (
    UPDATE public.players p
       SET team = r.team_name, updated_at = now()
      FROM r
     WHERE p.collection_id = p_collection_id
       AND p.name = r.player_name
       AND p.team IS DISTINCT FROM r.team_name
    RETURNING 1
  )
  SELECT count(*) INTO v_updated FROM upd;

  RETURN v_updated;
END
$function$;

CREATE OR REPLACE FUNCTION public.rollup_allday_rip_pull_value()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  n int;
  w timestamptz;
  t_start timestamptz := clock_timestamp();
BEGIN
  SELECT last_run_at INTO w FROM allday_rip_rollup_state WHERE singleton;
  w := COALESCE(w, '-infinity'::timestamptz);

  WITH changed AS (
    SELECT DISTINCT pack_nft_id
    FROM allday_pack_pull
    WHERE updated_at >= w
  ),
  agg AS (
    SELECT p.pack_nft_id,
           sum(p.fmv_usd)                                 AS total_fmv,
           count(*) FILTER (WHERE p.fmv_usd IS NOT NULL)  AS valued_pulls,
           count(*)                                       AS total_pulls
    FROM allday_pack_pull p
    JOIN changed c ON c.pack_nft_id = p.pack_nft_id
    GROUP BY p.pack_nft_id
  )
  UPDATE pack_rips r
  SET pull_value_usd = round(agg.total_fmv,2), metadata_updated_at = now()
  FROM agg
  WHERE r.collection_id='dee28451-5d62-409e-a1ad-a83f763ac070'
    AND r.pack_nft_id = agg.pack_nft_id
    AND agg.valued_pulls = agg.total_pulls AND agg.total_fmv IS NOT NULL
    AND r.pull_value_usd IS DISTINCT FROM round(agg.total_fmv,2);
  GET DIAGNOSTICS n = ROW_COUNT;

  UPDATE allday_rip_rollup_state SET last_run_at = t_start WHERE singleton;

  RETURN n;
END
$function$;

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

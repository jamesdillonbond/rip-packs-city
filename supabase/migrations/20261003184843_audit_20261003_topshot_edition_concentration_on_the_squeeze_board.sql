-- 2026-10-03 beta feedback 10256 (squeeze board: "show wallet concentration
-- based on the top 5 holders' combined ownership share" — editions where a
-- few stackers hold the supply even though the moments are not locked or
-- burned on-chain). Trevor: "Do everything mentioned."
--
-- SOURCE: public.topshot_ownership (one row per held NFT; Dune + the on-chain
-- owner walk). Measured 2026-10-03 ~11:45 AM PT: 267,742 rows over 2,261 of
-- 9,733 base editions, every covered edition ≥ 99 % of its circulation (the
-- walk covers an edition whole or not at all), +397 editions in the last week.
-- A concentration figure is published ONLY where the census is complete
-- (rows ≥ 98 % of circulation); every other edition reads NULL — the board
-- prints "—" and says how many of its rows have a census. Never a guessed %.
--
-- HOLDERS exclude two system accounts, stated here because excluding them is
-- a judgement: 0xb6f2481eba4df97b (Top Shot's pack-distribution account —
-- moments still inside unopened packs; 26,737 rows) and 0xe1f2a091f7bb5245
-- (TopShot_Buyback_2, Dapper's sell-back sink). Neither is a collector. Their
-- share is kept in system_held so nothing is hidden. The share denominator is
-- CIRCULATION (the tester's own definition: "500 circ, top 5 own 250 = 50 %").
--
-- SHAPE: a table refreshed write-first / delete-unwritten (R123) on pg_cron
-- every 6 h, logging a pipeline_runs row ('topshot-edition-concentration');
-- topshot_squeeze_board gains TWO appended columns (top5_share_pct, holders) —
-- the only shape CREATE OR REPLACE VIEW allows; security_invoker carried and
-- re-asserted; the table's ACL mirrors edition_fmv_current (RLS on, no
-- policies, service_role SELECT), which the view already joins.
--
-- Cost (measured, warm): the aggregate is one seq scan of topshot_ownership
-- + a hash aggregate, 452 ms / 12,252 buffers. Slot 58 past the hour is unused.
--
-- Revert: cron.unschedule('rpc-topshot-edition-concentration');
-- DROP FUNCTION public.refresh_topshot_edition_concentration();
-- the appended view columns stay (harmless) or DROP VIEW … CASCADE + re-create
-- both squeeze views from 20261003181445 / 20260903134528; then
-- DROP TABLE public.topshot_edition_concentration.

CREATE TABLE IF NOT EXISTS public.topshot_edition_concentration (
  edition_external_id text PRIMARY KEY,
  edition_id          uuid NOT NULL,
  circulation         integer NOT NULL,
  census_rows         integer NOT NULL,
  census_complete     boolean NOT NULL,
  holders             integer NOT NULL,
  system_held         integer NOT NULL,
  top1_share_pct      numeric(5,1),
  top5_share_pct      numeric(5,1),
  computed_at         timestamptz NOT NULL
);
COMMENT ON TABLE public.topshot_edition_concentration IS
  'Per base Top Shot edition: how concentrated the held supply is, from topshot_ownership. holders / top1 / top5 count COLLECTOR wallets only (pack-distribution + buyback sinks excluded, their rows in system_held); shares are % of circulation; top*_share_pct NULL unless census_complete (rows >= 98 % of circulation). Refreshed by refresh_topshot_edition_concentration() (pg_cron, 6-hourly). Beta feedback 10256, 2026-10-03.';

ALTER TABLE public.topshot_edition_concentration ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.topshot_edition_concentration FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.topshot_edition_concentration TO service_role;

CREATE OR REPLACE FUNCTION public.refresh_topshot_edition_concentration()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_coll     constant uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  v_started  timestamptz := clock_timestamp();
  v_stamp    timestamptz := clock_timestamp();
  v_cand     int;            -- NULL = not measured
  v_written  int := 0;       -- rows that LANDED
  v_complete int;
  v_deleted  int;            -- NULL = the delete did not run
  v_err      text;
  v_del_err  text;
  v_ok       boolean;
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtext('refresh_topshot_edition_concentration')::bigint) THEN
    RETURN jsonb_build_object('skipped', 'concurrent');
  END IF;

  BEGIN
    WITH held AS (
      SELECT o.edition_external_id AS ext, o.owner_address AS owner, count(*)::int AS n,
             (o.owner_address IN ('0xb6f2481eba4df97b', '0xe1f2a091f7bb5245')) AS is_sys
      FROM topshot_ownership o
      GROUP BY 1, 2, 4
    ), ranked AS (
      SELECT ext, owner, n, is_sys,
             row_number() OVER (PARTITION BY ext, is_sys ORDER BY n DESC, owner) AS rn
      FROM held
    ), per_ed AS (
      SELECT h.ext,
             sum(h.n)::int AS census_rows,
             sum(h.n) FILTER (WHERE h.is_sys)::int AS system_held,
             count(*) FILTER (WHERE NOT h.is_sys)::int AS holders,
             max(h.n) FILTER (WHERE NOT h.is_sys)::int AS top1,
             sum(h.n) FILTER (WHERE NOT h.is_sys AND h.rn <= 5)::int AS top5
      FROM ranked h
      GROUP BY h.ext
    ), cand AS (
      SELECT p.*, e.id AS edition_id, e.circulation_count AS circ,
             (p.census_rows >= ceil(e.circulation_count * 0.98)) AS complete
      FROM per_ed p
      JOIN editions e ON e.external_id = p.ext AND e.collection_id = v_coll
      WHERE e.circulation_count > 0
    ), up AS (
      INSERT INTO topshot_edition_concentration AS t (
        edition_external_id, edition_id, circulation, census_rows, census_complete,
        holders, system_held, top1_share_pct, top5_share_pct, computed_at)
      SELECT c.ext, c.edition_id, c.circ, c.census_rows, c.complete,
             coalesce(c.holders, 0), coalesce(c.system_held, 0),
             CASE WHEN c.complete THEN round(100.0 * coalesce(c.top1, 0) / c.circ, 1) END,
             CASE WHEN c.complete THEN round(100.0 * coalesce(c.top5, 0) / c.circ, 1) END,
             v_stamp
      FROM cand c
      ON CONFLICT (edition_external_id) DO UPDATE SET
        edition_id      = EXCLUDED.edition_id,
        circulation     = EXCLUDED.circulation,
        census_rows     = EXCLUDED.census_rows,
        census_complete = EXCLUDED.census_complete,
        holders         = EXCLUDED.holders,
        system_held     = EXCLUDED.system_held,
        top1_share_pct  = EXCLUDED.top1_share_pct,
        top5_share_pct  = EXCLUDED.top5_share_pct,
        computed_at     = EXCLUDED.computed_at
      RETURNING t.census_complete
    )
    SELECT (SELECT count(*) FROM cand), count(*), count(*) FILTER (WHERE up.census_complete)
      INTO v_cand, v_written, v_complete
      FROM up;
  EXCEPTION WHEN query_canceled OR OTHERS THEN
    v_err := left(SQLERRM, 300);
  END;

  -- Write first, then retire only what this run did NOT write (R123): an
  -- edition that left the census disappears; a failed write keeps yesterday's.
  IF v_err IS NULL THEN
    BEGIN
      DELETE FROM topshot_edition_concentration WHERE computed_at IS DISTINCT FROM v_stamp;
      GET DIAGNOSTICS v_deleted = ROW_COUNT;
    EXCEPTION WHEN query_canceled OR OTHERS THEN
      v_del_err := left(SQLERRM, 300);
    END;
  END IF;

  v_ok := v_err IS NULL AND v_del_err IS NULL AND v_written = v_cand;

  PERFORM public.log_pipeline_run(
    'topshot-edition-concentration', v_started, v_cand, v_written, 0,
    v_ok, coalesce(v_err, v_del_err), 'nba_top_shot', NULL, NULL,
    jsonb_build_object('candidates', v_cand, 'rows_written', v_written, 'census_complete', v_complete,
                       'rows_deleted', v_deleted, 'write_error', v_err, 'delete_error', v_del_err,
                       'duration_ms', (extract(epoch FROM clock_timestamp() - v_started) * 1000)::int));

  RETURN jsonb_build_object('ok', v_ok, 'candidates', v_cand, 'rows_written', v_written,
                            'census_complete', v_complete, 'rows_deleted', v_deleted,
                            'write_error', v_err, 'delete_error', v_del_err);
END
$function$;

-- anon-exec: NOT granted — a write function; postgres + service_role only (refresh_topshot_edition_concentration).
REVOKE ALL ON FUNCTION public.refresh_topshot_edition_concentration() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_topshot_edition_concentration() TO postgres, service_role;

-- First fill, so the view below has rows the moment it exists.
SELECT public.refresh_topshot_edition_concentration();

-- Every 6 h at :58 (an unused minute; hours off the divisible-by-3 band).
-- The statement_timeout rides on the COMMAND (proconfig is inert on pg_cron).
SELECT cron.schedule(
  'rpc-topshot-edition-concentration',
  '58 2,8,14,20 * * *',
  $cron$SET statement_timeout = '120s'; SELECT public.refresh_topshot_edition_concentration();$cron$
);

CREATE OR REPLACE VIEW public.topshot_squeeze_board
WITH (security_invoker = on) AS
 SELECT e.id AS edition_id,
    e.external_id,
    COALESCE(e.player_name, be.player_name) AS player_name,
    COALESCE(e.set_name, be.set_name) AS set_name,
    COALESCE(e.tier::text, replace(be.tier, 'MOMENT_TIER_'::text, ''::text)) AS tier,
    COALESCE(e.circulation_count, be.circulation_count) AS circulation,
    be.locked,
    be.burned,
    round(100.0 * COALESCE(be.locked, 0)::numeric / NULLIF(COALESCE(e.circulation_count, be.circulation_count, 0), 0)::numeric, 1) AS lock_pct,
    round(100.0 * COALESCE(be.burned, 0)::numeric / NULLIF(COALESCE(e.circulation_count, be.circulation_count, 0), 0)::numeric, 1) AS burn_pct,
    round(100.0 * (COALESCE(be.locked, 0) + COALESCE(be.burned, 0))::numeric / NULLIF(COALESCE(e.circulation_count, be.circulation_count, 0), 0)::numeric, 1) AS squeeze_pct,
    GREATEST(COALESCE(e.circulation_count, be.circulation_count, 0) - COALESCE(be.locked, 0) - COALESCE(be.burned, 0), 0) AS effectively_buyable,
    CASE WHEN efc.fmv_usd IS NULL THEN NULL::numeric ELSE be.low_ask END AS low_ask,
    efc.fmv_usd::numeric(12,4) AS fmv_usd,
    efc.confidence::text AS confidence,
    e.game_date,
    e.thumbnail_url,
    efc.fmv_usd IS NOT NULL AND efc.fmv_usd > 0::numeric AND be.low_ask IS NOT NULL AND be.low_ask > (10::numeric * efc.fmv_usd) AS low_ask_disconnected,
    e.set_id,
    e.team_name,
    -- APPENDED 2026-10-03 (beta feedback 10256): holder concentration from the
    -- owner census; NULL (not 0) when no complete census exists for the edition.
    tec.top5_share_pct,
    CASE WHEN tec.census_complete THEN tec.holders END AS holders
   FROM badge_editions be
     JOIN editions e ON e.external_id::text = be.external_id AND e.collection_id = be.collection_id
     LEFT JOIN edition_fmv_current efc ON efc.edition_id = e.id
     LEFT JOIN topshot_edition_concentration tec ON tec.edition_external_id = e.external_id
  WHERE e.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid AND COALESCE(e.circulation_count, be.circulation_count) IS NOT NULL AND COALESCE(e.circulation_count, be.circulation_count) > 0;

ALTER VIEW public.topshot_squeeze_board SET (security_invoker = on);

DO $verify$
DECLARE
  v_rows int;
  v_complete int;
  v_cols int;
BEGIN
  SELECT count(*), count(*) FILTER (WHERE census_complete) INTO v_rows, v_complete FROM public.topshot_edition_concentration;
  IF v_rows = 0 THEN RAISE EXCEPTION 'concentration table is empty after the first fill'; END IF;
  IF v_complete = 0 THEN RAISE EXCEPTION 'no edition has a complete census — the 98 %% rule or the source is wrong'; END IF;
  IF EXISTS (SELECT 1 FROM public.topshot_edition_concentration WHERE top5_share_pct IS NOT NULL AND NOT census_complete) THEN
    RAISE EXCEPTION 'a share was published without a complete census';
  END IF;
  IF EXISTS (SELECT 1 FROM public.topshot_edition_concentration WHERE top5_share_pct < top1_share_pct OR top5_share_pct > 100.5) THEN
    RAISE EXCEPTION 'share arithmetic is wrong';
  END IF;
  SELECT count(*) INTO v_cols FROM pg_attribute WHERE attrelid = 'public.topshot_squeeze_board'::regclass AND attnum > 0 AND NOT attisdropped;
  IF v_cols <> 22 THEN RAISE EXCEPTION 'topshot_squeeze_board column count is % not 22', v_cols; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE oid = 'public.topshot_squeeze_board'::regclass AND reloptions @> ARRAY['security_invoker=on']) THEN
    RAISE EXCEPTION 'topshot_squeeze_board lost security_invoker';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'rpc-topshot-edition-concentration' AND active) THEN
    RAISE EXCEPTION 'cron job missing';
  END IF;
  IF has_function_privilege('anon', 'public.refresh_topshot_edition_concentration()', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon can execute the refresh';
  END IF;
END
$verify$;

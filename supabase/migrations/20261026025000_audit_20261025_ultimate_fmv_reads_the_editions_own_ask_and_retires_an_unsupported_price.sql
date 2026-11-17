-- 2026-10-25 (PT) — the ULTIMATE FMV writer prices an edition from its OWN asks, and retires a
-- price it can no longer support instead of leaving it standing.
--
-- WHY. Production HTML sweep, 10-25 ~7:40 PM PT: /insights/rookie-board listed four Kon Knueppel
-- Signature Series /1s (241:8246, 241:8444, 241:8449, 260:8820) all at "$2,513", marked ask-derived,
-- though none was listed. compute_ultimate_non_special_fmv took its ask as MIN(cached_listings) over
-- (tier ULTIMATE, player_name, set_name) — every /1 of that player in a same-named set — so one
-- listing (241:8054, $4,569 then) priced all four (x 0.55 haircut = $2,512.95). Run live on 10-25 it
-- would have priced the same four at $9,000 from 241:8054's current ask. Population: 8 ULTIMATE
-- editions borrowed a sibling's ask (50 had a player/set ask, 43 their own). And because
-- recalc_ultimate_fmv inserted only when it found a price, an edition that lost its ask kept its
-- last row as the current FMV indefinitely (the four rows above are from 10-23).
--
-- WHAT.
--   compute_ultimate_non_special_fmv: the ask is the edition's own — cached_listings.moment_id =
--     editions.external_id (Top Shot carries the edition key there: 54 of 54 ULTIMATE listings
--     match). Special-serial exclusion, sale leg, ladder and return shape unchanged.
--   recalc_ultimate_fmv: when the model returns no price AND the edition's latest snapshot is this
--     writer's own priced row (algo_version LIKE 'ultimate-v1%', fmv NOT NULL), it writes a NO_DATA
--     row (NULL fmv — the main pipeline's convention). An edition it never priced is still never
--     written. rows_written counts both; extra.retired_no_data names the retirements.
-- Signatures, SECURITY DEFINER, search_path and ACLs unchanged (CREATE OR REPLACE).
-- anon-exec: unchanged (compute_ultimate_non_special_fmv, recalc_ultimate_fmv) — CREATE OR REPLACE of existing fns; ACLs preserved.
--
-- Pins: supabase/tests/compute_ultimate_non_special_fmv.sql, supabase/tests/recalc_ultimate_fmv.sql.
-- Revert: re-apply compute_ultimate_non_special_fmv from 20261004002116 and recalc_ultimate_fmv from
-- 20261004030511.

DO $guard$
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.compute_ultimate_non_special_fmv(uuid)'::regprocedure) IS DISTINCT FROM '9ec6ecf75d2a19dcb88cf4f1571d073e' THEN
    RAISE EXCEPTION 'compute_ultimate_non_special_fmv changed since the splice base -- re-splice';
  END IF;
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.recalc_ultimate_fmv()'::regprocedure) IS DISTINCT FROM '7d2fddb35cc6bad9b21da95f302ea3c0' THEN
    RAISE EXCEPTION 'recalc_ultimate_fmv changed since the splice base -- re-splice';
  END IF;
END
$guard$;

CREATE OR REPLACE FUNCTION public.compute_ultimate_non_special_fmv(p_edition_id uuid)
 RETURNS TABLE(edition_id uuid, collection_id uuid, collection_slug text, circulation integer, jersey_number integer, special_serials integer[], filter_skipped boolean, last_non_special_sale_price numeric, last_non_special_sale_at timestamp with time zone, days_since_sale integer, lowest_non_special_ask numeric, fmv_usd numeric, source text, confidence text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_circ int;
  v_player_id uuid;
  v_jersey int;
  v_collection_id uuid;
  v_collection_slug text;
  v_player_name text;
  v_set_name text;
  v_external_id text;
  v_specials int[];
  v_skip boolean;
  v_last_sale numeric;
  v_last_at timestamptz;
  v_days int;
  v_low_ask numeric;
  v_fmv numeric;
  v_source text;
  v_conf text;
BEGIN
  SELECT e.collection_id, c.slug, e.circulation_count, e.player_id, e.player_name, e.set_name, e.external_id
    INTO v_collection_id, v_collection_slug, v_circ, v_player_id, v_player_name, v_set_name, v_external_id
  FROM editions e
  JOIN collections c ON c.id = e.collection_id
  WHERE e.id = p_edition_id AND e.tier = 'ULTIMATE';

  IF NOT FOUND THEN RETURN; END IF;

  v_skip := (v_circ IS NULL OR v_circ <= 1);
  v_specials := get_ultimate_special_serials(p_edition_id);

  IF v_player_id IS NOT NULL THEN
    SELECT p.jersey_number INTO v_jersey FROM players p WHERE p.id = v_player_id;
  END IF;

  SELECT s.price_usd, s.sold_at
    INTO v_last_sale, v_last_at
  FROM public.sales_market s
  WHERE s.edition_id = p_edition_id
    AND s.price_usd > 0
    AND (v_skip OR NOT (s.serial_number = ANY(v_specials)))
  ORDER BY s.sold_at DESC
  LIMIT 1;

  IF v_last_at IS NOT NULL THEN
    v_days := EXTRACT(DAY FROM (now() - v_last_at))::int;
  END IF;

  -- 2026-10-25: the edition's OWN asks. This matched on (player_name, set_name), so one
  -- listed /1 lent its ask to every other /1 of that player in a same-named set: Kon
  -- Knueppel's four unlisted Signature Series /1s were priced from 241:8054's ask
  -- ($4,569 x 0.55 = $2,512.95 each on 10-23). cached_listings.moment_id carries the
  -- edition key for Top Shot (54 of 54 ULTIMATE listings match an editions.external_id).
  IF v_external_id IS NOT NULL THEN
    SELECT MIN(cl.ask_price)
      INTO v_low_ask
    FROM cached_listings cl
    WHERE cl.collection_id = v_collection_id
      AND cl.tier = 'ULTIMATE'
      AND cl.moment_id = v_external_id
      AND cl.ask_price > 0
      AND (v_skip OR NOT (cl.serial_number = ANY(v_specials)));
  END IF;

  IF v_last_sale IS NOT NULL AND v_low_ask IS NOT NULL THEN
    v_fmv := LEAST(v_last_sale, v_low_ask);
    v_source := 'min_sale_ask';
    v_conf := 'LOW';
  ELSIF v_last_sale IS NOT NULL THEN
    v_fmv := v_last_sale;
    v_source := 'sale_only';
    v_conf := 'SALES_ONLY';
  ELSIF v_low_ask IS NOT NULL THEN
    v_fmv := v_low_ask;
    v_source := 'ask_only';
    v_conf := 'ASK_ONLY';
  ELSE
    v_fmv := NULL;
    v_source := 'no_data';
    v_conf := 'NO_DATA';
  END IF;

  RETURN QUERY SELECT
    p_edition_id, v_collection_id, v_collection_slug, v_circ, v_jersey, v_specials, v_skip,
    v_last_sale, v_last_at, v_days, v_low_ask, v_fmv, v_source, v_conf;
END;
$function$;

CREATE OR REPLACE FUNCTION public.recalc_ultimate_fmv()
 RETURNS TABLE(total_editions integer, inserted integer, no_data integer, ask_only integer, sales_only integer, min_sale_ask integer, ran_at timestamp with time zone, duration_ms integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_total int := 0;
  v_inserted int := 0;
  v_no_data int := 0;
  v_ask_only int := 0;
  v_sales_only int := 0;
  v_min int := 0;
  v_retired int := 0;
  v_start timestamptz := clock_timestamp();
  v_ran timestamptz := now();
  v_finish timestamptz;
  v_dur int;
BEGIN
  DELETE FROM fmv_snapshots
  WHERE algo_version = 'ultimate-v1'
    AND computed_at >= date_trunc('day', v_ran)
    AND edition_id IN (SELECT id FROM editions WHERE tier = 'ULTIMATE');

  WITH src AS (
    SELECT
      e.id                          AS ed_id,
      r.collection_id               AS coll_id,
      r.collection_slug             AS coll_slug,
      r.fmv_usd                     AS fmv,
      r.lowest_non_special_ask      AS low_ask,
      r.confidence                  AS conf,
      r.days_since_sale             AS days,
      r.source                      AS src_kind
    FROM editions e
    LEFT JOIN LATERAL compute_ultimate_non_special_fmv(e.id) r ON true
    WHERE e.tier = 'ULTIMATE'
  ),
  ins AS (
    INSERT INTO fmv_snapshots (
      edition_id, collection_id, collection,
      fmv_usd, floor_price_usd, ask_proxy_fmv,
      confidence, days_since_sale,
      algo_version, computed_at
    )
    SELECT
      s.ed_id, s.coll_id, s.coll_slug,
      s.fmv, s.low_ask, s.low_ask,
      s.conf::fmv_confidence, s.days,
      'ultimate-v1', v_ran
    FROM src s
    WHERE s.fmv IS NOT NULL
    RETURNING 1
  ),
  -- 2026-10-25: a price this writer can no longer support is RETIRED, not left standing.
  -- It inserted only when it found a price, so an edition that lost its (often borrowed)
  -- ask kept its last ultimate-v1 row as the current FMV indefinitely. A NO_DATA row (NULL
  -- fmv, the main pipeline's convention) is written ONLY when the edition's latest snapshot
  -- is this writer's own priced row — an edition it never priced is still never written.
  ret AS (
    INSERT INTO fmv_snapshots (
      edition_id, collection_id, collection,
      fmv_usd, floor_price_usd, ask_proxy_fmv,
      confidence, days_since_sale,
      algo_version, computed_at
    )
    SELECT
      s.ed_id, s.coll_id, s.coll_slug,
      NULL, NULL, NULL,
      'NO_DATA'::fmv_confidence, s.days,
      'ultimate-v1', v_ran
    FROM src s
    WHERE s.fmv IS NULL
      AND s.coll_id IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM (
          SELECT f.algo_version, f.fmv_usd FROM fmv_snapshots f
           WHERE f.edition_id = s.ed_id ORDER BY f.computed_at DESC LIMIT 1
        ) l
        WHERE l.algo_version LIKE 'ultimate-v1%' AND l.fmv_usd IS NOT NULL
      )
    RETURNING 1
  )
  SELECT
    (SELECT COUNT(*)::int FROM src),
    (SELECT COUNT(*)::int FROM ins),
    (SELECT COUNT(*)::int FROM src WHERE src_kind = 'no_data'),
    (SELECT COUNT(*)::int FROM src WHERE src_kind = 'ask_only'),
    (SELECT COUNT(*)::int FROM src WHERE src_kind = 'sale_only'),
    (SELECT COUNT(*)::int FROM src WHERE src_kind = 'min_sale_ask'),
    (SELECT COUNT(*)::int FROM ret)
  INTO v_total, v_inserted, v_no_data, v_ask_only, v_sales_only, v_min, v_retired;

  v_finish := clock_timestamp();
  v_dur := (EXTRACT(EPOCH FROM (v_finish - v_start)) * 1000)::int;

  INSERT INTO pipeline_runs (
    pipeline, started_at, finished_at,
    rows_found, rows_written, rows_skipped, ok, extra
  )
  VALUES (
    'ultimate-fmv-recalc-v1', v_start, v_finish,
    v_total, v_inserted + v_retired, v_no_data, true,
    jsonb_build_object(
      'algo_version', 'ultimate-v1',
      'no_data', v_no_data,
      'ask_only', v_ask_only,
      'sales_only', v_sales_only,
      'min_sale_ask', v_min,
      'retired_no_data', v_retired,
      'duration_ms', v_dur
    )
  );

  RETURN QUERY SELECT v_total, v_inserted, v_no_data, v_ask_only, v_sales_only, v_min, v_ran, v_dur;
END;
$function$;

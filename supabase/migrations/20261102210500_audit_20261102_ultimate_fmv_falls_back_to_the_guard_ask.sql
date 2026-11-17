-- 2026-11-02 (#227) — recalc_ultimate_fmv stops publishing a price the thin-sales guard reverses minutes later.
--
-- Found tracing a portfolio that read 11.1k / 13.8k / 11.1k / 14.2k on flat holdings: 260:8827 (a 1/1).
-- compute_ultimate_non_special_fmv read asks only from cached_listings; on nights that cache had no
-- row it returned the last sale (serial #1, $3,333, August) as SALES_ONLY, recalc_ultimate_fmv wrote it
-- at 06:45 UTC, and apply_fmv_thin_sales_guard (inside /api/fmv-recalc, 06:48) reversed it to the
-- badge_editions ask (~$675–720). Over 7 days: 14 ULTIMATE editions (Top Shot 1/1s + All Day /10s),
-- 87 reversals, avg 2.7x — every reader inside the window (wmc's FMV refresh, pages, the portfolio
-- snapshot) could carry the high value.
--
-- Fix: when cached_listings has no ask, fall back to badge_editions.low_ask (same bound the guard uses).
-- Verified live: all 14 now return min_sale_ask at the ask (e.g. All Day 3103: $2,200 sale_only -> $499).
-- Applied 11-02 by a guarded in-place replace (marker count asserted = 1); this file is the full body.
--
-- Revert: re-apply the previous body (this one without the "2026-11-02 (#227)" block).
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

  -- 2026-11-02 (#227): when the edition's own cached_listings show no ask, fall back to
  -- badge_editions.low_ask — the source apply_fmv_thin_sales_guard reads three minutes later.
  -- Without it this writer published the last sale (e.g. a 1/1's $3,333 from August) every
  -- night the listing cache flickered, and the guard reversed it to the ask: 14 editions,
  -- 87 reversals in 7 days, avg 2.7x, readable in the window. badge low_ask has no serial,
  -- so a special serial's ask can stand in; LEAST(sale, ask) below and the guard both accept that.
  IF v_low_ask IS NULL AND v_external_id IS NOT NULL THEN
    SELECT MIN(b.low_ask) INTO v_low_ask
    FROM badge_editions b
    WHERE b.external_id = v_external_id AND b.collection_id = v_collection_id
      AND b.low_ask > 0 AND b.low_ask <= 10000;
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

-- anon-execute decision: REVOKED — called only by recalc_ultimate_fmv / service_role (grants unchanged).
REVOKE ALL ON FUNCTION public.compute_ultimate_non_special_fmv(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.compute_ultimate_non_special_fmv(uuid) TO service_role;

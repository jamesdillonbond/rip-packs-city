-- Snapshot migration: public.compute_ultimate_non_special_fmv(uuid).
--
-- Applied to prod historically via the Supabase MCP with no committed migration
-- file (making it UNPINNABLE). This commits the CURRENT LIVE definition verbatim
-- (pulled via pg_get_functiondef on 2026-08-01; byte-identical, md5
-- 766371c0f64596720e03d43a9477c55e) so it can carry a pinned invariant test.
-- Applying it is a no-op against prod.
--
-- What it does: a per-edition FMV estimator for ULTIMATE-tier editions that
-- EXCLUDES the collection's "special serials" (jersey/first/last, from
-- get_ultimate_special_serials) from both the last-sale and lowest-ask lookups --
-- so a $50k jersey-match serial can't drag the base edition's FMV. It resolves a
-- FMV from a source ladder: min(sale, ask) -> sale_only -> ask_only -> no_data,
-- with confidences LOW / SALES_ONLY / ASK_ONLY / NO_DATA respectively. It returns
-- nothing for a non-ULTIMATE edition. filter_skipped=true when circ<=1 (nothing to
-- exclude), which disables the special-serial filter.

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
  SELECT e.collection_id, c.slug, e.circulation_count, e.player_id, e.player_name, e.set_name
    INTO v_collection_id, v_collection_slug, v_circ, v_player_id, v_player_name, v_set_name
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
  FROM sales s
  WHERE s.edition_id = p_edition_id
    AND s.price_usd > 0
    AND (v_skip OR NOT (s.serial_number = ANY(v_specials)))
  ORDER BY s.sold_at DESC
  LIMIT 1;

  IF v_last_at IS NOT NULL THEN
    v_days := EXTRACT(DAY FROM (now() - v_last_at))::int;
  END IF;

  IF v_player_name IS NOT NULL AND v_set_name IS NOT NULL THEN
    SELECT MIN(cl.ask_price)
      INTO v_low_ask
    FROM cached_listings cl
    WHERE cl.collection_id = v_collection_id
      AND cl.tier = 'ULTIMATE'
      AND cl.player_name = v_player_name
      AND cl.set_name = v_set_name
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

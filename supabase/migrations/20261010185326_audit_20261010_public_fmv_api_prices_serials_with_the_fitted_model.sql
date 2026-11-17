-- audit_20261010_public_fmv_api_prices_serials_with_the_fitted_model
-- anon-exec: revoked (serial_fmv_multiplier_batch) — new function; REVOKE FROM PUBLIC, anon, authenticated below, GRANT to postgres + service_role (the /api/fmv route's client).
--
-- 2026-10-10 (known-issues #18 — "the serial-multiplier pricing call", decided under Trevor's
-- delegation, on a measurement). Two serial-premium models disagreed ~3x under one name: the public
-- /api/fmv applied lib/fmv/serial-multiplier's flat bands (#1 12x, 2-10 4.5x, 11-23 2.8x, last mint
-- 3x) while portfolios price with the fitted serial_fmv_estimate. Backtest, 4,477 Top Shot special-
-- serial sales (90 d, HIGH/MEDIUM editions, current edition FMV as the base for both), median
-- |ln(price / estimate)|:  #1 (391): flat 1.03 vs fitted 0.45 (fitted closer on 73 %);
-- last mint (444): 0.81 vs 0.53 (62 %);  serials 2-10 (3,642): 1.22 vs 0.40 (74 %) — the market
-- prices 2-10 at a median 1.38x, the flat band said 4.5x. The fitted model wins in every class.
--
-- WHAT. serial_fmv_multiplier_batch(p_items jsonb) returns one multiplier per (edition, serial) so
-- the route makes ONE call per request: estimate / fmv, 1.0 when the model sees no premium, NULL
-- (basis 'circulation_unknown') when the catalog circulation is missing or below the serial.
-- The route, its /api/fmv/demo spec and their tests change in the same commit.
--
-- REVERT: re-point app/api/fmv/route.ts at lib/fmv/serial-multiplier (git revert the code commit),
--   then DROP FUNCTION public.serial_fmv_multiplier_batch(jsonb);

CREATE OR REPLACE FUNCTION public.serial_fmv_multiplier_batch(p_items jsonb)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  -- One fitted serial premium per (edition, serial) for the public /api/fmv: the same estimator the
  -- portfolio prices with (serial_fmv_estimate: collection x tier x circulation band; buckets #1,
  -- jersey-match and perfect (last) mint). A NULL estimate is the model saying "no
  -- premium" -> 1.0. An edition whose catalog circulation is missing or below the serial cannot be
  -- placed in a band -> multiplier NULL, basis 'circulation_unknown' (never a guessed 1.0).
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'edition_id', i.edition_id,
           'serial', i.serial,
           'multiplier', CASE
               WHEN NOT x.circ_ok THEN NULL
               WHEN x.est IS NULL OR (x.est->>'estimate_usd') IS NULL THEN 1.0
               ELSE round((x.est->>'estimate_usd')::numeric / i.fmv, 4) END,
           'basis', CASE
               WHEN NOT x.circ_ok THEN 'circulation_unknown'
               WHEN x.est IS NULL THEN 'no_premium'
               ELSE coalesce(x.est->>'serial_bucket', x.est->>'basis') END)), '[]'::jsonb)
    FROM jsonb_to_recordset(p_items) AS i(edition_id uuid, serial integer, fmv numeric, confidence text)
    JOIN public.editions e ON e.id = i.edition_id
    CROSS JOIN LATERAL (
      SELECT coalesce(e.circulation_count > 0 AND e.circulation_count >= i.serial, false) AS circ_ok,
             CASE WHEN e.circulation_count > 0 AND e.circulation_count >= i.serial AND i.fmv > 0 AND i.serial > 0
                  THEN public.serial_fmv_estimate(e.collection_id, i.serial, e.circulation_count, e.tier::text,
                                                  i.fmv, upper(i.confidence), e.jersey_number, e.id)
             END AS est) x
   WHERE i.serial IS NOT NULL;
$function$;

REVOKE EXECUTE ON FUNCTION public.serial_fmv_multiplier_batch(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.serial_fmv_multiplier_batch(jsonb) TO postgres, service_role;

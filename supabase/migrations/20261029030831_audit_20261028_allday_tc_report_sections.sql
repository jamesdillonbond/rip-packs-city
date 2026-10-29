-- audit_20261028: NFL All Day sections for the Top Collector Report (/insights/tc-report, concierge get_collector_report).
--
-- get_wallet_tc_report's "top sets in progress" and "recent acquisitions" are Top Shot only. This returns the same two
-- sections over NFL All Day, with the same shapes, so the route reads it beside the report (in parallel) and the page
-- draws them with the same components:
--   top_sets            the wallet's 5 most-held All Day sets (by moments held) with owned / total editions and
--                       completion %; set totals count every edition in the set
--   recent_acquisitions All Day sales TO this wallet in the last 90 days (price > 0), newest 10, with external_id so the
--                       page can link /nfl-all-day/edition/<id>
-- Buyer coverage for All Day sales is ~100 % over the last 90 days (37,728 of 37,730 measured 10-28 ~8:40 PM PT), so
-- an empty list means no recorded purchase, not a missing column. An unindexed wallet returns empty top_sets — the
-- route's index_state (wallet_backfill_state) says whether that is "not indexed" or "holds none".
-- anon-exec: revoked (get_wallet_allday_tc_sections) — service-role read by /api/public/insights/tc-report and the concierge; REVOKE below.
--
-- Revert: DROP FUNCTION public.get_wallet_allday_tc_sections(text);

CREATE OR REPLACE FUNCTION public.get_wallet_allday_tc_sections(p_wallet text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '8s'
AS $function$
DECLARE
  v_wallet text := LOWER(p_wallet);
  v_top_sets jsonb;
  v_acquisitions jsonb;
BEGIN
  WITH wallet_set_holdings AS (
    SELECT s.id AS set_id, s.name AS set_name, s.series AS series,
      COUNT(DISTINCT e.id) AS owned_eds,
      COUNT(*) AS total_moments
    FROM wallet_moments_cache w
    JOIN editions e ON e.external_id::text = w.edition_key AND e.collection_id = w.collection_id
    JOIN sets s ON s.id = e.set_id
    WHERE w.wallet_address = v_wallet
      AND w.collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070'
    GROUP BY s.id, s.name, s.series
    ORDER BY total_moments DESC, s.name
    LIMIT 5
  ),
  set_totals AS (
    SELECT e.set_id, COUNT(DISTINCT e.id) AS set_total
    FROM editions e
    WHERE e.collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070'
      AND e.set_id IN (SELECT set_id FROM wallet_set_holdings)
    GROUP BY e.set_id
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'set_name', wsh.set_name,
    'series', wsh.series,
    'series_label', public.series_display_label('dee28451-5d62-409e-a1ad-a83f763ac070'::uuid, wsh.series::int),
    'owned_eds', wsh.owned_eds,
    'set_total_eds', st.set_total,
    'completion_pct', ROUND(100.0 * wsh.owned_eds / NULLIF(st.set_total, 0), 1),
    'total_moments_held', wsh.total_moments
  ) ORDER BY wsh.total_moments DESC, wsh.set_name), '[]'::jsonb)
  INTO v_top_sets
  FROM wallet_set_holdings wsh
  LEFT JOIN set_totals st ON st.set_id = wsh.set_id;

  WITH recent AS (
    SELECT s.sold_at, s.price_usd, s.serial_number, e.player_name, e.set_name, e.tier::text AS tier, e.external_id
    FROM sales s
    JOIN editions e ON e.id = s.edition_id
    WHERE s.collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070'
      AND s.buyer_address = v_wallet
      AND s.sold_at >= NOW() - INTERVAL '90 days'
      AND s.price_usd > 0
    ORDER BY s.sold_at DESC
    LIMIT 10
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'sold_at',     sold_at,
    'price_usd',   ROUND(price_usd, 2),
    'player_name', player_name,
    'set_name',    set_name,
    'tier',        tier,
    'serial',      serial_number,
    'external_id', external_id
  ) ORDER BY sold_at DESC), '[]'::jsonb)
  INTO v_acquisitions FROM recent;

  RETURN jsonb_build_object(
    'wallet',              v_wallet,
    'collection',          'nfl_all_day',
    'top_sets',            v_top_sets,
    'recent_acquisitions', v_acquisitions
  );
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.get_wallet_allday_tc_sections(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_wallet_allday_tc_sections(text) TO service_role;

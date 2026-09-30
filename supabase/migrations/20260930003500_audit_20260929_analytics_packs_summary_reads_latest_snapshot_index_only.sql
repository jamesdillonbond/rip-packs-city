-- 2026-09-29 (PT): analytics_packs_summary reads each pack's latest snapshot index-only, then
-- fetches just those rows.
-- Found from a production 500 (/api/analytics/packs/summary, "canceling statement due to statement
-- timeout", 4:35 PM PT). pgss for the PostgREST call: 2,027 calls, mean 1,785 ms, max 29,984 ms (the
-- 30 s service_role ceiling), 217k blocks/call. Plan: the `latest` CTE's DISTINCT ON selected ten
-- columns, so the planner read pack_ev_history by plain Index Scan and heap-fetched all 407,735 rows
-- to keep 4,685 (412,156 buffers). Now: DISTINCT ON over (pack_listing_id, snapshotted_at) alone is
-- an Index Only Scan (9.7k buffers), and only the winners are joined back (~25k buffers in all).
-- (pack_listing_id, snapshotted_at) is unique (407,735 rows / 407,735 keys; snapshotted_at NOT NULL);
-- a DISTINCT ON over the joined rows keeps one row per pack if that ever changes.
-- Equivalence, measured on prod before apply: live vs new body, `- 'as_of'`, IS DISTINCT FROM over 7
-- argument shapes (NULL, each collection, a 4-collection array) — 0 diffs; positive control (the key
-- pass ordered ASC) — 5 diffs. Only the `latest` CTE changed; base prosrc md5
-- a1d86aa166117b05ecabd289b02ef00f = the pin, re-read right before.
-- Pinned: supabase/tests/pinnacle_pack_drop_ev.sql (new: an older snapshot of the same listing
-- must not be read; a planted ASC fails it).
--
-- anon-exec: unchanged (analytics_packs_summary) — CREATE OR REPLACE of an existing fn; ACL preserved; verified 2026-09-29 after apply via has_function_privilege.
--
-- Revert: re-apply the analytics_packs_summary block from 20260929025310_audit_20260928_pinnacle_pack_ev_at_drop_grain.sql
CREATE OR REPLACE FUNCTION public.analytics_packs_summary(p_collections text[] DEFAULT NULL::text[])
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  result jsonb;
BEGIN
  WITH latest_key AS MATERIALIZED (
    -- Each pack's newest snapshot, found on the (pack_listing_id, snapshotted_at DESC)
    -- index alone. 2026-09-29: selecting every column inside this DISTINCT ON made the
    -- planner heap-fetch all ~408k history rows to keep ~4.7k (412k buffers a call,
    -- 2,027 calls, max 30 s = the service_role timeout); the key pass is index-only
    -- (~9.7k buffers) and only the winners are fetched below (~25k in all).
    SELECT DISTINCT ON (h.pack_listing_id) h.pack_listing_id, h.snapshotted_at
    FROM pack_ev_history h
    ORDER BY h.pack_listing_id, h.snapshotted_at DESC
  ),
  latest AS (
    -- (pack_listing_id, snapshotted_at) is unique today (407,735 rows / keys) but no
    -- constraint says so; the DISTINCT ON keeps one row per pack if that ever changes.
    SELECT DISTINCT ON (pe.pack_listing_id)
      pe.collection_id,
      pe.pack_listing_id,
      pe.pack_price,
      pe.pack_ev,
      pe.value_ratio,
      pe.is_positive_ev,
      pe.fmv_coverage_pct,
      pe.total_unopened,
      pe.depletion_pct,
      pe.snapshotted_at
    FROM latest_key k
    JOIN pack_ev_history pe
      ON pe.pack_listing_id = k.pack_listing_id AND pe.snapshotted_at = k.snapshotted_at
    ORDER BY pe.pack_listing_id
  ),
  named AS (
    SELECT
      CASE c.slug
        WHEN 'nba_top_shot'   THEN 'topshot'
        WHEN 'nfl_all_day'    THEN 'allday'
        WHEN 'laliga_golazos' THEN 'golazos'
        ELSE c.slug
      END AS coll,
      l.*
    FROM latest l
    JOIN collections c ON c.id = l.collection_id
    -- 2026-09-28: Pinnacle's pack_ev_history rows are per SUB-DISTRIBUTION of
    -- a drop (a $4.99 Standard pack draws from up to six pools), so they are
    -- not a buyer's EV. Pinnacle is answered by the drop-grain arm below.
    WHERE c.slug <> 'disney_pinnacle'
  ),
  per_collection AS (
    SELECT
      coll,
      jsonb_build_object(
        'packs_tracked',      COUNT(*),
        'sellable_packs',     COUNT(*) FILTER (WHERE pack_price BETWEEN 1 AND 5000),
        'positive_ev_packs',  COUNT(*) FILTER (WHERE pack_price BETWEEN 1 AND 5000 AND is_positive_ev),
        'avg_value_ratio',    COALESCE(ROUND(AVG(value_ratio)
                                FILTER (WHERE pack_price BETWEEN 1 AND 5000 AND value_ratio IS NOT NULL)::numeric, 2), 0),
        'median_pack_price',  COALESCE(ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY pack_price)
                                FILTER (WHERE pack_price BETWEEN 1 AND 5000)::numeric, 2), 0),
        'total_unopened',     COALESCE(SUM(total_unopened) FILTER (WHERE pack_price BETWEEN 1 AND 5000), 0),
        'last_refresh',       MAX(snapshotted_at),
        'minutes_since_refresh', EXTRACT(EPOCH FROM (now() - MAX(snapshotted_at)))::int / 60
      ) AS stats
    FROM named
    WHERE (p_collections IS NULL OR coll = ANY(p_collections))
    GROUP BY coll
  ),
  -- 2026-09-28: Disney Pinnacle at DROP grain (v_pinnacle_pack_drop_ev): one
  -- row per purchasable pack. "+EV" = the SALES-BACKED part of the EV beats
  -- the price (value resting on asking prices is excluded); the average ratio
  -- is over packs whose EV is not mostly asks, so an ask-priced chase pool
  -- cannot set it. `low_confidence_packs` counts the rest.
  pinnacle_drops AS (
    SELECT DISTINCT ON (v.drop_key)
      v.drop_key, v.pack_price, v.value_ratio, v.is_positive_ev, v.low_confidence_ev,
      v.drop_available, v.drop_updated_at
    FROM v_pinnacle_pack_drop_ev v
    ORDER BY v.drop_key
  ),
  pinnacle AS (
    SELECT
      'pinnacle'::text AS coll,
      jsonb_build_object(
        'packs_tracked',      COUNT(*),
        'sellable_packs',     COUNT(*) FILTER (WHERE pack_price BETWEEN 1 AND 5000),
        'positive_ev_packs',  COUNT(*) FILTER (WHERE pack_price BETWEEN 1 AND 5000 AND is_positive_ev),
        'low_confidence_packs', COUNT(*) FILTER (WHERE pack_price BETWEEN 1 AND 5000 AND low_confidence_ev),
        'avg_value_ratio',    ROUND(AVG(value_ratio)
                                FILTER (WHERE pack_price BETWEEN 1 AND 5000 AND value_ratio IS NOT NULL AND NOT low_confidence_ev)::numeric, 2),
        'median_pack_price',  ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY pack_price)
                                FILTER (WHERE pack_price BETWEEN 1 AND 5000)::numeric, 2),
        'total_unopened',     SUM(drop_available) FILTER (WHERE pack_price BETWEEN 1 AND 5000),
        'last_refresh',       MAX(drop_updated_at),
        'minutes_since_refresh', EXTRACT(EPOCH FROM (now() - MAX(drop_updated_at)))::int / 60,
        'ev_grain',           'drop'
      ) AS stats
    FROM pinnacle_drops
    WHERE (p_collections IS NULL OR 'pinnacle' = ANY(p_collections))
    HAVING COUNT(*) > 0
  )
  SELECT jsonb_build_object(
    'collections', COALESCE(jsonb_object_agg(coll, stats), '{}'::jsonb),
    'as_of', now(),
    'note', 'Sellable packs are those priced between $1 and $5,000. Reward/airdrop packs ($0) and holder/locked packs ($99,999) are excluded from the headline metrics.'
  )
  INTO result
  FROM (SELECT coll, stats FROM per_collection UNION ALL SELECT coll, stats FROM pinnacle) m;

  RETURN result;
END;
$function$;

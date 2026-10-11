-- audit_20261011 — get_relative_deals: normalize each name ONCE, join on two hash-joinable legs.
--
-- 📏 MEASURED 2026-10-11 ~12:55 PM PT: the Golazos call the Sniper fallback makes
-- (`get_relative_deals(golazos, 10, 50)`) took 1,325 ms and 30,458 buffers for 100 listings. 890 ms of
-- it was one join filter: `e.external_id = cl.moment_id OR (normalize_name(e.player_name) =
-- normalize_name(cl.player_name) AND normalize_name(e.set_name) = normalize_name(cl.set_name))`.
-- An OR is not hash- or merge-joinable, so it ran as a nested loop over every listing × edition pair
-- (100 × 575 = 57,477 pairs) and called normalize_name up to 4× per PAIR. normalize_name carries
-- `SET search_path`, so it is never inlined; each call is a full function invocation.
-- Vercel shows `api/relative-deals … RPC_READ_TIMEOUT … read exceeded 8000ms` 3× in 7 days (mean 2.2 s
-- in pg_stat_statements since 08-12; max 20.7 s). On Top Shot (25,315 listings × 14,521 editions =
-- 367M pairs) the old form cannot finish at all; the new one runs in ~1.9 s.
--
-- THE FIX (same output, different plan)
--   · names normalized once per ROW in two MATERIALIZED CTEs (listings, editions of the collection);
--   · the OR becomes a UNION of two equi-joins (external_id = moment_id; np = np AND ns = ns). A pair
--     matched by both legs is folded by UNION. The pair set is exactly the OR join's pair set, and
--     DISTINCT ON keeps the same ORDER BY (exact match first, then lowest edition id), so each listing
--     picks the same edition. NULL semantics are unchanged: normalize_name(NULL) = '' on both sides,
--     as before, and `=` on a NULL external_id/moment_id matches nothing in either form.
--   · tier_floors / tier_stats / the LATERAL latest-snapshot read / ordering: byte-identical.
--
-- 📏 VERIFIED BEFORE APPLY (pg_temp copy of this body vs the live function):
--   · listing → edition choice: 0 differences over 265 listings (all Golazos + All Day listings and a
--     60-listing Top Shot md5 sample);
--   · full output, compared as a sorted set at limit 10000 with min-discount 0 / 10 / 25: identical on
--     Golazos (24 / 13 / 4 rows) and All Day (9 / 0 / 0); Pinnacle and UFC have no listings (both empty);
--   · cost on the production call: 1,325 ms / 30,458 buffers → 49 ms / 2,059 buffers.
--
-- Callers: /api/relative-deals only (SniperClient fallback on Golazos / UFC). Signature, return type,
-- volatility, SECURITY DEFINER, search_path and ACL unchanged.
--
-- anon-exec: unchanged (get_relative_deals) — CREATE OR REPLACE of an existing fn; ACL preserved.
--
-- REVERT: re-apply the body of 20261001043000_audit_20260930_relative_deals_one_row_per_listing_with_its_ids.sql
-- (live prosrc md5 6285ae2db70833f77346e874cbb79a7d, which this migration's guard requires).

DO $guard$
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE proname = 'get_relative_deals' AND pronamespace = 'public'::regnamespace) <> '6285ae2db70833f77346e874cbb79a7d' THEN
    RAISE EXCEPTION 'get_relative_deals live body is not the one this migration was built from — re-read before a full-body write';
  END IF;
END $guard$;

CREATE OR REPLACE FUNCTION public.get_relative_deals(p_collection_id uuid, p_min_discount numeric DEFAULT 15, p_limit integer DEFAULT 50)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  -- Names are normalized ONCE per row (normalize_name carries SET search_path,
  -- so it is never inlined: the old OR join called it up to 4x per
  -- listing x edition PAIR -- 57,500 pairs on Golazos, 367M on Top Shot).
  -- The OR becomes two hash-joinable legs; a pair matched by both legs is
  -- folded by UNION, and DISTINCT ON keeps the same ordering, so each listing
  -- picks exactly the edition the OR join picked.
  WITH l AS MATERIALIZED (
    SELECT cl.id, cl.ask_price, cl.player_name, cl.serial_number, cl.buy_url,
           cl.flow_id, cl.moment_id,
           normalize_name(cl.player_name) AS np, normalize_name(cl.set_name) AS ns
      FROM cached_listings cl
     WHERE cl.collection_id = p_collection_id
  ),
  ed AS MATERIALIZED (
    SELECT e.id, e.tier, e.set_name, e.external_id,
           normalize_name(e.player_name) AS np, normalize_name(e.set_name) AS ns
      FROM editions e
     WHERE e.collection_id = p_collection_id
  ),
  pairs AS (
    SELECT l.id AS lid, ed.id AS eid FROM l JOIN ed ON ed.external_id = l.moment_id
    UNION
    SELECT l.id, ed.id FROM l JOIN ed ON ed.np = l.np AND ed.ns = l.ns
  ),
  raw AS (
    -- One row per LISTING. The exact external_id match wins, then the lowest
    -- edition id for determinism.
    SELECT DISTINCT ON (l.id)
      COALESCE(ed.tier::text, 'UNKNOWN') AS tier, l.ask_price,
      l.player_name, ed.set_name, ed.id AS edition_id, ed.external_id AS edition_key,
      l.serial_number, l.buy_url, NULLIF(l.flow_id, '') AS nft_id
    FROM pairs p
    JOIN l ON l.id = p.lid
    JOIN ed ON ed.id = p.eid
    ORDER BY l.id, (ed.external_id = l.moment_id) DESC, ed.id
  ),
  tier_floors AS (
    SELECT tier, MIN(ask_price) AS floor_price
    FROM raw GROUP BY tier
  ),
  tier_stats AS (
    SELECT r.tier,
      PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY r.ask_price)::numeric AS median_price,
      COUNT(*) AS listing_count
    FROM raw r
    JOIN tier_floors tf ON tf.tier = r.tier
    WHERE r.ask_price <= tf.floor_price * 100
    GROUP BY r.tier
    HAVING COUNT(*) >= 2
  )
  SELECT COALESCE(jsonb_agg(to_jsonb(d)), '[]'::jsonb) FROM (
    SELECT r.player_name, r.set_name, r.tier,
      r.ask_price::numeric, ROUND(ts.median_price, 2) AS tier_median,
      ROUND((1 - r.ask_price::numeric / ts.median_price) * 100) AS discount_pct,
      f.fmv_usd, f.confidence::text AS confidence,
      r.serial_number, r.buy_url, r.edition_key, r.nft_id
    FROM raw r
    JOIN tier_stats ts ON ts.tier = r.tier
    -- The LATEST snapshot, not the history (the history multiplied every row).
    LEFT JOIN LATERAL (
      SELECT fs.fmv_usd, fs.confidence
        FROM fmv_snapshots fs
       WHERE fs.collection_id = p_collection_id AND fs.edition_id = r.edition_id
       ORDER BY fs.computed_at DESC
       LIMIT 1
    ) f ON true
    WHERE r.ask_price::numeric < ts.median_price * (1 - p_min_discount / 100.0)
    ORDER BY discount_pct DESC
    LIMIT p_limit
  ) d;
$function$;

DO $post$
BEGIN
  IF has_function_privilege('anon', 'public.get_relative_deals(uuid,numeric,integer)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.get_relative_deals(uuid,numeric,integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'get_relative_deals became executable by anon/authenticated';
  END IF;
END $post$;

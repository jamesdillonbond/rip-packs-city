-- audit_20261123: Candy listed-share squeeze covers every 2026 Candy set (Candy parity pass 2, 2026-11-23, applied ~6:33 PM PT).
--
-- 20261124013201 read collector-held copies from market_cap_current, whose Candy supply split exists for the 2026 Base
-- Series ICONs only (mv_candy_scarcity_board is Base-scoped), so the board could not rank the 2026 MLB All-Star Game ICONs
-- — the Candy set with the live Magic Eden book (528 confirmed asks over 231 editions vs 41 on Base, 11-23).
-- Now the function counts holders straight from the census (wallet_moments_cache), with the SAME definition the
-- Base split used: collector-held = copies outside Candy's own wallets (candy_house_wallets: inventory, ICON buyback,
-- pack treasury); Candy-held = copies inside them. Scope: the four 2026 sets the registry catalogues (Base, All-Star
-- Game, Gold Series, Quest Rewards). Legacy (2021–2025) sets stay out: their per-symbol listing sweep is newer and thin
-- (e.g. 40 asks over 2,114 Leadoff editions with ≥ 25 holders), so a "0 listed" there is not yet a census.
--
-- Equivalence on Base, measured before writing: 100 ranked / 66 with 0 listed — identical to the 20261124013201 body.
-- All-Star Game adds 180 editions (71 with 0 listed, max 12.8 %). Cost: one index-only scan of the census over 476
-- edition keys, ~5.4k buffers / 1.5 s cold (page is ISR, 30 min).
-- Rows gain `rarity_label` (Candy's own rarity name — Core, Uncommon, Rare, Epic…; Trevor 11-12) and the payload a
-- per-set summary `sets`. `burned` is NULL: the census sees holders, not burns. Signature unchanged.
--
-- Revert: re-apply get_candy_listed_squeeze from 20261124013201.

-- anon-exec: unchanged (get_candy_listed_squeeze) — CREATE OR REPLACE of an existing fn, same signature; ACL preserved, verified has_function_privilege anon=false, authenticated=false.
CREATE OR REPLACE FUNCTION public.get_candy_listed_squeeze(p_min_held integer DEFAULT 25, p_limit integer DEFAULT 100)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH ed AS MATERIALIZED (
    SELECT e.id, e.external_id::text AS k, e.player_name, e.set_name, e.rarity_label, e.thumbnail_url, e.circulation_count
      FROM public.editions e
     WHERE e.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid
       AND e.set_id IN ('381ae129-7dc7-47f4-9022-dd9e0fc21e39'::uuid,   -- 2026 MLB Base Series ICONs
                        '8608ae96-10c5-4bf6-aedf-b0d4dc0bfe66'::uuid,   -- 2026 MLB All-Star Game ICONs
                        '02fe803a-05b0-4af3-82b5-402e157d8d64'::uuid,   -- 2026 MLB Gold Series ICONs
                        '29417ac1-1fb9-4346-bb08-e50253b618c8'::uuid)   -- 2026 MLB Base Series Collection Quest Rewards
  ), hw AS MATERIALIZED (
    SELECT wallet_address FROM public.candy_house_wallets
  ), h AS (
    SELECT w.edition_key,
           count(*) FILTER (WHERE w.wallet_address NOT IN (SELECT wallet_address FROM hw))::int AS collector_held,
           count(*) FILTER (WHERE w.wallet_address IN (SELECT wallet_address FROM hw))::int AS issuer_held
      FROM public.wallet_moments_cache w
     WHERE w.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid
       AND w.edition_key = ANY (ARRAY(SELECT k FROM ed))
     GROUP BY w.edition_key
  ), s AS (
    SELECT edition_id, count(*)::int AS sales_30d
      FROM public.sales
     WHERE collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid
       AND sold_at >= now() - interval '30 days' AND price_usd > 0
     GROUP BY edition_id
  ), r AS (
    SELECT ed.k AS external_id, ed.player_name, ed.set_name, ed.rarity_label, ed.thumbnail_url,
           ed.circulation_count AS minted, NULL::int AS burned, h.issuer_held, h.collector_held,
           COALESCE(f.confirmed_listing_count, 0)::int AS listed,
           CASE WHEN f.confirmed_floor_usd > 0 THEN f.confirmed_floor_usd END AS floor_ask_usd,
           CASE WHEN fc.fmv_usd > 0 THEN fc.fmv_usd END AS fmv_usd,
           COALESCE(s.sales_30d, 0) AS sales_30d
      FROM ed
      JOIN h ON h.edition_key = ed.k
      LEFT JOIN public.candy_listing_floor f ON f.edition_id = ed.id
      LEFT JOIN public.candy_fmv_current fc ON fc.edition_id = ed.id
      LEFT JOIN s ON s.edition_id = ed.id
     WHERE h.collector_held >= GREATEST(COALESCE(p_min_held, 25), 1)
  )
  SELECT jsonb_build_object(
    'listings_seen_at', (SELECT max(last_seen_at) FROM public.candy_listings WHERE is_active),
    'min_held', GREATEST(COALESCE(p_min_held, 25), 1),
    'editions_ranked', (SELECT count(*) FROM r),
    'editions_zero_listed', (SELECT count(*) FROM r WHERE listed = 0),
    'sets', COALESCE((SELECT jsonb_agg(jsonb_build_object('set_name', set_name, 'ranked', n, 'zero_listed', z) ORDER BY n DESC, set_name)
                        FROM (SELECT set_name, count(*) n, count(*) FILTER (WHERE listed = 0) z FROM r GROUP BY set_name) x), '[]'::jsonb),
    'rows', COALESCE((SELECT jsonb_agg(to_jsonb(x) ORDER BY x.pct_listed, x.sales_30d DESC, x.collector_held DESC, x.external_id)
       FROM (SELECT r.*, round(100.0 * r.listed / r.collector_held, 1) AS pct_listed
               FROM r
              ORDER BY (r.listed::numeric / r.collector_held), r.sales_30d DESC, r.collector_held DESC, r.external_id
              LIMIT LEAST(GREATEST(COALESCE(p_limit, 100), 1), 500)) x), '[]'::jsonb)
  )
$function$;

COMMENT ON FUNCTION public.get_candy_listed_squeeze(integer, integer) IS
  'Candy listed-share squeeze (2026-11-23; all 2026 sets from 20261124023333): editions of the 2026 Base, All-Star Game, Gold and Quest sets with >= p_min_held collector-held copies (census, outside candy_house_wallets) ranked by confirmed Magic Eden listings (candy_listing_floor, re-seen within 12 h) / collector_held ascending, with Candy-held copies, rarity label, floor ask, FMV, 30-day sales, a per-set summary and the newest sweep stamp.';

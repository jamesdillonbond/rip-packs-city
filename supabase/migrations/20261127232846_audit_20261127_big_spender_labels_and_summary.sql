-- Big-spender watch, follow-up (2026-11-27). Internal intel only — nothing user-facing reads these.
--  1. Pack labels: pack_purchases.pack_name is NULL on every recent secondary sale, so the ledger and
--     activity feed read "Pack". Resolve via pack_distributions.title on (collection_id, dist_id).
--  2. Top Shot labels put the series in front ("S1 Base", "S3 Metallic Gold LE", "2024-25 Rookie Debut")
--     per Trevor's 2026-11-10 rule; the season form for on-chain 6+ comes from series_display_label().
--  3. get_big_spender_summary(p_days): one row per tracked wallet — spend, sells, net, last seen.
-- Revert: re-apply 20261127232140_audit_20261127_big_spender_watch.sql (CREATE OR REPLACE bodies), then
--         DROP FUNCTION public.get_big_spender_summary(integer); DROP FUNCTION public.big_spender_item_label(uuid, integer, text, text, integer);

-- anon-exec: revoked (big_spender_item_label) — new helper; service_role/postgres only.
CREATE FUNCTION public.big_spender_item_label(p_collection_id uuid, p_series integer, p_player text, p_set text, p_serial integer)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_set text := p_set;
  v_series text;
BEGIN
  IF p_set IS NOT NULL AND p_series IS NOT NULL
     AND p_collection_id = (SELECT id FROM collections WHERE slug = 'nba_top_shot') THEN
    v_series := series_display_label(p_collection_id, p_series);
    IF v_series IS NOT NULL THEN
      v_series := regexp_replace(v_series, '^Series ([0-9]+)$', 'S\1');
      v_series := regexp_replace(v_series, '^Series ', '');
      v_set := v_series || ' ' || regexp_replace(p_set, ' Set$', '');
    END IF;
  END IF;
  RETURN nullif(concat_ws(' · ', p_player, v_set, CASE WHEN p_serial IS NOT NULL THEN '#' || p_serial END), '');
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.big_spender_item_label(uuid, integer, text, text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.big_spender_item_label(uuid, integer, text, text, integer) TO postgres, service_role;

-- anon-exec: unchanged (refresh_big_spender_wallets) — CREATE OR REPLACE of an existing fn; ACL preserved, verified anon=false.
CREATE OR REPLACE FUNCTION public.refresh_big_spender_wallets(p_days integer DEFAULT 45)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_from timestamptz := (date_trunc('month', (now() - make_interval(days => p_days)) AT TIME ZONE 'America/Los_Angeles')) AT TIME ZONE 'America/Los_Angeles';
  v_sales integer; v_wallets integer; v_new integer;
BEGIN
  DELETE FROM big_spender_top_sales WHERE sold_at >= v_from;

  WITH excluded AS (
    SELECT lower(address) a FROM flowty_excluded_addresses
    UNION SELECT unnest(ARRAY['0x3cdbb3d569211ff3','0xedf9df96c92f4595','0xc1e4f4f4c4257510'])
  ), u AS (
    SELECT 'sales_market' src, s.id::text ref, c.slug coll,
           'item' kind, s.price_usd p, s.buyer_address b, s.seller_address sl, s.sold_at t,
           big_spender_item_label(s.collection_id, e.series, e.player_name, e.set_name, s.serial_number) lbl
      FROM sales_market s JOIN collections c ON c.id = s.collection_id
      LEFT JOIN editions e ON e.id = s.edition_id
     WHERE s.sold_at >= v_from AND s.price_usd >= 100 AND s.buyer_address IS NOT NULL
    UNION ALL
    SELECT 'pinnacle_sales', ps.id, 'disney_pinnacle', 'item', ps.sale_price_usd, ps.buyer_address, ps.seller_address, ps.sold_at,
           nullif(concat_ws(' · ', pc.character_name, pc.set_name, CASE WHEN ps.serial_number IS NOT NULL THEN '#'||ps.serial_number END), '')
      FROM pinnacle_sales ps LEFT JOIN pinnacle_catalog pc ON pc.render_id = ps.render_id
     WHERE ps.sold_at >= v_from AND ps.sale_price_usd >= 100 AND ps.buyer_address IS NOT NULL
    UNION ALL
    SELECT 'panini_sales', md5(ps.sku||'|'||coalesce(ps.tx_hash,'')||'|'||ps.sold_at::text), 'panini_blockchain', 'item',
           ps.amount_usd, ps.buyer, ps.seller, ps.sold_at,
           nullif(concat_ws(' · ', e.player_name, e.set_name), '')
      FROM panini_sales ps
      LEFT JOIN editions e ON e.external_id = ps.edition_external_id
                          AND e.collection_id = (SELECT id FROM collections WHERE slug = 'panini_blockchain')
     WHERE ps.sold_at >= v_from AND ps.amount_usd >= 100 AND ps.buyer IS NOT NULL
    UNION ALL
    SELECT 'candy_pack_sales', cps.transaction_hash||'|'||cps.token_mint, 'candy_mlb', 'pack', cps.price_usd, cps.buyer, cps.seller, cps.sold_at, 'Candy pack'
      FROM candy_pack_sales cps
     WHERE cps.sold_at >= v_from AND cps.price_usd >= 100 AND cps.buyer IS NOT NULL
    UNION ALL
    SELECT 'pack_purchases', pp.id::text, c.slug, 'pack', pp.sale_price, pp.buyer_address, NULL, pp.sealed_at, coalesce(pp.pack_name, pd.title, 'Pack')
      FROM pack_purchases pp JOIN collections c ON c.id = pp.collection_id
      LEFT JOIN pack_distributions pd ON pd.collection_id = pp.collection_id AND pd.dist_id = pp.pack_dist_id
     WHERE pp.sealed_at >= v_from AND pp.sale_price >= 100 AND pp.event_kind = 'secondary_sale'
       AND pp.custom_id IS DISTINCT FROM 'nba' AND pp.buyer_address IS NOT NULL
  ), k AS (
    SELECT u.*,
           CASE WHEN b  ~ '^0x' THEN lower(b)  ELSE b  END bk,
           CASE WHEN sl ~ '^0x' THEN lower(sl) ELSE sl END sk,
           (date_trunc('month', t AT TIME ZONE 'America/Los_Angeles'))::date m
      FROM u
  ), r AS (
    SELECT k.*, rank() OVER (PARTITION BY coll, kind, m ORDER BY p DESC) rk
      FROM k WHERE bk NOT IN (SELECT a FROM excluded)
  )
  INSERT INTO big_spender_top_sales (source, sale_ref, wallet_key, seller_key, collection_slug, asset_kind, price_usd, sold_at, month_pt, month_rank, item_label)
  SELECT src, ref, bk, sk, coll, kind, p, t, m, rk, lbl FROM r WHERE rk <= 25
  ON CONFLICT (source, sale_ref) DO NOTHING;
  GET DIAGNOSTICS v_sales = ROW_COUNT;

  SELECT count(*) INTO v_new FROM (SELECT DISTINCT wallet_key FROM big_spender_top_sales) d
   WHERE NOT EXISTS (SELECT 1 FROM big_spender_wallets w WHERE w.wallet_key = d.wallet_key);

  WITH internal_wallets AS (
    SELECT lower(up.wallet_address) a FROM user_profiles up JOIN internal_accounts ia ON ia.user_id = up.id WHERE up.wallet_address IS NOT NULL
    UNION SELECT lower(sw.wallet_addr) FROM saved_wallets sw JOIN internal_accounts ia ON ia.user_id = sw.user_id WHERE sw.wallet_addr IS NOT NULL
  ), agg AS (
    SELECT ts.wallet_key,
           CASE WHEN bool_or(ts.collection_slug = 'panini_blockchain') AND NOT bool_or(ts.collection_slug <> 'panini_blockchain') THEN 'panini'
                WHEN ts.wallet_key !~ '^0x' THEN 'solana' ELSE 'flow' END chain,
           min(ts.sold_at) f, max(ts.sold_at) l, count(*) n, sum(ts.price_usd) tot, max(ts.price_usd) mx,
           array_agg(DISTINCT ts.collection_slug ORDER BY ts.collection_slug) colls,
           bool_or(EXISTS (SELECT 1 FROM big_spender_top_sales x WHERE x.wallet_key = ts.seller_key AND x.seller_key = ts.wallet_key)) recip
      FROM big_spender_top_sales ts GROUP BY ts.wallet_key
  )
  INSERT INTO big_spender_wallets AS w (wallet_key, chain, username, first_top_sale_at, last_top_sale_at, top_sale_count, top_sale_usd, biggest_sale_usd, collections, reciprocal_flag, is_internal, updated_at)
  SELECT a.wallet_key, a.chain,
         CASE WHEN a.chain = 'panini' THEN a.wallet_key ELSE wu.username END,
         a.f, a.l, a.n, a.tot, a.mx, a.colls, coalesce(a.recip, false),
         a.wallet_key IN (SELECT a2.a FROM internal_wallets a2), now()
    FROM agg a LEFT JOIN wallet_usernames wu ON wu.wallet_addr = a.wallet_key
  ON CONFLICT (wallet_key) DO UPDATE SET
    username = coalesce(EXCLUDED.username, w.username),
    first_top_sale_at = least(w.first_top_sale_at, EXCLUDED.first_top_sale_at),
    last_top_sale_at = EXCLUDED.last_top_sale_at,
    top_sale_count = EXCLUDED.top_sale_count, top_sale_usd = EXCLUDED.top_sale_usd,
    biggest_sale_usd = EXCLUDED.biggest_sale_usd, collections = EXCLUDED.collections,
    reciprocal_flag = EXCLUDED.reciprocal_flag, is_internal = EXCLUDED.is_internal, updated_at = now();
  GET DIAGNOSTICS v_wallets = ROW_COUNT;

  PERFORM log_pipeline_run('big_spender_refresh', true, jsonb_build_object('from', v_from, 'top_sales_written', v_sales, 'wallets_upserted', v_wallets, 'new_wallets', v_new));
  RETURN jsonb_build_object('from', v_from, 'top_sales_written', v_sales, 'wallets_upserted', v_wallets, 'new_wallets', v_new);
END;
$function$;

-- anon-exec: unchanged (get_big_spender_activity) — CREATE OR REPLACE of an existing fn; ACL preserved, verified anon=false.
CREATE OR REPLACE FUNCTION public.get_big_spender_activity(p_hours integer DEFAULT 24, p_min_usd numeric DEFAULT 0)
RETURNS TABLE (at timestamptz, wallet_key text, username text, side text, collection_slug text, asset_kind text, item_label text, price_usd numeric, counterparty text, wallet_top_sale_usd numeric, reciprocal_flag boolean)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH w AS (SELECT * FROM big_spender_wallets WHERE NOT muted AND NOT is_internal),
  since AS (SELECT now() - make_interval(hours => p_hours) t),
  ev AS (
    SELECT s.sold_at at, CASE WHEN s.buyer_address ~ '^0x' THEN lower(s.buyer_address) ELSE s.buyer_address END buyer,
           CASE WHEN s.seller_address ~ '^0x' THEN lower(s.seller_address) ELSE s.seller_address END seller,
           c.slug coll, 'item' kind,
           big_spender_item_label(s.collection_id, e.series, e.player_name, e.set_name, s.serial_number) lbl, s.price_usd p
      FROM sales_market s JOIN collections c ON c.id = s.collection_id LEFT JOIN editions e ON e.id = s.edition_id
     WHERE s.sold_at >= (SELECT t FROM since) AND s.price_usd >= p_min_usd
    UNION ALL
    SELECT ps.sold_at, lower(ps.buyer_address), lower(ps.seller_address), 'disney_pinnacle', 'item',
           nullif(concat_ws(' · ', pc.character_name, pc.set_name, CASE WHEN ps.serial_number IS NOT NULL THEN '#'||ps.serial_number END), ''), ps.sale_price_usd
      FROM pinnacle_sales ps LEFT JOIN pinnacle_catalog pc ON pc.render_id = ps.render_id
     WHERE ps.sold_at >= (SELECT t FROM since) AND ps.sale_price_usd >= p_min_usd
    UNION ALL
    SELECT ps.sold_at, ps.buyer, ps.seller, 'panini_blockchain', 'item', nullif(concat_ws(' · ', e.player_name, e.set_name), ''), ps.amount_usd
      FROM panini_sales ps LEFT JOIN editions e ON e.external_id = ps.edition_external_id
                          AND e.collection_id = (SELECT id FROM collections WHERE slug = 'panini_blockchain')
     WHERE ps.sold_at >= (SELECT t FROM since) AND ps.amount_usd >= p_min_usd
    UNION ALL
    SELECT cps.sold_at, cps.buyer, cps.seller, 'candy_mlb', 'pack', 'Candy pack', cps.price_usd
      FROM candy_pack_sales cps WHERE cps.sold_at >= (SELECT t FROM since) AND cps.price_usd >= p_min_usd
    UNION ALL
    SELECT pp.sealed_at, lower(pp.buyer_address), NULL, c.slug, 'pack', coalesce(pp.pack_name, pd.title, 'Pack'), pp.sale_price
      FROM pack_purchases pp JOIN collections c ON c.id = pp.collection_id
      LEFT JOIN pack_distributions pd ON pd.collection_id = pp.collection_id AND pd.dist_id = pp.pack_dist_id
     WHERE pp.sealed_at >= (SELECT t FROM since) AND pp.sale_price >= p_min_usd
       AND pp.event_kind = 'secondary_sale' AND pp.custom_id IS DISTINCT FROM 'nba'
  )
  SELECT ev.at, w.wallet_key, w.username, 'buy', ev.coll, ev.kind, ev.lbl, ev.p, ev.seller, w.top_sale_usd, w.reciprocal_flag
    FROM ev JOIN w ON w.wallet_key = ev.buyer
  UNION ALL
  SELECT ev.at, w.wallet_key, w.username, 'sell', ev.coll, ev.kind, ev.lbl, ev.p, ev.buyer, w.top_sale_usd, w.reciprocal_flag
    FROM ev JOIN w ON w.wallet_key = ev.seller
  ORDER BY 1 DESC;
$function$;

-- anon-exec: revoked (get_big_spender_summary) — new SECDEF intel reader; service_role/postgres only.
CREATE FUNCTION public.get_big_spender_summary(p_days integer DEFAULT 7)
RETURNS TABLE (wallet_key text, username text, buys integer, spent_usd numeric, sells integer, sold_usd numeric, net_usd numeric, biggest_buy_usd numeric, collections text[], last_seen_at timestamptz, lifetime_top_sale_usd numeric, tracked_since timestamptz, reciprocal_flag boolean)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT a.wallet_key, max(a.username),
         count(*) FILTER (WHERE a.side = 'buy')::int,
         coalesce(sum(a.price_usd) FILTER (WHERE a.side = 'buy'), 0),
         count(*) FILTER (WHERE a.side = 'sell')::int,
         coalesce(sum(a.price_usd) FILTER (WHERE a.side = 'sell'), 0),
         coalesce(sum(a.price_usd) FILTER (WHERE a.side = 'buy'), 0) - coalesce(sum(a.price_usd) FILTER (WHERE a.side = 'sell'), 0),
         max(a.price_usd) FILTER (WHERE a.side = 'buy'),
         array_agg(DISTINCT a.collection_slug ORDER BY a.collection_slug),
         max(a.at), max(a.wallet_top_sale_usd), max(w.tracked_since), bool_or(a.reciprocal_flag)
    FROM get_big_spender_activity(p_days * 24, 0) a
    JOIN big_spender_wallets w ON w.wallet_key = a.wallet_key
   GROUP BY a.wallet_key
   ORDER BY 4 DESC;
$function$;
REVOKE EXECUTE ON FUNCTION public.get_big_spender_summary(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_big_spender_summary(integer) TO postgres, service_role;

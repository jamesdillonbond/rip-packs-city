-- Big-spender watch (Trevor 2026-11-27: "start tracking any wallet that has hit any of our top sales").
-- A TOP SALE = one of a collection's 25 highest sales in its Pacific-time calendar month, $100 minimum,
-- ranked separately for Moments/Cards/Pins vs packs. Every buyer of a top sale is tracked; once tracked,
-- a wallet stays tracked (the ledger only re-ranks the open window).
-- System/marketplace accounts are excluded via flowty_excluded_addresses + the three marketplace
-- addresses Whale Watch already excludes. Top Shot's own shop (pack_purchases custom_id 'nba') excluded.
-- Revert: DROP FUNCTION public.get_big_spender_activity(integer, numeric); DROP FUNCTION public.refresh_big_spender_wallets(integer);
--         DROP TABLE public.big_spender_top_sales; DROP TABLE public.big_spender_wallets;  (+ cron.unschedule('rpc-big-spender-refresh'))

CREATE TABLE public.big_spender_wallets (
  wallet_key        text PRIMARY KEY,           -- Flow address lower-cased; Solana address as-is; Panini username as-is
  chain             text NOT NULL CHECK (chain IN ('flow','solana','panini')),
  username          text,
  first_top_sale_at timestamptz NOT NULL,
  last_top_sale_at  timestamptz NOT NULL,
  top_sale_count    integer NOT NULL,
  top_sale_usd      numeric NOT NULL,
  biggest_sale_usd  numeric NOT NULL,
  collections       text[] NOT NULL,
  reciprocal_flag   boolean NOT NULL DEFAULT false,  -- a top-sale counterparty also bought a top sale FROM this wallet (possible circular trading)
  is_internal       boolean NOT NULL DEFAULT false,  -- an RPC internal account's wallet
  muted             boolean NOT NULL DEFAULT false,  -- manual: hide from activity reads
  note              text,
  tracked_since     timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.big_spender_wallets IS 'Trevor 2026-11-27: every buyer of a top sale (a collection''s 25 highest sales in its PT month, $100 min, items and packs ranked separately). Sticky: once tracked, stays tracked. Written by refresh_big_spender_wallets(); read with get_big_spender_activity().';

CREATE TABLE public.big_spender_top_sales (
  source          text NOT NULL,   -- sales_market | pinnacle_sales | panini_sales | candy_pack_sales | pack_purchases
  sale_ref        text NOT NULL,
  wallet_key      text NOT NULL,
  seller_key      text,
  collection_slug text NOT NULL,
  asset_kind      text NOT NULL CHECK (asset_kind IN ('item','pack')),
  price_usd       numeric NOT NULL,
  sold_at         timestamptz NOT NULL,
  month_pt        date NOT NULL,
  month_rank      integer NOT NULL,
  item_label      text,
  PRIMARY KEY (source, sale_ref)
);
CREATE INDEX big_spender_top_sales_wallet_idx ON public.big_spender_top_sales (wallet_key);
CREATE INDEX big_spender_top_sales_sold_at_idx ON public.big_spender_top_sales (sold_at);

ALTER TABLE public.big_spender_wallets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.big_spender_top_sales ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.big_spender_wallets, public.big_spender_top_sales FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.big_spender_wallets, public.big_spender_top_sales TO service_role;

-- anon-exec: revoked (refresh_big_spender_wallets) — new SECDEF writer; service_role/postgres only.
CREATE FUNCTION public.refresh_big_spender_wallets(p_days integer DEFAULT 45)
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
           nullif(concat_ws(' · ', e.player_name, e.set_name, CASE WHEN s.serial_number IS NOT NULL THEN '#'||s.serial_number END), '') lbl
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
    SELECT 'pack_purchases', pp.id::text, c.slug, 'pack', pp.sale_price, pp.buyer_address, NULL, pp.sealed_at, coalesce(pp.pack_name, 'Pack')
      FROM pack_purchases pp JOIN collections c ON c.id = pp.collection_id
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
REVOKE EXECUTE ON FUNCTION public.refresh_big_spender_wallets(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_big_spender_wallets(integer) TO postgres, service_role;

-- anon-exec: revoked (get_big_spender_activity) — new SECDEF reader of wallet activity; service_role/postgres only.
CREATE FUNCTION public.get_big_spender_activity(p_hours integer DEFAULT 24, p_min_usd numeric DEFAULT 0)
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
           nullif(concat_ws(' · ', e.player_name, e.set_name, CASE WHEN s.serial_number IS NOT NULL THEN '#'||s.serial_number END), '') lbl, s.price_usd p
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
    SELECT pp.sealed_at, lower(pp.buyer_address), NULL, c.slug, 'pack', coalesce(pp.pack_name, 'Pack'), pp.sale_price
      FROM pack_purchases pp JOIN collections c ON c.id = pp.collection_id
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
REVOKE EXECUTE ON FUNCTION public.get_big_spender_activity(integer, numeric) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_big_spender_activity(integer, numeric) TO postgres, service_role;

-- Big-spender watch: one wallet key per wallet (2026-11-27). 23 Disney Pinnacle whales were keyed as
-- bare 16-hex strings ("9d6393bf07e789be") because some pinnacle_sales rows store the Flow address
-- without "0x", and the chain rule ("no 0x → Solana") then labelled them Solana — so Whale Watch
-- linked them to the Candy wallet page and never asked Atlas for their names.
-- big_spender_key(): lower-case a 0x Flow address; prefix "0x" to a bare 16-hex Flow address; return
-- anything else untouched (a Solana key is case-sensitive base58, 32-44 chars, and can never match
-- ^[0-9a-fA-F]{16}$). Every key read in the three functions goes through it. Data: the ledger's keys are
-- rewritten in place; the 23 mis-keyed wallet rows are deleted and re-created under their 0x key by the
-- refresh that follows this migration.
-- Revert: re-apply the bodies from 20261127232846 (refresh_big_spender_wallets, get_big_spender_activity)
-- and 20261128015710 (refresh_whale_watch_board); DROP FUNCTION public.big_spender_key(text).

-- anon-exec: revoked (big_spender_key) — new helper; service_role/postgres only.
CREATE FUNCTION public.big_spender_key(p_key text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT CASE
           WHEN p_key ~ '^0[xX]' THEN lower(p_key)
           WHEN p_key ~ '^[0-9a-fA-F]{16}$' THEN '0x' || lower(p_key)
           ELSE p_key
         END
$function$;
REVOKE EXECUTE ON FUNCTION public.big_spender_key(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.big_spender_key(text) TO postgres, service_role;

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
           big_spender_key(b) bk,
           big_spender_key(sl) sk,
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
    SELECT s.sold_at at, big_spender_key(s.buyer_address) buyer,
           big_spender_key(s.seller_address) seller,
           c.slug coll, 'item' kind,
           big_spender_item_label(s.collection_id, e.series, e.player_name, e.set_name, s.serial_number) lbl, s.price_usd p
      FROM sales_market s JOIN collections c ON c.id = s.collection_id LEFT JOIN editions e ON e.id = s.edition_id
     WHERE s.sold_at >= (SELECT t FROM since) AND s.price_usd >= p_min_usd
    UNION ALL
    SELECT ps.sold_at, big_spender_key(ps.buyer_address), big_spender_key(ps.seller_address), 'disney_pinnacle', 'item',
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
    SELECT pp.sealed_at, big_spender_key(pp.buyer_address), NULL, c.slug, 'pack', coalesce(pp.pack_name, pd.title, 'Pack'), pp.sale_price
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

-- anon-exec: unchanged (refresh_whale_watch_board) — CREATE OR REPLACE of an existing fn; ACL preserved, verified anon=false.
CREATE OR REPLACE FUNCTION public.refresh_whale_watch_board()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_board jsonb;
  v_since timestamptz := now() - interval '30 days';
  v_panini uuid := (SELECT id FROM collections WHERE slug = 'panini_blockchain');
BEGIN
  CREATE TEMP TABLE _ww_ev ON COMMIT DROP AS
  WITH w AS (
    SELECT wallet_key FROM big_spender_wallets WHERE NOT muted AND NOT is_internal
  ), raw AS (
    SELECT 'sales_market'::text src, s.id::text ref, c.slug coll, 'item'::text kind, s.price_usd p, s.sold_at t,
           big_spender_key(s.buyer_address) b,
           big_spender_key(s.seller_address) sl,
           s.edition_id::text e_id, s.collection_id c_id, s.serial_number::int ser
      FROM sales_market s JOIN collections c ON c.id = s.collection_id
     WHERE s.sold_at >= v_since AND s.price_usd > 0 AND s.buyer_address IS NOT NULL
    UNION ALL
    SELECT 'pinnacle_sales', ps.id, 'disney_pinnacle', 'item', ps.sale_price_usd, ps.sold_at,
           big_spender_key(ps.buyer_address), big_spender_key(ps.seller_address), ps.render_id, NULL, ps.serial_number::int
      FROM pinnacle_sales ps
     WHERE ps.sold_at >= v_since AND ps.sale_price_usd > 0 AND ps.buyer_address IS NOT NULL
    UNION ALL
    SELECT 'panini_sales', ps.sku, 'panini_blockchain', 'item', ps.amount_usd, ps.sold_at,
           ps.buyer, ps.seller, ps.edition_external_id, NULL, NULL
      FROM panini_sales ps
     WHERE ps.sold_at >= v_since AND ps.amount_usd > 0 AND ps.buyer IS NOT NULL
    UNION ALL
    SELECT 'candy_pack_sales', cps.transaction_hash, 'candy_mlb', 'pack', cps.price_usd, cps.sold_at,
           cps.buyer, cps.seller, NULL, NULL, NULL
      FROM candy_pack_sales cps
     WHERE cps.sold_at >= v_since AND cps.price_usd > 0 AND cps.buyer IS NOT NULL
    UNION ALL
    SELECT 'pack_purchases', pp.id::text, c.slug, 'pack', pp.sale_price, pp.sealed_at,
           big_spender_key(pp.buyer_address), NULL, pp.pack_dist_id, pp.collection_id, NULL
      FROM pack_purchases pp JOIN collections c ON c.id = pp.collection_id
     WHERE pp.sealed_at >= v_since AND pp.sale_price > 0 AND pp.event_kind = 'secondary_sale'
       AND pp.custom_id IS DISTINCT FROM 'nba' AND pp.buyer_address IS NOT NULL
  ), pairs AS (
    SELECT DISTINCT a.wallet_key b, a.seller_key sl
      FROM big_spender_top_sales a
     WHERE a.seller_key IS NOT NULL
       AND EXISTS (SELECT 1 FROM big_spender_top_sales x WHERE x.wallet_key = a.seller_key AND x.seller_key = a.wallet_key)
  )
  SELECT raw.* FROM raw
   WHERE raw.b IN (SELECT wallet_key FROM w)
     AND NOT EXISTS (SELECT 1 FROM pairs pr WHERE pr.b = raw.b AND pr.sl = raw.sl);

  WITH who AS (
    SELECT bw.wallet_key, bw.chain,
           coalesce(bw.username, CASE WHEN bw.chain = 'panini' THEN bw.wallet_key END) username,
           bw.top_sale_usd, bw.tracked_since
      FROM big_spender_wallets bw
  ), lead AS (
    SELECT d.days, e.b,
           count(*) buys, count(*) FILTER (WHERE e.kind = 'pack') pack_buys,
           round(sum(e.p)::numeric, 2) spent, round(max(e.p)::numeric, 2) biggest,
           array_agg(DISTINCT e.coll ORDER BY e.coll) colls, max(e.t) last_at
      FROM (VALUES (7), (30)) d(days)
      JOIN _ww_ev e ON e.t >= now() - make_interval(days => d.days)
     GROUP BY d.days, e.b
  ), lead_top_coll AS (
    SELECT DISTINCT ON (d.days, e.b) d.days, e.b, e.coll top_coll
      FROM (VALUES (7), (30)) d(days)
      JOIN _ww_ev e ON e.t >= now() - make_interval(days => d.days)
     GROUP BY d.days, e.b, e.coll
     ORDER BY d.days, e.b, sum(e.p) DESC, e.coll
  ), lead_ranked AS (
    SELECT l.*, tc.top_coll, row_number() OVER (PARTITION BY l.days ORDER BY l.spent DESC, l.b) rn
      FROM lead l JOIN lead_top_coll tc ON tc.days = l.days AND tc.b = l.b
  ), lead_coll AS (
    SELECT d.days, e.coll, e.b,
           count(*) buys, count(*) FILTER (WHERE e.kind = 'pack') pack_buys,
           round(sum(e.p)::numeric, 2) spent, round(max(e.p)::numeric, 2) biggest, max(e.t) last_at
      FROM (VALUES (7), (30)) d(days)
      JOIN _ww_ev e ON e.t >= now() - make_interval(days => d.days)
     GROUP BY d.days, e.coll, e.b
  ), lead_coll_ranked AS (
    SELECT lc.*, row_number() OVER (PARTITION BY lc.days, lc.coll ORDER BY lc.spent DESC, lc.b) rn FROM lead_coll lc
  ), labelled AS (
    -- Labels only for the rows the board shows (big moves and biggest buys).
    SELECT e.*,
           CASE e.src
             WHEN 'sales_market' THEN (SELECT big_spender_item_label(e.c_id, ed.series, ed.player_name, ed.set_name, e.ser) FROM editions ed WHERE ed.id = e.e_id::uuid)
             WHEN 'pinnacle_sales' THEN (SELECT nullif(concat_ws(' · ', pc.character_name, pc.set_name, CASE WHEN e.ser IS NOT NULL THEN '#' || e.ser END), '') FROM pinnacle_catalog pc WHERE pc.render_id = e.e_id)
             WHEN 'panini_sales' THEN (SELECT nullif(concat_ws(' · ', ed.player_name, ed.set_name), '') FROM editions ed WHERE ed.external_id = e.e_id AND ed.collection_id = v_panini LIMIT 1)
             WHEN 'pack_purchases' THEN (SELECT pd.title FROM pack_distributions pd WHERE pd.collection_id = e.c_id AND pd.dist_id = e.e_id)
             ELSE 'Candy pack'
           END lbl,
           CASE WHEN e.src = 'sales_market' THEN e.e_id END edition_id,
           CASE e.src
             WHEN 'sales_market' THEN (SELECT ed.external_id FROM editions ed WHERE ed.id = e.e_id::uuid)
             WHEN 'pinnacle_sales' THEN e.e_id
             WHEN 'panini_sales' THEN e.e_id
             WHEN 'pack_purchases' THEN e.e_id
           END link_key
      FROM (
        (SELECT * FROM _ww_ev WHERE t >= now() - interval '7 days' AND p >= 250 ORDER BY t DESC LIMIT 40)
        UNION
        (SELECT * FROM _ww_ev ORDER BY p DESC LIMIT 15)
      ) e
  ), move_rows AS (
    SELECT jsonb_build_object(
             'at', l.t, 'collection', l.coll, 'kind', l.kind, 'item', coalesce(l.lbl, CASE WHEN l.kind = 'pack' THEN 'Pack' END),
             'price_usd', round(l.p::numeric, 2), 'username', who.username, 'chain', who.chain,
             'wallet', CASE WHEN who.username IS NULL THEN l.b END, 'key', l.b, 'edition_id', l.edition_id,
             'link_key', l.link_key) j,
           l.t, l.p
      FROM labelled l JOIN who ON who.wallet_key = l.b
  )
  SELECT jsonb_build_object(
    'computed_at', now(),
    'tracked_wallets', (SELECT count(*) FROM big_spender_wallets WHERE NOT muted AND NOT is_internal),
    'active_7d', (SELECT count(DISTINCT b) FROM _ww_ev WHERE t >= now() - interval '7 days'),
    'spend_7d_usd', (SELECT round(coalesce(sum(p), 0)::numeric, 2) FROM _ww_ev WHERE t >= now() - interval '7 days'),
    'new_tracked_7d', (SELECT count(*) FROM big_spender_wallets WHERE NOT muted AND NOT is_internal AND first_top_sale_at >= now() - interval '7 days'),
    'leaders', jsonb_build_object(
      '7d', coalesce((SELECT jsonb_agg(jsonb_build_object(
              'rank', lr.rn, 'username', who.username, 'chain', who.chain,
              'wallet', CASE WHEN who.username IS NULL THEN lr.b END,
              'buys', lr.buys, 'pack_buys', lr.pack_buys, 'spent_usd', lr.spent, 'biggest_usd', lr.biggest,
              'collections', lr.colls, 'top_collection', lr.top_coll, 'key', lr.b, 'last_at', lr.last_at) ORDER BY lr.rn)
             FROM lead_ranked lr JOIN who ON who.wallet_key = lr.b WHERE lr.days = 7 AND lr.rn <= 25), '[]'::jsonb),
      '30d', coalesce((SELECT jsonb_agg(jsonb_build_object(
              'rank', lr.rn, 'username', who.username, 'chain', who.chain,
              'wallet', CASE WHEN who.username IS NULL THEN lr.b END,
              'buys', lr.buys, 'pack_buys', lr.pack_buys, 'spent_usd', lr.spent, 'biggest_usd', lr.biggest,
              'collections', lr.colls, 'top_collection', lr.top_coll, 'key', lr.b, 'last_at', lr.last_at) ORDER BY lr.rn)
             FROM lead_ranked lr JOIN who ON who.wallet_key = lr.b WHERE lr.days = 30 AND lr.rn <= 25), '[]'::jsonb)
    ),
    'by_collection', coalesce((
      SELECT jsonb_object_agg(c.coll, jsonb_build_object(
               '7d', coalesce((SELECT jsonb_agg(jsonb_build_object(
                        'rank', x.rn, 'username', who.username, 'chain', who.chain,
                        'wallet', CASE WHEN who.username IS NULL THEN x.b END, 'key', x.b,
                        'buys', x.buys, 'pack_buys', x.pack_buys, 'spent_usd', x.spent, 'biggest_usd', x.biggest,
                        'collections', jsonb_build_array(x.coll), 'top_collection', x.coll, 'last_at', x.last_at) ORDER BY x.rn)
                       FROM lead_coll_ranked x JOIN who ON who.wallet_key = x.b
                      WHERE x.days = 7 AND x.coll = c.coll AND x.rn <= 10), '[]'::jsonb),
               '30d', coalesce((SELECT jsonb_agg(jsonb_build_object(
                        'rank', x.rn, 'username', who.username, 'chain', who.chain,
                        'wallet', CASE WHEN who.username IS NULL THEN x.b END, 'key', x.b,
                        'buys', x.buys, 'pack_buys', x.pack_buys, 'spent_usd', x.spent, 'biggest_usd', x.biggest,
                        'collections', jsonb_build_array(x.coll), 'top_collection', x.coll, 'last_at', x.last_at) ORDER BY x.rn)
                       FROM lead_coll_ranked x JOIN who ON who.wallet_key = x.b
                      WHERE x.days = 30 AND x.coll = c.coll AND x.rn <= 10), '[]'::jsonb)))
        FROM (SELECT DISTINCT coll FROM _ww_ev) c), '{}'::jsonb),
    'moves', coalesce((SELECT jsonb_agg(m.j ORDER BY m.t DESC) FROM move_rows m WHERE m.t >= now() - interval '7 days' AND m.p >= 250), '[]'::jsonb),
    'biggest_30d', coalesce((SELECT jsonb_agg(x.j ORDER BY x.p DESC) FROM (SELECT j, p FROM move_rows ORDER BY p DESC LIMIT 15) x), '[]'::jsonb)
  ) INTO v_board;

  INSERT INTO whale_watch_board (id, board, computed_at) VALUES (1, v_board, now())
  ON CONFLICT (id) DO UPDATE SET board = EXCLUDED.board, computed_at = EXCLUDED.computed_at;

  PERFORM log_pipeline_run('whale_watch_board', true, jsonb_build_object(
    'leaders_7d', jsonb_array_length(v_board->'leaders'->'7d'),
    'leaders_30d', jsonb_array_length(v_board->'leaders'->'30d'),
    'moves', jsonb_array_length(v_board->'moves')));
  RETURN jsonb_build_object('leaders_7d', jsonb_array_length(v_board->'leaders'->'7d'),
                            'leaders_30d', jsonb_array_length(v_board->'leaders'->'30d'),
                            'moves', jsonb_array_length(v_board->'moves'));
END;
$function$;

-- Data: rewrite the ledger's keys, drop the mis-keyed wallet rows (re-created by the next refresh).
UPDATE public.big_spender_top_sales
   SET wallet_key = public.big_spender_key(wallet_key), seller_key = public.big_spender_key(seller_key)
 WHERE wallet_key ~ '^[0-9a-fA-F]{16}$' OR seller_key ~ '^[0-9a-fA-F]{16}$';
DELETE FROM public.big_spender_wallets WHERE wallet_key ~ '^[0-9a-fA-F]{16}$';

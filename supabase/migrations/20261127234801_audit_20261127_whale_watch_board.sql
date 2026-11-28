-- Whale Watch board (2026-11-27). Trevor: "Maybe we should have a page that has this. Like a whale
-- watcher page" → "this page can be user-facing". Backs /insights/whale-watch.
--
-- Reading the activity live costs ~32 s over 30 days (measured 2026-11-27), so the board is a
-- PRECOMPUTED snapshot: refresh_whale_watch_board() writes one jsonb row, hourly, and the public
-- route reads that row (service role). Nothing here is granted to anon/authenticated.
--
-- What it counts: BUYS by wallets in big_spender_wallets (anyone who has bought one of a
-- collection's top-25 sales of a PT month, $100 min). Excluded: muted and internal wallets, and
-- trades between a RECIPROCAL PAIR — two wallets that have each bought a top sale from the other —
-- so cards changing hands back and forth do not read as spend.
-- Schedule (created with cron.schedule, jobid 954): select cron.schedule('rpc-whale-watch-board', '27 * * * *', $$select public.refresh_whale_watch_board()$$);
-- Revert: select cron.unschedule('rpc-whale-watch-board'); DROP FUNCTION public.refresh_whale_watch_board();
--         DROP TABLE public.whale_watch_board;

CREATE TABLE public.whale_watch_board (
  id          integer PRIMARY KEY CHECK (id = 1),
  board       jsonb NOT NULL,
  computed_at timestamptz NOT NULL
);
ALTER TABLE public.whale_watch_board ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.whale_watch_board FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.whale_watch_board TO service_role;

-- anon-exec: revoked (refresh_whale_watch_board) — new SECDEF writer; service_role/postgres only.
CREATE FUNCTION public.refresh_whale_watch_board()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_board jsonb;
  v_since timestamptz := now() - interval '30 days';
  v_topshot uuid := (SELECT id FROM collections WHERE slug = 'nba_top_shot');
  v_panini uuid := (SELECT id FROM collections WHERE slug = 'panini_blockchain');
BEGIN
  CREATE TEMP TABLE _ww_ev ON COMMIT DROP AS
  WITH w AS (
    SELECT wallet_key FROM big_spender_wallets WHERE NOT muted AND NOT is_internal
  ), raw AS (
    SELECT 'sales_market'::text src, s.id::text ref, c.slug coll, 'item'::text kind, s.price_usd p, s.sold_at t,
           CASE WHEN s.buyer_address ~ '^0x' THEN lower(s.buyer_address) ELSE s.buyer_address END b,
           CASE WHEN s.seller_address ~ '^0x' THEN lower(s.seller_address) ELSE s.seller_address END sl,
           s.edition_id::text e_id, s.collection_id c_id, s.serial_number::int ser
      FROM sales_market s JOIN collections c ON c.id = s.collection_id
     WHERE s.sold_at >= v_since AND s.price_usd > 0 AND s.buyer_address IS NOT NULL
    UNION ALL
    SELECT 'pinnacle_sales', ps.id, 'disney_pinnacle', 'item', ps.sale_price_usd, ps.sold_at,
           lower(ps.buyer_address), lower(ps.seller_address), ps.render_id, NULL, ps.serial_number::int
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
           lower(pp.buyer_address), NULL, pp.pack_dist_id, pp.collection_id, NULL
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
  ), lead_ranked AS (
    SELECT l.*, row_number() OVER (PARTITION BY l.days ORDER BY l.spent DESC, l.b) rn FROM lead l
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
           CASE WHEN e.src = 'sales_market' THEN e.e_id END edition_id
      FROM (
        (SELECT * FROM _ww_ev WHERE t >= now() - interval '7 days' AND p >= 250 ORDER BY t DESC LIMIT 40)
        UNION
        (SELECT * FROM _ww_ev ORDER BY p DESC LIMIT 15)
      ) e
  ), move_rows AS (
    SELECT jsonb_build_object(
             'at', l.t, 'collection', l.coll, 'kind', l.kind, 'item', coalesce(l.lbl, CASE WHEN l.kind = 'pack' THEN 'Pack' END),
             'price_usd', round(l.p::numeric, 2), 'username', who.username, 'chain', who.chain,
             'wallet', CASE WHEN who.username IS NULL THEN l.b END, 'edition_id', l.edition_id) j,
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
              'collections', lr.colls, 'last_at', lr.last_at) ORDER BY lr.rn)
             FROM lead_ranked lr JOIN who ON who.wallet_key = lr.b WHERE lr.days = 7 AND lr.rn <= 25), '[]'::jsonb),
      '30d', coalesce((SELECT jsonb_agg(jsonb_build_object(
              'rank', lr.rn, 'username', who.username, 'chain', who.chain,
              'wallet', CASE WHEN who.username IS NULL THEN lr.b END,
              'buys', lr.buys, 'pack_buys', lr.pack_buys, 'spent_usd', lr.spent, 'biggest_usd', lr.biggest,
              'collections', lr.colls, 'last_at', lr.last_at) ORDER BY lr.rn)
             FROM lead_ranked lr JOIN who ON who.wallet_key = lr.b WHERE lr.days = 30 AND lr.rn <= 25), '[]'::jsonb)
    ),
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
REVOKE EXECUTE ON FUNCTION public.refresh_whale_watch_board() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_whale_watch_board() TO postgres, service_role;

INSERT INTO public.pipeline_cadence_watchlist (pipeline, max_silent_minutes, max_minutes_without_success, severity, notes)
VALUES ('whale_watch_board', 180, 360, 'info',
        'pg_cron rpc-whale-watch-board (hourly at :27). refresh_whale_watch_board() — the precomputed snapshot /insights/whale-watch reads. Logs only on success. audit_20261127.')
ON CONFLICT (pipeline) DO NOTHING;

-- click_attribution_rechecks_a_buyer_filled_in_after_the_match
-- anon-exec: unchanged (attribute_outbound_clicks) — CREATE OR REPLACE of an existing fn, same signature; ACL preserved (postgres, service_role only), verified before applying.
--
-- 2026-10-03 (Trevor: "are you tracking and able to pick up the buys I have made that came via
-- telegram notifications I set that I clicked through on?").
--
-- The clicks WERE tracked (/go/a/<delivery> → outbound_clicks, 6 Telegram click-throughs since
-- 10-01) and matched to their sales, but each match was written ONCE (NOT EXISTS + ON CONFLICT
-- DO NOTHING) at the moment it was found. On-chain Top Shot sales land with buyer_address NULL
-- and the buyer is filled in afterwards (81 of 2,232 in the last 24 h were still NULL), so a
-- match made in that gap recorded buyer_is_clicker = false — "not the clicker", read off an
-- UNKNOWN — and never looked again. Trevor's two 10-01 alert buys (Greg Brown III #2282 $0.26,
-- Jarrett Jack #8982 $0.41) sat at "likely" while `sales` named his own wallet as the buyer.
-- All 3 NULL-buyer rows in the table had a known buyer by 10-03.
--
-- FIX: a re-check step inside the same guarded block. Every attribution row still carrying a
-- NULL buyer (clicked within 14 days) is re-read from its sale; once the buyer is known it is
-- written, buyer_is_clicker recomputed with the SAME wallet rule (click wallet + the user's
-- saved wallets; hex case-insensitive), and a clicker's purchase upgraded to confirmed. A buyer
-- who is someone else keeps the click-time confidence. Reported as `buyer_rechecked`.
--
-- Base verified: live prosrc md5 2b1bfbeded52dd2c63b7f1b9ad85d0e0 == the 20261001033000 body.
-- Pin: supabase/tests/attribute_outbound_clicks.sql (claims 9-10 added).
--
-- REVERT: re-apply the function body from
--   supabase/migrations/20261001033000_audit_20260930_rpc_clicks_are_attributed_to_the_marketplace_sales_that_follow_them.sql
-- (rows already upgraded stay correct — their buyer is read from `sales`).

CREATE OR REPLACE FUNCTION public.attribute_outbound_clicks(p_lookback_hours integer DEFAULT 72)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_started timestamptz := clock_timestamp();
  v_scanned int := 0;
  v_written int := 0;
  v_rechecked int := 0;
  v_err text;
BEGIN
  BEGIN
    DROP TABLE IF EXISTS _ac_clicks;
    CREATE TEMP TABLE _ac_clicks ON COMMIT DROP AS
    SELECT c.id, c.created_at, c.moment_id, c.edition_key, c.ask_price_usd, c.wallet_address, c.user_id,
           -- the click's collection: what the writer said, else read off the destination's host
           COALESCE(
             CASE replace(lower(c.collection_slug), '-', '_')
               WHEN 'pinnacle' THEN 'disney_pinnacle' WHEN 'topshot' THEN 'nba_top_shot'
               WHEN 'allday' THEN 'nfl_all_day' WHEN 'golazos' THEN 'laliga_golazos'
               WHEN 'panini' THEN 'panini_blockchain' WHEN 'ufc' THEN 'ufc_strike'
               ELSE replace(lower(c.collection_slug), '-', '_') END,
             CASE
               WHEN coalesce(c.buy_url, c.destination) ~* 'nbatopshot\.com|dapper\.market/nba' THEN 'nba_top_shot'
               WHEN coalesce(c.buy_url, c.destination) ~* 'nflallday\.com|dapper\.market/nfl' THEN 'nfl_all_day'
               WHEN coalesce(c.buy_url, c.destination) ~* 'laligagolazos\.com' THEN 'laliga_golazos'
               WHEN coalesce(c.buy_url, c.destination) ~* 'disneypinnacle\.com' THEN 'disney_pinnacle'
               WHEN coalesce(c.buy_url, c.destination) ~* 'ufcstrike\.com' THEN 'ufc_strike'
             END) AS coll
      FROM public.outbound_clicks c
     WHERE c.created_at > now() - make_interval(hours => GREATEST(p_lookback_hours, 1))
       AND NOT COALESCE(c.bot_ua, false)
       AND (c.moment_id IS NOT NULL OR c.edition_key IS NOT NULL)
       AND NOT EXISTS (SELECT 1 FROM public.click_attributed_purchases a WHERE a.click_id = c.id);
    GET DIAGNOSTICS v_scanned = ROW_COUNT;

    WITH k AS (
      SELECT ck.*, col.id AS coll_id
        FROM _ac_clicks ck
        JOIN public.collections col ON col.slug = ck.coll
    ), m AS (
      -- first sale of the EXACT moment within 48 h, from whichever table carries that collection
      SELECT k.id AS click_id, k.created_at, k.coll, k.ask_price_usd, k.wallet_address, k.user_id,
             'same_moment'::text AS match, s.*
        FROM k
        CROSS JOIN LATERAL (
          SELECT * FROM (
            SELECT 'sales'::text AS sale_source, sa.id::text AS sale_ref, sa.nft_id::text AS nft_id, sa.sold_at,
                   sa.price_usd, sa.buyer_address::text AS buyer_address
              FROM public.sales sa
             WHERE k.coll NOT IN ('disney_pinnacle', 'panini_blockchain')
               AND sa.collection_id = k.coll_id AND sa.nft_id = k.moment_id
               AND sa.sold_at > k.created_at AND sa.sold_at <= k.created_at + interval '48 hours'
            UNION ALL
            SELECT 'pinnacle_sales', ps.id, ps.nft_id, ps.sold_at, ps.sale_price_usd, ps.buyer_address
              FROM public.pinnacle_sales ps
             WHERE k.coll = 'disney_pinnacle' AND ps.nft_id = k.moment_id
               AND ps.sold_at > k.created_at AND ps.sold_at <= k.created_at + interval '48 hours'
            UNION ALL
            SELECT 'panini_sales', pn.sku || '@' || pn.sold_at::text, pn.sku, pn.sold_at, pn.amount_usd, pn.buyer
              FROM public.panini_sales pn
             WHERE k.coll = 'panini_blockchain' AND pn.sku = k.moment_id
               AND pn.sold_at > k.created_at AND pn.sold_at <= k.created_at + interval '48 hours'
          ) u ORDER BY u.sold_at LIMIT 1
        ) s
       WHERE k.moment_id IS NOT NULL
    ), e AS (
      -- edition-level clicks (no moment id): the clicked edition sold within 2 h at <= ask x 1.02
      SELECT k.id AS click_id, k.created_at, k.coll, k.ask_price_usd, k.wallet_address, k.user_id,
             'same_edition'::text AS match, s.*
        FROM k
        CROSS JOIN LATERAL (
          SELECT * FROM (
            SELECT 'sales'::text AS sale_source, sa.id::text AS sale_ref, sa.nft_id::text AS nft_id, sa.sold_at,
                   sa.price_usd, sa.buyer_address::text AS buyer_address
              FROM public.editions ed
              JOIN public.sales sa ON sa.edition_id = ed.id
             WHERE k.coll NOT IN ('disney_pinnacle', 'panini_blockchain')
               AND ed.collection_id = k.coll_id AND ed.external_id = k.edition_key
               AND sa.sold_at > k.created_at AND sa.sold_at <= k.created_at + interval '2 hours'
               AND (k.ask_price_usd IS NULL OR sa.price_usd <= k.ask_price_usd * 1.02)
            UNION ALL
            SELECT 'pinnacle_sales', ps.id, ps.nft_id, ps.sold_at, ps.sale_price_usd, ps.buyer_address
              FROM public.pinnacle_sales ps
             WHERE k.coll = 'disney_pinnacle' AND ps.render_id = k.edition_key
               AND ps.sold_at > k.created_at AND ps.sold_at <= k.created_at + interval '2 hours'
               AND (k.ask_price_usd IS NULL OR ps.sale_price_usd <= k.ask_price_usd * 1.02)
            UNION ALL
            SELECT 'panini_sales', pn.sku || '@' || pn.sold_at::text, pn.sku, pn.sold_at, pn.amount_usd, pn.buyer
              FROM public.panini_sales pn
             WHERE k.coll = 'panini_blockchain' AND pn.edition_external_id = k.edition_key
               AND pn.sold_at > k.created_at AND pn.sold_at <= k.created_at + interval '2 hours'
               AND (k.ask_price_usd IS NULL OR pn.amount_usd <= k.ask_price_usd * 1.02)
          ) u ORDER BY u.sold_at LIMIT 1
        ) s
       WHERE k.moment_id IS NULL AND k.edition_key IS NOT NULL
    ), hits AS (
      SELECT h.*,
             -- the clicker's wallets: the one on the click, plus every wallet the user saved.
             -- Hex (Flow/EVM) compares case-insensitively; anything else (Solana base58) exactly.
             EXISTS (
               SELECT 1 FROM (
                 SELECT h.wallet_address AS w
                 UNION ALL
                 SELECT sw.wallet_addr FROM public.saved_wallets sw WHERE h.user_id IS NOT NULL AND sw.user_id = h.user_id
               ) ws
               WHERE ws.w IS NOT NULL AND h.buyer_address IS NOT NULL
                 AND CASE WHEN h.buyer_address ~* '^0x' THEN lower(ws.w) = lower(h.buyer_address)
                          ELSE ws.w = h.buyer_address END
             ) AS buyer_is_clicker
        FROM (SELECT * FROM m UNION ALL SELECT * FROM e) h
    ), ins AS (
      INSERT INTO public.click_attributed_purchases
        (click_id, clicked_at, collection_slug, sale_source, sale_ref, nft_id, sold_at, price_usd, buyer_address,
         match, confidence, buyer_is_clicker, minutes_after_click)
      SELECT h.click_id, h.created_at, h.coll, h.sale_source, h.sale_ref, h.nft_id, h.sold_at, h.price_usd, h.buyer_address,
             h.match,
             CASE WHEN h.buyer_is_clicker THEN 'confirmed'
                  WHEN h.match = 'same_moment' AND h.sold_at <= h.created_at + interval '2 hours'
                       AND (h.ask_price_usd IS NULL OR h.price_usd IS NULL OR h.price_usd <= h.ask_price_usd * 1.05) THEN 'likely'
                  ELSE 'possible' END,
             h.buyer_is_clicker,
             floor(extract(epoch FROM h.sold_at - h.created_at) / 60)::int
        FROM hits h
      ON CONFLICT (click_id) DO NOTHING
      RETURNING 1
    )
    SELECT count(*) INTO v_written FROM ins;

    -- RE-CHECK (2026-10-03). An on-chain sale lands with buyer_address NULL and the buyer is
    -- filled in later, so a row attributed in that gap was stamped buyer_is_clicker=false for
    -- good -- a "not the clicker" read off an UNKNOWN (Trevor's two 10-01 alert buys sat at
    -- "likely" with his own wallet as the buyer). Every row still carrying a NULL buyer is
    -- re-read from its sale for 14 days: the buyer is filled in, buyer_is_clicker recomputed
    -- with the same wallet rule as above, and a clicker's purchase upgraded to confirmed.
    -- A buyer who is NOT the clicker leaves the confidence as the click-time rules set it.
    WITH known AS (
      SELECT a.click_id, sb.buyer_address
        FROM public.click_attributed_purchases a
        CROSS JOIN LATERAL (
          -- (id, sold_at) is the partitioned table's primary key: an index probe with pruning.
          -- The CASE keeps a non-uuid ref from another source from ever reaching the cast.
          SELECT sa.buyer_address::text AS buyer_address FROM public.sales sa
           WHERE a.sale_source = 'sales'
             AND sa.id = (CASE WHEN a.sale_source = 'sales' THEN a.sale_ref END)::uuid
             AND sa.sold_at = a.sold_at
          UNION ALL
          SELECT ps.buyer_address::text FROM public.pinnacle_sales ps
           WHERE a.sale_source = 'pinnacle_sales' AND ps.id = a.sale_ref
          UNION ALL
          SELECT pn.buyer::text FROM public.panini_sales pn
           WHERE a.sale_source = 'panini_sales' AND pn.sku || '@' || pn.sold_at::text = a.sale_ref
        ) sb
       WHERE a.buyer_address IS NULL
         AND a.clicked_at > now() - interval '14 days'
         AND sb.buyer_address IS NOT NULL
    ), judged AS (
      SELECT k.click_id, k.buyer_address,
             EXISTS (
               SELECT 1 FROM (
                 SELECT oc.wallet_address AS w
                 UNION ALL
                 SELECT sw.wallet_addr FROM public.saved_wallets sw WHERE oc.user_id IS NOT NULL AND sw.user_id = oc.user_id
               ) ws
               WHERE ws.w IS NOT NULL
                 AND CASE WHEN k.buyer_address ~* '^0x' THEN lower(ws.w) = lower(k.buyer_address)
                          ELSE ws.w = k.buyer_address END
             ) AS is_clicker
        FROM known k
        JOIN public.outbound_clicks oc ON oc.id = k.click_id
    ), upd AS (
      UPDATE public.click_attributed_purchases a
         SET buyer_address = j.buyer_address,
             buyer_is_clicker = j.is_clicker,
             confidence = CASE WHEN j.is_clicker THEN 'confirmed' ELSE a.confidence END
        FROM judged j
       WHERE a.click_id = j.click_id
      RETURNING 1
    )
    SELECT count(*) INTO v_rechecked FROM upd;
  EXCEPTION WHEN query_canceled OR OTHERS THEN
    v_err := left(SQLERRM, 300);
  END;
  -- ok is derived from whether the work ran; rows_written counts rows actually inserted.
  PERFORM public.log_pipeline_run('attribute-outbound-clicks', v_started, v_scanned, v_written, 0, v_err IS NULL, v_err,
    NULL, NULL, NULL,
    jsonb_build_object('clicks_scanned', v_scanned, 'attributed', v_written, 'buyer_rechecked', v_rechecked,
                       'lookback_hours', p_lookback_hours,
                       'via', 'pg_cron', 'duration_ms', (extract(epoch FROM clock_timestamp() - v_started) * 1000)::int));
  RETURN jsonb_build_object('clicks_scanned', v_scanned, 'attributed', v_written, 'buyer_rechecked', v_rechecked, 'error', v_err);
END
$function$;

DO $$
BEGIN
  IF has_function_privilege('anon', 'public.attribute_outbound_clicks(integer)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.attribute_outbound_clicks(integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'attribute_outbound_clicks must not be executable by anon/authenticated';
  END IF;
END
$$;

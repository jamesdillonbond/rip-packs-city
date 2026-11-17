-- 2026-09-25 (PT) — the wallet transaction history had no PACK SELLS at all,
-- and missed the marketplace pack buys the on-chain table never saw.
--
-- WHY. /dashboard/history says "Every pack and moment that moved through your
-- saved wallets", but get_wallet_transaction_history unions pack_buy (on-chain
-- pack_purchases, buyer = wallet), pack_open, moment_buy/pull/sell — nothing
-- for a pack the wallet SOLD. The pack-history page (get_wallet_pack_history)
-- already reads both the on-chain seller rows and the Dapper marketplace index
-- (topshot_/allday_pack_sales_history, storefront_address = the SELLING
-- wallet): Trevor's wallet has 396 Top Shot + 106 All Day marketplace pack
-- sells ($28k of proceeds on the packs page) and only 42 moment sells, so his
-- SELLS tab showed 42 rows and none of the packs. 40 of his marketplace pack
-- BUYS are likewise absent from pack_purchases.
--
-- WHAT. Guarded splice on the live body (no committed definition existed):
-- four arms after pack_open — pack_sell from pack_purchases (seller = wallet),
-- pack_sell from each marketplace index (storefront = wallet, purchased) when
-- the on-chain table has no sale of that pack by this wallet, and pack_buy from
-- each marketplace index (buyer = wallet) when the on-chain table has no buy of
-- that pack by this wallet — so a sale the worker DID ingest is never listed
-- twice. Marketplace rows carry method 'marketplace' and currency 'USD'.
-- pack_sell rides the existing `sells` and `packs` filters and joins the same
-- pack title/image CASEs as pack_buy/pack_open; total_count is unchanged in shape. Header (STABLE,
-- SECURITY DEFINER, search_path=public, statement_timeout=20s) and ACL
-- (postgres, service_role) preserved. Revert: remove the four arms by the same
-- anchor.

-- anon-exec: intentional — get_wallet_transaction_history is called by /api/wallet/transaction-history with the service client behind the saved-wallet ownership check (ACL unchanged by CREATE OR REPLACE: postgres, service_role).
DO $$
DECLARE
  v_src text;
  v_new text;
  v_old constant text := E'    FROM public.pack_rips pr\n    WHERE v_pack_open AND pr.opener_address = v_wallet\n    UNION ALL\n    SELECT ''moment_buy''';
  v_rep constant text := E'    FROM public.pack_rips pr\n    WHERE v_pack_open AND pr.opener_address = v_wallet\n    UNION ALL\n'
    || E'    -- 2026-09-25: packs the wallet SOLD — on-chain first, then the Dapper\n'
    || E'    -- marketplace index for sales the worker never ingested (never both).\n'
    || E'    SELECT ''pack_sell'', pp.sealed_at, pp.collection_id,\n'
    || E'           NULL::text, pp.pack_nft_id, pp.pack_dist_id,\n'
    || E'           pp.sale_price, pp.sale_currency, pp.buyer_address, NULL::uuid,\n'
    || E'           NULL::int, pp.event_kind, NULL::int\n'
    || E'    FROM public.pack_purchases pp\n'
    || E'    WHERE v_sells AND pp.seller_address = v_wallet\n'
    || E'    UNION ALL\n'
    || E'    SELECT ''pack_sell'', h.block_time, ''95f28a17-224a-4025-96ad-adf8a4c63bfd''::uuid,\n'
    || E'           NULL::text, h.pack_nft_id, h.dist_id,\n'
    || E'           h.sale_price_usd, ''USD'', h.buyer_address, NULL::uuid,\n'
    || E'           NULL::int, ''marketplace'', NULL::int\n'
    || E'    FROM public.topshot_pack_sales_history h\n'
    || E'    WHERE v_sells AND h.storefront_address = v_wallet AND h.purchased\n'
    || E'      AND NOT EXISTS (SELECT 1 FROM public.pack_purchases q\n'
    || E'                       WHERE q.pack_nft_id = h.pack_nft_id AND q.seller_address = v_wallet)\n'
    || E'    UNION ALL\n'
    || E'    SELECT ''pack_sell'', h.block_time, ''dee28451-5d62-409e-a1ad-a83f763ac070''::uuid,\n'
    || E'           NULL::text, h.pack_nft_id, h.dist_id,\n'
    || E'           h.sale_price_usd, ''USD'', h.buyer_address, NULL::uuid,\n'
    || E'           NULL::int, ''marketplace'', NULL::int\n'
    || E'    FROM public.allday_pack_sales_history h\n'
    || E'    WHERE v_sells AND h.storefront_address = v_wallet AND h.purchased\n'
    || E'      AND NOT EXISTS (SELECT 1 FROM public.pack_purchases q\n'
    || E'                       WHERE q.pack_nft_id = h.pack_nft_id AND q.seller_address = v_wallet)\n'
    || E'    UNION ALL\n'
    || E'    -- marketplace pack BUYS the on-chain table missed.\n'
    || E'    SELECT ''pack_buy'', h.block_time, ''95f28a17-224a-4025-96ad-adf8a4c63bfd''::uuid,\n'
    || E'           NULL::text, h.pack_nft_id, h.dist_id,\n'
    || E'           h.sale_price_usd, ''USD'', h.storefront_address, NULL::uuid,\n'
    || E'           NULL::int, ''marketplace'', NULL::int\n'
    || E'    FROM public.topshot_pack_sales_history h\n'
    || E'    WHERE v_pack_buy AND h.buyer_address = v_wallet AND h.purchased\n'
    || E'      AND NOT EXISTS (SELECT 1 FROM public.pack_purchases q\n'
    || E'                       WHERE q.pack_nft_id = h.pack_nft_id AND q.buyer_address = v_wallet)\n'
    || E'    UNION ALL\n'
    || E'    SELECT ''pack_buy'', h.block_time, ''dee28451-5d62-409e-a1ad-a83f763ac070''::uuid,\n'
    || E'           NULL::text, h.pack_nft_id, h.dist_id,\n'
    || E'           h.sale_price_usd, ''USD'', h.storefront_address, NULL::uuid,\n'
    || E'           NULL::int, ''marketplace'', NULL::int\n'
    || E'    FROM public.allday_pack_sales_history h\n'
    || E'    WHERE v_pack_buy AND h.buyer_address = v_wallet AND h.purchased\n'
    || E'      AND NOT EXISTS (SELECT 1 FROM public.pack_purchases q\n'
    || E'                       WHERE q.pack_nft_id = h.pack_nft_id AND q.buyer_address = v_wallet)\n'
    || E'    UNION ALL\n'
    || E'    SELECT ''moment_buy''';
  v_n int;
BEGIN
  SELECT p.prosrc INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'get_wallet_transaction_history'
     AND pg_get_function_identity_arguments(p.oid) = 'p_wallet text, p_limit integer, p_offset integer, p_kind text';
  IF v_src IS NULL THEN RAISE EXCEPTION 'get_wallet_transaction_history(text,int,int,text) not found'; END IF;
  IF position('''pack_sell''' IN v_src) > 0 THEN
    RAISE NOTICE 'pack_sell arm already present — no-op';
    RETURN;
  END IF;
  v_n := (length(v_src) - length(replace(v_src, v_old, ''))) / length(v_old);
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'get_wallet_transaction_history: expected the pack_open→moment_buy anchor exactly once, found %', v_n;
  END IF;
  v_new := replace(v_src, v_old, v_rep);
  -- pack_sell rows take the pack title / image like the other pack kinds (three CASEs).
  v_n := (length(v_new) - length(replace(v_new, 'kind IN (''pack_buy'',''pack_open'')', ''))) / length('kind IN (''pack_buy'',''pack_open'')');
  IF v_n <> 3 THEN
    RAISE EXCEPTION 'get_wallet_transaction_history: expected the pack-kind CASE list exactly three times, found %', v_n;
  END IF;
  v_new := replace(v_new, 'kind IN (''pack_buy'',''pack_open'')', 'kind IN (''pack_buy'',''pack_open'',''pack_sell'')');
  EXECUTE format(
    'CREATE OR REPLACE FUNCTION public.get_wallet_transaction_history(p_wallet text, p_limit integer DEFAULT 50, p_offset integer DEFAULT 0, p_kind text DEFAULT NULL::text) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO ''public'' SET statement_timeout TO ''20s'' AS %L',
    v_new);
END $$;

-- Post-conditions: the arm landed; a wallet with marketplace pack sells sees
-- pack_sell rows under kind=sells and none twice; a wallet with none is
-- unchanged (no-change control on the moment_sell count).
DO $$
DECLARE v_src text; v_w text; v_res jsonb; v_pack_sells int; v_dupes int;
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc WHERE proname = 'get_wallet_transaction_history' AND pronamespace = 'public'::regnamespace;
  IF position('''pack_sell''' IN v_src) = 0 THEN RAISE EXCEPTION 'pack_sell arm missing after splice'; END IF;

  SELECT storefront_address INTO v_w FROM public.topshot_pack_sales_history
   WHERE purchased GROUP BY storefront_address ORDER BY count(*) DESC LIMIT 1;
  IF v_w IS NOT NULL THEN
    v_res := public.get_wallet_transaction_history(v_w, 200, 0, 'sells');
    SELECT count(*) INTO v_pack_sells FROM jsonb_array_elements(v_res->'events') e WHERE e->>'kind' = 'pack_sell';
    IF v_pack_sells = 0 THEN RAISE EXCEPTION 'top storefront wallet % reports no pack_sell rows', v_w; END IF;
    SELECT count(*) - count(DISTINCT (e->>'pack_nft_id') || '|' || (e->>'occurred_at')) INTO v_dupes
      FROM jsonb_array_elements(v_res->'events') e WHERE e->>'kind' = 'pack_sell';
    IF v_dupes <> 0 THEN RAISE EXCEPTION '% duplicated pack_sell rows for %', v_dupes, v_w; END IF;
  END IF;
END $$;

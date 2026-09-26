-- 2026-09-25 (PT) — the wallet transaction history now lists Golazos and
-- Disney Pinnacle pack OPENS, and Golazos marketplace pack BUYS/SELLS.
--
-- WHY. /dashboard/history promises "Every pack and moment that moved through
-- your saved wallets", but get_wallet_transaction_history reads pack opens only
-- from pack_rips, which holds NO Golazos or Pinnacle rows (0 of each). Their
-- opens live in golazos_pack_opens (78,825 rows) and pinnacle_pack_opens
-- (89,089), and Golazos marketplace sales in golazos_pack_sales_history — none
-- of which the history read. Trevor's wallet: 14 Golazos opens and 7 Golazos
-- marketplace pack buys, all absent.
--
-- WHAT. Guarded splice after the All Day marketplace pack_buy arm (the anchor
-- must match exactly once or the migration RAISEs): four arms in the same
-- column order as the existing ones — pack_open from golazos_pack_opens and
-- from pinnacle_pack_opens (no dedupe needed: pack_rips holds neither), and
-- pack_sell / pack_buy from golazos_pack_sales_history with the same
-- NOT EXISTS (pack_purchases) guard the Top Shot / All Day arms use, so an
-- ingested sale is never listed twice. Titles/images join pack_distributions
-- as for every pack row (Pinnacle has no pack art anywhere public — its rows
-- carry a title and the placeholder). Header preserved from pg_proc (STABLE,
-- SECURITY DEFINER, search_path=public, statement_timeout=20s); ACL unchanged.
-- Plus an index for the Pinnacle arm's opener lookup (34 MB table; Golazos
-- already has idx_golazos_pack_opens_opener).
--
-- Revert: remove the four arms by the same anchor (the replacement text is
-- the anchor with the arms inserted before its trailing UNION ALL);
-- DROP INDEX public.idx_pinnacle_pack_opens_opener.

CREATE INDEX IF NOT EXISTS idx_pinnacle_pack_opens_opener
  ON public.pinnacle_pack_opens (opener_address, opened_at DESC);

-- anon-exec: unchanged (get_wallet_transaction_history) — CREATE OR REPLACE of an existing fn; ACL preserved, has_function_privilege anon=false, authenticated=false (read 2026-09-25).
DO $$
DECLARE
  v_src text;
  v_new text;
  v_n   int;
  v_w   text;
  v_before_t int; v_before_p int; v_after int; v_expect int;
  v_old constant text := E'    FROM public.allday_pack_sales_history h\n    WHERE v_pack_buy AND h.buyer_address = v_wallet AND h.purchased\n      AND NOT EXISTS (SELECT 1 FROM public.pack_purchases q\n                       WHERE q.pack_nft_id = h.pack_nft_id AND q.buyer_address = v_wallet)\n    UNION ALL\n    SELECT ''moment_buy''';
  v_rep constant text := E'    FROM public.allday_pack_sales_history h\n    WHERE v_pack_buy AND h.buyer_address = v_wallet AND h.purchased\n      AND NOT EXISTS (SELECT 1 FROM public.pack_purchases q\n                       WHERE q.pack_nft_id = h.pack_nft_id AND q.buyer_address = v_wallet)\n    UNION ALL\n'
    || E'    -- 2026-09-25: Golazos + Pinnacle opens live in their own tables\n'
    || E'    -- (pack_rips holds neither), and Golazos marketplace sales too.\n'
    || E'    SELECT ''pack_open'', go.opened_at, ''06248cc4-b85f-47cd-af67-1855d14acd75''::uuid,\n'
    || E'           NULL::text, go.pack_nft_id, go.dist_id,\n'
    || E'           go.pull_value_usd, NULL::text, NULL::text, NULL::uuid,\n'
    || E'           NULL::int, NULL::text, go.moments_pulled\n'
    || E'    FROM public.golazos_pack_opens go\n'
    || E'    WHERE v_pack_open AND go.opener_address = v_wallet\n'
    || E'    UNION ALL\n'
    || E'    SELECT ''pack_open'', po.opened_at, ''7dd9dd11-e8b6-45c4-ac99-71331f959714''::uuid,\n'
    || E'           NULL::text, po.pack_nft_id, po.dist_id,\n'
    || E'           po.pull_value_usd, NULL::text, NULL::text, NULL::uuid,\n'
    || E'           NULL::int, NULL::text, po.moments_pulled\n'
    || E'    FROM public.pinnacle_pack_opens po\n'
    || E'    WHERE v_pack_open AND po.opener_address = v_wallet\n'
    || E'    UNION ALL\n'
    || E'    SELECT ''pack_sell'', h.block_time, ''06248cc4-b85f-47cd-af67-1855d14acd75''::uuid,\n'
    || E'           NULL::text, h.pack_nft_id, h.dist_id,\n'
    || E'           h.sale_price_usd, ''USD'', h.buyer_address, NULL::uuid,\n'
    || E'           NULL::int, ''marketplace'', NULL::int\n'
    || E'    FROM public.golazos_pack_sales_history h\n'
    || E'    WHERE v_sells AND h.storefront_address = v_wallet AND h.purchased\n'
    || E'      AND NOT EXISTS (SELECT 1 FROM public.pack_purchases q\n'
    || E'                       WHERE q.pack_nft_id = h.pack_nft_id AND q.seller_address = v_wallet)\n'
    || E'    UNION ALL\n'
    || E'    SELECT ''pack_buy'', h.block_time, ''06248cc4-b85f-47cd-af67-1855d14acd75''::uuid,\n'
    || E'           NULL::text, h.pack_nft_id, h.dist_id,\n'
    || E'           h.sale_price_usd, ''USD'', h.storefront_address, NULL::uuid,\n'
    || E'           NULL::int, ''marketplace'', NULL::int\n'
    || E'    FROM public.golazos_pack_sales_history h\n'
    || E'    WHERE v_pack_buy AND h.buyer_address = v_wallet AND h.purchased\n'
    || E'      AND NOT EXISTS (SELECT 1 FROM public.pack_purchases q\n'
    || E'                       WHERE q.pack_nft_id = h.pack_nft_id AND q.buyer_address = v_wallet)\n'
    || E'    UNION ALL\n'
    || E'    SELECT ''moment_buy''';
BEGIN
  SELECT p.prosrc INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'get_wallet_transaction_history'
     AND pg_get_function_identity_arguments(p.oid) = 'p_wallet text, p_limit integer, p_offset integer, p_kind text';
  IF v_src IS NULL THEN RAISE EXCEPTION 'get_wallet_transaction_history not found'; END IF;
  v_n := (length(v_src) - length(replace(v_src, v_old, ''))) / length(v_old);
  IF v_n <> 1 THEN RAISE EXCEPTION 'get_wallet_transaction_history: anchor expected once, found %', v_n; END IF;
  v_new := replace(v_src, v_old, v_rep);

  -- Before-counts (the function as it was): Trevor, and the busiest Pinnacle
  -- opener with a small history.
  SELECT opener_address INTO v_w FROM public.pinnacle_pack_opens
   GROUP BY opener_address HAVING count(*) BETWEEN 3 AND 50 ORDER BY count(*) DESC LIMIT 1;
  v_before_t := (public.get_wallet_transaction_history('0xbd94cade097e50ac', 1, 0, 'all')->>'total_count')::int;
  IF v_w IS NOT NULL THEN
    v_before_p := (public.get_wallet_transaction_history(v_w, 1, 0, 'all')->>'total_count')::int;
  END IF;

  EXECUTE format(
    'CREATE OR REPLACE FUNCTION public.get_wallet_transaction_history(p_wallet text, p_limit integer DEFAULT 50, p_offset integer DEFAULT 0, p_kind text DEFAULT NULL::text) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO ''public'' SET statement_timeout TO ''20s'' AS %L',
    v_new);

  -- The delta must be EXACTLY what the four new sources hold for that wallet —
  -- which also proves no existing arm changed (no-change control).
  v_after := (public.get_wallet_transaction_history('0xbd94cade097e50ac', 1, 0, 'all')->>'total_count')::int;
  SELECT (SELECT count(*) FROM public.golazos_pack_opens WHERE opener_address = '0xbd94cade097e50ac')
       + (SELECT count(*) FROM public.pinnacle_pack_opens WHERE opener_address = '0xbd94cade097e50ac')
       + (SELECT count(*) FROM public.golazos_pack_sales_history h WHERE h.storefront_address = '0xbd94cade097e50ac' AND h.purchased
            AND NOT EXISTS (SELECT 1 FROM public.pack_purchases q WHERE q.pack_nft_id = h.pack_nft_id AND q.seller_address = '0xbd94cade097e50ac'))
       + (SELECT count(*) FROM public.golazos_pack_sales_history h WHERE h.buyer_address = '0xbd94cade097e50ac' AND h.purchased
            AND NOT EXISTS (SELECT 1 FROM public.pack_purchases q WHERE q.pack_nft_id = h.pack_nft_id AND q.buyer_address = '0xbd94cade097e50ac'))
    INTO v_expect;
  IF v_expect < 21 THEN RAISE EXCEPTION 'expected Trevor to have >= 21 Golazos pack events, found %', v_expect; END IF;
  IF v_after - v_before_t <> v_expect THEN
    RAISE EXCEPTION 'Trevor history grew by %, expected exactly %', v_after - v_before_t, v_expect;
  END IF;
  IF v_w IS NOT NULL THEN
    v_after := (public.get_wallet_transaction_history(v_w, 1, 0, 'all')->>'total_count')::int;
    SELECT count(*) INTO v_expect FROM public.pinnacle_pack_opens WHERE opener_address = v_w;
    IF v_after - v_before_p <> v_expect THEN
      RAISE EXCEPTION 'Pinnacle opener % history grew by %, expected exactly %', v_w, v_after - v_before_p, v_expect;
    END IF;
  END IF;
END $$;

-- Post-condition: the ACL did not move.
DO $$
BEGIN
  IF has_function_privilege('anon', 'public.get_wallet_transaction_history(text,integer,integer,text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.get_wallet_transaction_history(text,integer,integer,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'get_wallet_transaction_history ACL widened';
  END IF;
END $$;

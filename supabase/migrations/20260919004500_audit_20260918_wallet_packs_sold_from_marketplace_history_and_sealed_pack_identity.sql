-- audit_20260918_wallet_packs_sold_from_marketplace_history_and_sealed_pack_identity
--
-- WHAT IS WRONG (Trevor, 2026-09-18: "my wallet shows 0 sold packs when I've
-- sold hundreds", and sealed Top Shot packs render as "Pack #394446" with no
-- thumbnail, no name and no market data).
--
-- 1. SOLD = 0 FOR EVERY WALLET ON THE PLATFORM, NOT JUST THIS ONE. Both wallet
--    pack RPCs derive "sold" from `pack_purchases.seller_address = wallet`, and
--    that column is populated by pack-events-ingest from the TRANSACTION PAYER,
--    which on Dapper's marketplace is the escrow account 0x18eb4ee6b3c026d2 on
--    every secondary sale. Measured 2026-09-18 over public.pack_purchases:
--      nba_top_shot secondary_sale  seller = escrow ........ 103,396
--      nba_top_shot secondary_sale  seller = a user wallet .. 2
--      nfl_all_day  secondary_sale  seller = escrow ........ 2,107
--    So `seller_address = <any user wallet>` matches 2 rows out of 105,505 and
--    the "Sold" tab is structurally empty. Meanwhile the marketplace history
--    tables the Atlas walker has been filling since June carry the SELLER as
--    `storefront_address` on every row, with `dist_id` on every row, back to
--    2023-09 (TS) / 2022-12 (AD), and nothing in the wallet path reads them:
--      topshot_pack_sales_history: 591,919 rows, 6,374 distinct sellers
--      allday_pack_sales_history:  552,519 rows, 4,876 distinct sellers
--    For 0xbd94cade097e50ac they hold 396 TS sales ($26,252) + 106 AD ($2,038),
--    and 71 + 81 BUYS back to 2023-12 that pack_purchases (coverage starts
--    2026-04, packs.md) cannot see. 5 of the packs the RPC labels HELD were
--    sold by this wallet per that table -- a HELD row that is a false claim.
--
-- 2. FABRICATED ZEROS. get_wallet_pack_history emitted
--    `ROUND(COALESCE(buy_price, 0))`, `COALESCE(sell_price, 0)`,
--    `COALESCE(pull_value_usd, 0)` and a realized P&L built from those. Every
--    Top Shot primary drop has sale_price NULL on chain (240,585 of 240,585), so
--    every sealed drop pack rendered "BUY $0", and 453 of this wallet's 503 rips
--    rendered "PULL VALUE $0" -- the `?? 0` shape CLAUDE.md bans, one layer down.
--
-- 3. SEALED PACK IDENTITY. The row's name/image came ONLY from
--    pack_rips.dist_id, i.e. after the pack is opened. For a sealed pack the
--    distribution is also knowable from (a) pack_purchases.pack_dist_id (the
--    rip-propagation trigger fills it on 78% of primary rows), (b) the
--    wallet's own marketplace buy/sell row, (c) ANY marketplace row for that
--    pack_nft_id (a distribution is immutable per pack). For this wallet that
--    is 3 -> 9 of 95 sealed packs; the other 86 are unopened primary drops for
--    which NO source on this platform records the distribution (packs.md:
--    "who holds it but not what it is") -- those now say so instead of
--    pretending a name is a serial fragment.
--
-- WHAT THIS DOES.
--   * Five indexes on the two marketplace-history tables (seller, buyer, and
--     TS pack_nft_id). Built CONCURRENTLY via execute_sql on 2026-09-18 before
--     this file (all indisvalid=true); recorded here so they are not fileless.
--     Without them a seller lookup was a 21,489-buffer parallel seq scan (1.3 s).
--   * get_wallet_pack_history v4: buys and sells are a UNION of pack_purchases
--     and the two marketplace tables, deduped per (collection, pack) with the
--     on-chain row winning ties. Prices are NULL when unknown; primary drops
--     price at the distribution's retail_price_usd like the summary already
--     did; realized P&L is NULL unless both legs are known. Status is time-
--     aware (a pack sold and later bought back is HELD, not FLIPPED). Additive
--     keys: buy_usd, buy_price_source, sell_source, dist_source, lowest_ask_usd,
--     ask_checked_at, pack_ev_usd, last_sale_usd, last_sale_at,
--     dist_total_sealed, dist_total_opened, and a `coverage` object.
--   * get_wallet_pack_summary v3: same union for packs_purchased / packs_sold /
--     spent / proceeds / by_currency / by_collection. Every existing key keeps
--     its name and type. Additive: totals.buys_from_marketplace_history,
--     totals.sells_from_marketplace_history.
--
-- COST. All reads are wallet-keyed index probes (pack_purchases buyer/seller,
-- pack_rips opener, the five indexes above). The per-row market joins run on
-- the PAGE only (<= 200 rows): pack_ask_state by PK, mv_pack_ev_latest by its
-- (dist_id, collection_id) index, last sale via idx_pack_purchases_pack_dist_id.
--
-- ⚠ The markers below keep the function name ON THE SAME LINE as `anon-exec:` --
-- migration-new-function-states-its-anon-exec-decision matches per LINE.
-- anon-exec: intentional — CREATE OR REPLACE keeps the ACL of get_wallet_pack_history (service_role only; verified live 2026-09-18: anon false, authenticated false, service_role true)
-- anon-exec: intentional — CREATE OR REPLACE keeps the ACL of get_wallet_pack_summary (service_role only; verified live 2026-09-18: anon false, authenticated false, service_role true)
--
-- REVERT: re-apply the previous bodies from
--   supabase/migrations/20260912221500_audit_20260912_pack_summary_ripped_value_known_count.sql (summary)
--   and the v3 history body recorded in docs/reference/packs.md's revert note
--   for this change (history). The indexes can stay; they are read-only wins.
--   The UI reads every new key with a null-guard, so an old body degrades to
--   the previous rendering rather than erroring.

CREATE INDEX IF NOT EXISTS idx_ts_pack_sales_hist_pack
  ON public.topshot_pack_sales_history USING btree (pack_nft_id);
CREATE INDEX IF NOT EXISTS idx_ts_pack_sales_hist_seller
  ON public.topshot_pack_sales_history USING btree (storefront_address, block_time DESC) WHERE purchased;
CREATE INDEX IF NOT EXISTS idx_ts_pack_sales_hist_buyer
  ON public.topshot_pack_sales_history USING btree (buyer_address, block_time DESC) WHERE purchased;
CREATE INDEX IF NOT EXISTS idx_allday_pack_sales_hist_seller
  ON public.allday_pack_sales_history USING btree (storefront_address, block_time DESC) WHERE purchased;
CREATE INDEX IF NOT EXISTS idx_allday_pack_sales_hist_buyer
  ON public.allday_pack_sales_history USING btree (buyer_address, block_time DESC) WHERE purchased;

-- >>> BEGIN verbatim get_wallet_pack_history (pinned by supabase/tests/get_wallet_pack_history.sql) >>>
CREATE OR REPLACE FUNCTION public.get_wallet_pack_history(p_wallet text, p_collection_slug text DEFAULT NULL::text, p_status text DEFAULT NULL::text, p_limit integer DEFAULT 50, p_offset integer DEFAULT 0)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '20s'
AS $function$
DECLARE
  v_wallet text := lower(coalesce(p_wallet, ''));
  v_safe_limit  int := LEAST(GREATEST(COALESCE(p_limit, 50), 1), 200);
  v_safe_offset int := GREATEST(COALESCE(p_offset, 0), 0);
  v_ts uuid;
  v_ad uuid;
  v_total int;
  v_packs jsonb;
BEGIN
  IF v_wallet = '' THEN
    RETURN jsonb_build_object('error', 'wallet required');
  END IF;

  SELECT id INTO v_ts FROM public.collections WHERE slug = 'nba_top_shot';
  SELECT id INTO v_ad FROM public.collections WHERE slug = 'nfl_all_day';

  WITH buy_src AS (
    -- (1) on-chain, via pack-events-ingest: secondary ListingCompleted rows AND
    --     primary Withdraw/Mint rows (sale_price NULL on chain -> priced at retail below)
    SELECT pack_nft_id, collection_id, sale_price AS price, sale_currency AS currency,
           sealed_at AS at, seller_address AS counterparty, is_primary_drop, event_kind,
           pack_dist_id AS dist_id, 'onchain'::text AS src, 1 AS pri
    FROM public.pack_purchases WHERE buyer_address = v_wallet
    UNION ALL
    -- (2) Dapper marketplace history (Atlas walker). Buyer-side rows. USD.
    SELECT pack_nft_id, v_ts, sale_price_usd, 'USD', block_time, storefront_address, false,
           'secondary_sale', dist_id, 'marketplace', 2
    FROM public.topshot_pack_sales_history WHERE buyer_address = v_wallet AND purchased
    UNION ALL
    SELECT pack_nft_id, v_ad, sale_price_usd, 'USD', block_time, storefront_address, false,
           'secondary_sale', dist_id, 'marketplace', 2
    FROM public.allday_pack_sales_history WHERE buyer_address = v_wallet AND purchased
  ),
  -- One buy per pack. The same purchase is often in BOTH sources with DIFFERENT
  -- timestamps: the marketplace row carries the sale moment, the on-chain row
  -- the settlement, which lands later by a median 4 h and a p90 of 9 DAYS
  -- (31,995 matched Top Shot pairs, Jun-Aug 2026). So rows within 30 days of
  -- the pack's latest buy row are ONE purchase: price/counterparty come from
  -- its latest row (on-chain on a tie), bought_at is the EARLIEST of them --
  -- otherwise a quick flip whose on-chain settlement post-dates the resale
  -- reads as "bought back" and renders HELD.
  buy_ranked AS (
    SELECT b.*, MAX(at) OVER (PARTITION BY collection_id, pack_nft_id) AS max_at
    FROM buy_src b
  ),
  latest_buys AS (
    SELECT DISTINCT ON (collection_id, pack_nft_id)
           pack_nft_id, collection_id, price AS buy_price, currency AS buy_currency,
           MIN(at) FILTER (WHERE at >= max_at - interval '30 days')
             OVER (PARTITION BY collection_id, pack_nft_id) AS bought_at,
           counterparty AS bought_from, is_primary_drop AS bought_primary,
           event_kind AS bought_event_kind, src AS buy_src
    FROM buy_ranked
    ORDER BY collection_id, pack_nft_id, at DESC, pri
  ),
  buy_dist AS (
    SELECT collection_id, pack_nft_id, MAX(dist_id) AS dist_id
    FROM buy_src WHERE dist_id IS NOT NULL GROUP BY 1, 2
  ),
  sell_src AS (
    -- (1) on-chain rows whose seller IS this wallet. Structurally ~never true on
    --     Dapper (the payer is the escrow), kept so a real seller row still counts.
    SELECT pack_nft_id, collection_id, sale_price AS price, sale_currency AS currency,
           sealed_at AS at, buyer_address AS counterparty, pack_dist_id AS dist_id,
           'onchain'::text AS src, 1 AS pri
    FROM public.pack_purchases WHERE seller_address = v_wallet
    UNION ALL
    -- (2) marketplace history: storefront_address is the SELLING wallet.
    SELECT pack_nft_id, v_ts, sale_price_usd, 'USD', block_time, buyer_address, dist_id, 'marketplace', 2
    FROM public.topshot_pack_sales_history WHERE storefront_address = v_wallet AND purchased
    UNION ALL
    SELECT pack_nft_id, v_ad, sale_price_usd, 'USD', block_time, buyer_address, dist_id, 'marketplace', 2
    FROM public.allday_pack_sales_history WHERE storefront_address = v_wallet AND purchased
  ),
  latest_sells AS (
    SELECT DISTINCT ON (collection_id, pack_nft_id)
           pack_nft_id, collection_id, price AS sell_price, currency AS sell_currency,
           at AS sold_at, counterparty AS sold_to, src AS sell_src
    FROM sell_src
    ORDER BY collection_id, pack_nft_id, at DESC, pri
  ),
  sell_dist AS (
    SELECT collection_id, pack_nft_id, MAX(dist_id) AS dist_id
    FROM sell_src WHERE dist_id IS NOT NULL GROUP BY 1, 2
  ),
  wallet_rips AS (
    SELECT id, pack_nft_id, collection_id, sealed_at, moments_pulled, dist_id, pull_value_usd
    FROM public.pack_rips WHERE opener_address = v_wallet
  ),
  events AS (
    SELECT collection_id, pack_nft_id, bought_at AS event_at, 'buy'::text AS role FROM latest_buys
    UNION ALL
    SELECT collection_id, pack_nft_id, sold_at, 'sell' FROM latest_sells
    UNION ALL
    SELECT collection_id, pack_nft_id, sealed_at, 'rip' FROM wallet_rips
  ),
  dedup AS (
    SELECT collection_id, pack_nft_id,
      MAX(event_at)          AS latest_event_at,
      MIN(event_at)          AS first_event_at,
      bool_or(role = 'buy')  AS has_buy,
      bool_or(role = 'sell') AS has_sell,
      bool_or(role = 'rip')  AS has_rip
    FROM events GROUP BY 1, 2
  ),
  resolved AS (
    SELECT
      d.*,
      c.slug AS collection_slug, c.name AS collection_name,
      lb.buy_price, lb.buy_currency, lb.bought_at, lb.bought_from, lb.bought_primary,
      lb.bought_event_kind, lb.buy_src,
      ls.sell_price, ls.sell_currency, ls.sold_at, ls.sold_to, ls.sell_src,
      wr.id AS rip_id, wr.sealed_at AS ripped_at, wr.moments_pulled, wr.pull_value_usd,
      -- distribution: rip > the wallet's own rows > any marketplace row for this pack
      COALESCE(wr.dist_id, bd.dist_id, sd.dist_id, hx.dist_id) AS dist_id,
      CASE
        WHEN wr.dist_id IS NOT NULL THEN 'rip'
        WHEN bd.dist_id IS NOT NULL OR sd.dist_id IS NOT NULL THEN 'own_row'
        WHEN hx.dist_id IS NOT NULL THEN 'peer_sale'
        ELSE NULL
      END AS dist_source
    FROM dedup d
    JOIN public.collections c ON c.id = d.collection_id
    LEFT JOIN latest_buys  lb ON lb.collection_id = d.collection_id AND lb.pack_nft_id = d.pack_nft_id
    LEFT JOIN latest_sells ls ON ls.collection_id = d.collection_id AND ls.pack_nft_id = d.pack_nft_id
    LEFT JOIN wallet_rips  wr ON wr.collection_id = d.collection_id AND wr.pack_nft_id = d.pack_nft_id
    LEFT JOIN buy_dist     bd ON bd.collection_id = d.collection_id AND bd.pack_nft_id = d.pack_nft_id
    LEFT JOIN sell_dist    sd ON sd.collection_id = d.collection_id AND sd.pack_nft_id = d.pack_nft_id
    LEFT JOIN LATERAL (
      SELECT h.dist_id FROM public.topshot_pack_sales_history h
      WHERE d.collection_id = v_ts
        AND wr.dist_id IS NULL AND bd.dist_id IS NULL AND sd.dist_id IS NULL
        AND h.pack_nft_id = d.pack_nft_id AND h.dist_id IS NOT NULL
      UNION ALL
      SELECT h.dist_id FROM public.allday_pack_sales_history h
      WHERE d.collection_id = v_ad
        AND wr.dist_id IS NULL AND bd.dist_id IS NULL AND sd.dist_id IS NULL
        AND h.pack_nft_id = d.pack_nft_id AND h.dist_id IS NOT NULL
      LIMIT 1
    ) hx ON true
  ),
  enriched AS (
    SELECT
      r.*,
      pd.title              AS pack_name,
      pd.image_url          AS pack_image,
      pd.metadata->>'tier'  AS pack_tier,
      pd.total_sealed       AS dist_total_sealed,
      pd.total_opened       AS dist_total_opened,
      (pd.metadata->>'retail_price_usd')::numeric AS retail_usd,
      -- what the wallet PAID: on-chain/marketplace price for a secondary buy,
      -- the distribution's retail price for a primary drop, NULL when unknown.
      CASE WHEN r.bought_primary THEN (pd.metadata->>'retail_price_usd')::numeric
           ELSE r.buy_price END AS buy_usd,
      CASE
        WHEN NOT r.has_buy THEN NULL
        WHEN r.bought_primary AND (pd.metadata->>'retail_price_usd') IS NOT NULL THEN 'retail'
        WHEN r.bought_primary THEN NULL
        WHEN r.buy_price IS NULL THEN NULL
        ELSE r.buy_src
      END AS buy_price_source
    FROM resolved r
    LEFT JOIN public.pack_distributions pd
      ON pd.dist_id = r.dist_id AND pd.collection_id = r.collection_id
  ),
  classified AS (
    SELECT *,
      CASE
        WHEN has_rip                                            THEN 'ripped'
        WHEN has_sell AND has_buy AND sold_at >= bought_at      THEN 'flipped'
        WHEN has_sell AND NOT has_buy                           THEN 'sold'
        WHEN has_buy                                            THEN 'held'
        ELSE 'other'
      END AS status
    FROM enriched
  ),
  with_pl AS (
    SELECT *,
      CASE
        WHEN status = 'ripped'  AND pull_value_usd IS NOT NULL AND buy_usd IS NOT NULL THEN pull_value_usd - buy_usd
        WHEN status = 'flipped' AND sell_price     IS NOT NULL AND buy_usd IS NOT NULL THEN sell_price     - buy_usd
        ELSE NULL
      END AS realized_pl_usd
    FROM classified
  ),
  filtered AS (
    SELECT * FROM with_pl
    WHERE (p_collection_slug IS NULL OR collection_slug = p_collection_slug)
      AND (
        p_status IS NULL
        OR p_status = 'all'
        -- virtual status: every "no longer sealed in this wallet, sold on"
        -- outcome, regardless of whether a matching buy was attributable
        OR (p_status = 'sold_any' AND status IN ('flipped', 'sold'))
        OR status = p_status
      )
  ),
  page AS (
    SELECT * FROM filtered
    ORDER BY latest_event_at DESC, collection_id, pack_nft_id
    LIMIT v_safe_limit OFFSET v_safe_offset
  ),
  -- market context, PAGE rows only: current floor ask, latest EV snapshot, last
  -- recorded secondary sale of the same distribution. All NULL when unknown.
  page_market AS (
    SELECT
      p.*,
      CASE WHEN pas.is_listed THEN pas.lowest_ask END AS lowest_ask_usd,
      pas.last_checked_at                             AS ask_checked_at,
      ev.pack_ev                                      AS pack_ev_usd,
      ev.snapshotted_at                               AS ev_snapshotted_at,
      lsale.sale_price                                AS last_sale_usd,
      lsale.sealed_at                                 AS last_sale_at
    FROM page p
    LEFT JOIN public.pack_ask_state pas
      ON p.dist_id IS NOT NULL
     AND pas.dist_id = p.dist_id
     AND pas.collection_slug = replace(p.collection_slug, '_', '-')
    LEFT JOIN public.mv_pack_ev_latest ev
      ON p.dist_id IS NOT NULL
     AND ev.dist_id = p.dist_id AND ev.collection_id = p.collection_id
    LEFT JOIN LATERAL (
      SELECT pp.sale_price, pp.sealed_at
      FROM public.pack_purchases pp
      WHERE p.dist_id IS NOT NULL
        AND pp.pack_dist_id = p.dist_id
        AND pp.collection_id = p.collection_id
        AND pp.event_kind = 'secondary_sale'
        AND pp.sale_price IS NOT NULL
      ORDER BY pp.sealed_at DESC
      LIMIT 1
    ) lsale ON true
  )
  SELECT
    (SELECT COUNT(*) FROM filtered),
    COALESCE(jsonb_agg(
      jsonb_build_object(
        'pack_nft_id', pack_nft_id, 'collection_id', collection_id,
        'collection_slug', collection_slug, 'collection_name', collection_name,
        'status', status, 'has_buy', has_buy, 'has_sell', has_sell, 'has_rip', has_rip,
        'latest_event_at', latest_event_at, 'first_event_at', first_event_at,
        'pack_name', pack_name, 'pack_image', pack_image, 'pack_tier', pack_tier,
        'dist_id', dist_id, 'dist_source', dist_source,
        'dist_total_sealed', dist_total_sealed, 'dist_total_opened', dist_total_opened,
        'rip_id', rip_id, 'ripped_at', ripped_at,
        'moments_pulled', moments_pulled,
        'pull_value_usd', CASE WHEN pull_value_usd IS NULL THEN NULL ELSE ROUND(pull_value_usd::numeric, 2) END,
        'buy_price', CASE WHEN buy_price IS NULL THEN NULL ELSE ROUND(buy_price::numeric, 2) END,
        'buy_usd',   CASE WHEN buy_usd   IS NULL THEN NULL ELSE ROUND(buy_usd::numeric, 2) END,
        'buy_price_source', buy_price_source,
        'buy_currency', buy_currency, 'bought_at', bought_at, 'bought_from', bought_from,
        'bought_primary', bought_primary,
        'event_kind', bought_event_kind,
        'sell_price', CASE WHEN sell_price IS NULL THEN NULL ELSE ROUND(sell_price::numeric, 2) END,
        'sell_source', sell_src,
        'sell_currency', sell_currency, 'sold_at', sold_at, 'sold_to', sold_to,
        'realized_pl_usd', CASE WHEN realized_pl_usd IS NULL THEN NULL ELSE ROUND(realized_pl_usd::numeric, 2) END,
        'lowest_ask_usd', CASE WHEN lowest_ask_usd IS NULL THEN NULL ELSE ROUND(lowest_ask_usd::numeric, 2) END,
        'ask_checked_at', ask_checked_at,
        'pack_ev_usd', CASE WHEN pack_ev_usd IS NULL THEN NULL ELSE ROUND(pack_ev_usd::numeric, 2) END,
        'ev_snapshotted_at', ev_snapshotted_at,
        'last_sale_usd', CASE WHEN last_sale_usd IS NULL THEN NULL ELSE ROUND(last_sale_usd::numeric, 2) END,
        'last_sale_at', last_sale_at
      ) ORDER BY latest_event_at DESC, collection_id, pack_nft_id
    ), '[]'::jsonb)
  INTO v_total, v_packs
  FROM page_market;

  RETURN jsonb_build_object(
    'wallet', v_wallet,
    'collection_slug', p_collection_slug,
    'status_filter', p_status,
    'limit', v_safe_limit,
    'offset', v_safe_offset,
    'total_count', v_total,
    'packs', v_packs,
    'coverage', jsonb_build_object(
      'onchain', 'pack_purchases: Top Shot + All Day, block-indexed from 2026-04; primary drops carry no price on chain',
      'marketplace', 'topshot_pack_sales_history / allday_pack_sales_history: Dapper marketplace secondary sales (seller = storefront_address), Top Shot from 2023-09, All Day from 2022-12; ingest is bursty and can lag days',
      'sealed_identity', 'a sealed Top Shot primary-drop pack has no distribution recorded anywhere until it is opened or sold on the marketplace; dist_id/pack_name are NULL for those rows by design'
    ),
    'computed_at', now()
  );
END;
$function$;
-- <<< END verbatim get_wallet_pack_history <<<

-- >>> BEGIN verbatim get_wallet_pack_summary (pinned by supabase/tests/get_wallet_pack_summary.sql) >>>
CREATE OR REPLACE FUNCTION public.get_wallet_pack_summary(p_wallet text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '15s'
AS $function$
DECLARE
  v_wallet text := lower(coalesce(p_wallet, ''));
  v_ts uuid;
  v_ad uuid;
  v_purchases_total int; v_sales_total int; v_rips_total int;
  v_rips_valued int;
  v_spent numeric; v_proceeds numeric; v_ripped_value numeric;
  v_primary_spent numeric; v_primary_count int; v_primary_unknown int;
  v_secondary_spent numeric; v_secondary_count int;
  v_secondary_proceeds numeric; v_secondary_sold_count int;
  v_buys_marketplace int; v_sells_marketplace int;
  v_currency_breakdown jsonb; v_by_collection jsonb;
  v_first_event timestamptz; v_last_event timestamptz;
BEGIN
  IF v_wallet = '' THEN RETURN jsonb_build_object('error', 'wallet required'); END IF;

  SELECT id INTO v_ts FROM public.collections WHERE slug = 'nba_top_shot';
  SELECT id INTO v_ad FROM public.collections WHERE slug = 'nfl_all_day';

  -- One row per (collection, pack) the wallet BOUGHT and one per pack it SOLD,
  -- across the on-chain table and the two marketplace-history tables, so a
  -- purchase both sources saw counts once. Materialised in temp tables because
  -- three aggregates below read each set. Dropped first so the function is
  -- safe to call twice inside one transaction (ON COMMIT DROP alone is not).
  DROP TABLE IF EXISTS _wps_buys; DROP TABLE IF EXISTS _wps_sells;
  CREATE TEMP TABLE _wps_buys ON COMMIT DROP AS
  WITH buy_src AS (
    SELECT pp.pack_nft_id, pp.collection_id, pp.sale_price AS price, pp.sale_currency AS currency,
           pp.sealed_at AS at, pp.is_primary_drop, pp.pack_dist_id AS dist_id, 'onchain'::text AS src, 1 AS pri
    FROM public.pack_purchases pp WHERE pp.buyer_address = v_wallet
    UNION ALL
    SELECT h.pack_nft_id, v_ts, h.sale_price_usd, 'USD', h.block_time, false, h.dist_id, 'marketplace', 2
    FROM public.topshot_pack_sales_history h WHERE h.buyer_address = v_wallet AND h.purchased
    UNION ALL
    SELECT h.pack_nft_id, v_ad, h.sale_price_usd, 'USD', h.block_time, false, h.dist_id, 'marketplace', 2
    FROM public.allday_pack_sales_history h WHERE h.buyer_address = v_wallet AND h.purchased
  ),
  latest AS (
    SELECT DISTINCT ON (collection_id, pack_nft_id) *
    FROM buy_src ORDER BY collection_id, pack_nft_id, at DESC, pri
  ),
  any_dist AS (
    SELECT collection_id, pack_nft_id, MAX(dist_id) AS dist_id
    FROM buy_src WHERE dist_id IS NOT NULL GROUP BY 1, 2
  )
  SELECT
    l.collection_id, l.pack_nft_id, l.price, l.currency, l.at, l.is_primary_drop, l.src,
    CASE WHEN l.is_primary_drop THEN
      COALESCE(
        (pd_direct.metadata->>'retail_price_usd')::numeric,
        (pd_via_rip.metadata->>'retail_price_usd')::numeric
      )
    ELSE l.price END AS effective_buy_usd,
    (l.is_primary_drop AND
      COALESCE(
        (pd_direct.metadata->>'retail_price_usd')::numeric,
        (pd_via_rip.metadata->>'retail_price_usd')::numeric
      ) IS NULL
    ) AS is_unknown_primary_buy
  FROM latest l
  LEFT JOIN any_dist ad ON ad.collection_id = l.collection_id AND ad.pack_nft_id = l.pack_nft_id
  LEFT JOIN public.pack_distributions pd_direct
    ON pd_direct.dist_id = ad.dist_id AND pd_direct.collection_id = l.collection_id
  LEFT JOIN public.pack_rips pr
    ON pr.pack_nft_id = l.pack_nft_id AND pr.collection_id = l.collection_id
  LEFT JOIN public.pack_distributions pd_via_rip
    ON pd_via_rip.dist_id = pr.dist_id AND pd_via_rip.collection_id = l.collection_id;

  CREATE TEMP TABLE _wps_sells ON COMMIT DROP AS
  WITH sell_src AS (
    SELECT pp.pack_nft_id, pp.collection_id, pp.sale_price AS price, pp.sale_currency AS currency,
           pp.sealed_at AS at, pp.is_primary_drop, 'onchain'::text AS src, 1 AS pri
    FROM public.pack_purchases pp WHERE pp.seller_address = v_wallet
    UNION ALL
    SELECT h.pack_nft_id, v_ts, h.sale_price_usd, 'USD', h.block_time, false, 'marketplace', 2
    FROM public.topshot_pack_sales_history h WHERE h.storefront_address = v_wallet AND h.purchased
    UNION ALL
    SELECT h.pack_nft_id, v_ad, h.sale_price_usd, 'USD', h.block_time, false, 'marketplace', 2
    FROM public.allday_pack_sales_history h WHERE h.storefront_address = v_wallet AND h.purchased
  )
  SELECT DISTINCT ON (collection_id, pack_nft_id) *
  FROM sell_src ORDER BY collection_id, pack_nft_id, at DESC, pri;

  SELECT
    COUNT(*),
    COALESCE(SUM(effective_buy_usd), 0),
    COUNT(*) FILTER (WHERE is_primary_drop),
    COALESCE(SUM(effective_buy_usd) FILTER (WHERE is_primary_drop), 0),
    COUNT(*) FILTER (WHERE is_unknown_primary_buy),
    COUNT(*) FILTER (WHERE NOT is_primary_drop),
    COALESCE(SUM(price) FILTER (WHERE NOT is_primary_drop), 0),
    COUNT(*) FILTER (WHERE src = 'marketplace')
  INTO v_purchases_total, v_spent, v_primary_count, v_primary_spent, v_primary_unknown,
       v_secondary_count, v_secondary_spent, v_buys_marketplace
  FROM _wps_buys;

  SELECT
    COUNT(*),
    COALESCE(SUM(price), 0),
    COUNT(*) FILTER (WHERE NOT is_primary_drop),
    COALESCE(SUM(price) FILTER (WHERE NOT is_primary_drop), 0),
    COUNT(*) FILTER (WHERE src = 'marketplace')
  INTO v_sales_total, v_proceeds, v_secondary_sold_count, v_secondary_proceeds, v_sells_marketplace
  FROM _wps_sells;

  -- 2026-09-12: COUNT(pull_value_usd) counts NON-NULL only, which is exactly the
  -- coverage figure. Same scan as the COUNT(*) and SUM() beside it.
  SELECT COUNT(*), COUNT(pull_value_usd), COALESCE(SUM(pull_value_usd), 0), MIN(sealed_at), MAX(sealed_at)
  INTO v_rips_total, v_rips_valued, v_ripped_value, v_first_event, v_last_event
  FROM public.pack_rips WHERE opener_address = v_wallet;

  SELECT COALESCE(jsonb_object_agg(sale_currency, jsonb_build_object('purchases', purchases, 'sales', sales, 'spent', spent, 'proceeds', proceeds)), '{}'::jsonb)
  INTO v_currency_breakdown
  FROM (
    SELECT COALESCE(currency, 'UNKNOWN') AS sale_currency,
      SUM(purchases)::int AS purchases, SUM(sales)::int AS sales,
      ROUND(SUM(spent)::numeric, 2) AS spent, ROUND(SUM(proceeds)::numeric, 2) AS proceeds
    FROM (
      SELECT currency, 1 AS purchases, 0 AS sales, COALESCE(price, 0) AS spent, 0::numeric AS proceeds FROM _wps_buys
      UNION ALL
      SELECT currency, 0, 1, 0::numeric, COALESCE(price, 0) FROM _wps_sells
    ) u
    GROUP BY COALESCE(currency, 'UNKNOWN')
  ) cur;

  SELECT COALESCE(jsonb_agg(row_to_json(cb.*)::jsonb ORDER BY cb.activity_total DESC), '[]'::jsonb)
  INTO v_by_collection
  FROM (
    WITH purchases AS (
      SELECT collection_id, COUNT(*)::int AS n,
             COUNT(*) FILTER (WHERE is_primary_drop)::int AS primary_n,
             COUNT(*) FILTER (WHERE NOT is_primary_drop)::int AS secondary_n,
             COUNT(*) FILTER (WHERE is_unknown_primary_buy)::int AS unknown_primary_n,
             COALESCE(SUM(effective_buy_usd), 0)::numeric AS amt
      FROM _wps_buys GROUP BY collection_id
    ),
    sales AS (
      SELECT collection_id, COUNT(*)::int AS n, COALESCE(SUM(price), 0)::numeric AS amt
      FROM _wps_sells GROUP BY collection_id
    ),
    rips AS (
      SELECT collection_id, COUNT(*)::int AS n, COALESCE(SUM(pull_value_usd), 0)::numeric AS amt
      FROM public.pack_rips WHERE opener_address = v_wallet GROUP BY collection_id
    ),
    all_coll AS (SELECT collection_id FROM purchases UNION SELECT collection_id FROM sales UNION SELECT collection_id FROM rips)
    SELECT c.id AS collection_id, c.slug AS collection_slug, c.name AS collection_name,
      COALESCE(p.n, 0) AS packs_purchased, COALESCE(p.primary_n, 0) AS primary_drops, COALESCE(p.secondary_n, 0) AS secondary_buys,
      COALESCE(p.unknown_primary_n, 0) AS primary_spend_unknown_count,
      COALESCE(s.n, 0) AS packs_sold, COALESCE(r.n, 0) AS packs_ripped,
      ROUND(COALESCE(p.amt, 0)::numeric, 2) AS spent_usd, ROUND(COALESCE(s.amt, 0)::numeric, 2) AS proceeds_usd, ROUND(COALESCE(r.amt, 0)::numeric, 2) AS ripped_value_usd,
      ROUND((COALESCE(s.amt,0) + COALESCE(r.amt,0) - COALESCE(p.amt,0))::numeric, 2) AS net_pl_usd,
      COALESCE(p.n, 0) + COALESCE(s.n, 0) + COALESCE(r.n, 0) AS activity_total
    FROM all_coll a JOIN public.collections c ON c.id = a.collection_id
    LEFT JOIN purchases p ON p.collection_id = a.collection_id
    LEFT JOIN sales s     ON s.collection_id = a.collection_id
    LEFT JOIN rips r      ON r.collection_id = a.collection_id
  ) cb;

  RETURN jsonb_build_object(
    'wallet', v_wallet,
    'totals', jsonb_build_object(
      'packs_purchased',                v_purchases_total,
      'primary_drops',                  v_primary_count,
      'secondary_buys',                 v_secondary_count,
      'packs_sold',                     v_sales_total,
      'packs_ripped',                   v_rips_total,
      'ripped_value_known_count',       v_rips_valued,
      'buys_from_marketplace_history',  v_buys_marketplace,
      'sells_from_marketplace_history', v_sells_marketplace,
      'spent_usd',                      ROUND(COALESCE(v_spent, 0)::numeric, 2),
      'primary_spent_usd',              ROUND(COALESCE(v_primary_spent, 0)::numeric, 2),
      'primary_spend_unknown_count',    v_primary_unknown,
      'secondary_spent_usd',            ROUND(COALESCE(v_secondary_spent, 0)::numeric, 2),
      'sold_proceeds_usd',              ROUND(COALESCE(v_proceeds, 0)::numeric, 2),
      'secondary_proceeds_usd',         ROUND(COALESCE(v_secondary_proceeds, 0)::numeric, 2),
      'ripped_value_usd',               ROUND(COALESCE(v_ripped_value, 0)::numeric, 2),
      'net_pl_usd',                     ROUND((COALESCE(v_proceeds, 0) + COALESCE(v_ripped_value, 0) - COALESCE(v_spent, 0))::numeric, 2),
      'first_event_at',                 v_first_event,
      'last_event_at',                  v_last_event
    ),
    'by_currency', v_currency_breakdown,
    'by_collection', v_by_collection,
    'computed_at', now(),
    'note', 'Buys and sells are one row per (collection, pack) across public.pack_purchases (on-chain: secondary_sale + primary_withdraw/primary_mint, block-indexed from 2026-04) and the Dapper marketplace history tables topshot_pack_sales_history / allday_pack_sales_history (seller = storefront_address; Top Shot from 2023-09, All Day from 2022-12; bursty ingest). pack_purchases.seller_address is the transaction PAYER, which on Dapper is the escrow account, so on-chain rows almost never identify a seller -- packs_sold comes from the marketplace tables. Primary drop sale_price is NULL on-chain; primary_spent_usd recovers retail via pack_distributions.metadata->>retail_price_usd and primary_spend_unknown_count counts the rest. ripped_value_known_count is how many of packs_ripped carry a pull_value_usd -- ripped_value_usd sums THOSE only.'
  );
END;
$function$;
-- <<< END verbatim get_wallet_pack_summary <<<

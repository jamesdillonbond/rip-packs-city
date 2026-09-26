-- #145 follow-up: candy_pack_market counted Magic Eden's listing ESCROW as a collector wallet.
-- A pack held by a wallet in candy_holder_board_exclusions (today: the ME escrow
-- 1BWutmTv…X6NDix, identified 2026-09-25) is attributed to the SELLER of its newest active
-- listing; with no active listing it still counts as collector-held (it is not treasury),
-- but no wallet is credited — the escrow itself is never counted as a collector wallet.
-- Measured before apply (2026-09-26 ~8:45 AM PT): treasury_held 2,336 and collector_held 165
-- unchanged; collector_wallets 63 -> 71 (the escrow's 14 packs belong to 9 sellers who hold
-- no other pack; the escrow itself drops out).
-- Revert: re-apply the view body from 20260727101200_audit_20260727_candy_pack_market_drop_unprovable_sealed_split.sql
-- (packs CTE reading candy_packs.owner directly), then ALTER VIEW ... SET (security_invoker = on).
CREATE OR REPLACE VIEW public.candy_pack_market AS
 WITH treas AS (
         SELECT candy_treasury_wallet.wallet_address
           FROM candy_treasury_wallet
        ), attr AS (
         SELECT cp.token_mint,
            cp.owner,
            cp.pack_supply,
            cp.is_burnt,
            cp.last_seen_at,
                CASE
                    WHEN ex.wallet_address IS NULL THEN cp.owner
                    ELSE ls.seller
                END AS holder
           FROM candy_packs cp
             LEFT JOIN candy_holder_board_exclusions ex ON ex.wallet_address = cp.owner
             LEFT JOIN LATERAL ( SELECT l.seller
                   FROM candy_pack_listings l
                  WHERE l.token_mint = cp.token_mint AND l.is_active AND (l.expiry IS NULL OR l.expiry > now())
                  ORDER BY l.last_seen_at DESC
                 LIMIT 1) ls ON ex.wallet_address IS NOT NULL
        ), packs AS (
         SELECT count(*) AS pack_assets_indexed,
            max(attr.pack_supply) AS declared_supply,
            count(*) FILTER (WHERE COALESCE(attr.holder, attr.owner) = (( SELECT treas.wallet_address
                   FROM treas))) AS treasury_held,
            count(*) FILTER (WHERE COALESCE(attr.holder, attr.owner) <> (( SELECT treas.wallet_address
                   FROM treas))) AS collector_held,
            count(DISTINCT attr.holder) FILTER (WHERE attr.holder <> (( SELECT treas.wallet_address
                   FROM treas))) AS collector_wallets,
            count(*) FILTER (WHERE attr.is_burnt) AS burnt_assets,
            max(attr.last_seen_at) AS inventory_refreshed_at
           FROM attr
        ), dupes AS (
         SELECT count(*) AS duplicate_serials
           FROM ( SELECT candy_packs.serial_number
                   FROM candy_packs
                  WHERE candy_packs.serial_number IS NOT NULL
                  GROUP BY candy_packs.serial_number
                 HAVING count(*) > 1) d_1
        ), asks AS (
         SELECT count(*) AS active_asks,
            min(candy_pack_listings.price_usd) AS floor_ask_usd,
            min(candy_pack_listings.price_sol) AS floor_ask_sol
           FROM candy_pack_listings
          WHERE candy_pack_listings.is_active AND (candy_pack_listings.expiry IS NULL OR candy_pack_listings.expiry > now())
        ), sales AS (
         SELECT count(*) AS sales_all,
            count(*) FILTER (WHERE candy_pack_sales.sold_at > (now() - '24:00:00'::interval)) AS sales_24h,
            count(*) FILTER (WHERE candy_pack_sales.sold_at > (now() - '7 days'::interval)) AS sales_7d,
            round(sum(candy_pack_sales.price_usd) FILTER (WHERE candy_pack_sales.sold_at > (now() - '7 days'::interval)), 2) AS volume_7d_usd,
            round(avg(candy_pack_sales.price_usd) FILTER (WHERE candy_pack_sales.sold_at > (now() - '7 days'::interval)), 2) AS avg_7d_usd,
            round(percentile_cont(0.5::double precision) WITHIN GROUP (ORDER BY (candy_pack_sales.price_usd::double precision)) FILTER (WHERE candy_pack_sales.sold_at > (now() - '7 days'::interval))::numeric, 2) AS median_7d_usd,
            max(candy_pack_sales.sold_at) AS last_sale_at,
            round((array_agg(candy_pack_sales.price_usd ORDER BY candy_pack_sales.sold_at DESC))[1], 2) AS last_sale_usd
           FROM candy_pack_sales
        )
 SELECT p.pack_assets_indexed,
    p.declared_supply,
    d.duplicate_serials,
    p.treasury_held,
    p.collector_held,
    p.collector_wallets,
    p.burnt_assets,
    p.inventory_refreshed_at,
    a.active_asks,
    a.floor_ask_usd,
    a.floor_ask_sol,
    s.sales_all,
    s.sales_24h,
    s.sales_7d,
    s.volume_7d_usd,
    s.avg_7d_usd,
    s.median_7d_usd,
    s.last_sale_at,
    s.last_sale_usd,
    ev.pack_cost_usd AS retail_usd,
    ev.typical_pull_ev_usd,
    ev.actual_ev_usd,
    round(s.median_7d_usd / NULLIF(ev.pack_cost_usd, 0::numeric), 2) AS median_vs_retail_x,
    round(s.median_7d_usd / NULLIF(ev.typical_pull_ev_usd, 0::numeric), 2) AS median_vs_typical_pull_x,
    round(s.median_7d_usd / NULLIF(ev.actual_ev_usd, 0::numeric), 2) AS median_vs_actual_ev_x,
    ev.model_note
   FROM packs p
     CROSS JOIN dupes d
     CROSS JOIN asks a
     CROSS JOIN sales s
     LEFT JOIN LATERAL ( SELECT candy_pack_ev_model.icon_slots,
            candy_pack_ev_model.rainbow_chance,
            candy_pack_ev_model.pack_cost_usd,
            candy_pack_ev_model.common_slot_ev,
            candy_pack_ev_model.common_slot_typical,
            candy_pack_ev_model.rainbow_ev,
            candy_pack_ev_model.common_total,
            candy_pack_ev_model.common_priced,
            candy_pack_ev_model.rainbow_total,
            candy_pack_ev_model.rainbow_priced,
            candy_pack_ev_model.actual_ev_usd,
            candy_pack_ev_model.typical_pull_ev_usd,
            candy_pack_ev_model.model_note
           FROM candy_pack_ev_model) ev ON true;

ALTER VIEW public.candy_pack_market SET (security_invoker = on);

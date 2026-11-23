-- Ranked HobbyCardIndex lookup list for the setup month (DRAFT, read-only).
-- Needs the panini_physical_crosswalk_draft view (or paste its body as a CTE).
-- One row per distinct PAPER card (product + card number + subset + parallel + person),
-- ranked by the digital 90-day sale dollars of its digital twins. One HCI /sales call
-- per row. Measured 2026-11-22: 41,545 keys, 17,322 with a digital sale in 90 days;
-- the top 500 carry 68 % of comparable digital $ (top 100: 43 %).
-- At card-number grain (all parallels of one paper card together) the top 500
-- carry 81.5 % — use that grain only if HCI returns every parallel under one card id.
with s as (
  select edition_external_id, sum(amount_usd) as usd, count(*) as n
    from public.panini_sales
   where sold_at > now() - interval '90 days' and amount_usd > 0
   group by 1
)
select row_number() over (order by sum(s.usd) desc nulls last) as rank,
       cw.physical_product, cw.card_number, cw.physical_subset, cw.physical_parallel,
       min(cw.player_name) as player_name, cw.espn_id,
       min(cw.digital_mint_cap) as digital_mint_cap,
       round(sum(s.usd)) as digital_usd_90d, sum(s.n) as digital_sales_90d,
       min(cw.physical_search_query) as hci_query,
       array_agg(cw.external_id order by cw.external_id) as digital_editions
  from public.panini_physical_crosswalk_draft cw
  left join s on s.edition_external_id = cw.external_id
 where cw.comparable
 group by cw.physical_product, cw.card_number, cw.physical_subset, cw.physical_parallel, cw.espn_id
 order by rank
 limit 500;

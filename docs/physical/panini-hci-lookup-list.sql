-- Ranked HobbyCardIndex lookup list for the setup month (DRAFT, read-only).
-- Needs the panini_physical_crosswalk_draft view (or paste its body as a CTE).
-- One row per distinct PAPER card (product + card number + subset + parallel + person),
-- ranked by the digital 90-day sale dollars of its digital twins. One HCI /sales call
-- per row.
--
-- 2026-11-22 ~10:45 PM PT: rows now need >= 3 digital sales in 90 days. The comparison
-- method is realised MEDIAN vs realised MEDIAN, and a median of one or two sales is not
-- one. Ranked by dollars alone, 236 of the top 500 had fewer than 3 digital sales (the
-- #1 row was a single $110,000 sale), so a third of the 500 lookups would have bought
-- a paper price with nothing to compare it to.
-- Measured: 43,005 comparable keys, $1,375,829 digital 90-day $. Keys with >= 3 sales:
-- 6,984 carrying $689,656 (half the dollars; the other half sits on 10,874 keys with
-- 1-2 sales). The top 500 of those carry $482,245 (35 % of all, 70 % of the >= 3 set)
-- over 7,175 digital sales; the 500th row is $179. 40 of the 500 are mint cap <= 10.
-- The earlier dollars-only ranking: top 500 = $964,964 (70 %), mostly thin.
-- At card-number grain (all parallels of one paper card together) coverage is higher
-- — use that grain only if HCI returns every parallel under one card id.
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
having coalesce(sum(s.n), 0) >= 3   -- a median needs sales; see header
 order by rank
 limit 500;

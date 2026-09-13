-- candy_market_board — the BROWSE feed behind Candy's Market tab.
--
-- ⚠ THIS IS NOT candy_deals_board WITH A WIDER LIMIT, and the difference is the
-- whole point. That view carries two DEAL predicates:
--     AND l.price_usd < fc.fmv_usd
--     AND (m.median_sale_usd IS NULL OR l.price_usd < m.median_sale_usd)
-- which is correct for a deals board and wrong for a market: measured
-- 2026-09-12, they cut the 1,821 active Candy listings down to 233. A Market
-- tab that showed only listings priced below FMV would be publishing "this is
-- the Candy market" about 13% of it, with the expensive 87% silently absent --
-- and nothing on the page would say so.
--
-- Same JOINS as the deals board deliberately, so the two surfaces cannot drift
-- on what a listing IS. Serial comes from wallet_moments_cache keyed on
-- moment_id = token_mint, which is how Candy's per-serial identity is stored.
--
-- Coverage measured the day this shipped, over all 1,821 active priced rows:
-- serial 1821/1821, FMV 1821/1821, thumbnail 1821/1821. The joins to editions
-- and candy_fmv_current are therefore INNER (a listing we cannot name or price
-- is not something to render), while the serial and median joins stay LEFT --
-- they are complete today but neither is structurally guaranteed, and dropping
-- a real listing because its serial has not been indexed yet would be the
-- worse failure. The caller renders a missing serial as unknown, not as #0.
create or replace view candy_market_board as
with med as (
  select s.edition_id,
         count(*) as sales_count,
         (percentile_cont(0.5) within group (order by s.price_usd::double precision))::numeric as median_sale_usd
    from sales s
   where s.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid
     and s.price_usd is not null
     and s.price_usd > 0::numeric
   group by s.edition_id
)
select l.pda_address,
       l.token_mint,
       e.id                as edition_id,
       e.external_id,
       e.player_name,
       e.name              as edition_name,
       e.set_name,
       e.team_name,
       e.tier::text        as tier,
       e.circulation_count,
       e.thumbnail_url,
       w.serial_number,
       l.price_usd         as ask_usd,
       l.price_sol         as ask_sol,
       fc.fmv_usd,
       fc.confidence::text as confidence,
       round(100.0 * (1::numeric - l.price_usd / nullif(fc.fmv_usd, 0::numeric)), 1) as discount_pct,
       l.seller,
       l.first_seen_at,
       l.last_seen_at,
       m.median_sale_usd,
       m.sales_count
  from candy_listings l
  join editions e          on e.id = l.edition_id
  join candy_fmv_current fc on fc.edition_id = l.edition_id
  left join med m          on m.edition_id = l.edition_id
  left join wallet_moments_cache w
         on w.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid
        and w.moment_id = l.token_mint
 where l.is_active
   and l.price_usd is not null
   and l.price_usd > 0::numeric;

comment on view candy_market_board is
  'Candy MLB browse feed: every ACTIVE priced listing, unlike candy_deals_board which keeps only those below FMV and below the median sale (233 of 1821 on 2026-09-12). Same joins as that view so the two cannot drift.';

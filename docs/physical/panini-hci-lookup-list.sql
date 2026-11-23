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
--
-- 2026-11-23 ~8:00 AM PT: rows whose digital print run EQUALS the paper print run come
-- first (`like_for_like`). Trevor's question is digital vs paper price; between two
-- different scarcities (2026 World Cup Old Glory: /7 digital, /94 paper) a ratio measures
-- the print runs as much as the format. Paper runs below are from the published paper
-- checklists (checklistinsider / checklistcenter, read 2026-11-22/23); a parallel not in
-- `paper_runs` is unknown (NULL), never assumed to match. Measured 2026-11-23 for the rows
-- that also have >= 3 digital sales: 2026 Prizm WNBA Gold /10 (66 cards, $19.8k), Mojo /25
-- (172, $17.0k), Black Gold /5 (10), Plum Blossom /8 (5); 2026 World Cup Gold /10 (1).
-- Run live 2026-11-23 (read-only): the top 500 is 248 like-for-like paper cards (Mojo 168,
-- Gold 65, Black Gold 10, Plum Blossom 5 — all 2026 Prizm WNBA), then 252 by dollars
-- (229 with an unknown paper run, 23 known mismatches). It carries $436,961 of digital
-- 90-day sales, against $482,245 for the dollars-only top 500: the price of putting
-- clean pairs first.
-- ⚠ The PAPER side needs >= 3 sales too, and a /10 paper card rarely sells 3 times in 90
-- days; expect the usable pairs to be a fraction of these, concentrated on the stars.
-- ⚠ Prizm WNBA paper runs come from checklistcenter's product breakdown (the
-- checklistinsider page was behind a bot check on 11-23); re-check them against the
-- feed's own print runs in the first hour of the month.
with s as (
  select edition_external_id, sum(amount_usd) as usd, count(*) as n
    from public.panini_sales
   where sold_at > now() - interval '90 days' and amount_usd > 0
   group by 1
), paper_runs(physical_product, physical_subset, physical_parallel, paper_print_run) as (values
  -- 2026 Panini Prizm WNBA (paper, Sept 2026)
  ('2026 Panini Prizm WNBA', 'Base', 'Gold', 10), ('2026 Panini Prizm WNBA', 'Base', 'Mojo', 25),
  ('2026 Panini Prizm WNBA', 'Base', 'Black Gold', 5), ('2026 Panini Prizm WNBA', 'Base', 'Plum Blossom', 8),
  ('2026 Panini Prizm WNBA', 'Base', 'Cherry Blossom', 20), ('2026 Panini Prizm WNBA', 'Base', 'Gold Vinyl', 1),
  -- 2026 Panini Prizm FIFA World Cup (paper, June 2026)
  ('2026 Panini Prizm World Cup Soccer', 'Base', 'Gold', 10), ('2026 Panini Prizm World Cup Soccer', 'Base', 'Black', 1),
  ('2026 Panini Prizm World Cup Soccer', 'Base Choice', 'Nebula', 1), ('2026 Panini Prizm World Cup Soccer', 'Base', 'Red', 50),
  ('2026 Panini Prizm World Cup Soccer', 'Base', 'Blue', 40), ('2026 Panini Prizm World Cup Soccer', 'Base', 'Cracked Ice', 23),
  ('2026 Panini Prizm World Cup Soccer', 'Base', 'Old Glory', 94), ('2026 Panini Prizm World Cup Soccer', 'Base', 'Plum Blossom', 8),
  ('2026 Panini Prizm World Cup Soccer', 'Base', 'Cherry Blossom', 20), ('2026 Panini Prizm World Cup Soccer', 'Base', 'Aguila', 70),
  ('2026 Panini Prizm World Cup Soccer', 'Base', 'Panini Logo', 61), ('2026 Panini Prizm World Cup Soccer', 'Base', 'Maple Leaf', 86)
), keyed as (
  select cw.physical_product, cw.card_number, cw.physical_subset, cw.physical_parallel, cw.espn_id,
         min(cw.player_name) as player_name,
         min(cw.digital_mint_cap) as digital_mint_cap,
         min(pr.paper_print_run) as paper_print_run,
         round(sum(s.usd)) as digital_usd_90d, coalesce(sum(s.n), 0) as digital_sales_90d,
         min(cw.physical_search_query) as hci_query,
         array_agg(cw.external_id order by cw.external_id) as digital_editions
    from public.panini_physical_crosswalk_draft cw
    left join s on s.edition_external_id = cw.external_id
    left join paper_runs pr on pr.physical_product = cw.physical_product
                           and pr.physical_subset = cw.physical_subset
                           and pr.physical_parallel = cw.physical_parallel
   where cw.comparable
   group by cw.physical_product, cw.card_number, cw.physical_subset, cw.physical_parallel, cw.espn_id
  having coalesce(sum(s.n), 0) >= 3   -- a median needs sales; see header
)
-- Only a CONFIRMED match is promoted. A known mismatch is not better than an unknown
-- run, so both rank by dollars after the matches (a first draft ordered `desc nulls
-- last`, which put every known World Cup mismatch ahead of every unknown product).
select row_number() over (order by coalesce(digital_mint_cap = paper_print_run, false) desc, digital_usd_90d desc nulls last) as rank,
       (digital_mint_cap = paper_print_run) as like_for_like,  -- NULL = paper run unknown
       *
  from keyed
 order by rank
 limit 500;

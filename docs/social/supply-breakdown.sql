-- docs/social/supply-breakdown.sql — per-player supply split for scripts/social/x-supply-breakdown.mjs
-- First used 11-15 (2026 class, https://x.com/rippackscity/status/2122082396774547650); 11-16 run for the
-- 2025 class (rookie-season Moments only). Read-only.
--
-- EDIT THE TWO PARAMETERS in `params`:
--   players — the list, in the order of the post being quoted.
--   season  — the class's ROOKIE season ('2025-26' for the 2025 class, '2026-27' for 2026).
--             Trevor, 11-16: "These should only be for their rookie season". A 2025 rookie's
--             2026-27 Moments (Season Tip-Off: Flagg and Bailey, 234 each with parallels) are left out.
--             The season is badge_editions.season = Atlas metadata.NbaSeason (the Moment's own game
--             season); 2026 Playoff Premieres and
--             2026 NBA Finals are Series 2025-26 and DO count as a 2025 rookie's rookie season.
-- Output columns map to the JSON rows: [player, team, unlocked, locked, in_packs, reserve
-- (minted, not in packs), burned]. Check every row sums to `total`.
--
-- To pick a class's top 10 the way the Wednesday post does (all-time sales, every rookie-season
-- edition), see the "top-10 by sales" query at the bottom.
--
-- WHY THE REFERENCE HIDDEN COUNT: badge_editions.hidden_in_packs (Top Shot's issuer-held count) is
-- refreshed hourly; the Atlas pack contents (topshot_atlas_dist_editions.remaining_count) are read
-- per dist on their own schedule (some rows are weeks old). Subtracting a STALE pack count from a
-- FRESH hidden count understated the reserve by ~30 on 11-15. So the reserve is measured at the pack
-- read's own moment (hidden_at_fetch, from the dist row with the most remaining), and "in packs" =
-- current hidden − that reserve.
-- ⚠ Even so, this is an ESTIMATE of the split (11-16, 2025 class: 960 / 98 here vs 954 / 104 read
-- live, ±2 per player). In packs + reserve (= hidden) is exact. For a post, re-read the split live
-- with scripts/social/supply-breakdown-live-check.js and use those numbers.
with params as (
  select array['Cooper Flagg','Dylan Harper','Kon Knueppel','VJ Edgecombe','Ace Bailey',
               'Derik Queen','Cedric Coward','Tre Johnson','Collin Murray-Boyles','Jeremiah Fears']::text[] players,
         '2025-26'::text season),
be as (
  select external_id, player_name, team, circulation_count c, locked, burned, hidden_in_packs h_now, updated_at,
         split_part(external_id, ':', 1)::int set_id,
         split_part(split_part(external_id, '::', 1), ':', 2)::int play_id,
         case when coalesce(parallel_name, '') = '' then 'Standard' else parallel_name end par
    from badge_editions b, params p
   where b.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
     and b.player_name = any (p.players)
     and b.season = p.season),
x as (
  select x.* from topshot_atlas_dist_editions x
    join topshot_atlas_dists d on d.dist_id = x.dist_id and d.editions_pass = x.pass
   where x.remaining_count > 0),
j as (
  select be.external_id, sum(x.remaining_count) inp,
         (array_agg(x.hidden_at_fetch order by x.remaining_count desc))[1] h_ref
    from be join x on x.set_id = be.set_id and x.play_id = be.play_id and x.parallel = be.par
   group by 1),
e as (select be.*, greatest(0, coalesce(j.h_ref - j.inp, be.h_now)) reserve from be left join j using (external_id))
select coalesce(player_name, 'ALL') player, case when grouping(player_name) = 0 then max(team) end team,
       count(*) editions, sum(c) total,
       sum(c - locked - burned - h_now)        unlocked,
       sum(locked)                             locked,
       sum(h_now - least(reserve, h_now))      in_packs,
       sum(least(reserve, h_now))              reserve,
       sum(burned)                             burned,
       max(updated_at)                         counts_as_of
  from e group by rollup(player_name) order by player;

-- ── Top 10 of a class by all-time sales, rookie-season editions only ─────────────────────────────
-- Cohorts: topshot_2025_rookie_players, topshot_2026_rookie_players. Same metric as the Wednesday
-- post (lib/insights/rookie-sales.ts: every edition, price_usd > 0, all time) restricted to the
-- rookie season. Show #11 too: on 11-16 #8/#9 (Tre Johnson / Collin Murray-Boyles) were $20 apart.
-- select e.player_name, count(*) sales, round(sum(s.price_usd)) gmv
--   from sales s
--   join editions e on e.id = s.edition_id
--   join badge_editions b on b.collection_id = e.collection_id and b.external_id = e.external_id
--  where e.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
--    and e.player_name in (select player_name from topshot_2025_rookie_players)
--    and b.season = '2025-26' and s.price_usd > 0
--  group by 1 order by gmv desc limit 12;

-- ── Inputs for scripts/social/supply-breakdown-live-check.js ─────────────────────────────────────
-- The Atlas edition ids of the list's editions, and every distribution RPC has seen holding any of
-- them unopened. Paste both strings into the script's EDITIONS / DISTS constants. (A distribution
-- that RPC recorded as empty stays empty — packs are never refilled — and the script also probes
-- the ids just above RPC's newest distribution for a brand-new drop.)
-- with params as (select array['Cooper Flagg', /* … */ 'Jeremiah Fears']::text[] players, '2025-26'::text season),
-- be as (select b.external_id, b.player_name,
--               split_part(b.external_id, ':', 1)::int set_id,
--               split_part(split_part(b.external_id, '::', 1), ':', 2)::int play_id,
--               case when coalesce(b.parallel_name, '') = '' then 'Standard' else b.parallel_name end par
--          from badge_editions b, params p
--         where b.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
--           and b.player_name = any (p.players) and b.season = p.season)
-- select (select string_agg(m.atlas_edition_id || ':' || be.player_name, ',')
--           from be join topshot_atlas_edition_map m using (external_id)) as editions,
--        (select string_agg(distinct x.dist_id::text, ',')
--           from be join topshot_atlas_dist_editions x
--             on x.set_id = be.set_id and x.play_id = be.play_id and x.parallel = be.par
--          where x.remaining_count > 0) as dists,
--        (select max(dist_id::int) from topshot_atlas_dists) as newest_dist;

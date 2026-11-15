-- docs/social/supply-breakdown.sql — per-player supply split for scripts/social/x-supply-breakdown.mjs
-- (first used 11-15, quote post https://x.com/rippackscity/status/2122082396774547650). Read-only.
-- Edit the player list. Output columns map to the JSON rows: [player, team, unlocked, locked,
-- in_packs, reserve (minted, not in packs), burned]. Check every row sums to `total`.
--
-- WHY THE REFERENCE HIDDEN COUNT: badge_editions.hidden_in_packs (Top Shot's issuer-held count) is
-- refreshed hourly; the Atlas pack contents (topshot_atlas_dist_editions.remaining_count) are read
-- per dist on their own schedule. Subtracting a STALE pack count from a FRESH hidden count
-- understated the reserve by ~30 on 11-15 (Collector Packs kept being opened after the pack read).
-- So the reserve is measured at the pack read's own moment (hidden_at_fetch, from the dist row with
-- the most remaining), and "in packs" = current hidden − that reserve. The reserve only moves when
-- Top Shot issues it (Overtime packs drew Dybantsa's and Peterson's down to 11 and 10).
with be as (
  select external_id, player_name, circulation_count c, locked, burned, hidden_in_packs h_now, updated_at,
         split_part(external_id, ':', 1)::int set_id,
         split_part(split_part(external_id, '::', 1), ':', 2)::int play_id,
         case when coalesce(parallel_name, '') = '' then 'Standard' else parallel_name end par
    from badge_editions
   where collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
     and player_name in ('AJ Dybantsa','Darius Acuff Jr.','Cameron Boozer','Darryn Peterson','Yaxel Lendeborg',
                         'Caleb Wilson','Aday Mara','Meleek Thomas','Brayden Burries','Keaton Wagler')),
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
select coalesce(player_name, 'ALL') player, sum(c) total,
       sum(c - locked - burned - h_now)        unlocked,
       sum(locked)                             locked,
       sum(h_now - least(reserve, h_now))      in_packs,
       sum(least(reserve, h_now))              reserve,
       sum(burned)                             burned,
       max(updated_at)                         counts_as_of
  from e group by rollup(player_name) order by player;

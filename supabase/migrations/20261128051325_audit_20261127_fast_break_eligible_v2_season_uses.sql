-- audit_20261127_fast_break_eligible_v2_season_uses
--
-- Trevor 2026-11-27 ("Yes do it all" / "Go"). Regular-season Fast Break (2026-27) gives every
-- MOMENT a number of uses per run: the HIGHER of its average-sale-price band and its tier.
--   Price bands (Top Shot help center "Fast Break", 2025-26 fatigue table):
--     $0.01-$10 -> 1 · $10.01-$50 -> 2 · $50.01-$300 -> 3 · $300.01-$1,000 -> 4 · $1,000.01+ -> unlimited
--   Tier floors: Rare 2 and Ultimate every night are stated in Top Shot's 2026-27 announcement;
--     Legendary 4 is the prior tier rule, ASSUMED until Top Shot states it; Common/Fandom 1.
-- ASP proxy: wallet_moments_cache.fmv_usd (the Moment's edition FMV); a Moment with no price
-- gets its tier floor only. A player's uses = his best single Moment's (conservative: we do not
-- assume uses add across Moments of the same player).
-- get_fb_eligible_players (v1, playoff tier caps) is left untouched for the playoff runs.
-- total_allowed / remaining_uses NULL = unlimited.
--
-- Also: the run seeded 11-27 ('Classic Run — Nov 16–29') has a Captain (1.5x, help center).
-- Revert: drop function public.get_fb_eligible_players_v2(text, uuid);
--         update fast_break_runs set has_captain = false where name = 'Classic Run — Nov 16–29';

create or replace function public.get_fb_eligible_players_v2(p_wallet_addr text, p_run_id uuid default null)
returns table (
  nba_player_id uuid, full_name text, current_team_abbr text, highest_tier text,
  total_allowed smallint, best_moment_id text, best_serial integer, best_fmv_usd numeric,
  total_owned integer, has_locked boolean, times_used smallint, remaining_uses smallint)
language sql
stable
set search_path to 'pg_catalog', 'public'
as $function$
  with wm as (
    select wmc.player_name, upper(wmc.tier::text) as tier, wmc.serial_number, wmc.moment_id,
           wmc.fmv_usd, coalesce(wmc.is_locked, false) as is_locked
      from wallet_moments_cache wmc
     where wmc.wallet_address = p_wallet_addr
       and wmc.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
       and wmc.player_name is not null
  ),
  resolved as (
    select wm.*, coalesce(np_direct.id, np_alias.id) as pid,
           -- uses for THIS Moment; 99 stands for unlimited inside the aggregate
           greatest(
             case when wm.fmv_usd > 1000 then 99 when wm.fmv_usd > 300 then 4
                  when wm.fmv_usd > 50 then 3 when wm.fmv_usd > 10 then 2 else 1 end,
             case wm.tier when 'ULTIMATE' then 99 when 'LEGENDARY' then 4 when 'RARE' then 2 else 1 end
           ) as uses
      from wm
      left join nba_players np_direct on np_direct.full_name_normalized = normalize_player_name(wm.player_name)
      left join nba_player_aliases npa on npa.alias_normalized = normalize_player_name(wm.player_name)
      left join nba_players np_alias on np_alias.id = npa.nba_player_id
     where coalesce(np_direct.id, np_alias.id) is not null
  ),
  best as (
    select distinct on (pid) pid, tier, moment_id, serial_number, fmv_usd, uses
      from resolved
     order by pid, uses desc,
              case tier when 'ULTIMATE' then 5 when 'LEGENDARY' then 4 when 'RARE' then 3
                        when 'FANDOM' then 2 else 1 end desc,
              serial_number asc nulls last
  ),
  totals as (
    select pid, count(*)::int as total_owned, bool_or(is_locked) as has_locked from resolved group by pid
  ),
  used as (
    select u.nba_player_id as pid, u.times_used
      from fast_break_player_uses u
     where p_run_id is not null and u.run_id = p_run_id
  )
  select b.pid, np.full_name, np.current_team_abbr, b.tier,
         case when b.uses >= 99 then null else b.uses::smallint end,
         b.moment_id, b.serial_number, b.fmv_usd,
         t.total_owned, t.has_locked,
         coalesce(u.times_used, 0)::smallint,
         case when b.uses >= 99 then null
              else greatest(b.uses - coalesce(u.times_used, 0), 0)::smallint end
    from best b
    join nba_players np on np.id = b.pid
    left join totals t on t.pid = b.pid
    left join used u on u.pid = b.pid
   order by np.full_name;
$function$;
-- anon-exec: revoked (get_fb_eligible_players_v2) — new; only the service-role Fast Break routes call it.
revoke execute on function public.get_fb_eligible_players_v2(text, uuid) from public, anon, authenticated;
grant execute on function public.get_fb_eligible_players_v2(text, uuid) to service_role;

update public.fast_break_runs set has_captain = true where name = 'Classic Run — Nov 16–29';

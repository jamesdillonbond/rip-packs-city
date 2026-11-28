-- audit_20261128_fast_break_eligible_v3_topshot_asp
--
-- Trevor 2026-11-28 7:33 AM PT ("Keep going and activate it … do research on all of the current
-- rules of fb"). v2 (20261128051325) priced a Moment's uses off RPC's FMV and matched Top Shot's
-- own use count on 106 of 115 of Trevor's players on tonight's slate. Read on
-- nbatopshot.com/fastbreak (each player card's "N of M plays left"), the rule that matches ALL
-- 116 of 116 is:
--   uses per Moment = max(price band of Top Shot's OWN average sale price
--                         [badge_editions.avg_sale_price; $0 / none = unlimited "Hall of Fame",
--                          $0.01–10 → 1, $10.01–50 → 2, $50.01–300 → 3, $300.01–1,000 → 4,
--                          $1,000.01+ → unlimited],
--                         tier floor [Common/Fandom 1, Rare 2, Legendary 4, Ultimate unlimited])
--   a player's uses = his best Moment's ("Fast Break will prioritize the Moment that has the most
--   usages", help center). FMV-only scored 106/115; ASP-only without tier floors 60/116; Legendary
--   floor = unlimited 91/116 — so Legendary 4 is now MEASURED, not assumed.
-- Also: v1/v2 read fast_break_player_uses by run only — every collector's plays counted against
-- everyone. v3 takes p_user_id and counts only that user's.
-- v2 stays (no DROP) until the routes have moved; retire it in a later migration.
-- Revert: drop function public.get_fb_eligible_players_v3(text, uuid, uuid); point the routes back at v2.

create or replace function public.get_fb_eligible_players_v3(
  p_wallet_addr text, p_run_id uuid default null, p_user_id uuid default null)
returns table (
  nba_player_id uuid, full_name text, current_team_abbr text, highest_tier text,
  total_allowed smallint, best_moment_id text, best_serial integer, best_asp_usd numeric,
  total_owned integer, has_locked boolean, times_used smallint, remaining_uses smallint)
language sql
stable
set search_path to 'pg_catalog', 'public'
as $function$
  with wm as (
    select wmc.player_name, upper(wmc.tier::text) as tier, wmc.serial_number, wmc.moment_id,
           be.avg_sale_price as asp, coalesce(wmc.is_locked, false) as is_locked
      from wallet_moments_cache wmc
      left join badge_editions be
        on be.collection_id = wmc.collection_id and be.external_id = wmc.edition_key
     where wmc.wallet_address = p_wallet_addr
       and wmc.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
       and wmc.player_name is not null
  ),
  resolved as (
    select wm.*, coalesce(np_direct.id, np_alias.id) as pid,
           -- 99 stands for unlimited inside the aggregate
           greatest(
             case when coalesce(wm.asp, 0) = 0 or wm.asp > 1000 then 99
                  when wm.asp > 300 then 4 when wm.asp > 50 then 3 when wm.asp > 10 then 2 else 1 end,
             case wm.tier when 'ULTIMATE' then 99 when 'LEGENDARY' then 4 when 'RARE' then 2 else 1 end
           ) as uses
      from wm
      left join nba_players np_direct on np_direct.full_name_normalized = normalize_player_name(wm.player_name)
      left join nba_player_aliases npa on npa.alias_normalized = normalize_player_name(wm.player_name)
      left join nba_players np_alias on np_alias.id = npa.nba_player_id
     where coalesce(np_direct.id, np_alias.id) is not null
  ),
  best as (
    select distinct on (pid) pid, tier, moment_id, serial_number, asp, uses
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
     where p_run_id is not null and p_user_id is not null
       and u.run_id = p_run_id and u.user_id = p_user_id
  )
  select b.pid, np.full_name, np.current_team_abbr, b.tier,
         case when b.uses >= 99 then null else b.uses::smallint end,
         b.moment_id, b.serial_number, b.asp,
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
-- anon-exec: revoked (get_fb_eligible_players_v3) — new; only the service-role Fast Break routes call it.
revoke execute on function public.get_fb_eligible_players_v3(text, uuid, uuid) from public, anon, authenticated;
grant execute on function public.get_fb_eligible_players_v3(text, uuid, uuid) to service_role;

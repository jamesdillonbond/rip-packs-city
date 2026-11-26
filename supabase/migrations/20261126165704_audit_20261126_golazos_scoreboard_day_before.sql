-- audit_20261126_golazos_scoreboard_day_before
--
-- Golazos dates some Moments a day after the match (2023-01-23 Athletic Club v Real Madrid was played
-- Sunday 01-22; 2023-02-06 FC Barcelona v Sevilla FC on 02-05) — measured on the lane's first 40 dates:
-- 64 / 76 editions paired with exactly one match on their own date, 12 did not, all late-January /
-- February 2023 matches played the evening before. The dispatch now fetches each Golazos date AND the
-- day before; the reader pairs on either (both clubs, exactly one match). Body otherwise identical to
-- 20261126165600.
--
-- Revert: re-apply espn_soccer_scoreboard_dispatch from 20261126165600_audit_20261126_golazos_match_results_lane.sql.

CREATE OR REPLACE FUNCTION public.espn_soccer_scoreboard_dispatch(p_limit int default 40)
returns int
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare
  r     record;
  v_req bigint;
  v_n   int := 0;
begin
  if not pg_try_advisory_xact_lock(hashtext('espn_soccer_scoreboard_dispatch')::bigint) then
    return 0;
  end if;
  for r in
    select d.match_date
      from (select distinct x.match_date
              from public.editions e
              join public.collections c on c.id = e.collection_id and c.slug = 'laliga_golazos'
              cross join lateral (values (e.game_date), (e.game_date - 1)) x(match_date)
             where e.game_date is not null) d
      left join public.espn_soccer_scoreboard_fetches f on f.league = 'esp.1' and f.match_date = d.match_date
     where f.match_date is null
        or (f.status = 'error' and f.attempts < 3 and coalesce(f.fetched_at, f.requested_at) < now() - interval '1 hour')
        or (f.status = 'requested' and f.attempts < 3 and f.requested_at < now() - interval '1 hour')
     order by d.match_date desc
     limit greatest(1, least(coalesce(p_limit, 40), 100))
  loop
    v_req := net.http_get('https://site.api.espn.com/apis/site/v2/sports/soccer/esp.1/scoreboard?dates=' || to_char(r.match_date, 'YYYYMMDD'));
    insert into public.espn_soccer_scoreboard_fetches as f (league, match_date, status, request_id, requested_at, attempts)
    values ('esp.1', r.match_date, 'requested', v_req, now(), 1)
    on conflict (league, match_date) do update
       set status = 'requested', request_id = excluded.request_id, requested_at = now(), attempts = f.attempts + 1;
    v_n := v_n + 1;
  end loop;
  return v_n;
end
$$;
-- anon-exec: unchanged (espn_soccer_scoreboard_dispatch) — CREATE OR REPLACE of an existing fn; ACL preserved, verified anon=false via has_function_privilege 2026-11-26.

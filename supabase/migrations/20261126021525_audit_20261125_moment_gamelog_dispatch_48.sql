-- audit_20261125_moment_gamelog_dispatch_48
--
-- The moment-game-lines lane's first scheduled drain (2026-11-25 6:05 PM PT) took 874 ms for 24 ESPN
-- game logs, 0 errors. Doubling the per-tick batch 24 -> 48 (drain limit stays 60 per tick) brings the
-- ~6,000-target backfill from ~2.5 days to ~21 hours: ~5 ESPN requests a minute from this lane, beside
-- espn-game-logs' ~4. Body otherwise identical to 20261126020013 (live prosrc md5 verified equal to the
-- file before this replace).
--
-- Revert: re-apply the moment_gamelog_dispatch body of 20261126020013_audit_20261125_moment_game_lines.sql.

create or replace function public.moment_gamelog_dispatch()
returns jsonb language plpgsql
set search_path = pg_catalog, public
as $$
declare
  t     record;
  v_req bigint;
  v_n   int := 0;
begin
  if exists (select 1 from public.player_gamelog_requests
              where drained_at is null and dispatched_at > now() - interval '10 minutes') then
    return jsonb_build_object('skipped', 'in_flight');
  end if;
  for t in select * from public.moment_gamelog_targets(48) loop
    v_req := net.http_get(
      url := 'https://site.web.api.espn.com/apis/common/v3/sports/'
             || case t.espn_league when 'nfl' then 'football/nfl' when 'wnba' then 'basketball/wnba' else 'basketball/nba' end
             || '/athletes/' || t.espn_id || '/gamelog?season=' || t.season,
      timeout_milliseconds := 30000);
    insert into public.player_gamelog_requests (request_id, espn_league, espn_id, season)
    values (v_req, t.espn_league, t.espn_id, t.season);
    insert into public.player_gamelog_fetches (espn_league, espn_id, season, status, attempts, requested_at)
    values (t.espn_league, t.espn_id, t.season, 'requested', 1, now())
    on conflict (espn_league, espn_id, season) do update
       set status = 'requested', attempts = public.player_gamelog_fetches.attempts + 1, requested_at = now();
    v_n := v_n + 1;
  end loop;
  return jsonb_build_object('requests', v_n);
end
$$;

-- anon-exec: unchanged (moment_gamelog_dispatch) — CREATE OR REPLACE of an existing fn; ACL preserved, verified anon=false via has_function_privilege 2026-11-25.

update public.fast_break_runs
   set contest_id = 'contest-run-nba-classic-2026-11-16'
 where contest_id = 'contest-run-nba-classic-2026-11-16-2026-11-29';

create or replace function public.fast_break_ingest_topshot(p jsonb)
returns jsonb
language plpgsql
set search_path to 'pg_catalog', 'public'
as $function$
declare
  v_contest text := regexp_replace(coalesce(p->>'contest_id', ''),
                      '^(contest-run-nba-(classic|pro)-\d{4}-\d{2}-\d{2})-\d{4}-\d{2}-\d{2}$', '\1');
  v_m text[];
  v_mode text;
  v_start date;
  v_end date;
  v_today date := coalesce((p->>'today')::date, (now() at time zone 'America/New_York')::date);
  v_user uuid := (p->>'user_id')::uuid;
  v_run uuid;
  v_name text;
  v_nights int := 0;
  v_unparsed int := 0;
  v_cards int := 0;
  v_unresolved int := 0;
  v_uses int := 0;
begin
  v_m := regexp_match(v_contest, '^contest-run-nba-(classic|pro)-(\d{4}-\d{2}-\d{2})$');
  if v_m is null then
    raise exception 'fast_break_ingest_topshot: unrecognised contest id %', p->>'contest_id';
  end if;
  v_mode := v_m[1];
  v_start := v_m[2]::date;
  select max((x->>'date')::date) into v_end
    from jsonb_array_elements(coalesce(p->'nights', '[]'::jsonb)) x;
  if v_end is null or v_end < v_start then
    raise exception 'fast_break_ingest_topshot: no nights for %', v_contest;
  end if;

  insert into public.fast_break_runs as r
    (name, start_date, end_date, lineup_size, format, objective, has_captain, is_active, mode, contest_id)
  values ('', v_start, v_end, 5, v_mode, 'thresholds', true, false, v_mode, v_contest)
  on conflict (contest_id) where contest_id is not null
  do update set start_date = excluded.start_date,
                end_date = greatest(r.end_date, excluded.end_date),
                mode = excluded.mode
  returning id, end_date into v_run, v_end;

  v_name := initcap(v_mode) || ' Run — ' || to_char(v_start, 'Mon FMDD') || '–' ||
            case when date_trunc('month', v_start) = date_trunc('month', v_end)
                 then to_char(v_end, 'FMDD') else to_char(v_end, 'Mon FMDD') end;
  update public.fast_break_runs set name = v_name where id = v_run and name is distinct from v_name;

  if v_today between v_start and v_end then
    update public.fast_break_runs set is_active = (id = v_run)
     where mode = v_mode and is_active is distinct from (id = v_run);
  end if;

  insert into public.fast_break_nights as n (run_id, game_date, objective, targets, source)
  select v_run, (x->>'date')::date, x->>'objective',
         public.fast_break_parse_targets(x->>'objective'), 'topshot_page_sync'
    from jsonb_array_elements(coalesce(p->'nights', '[]'::jsonb)) x
   where x->>'date' is not null and coalesce(x->>'objective', '') <> ''
  on conflict (run_id, game_date) do update
     set objective = excluded.objective, targets = excluded.targets, source = excluded.source;
  get diagnostics v_nights = row_count;
  select count(*) into v_unparsed
    from public.fast_break_nights where run_id = v_run and targets = '{}'::jsonb;

  if v_user is not null and jsonb_typeof(p->'players') = 'array' then
    insert into public.fast_break_topshot_cards as c
      (user_id, run_id, game_date, player_name, nba_player_id, plays_left, plays_total, captured_at)
    select v_user, v_run, v_today, x->>'name',
           (select coalesce(np.id, npa.nba_player_id)
              from (select public.normalize_player_name(x->>'name') as k) kk
              left join public.nba_players np on np.full_name_normalized = kk.k
              left join public.nba_player_aliases npa on npa.alias_normalized = kk.k
             limit 1),
           nullif(x->>'left', '')::smallint, nullif(x->>'total', '')::smallint, now()
      from jsonb_array_elements(p->'players') x
     where coalesce(x->>'name', '') <> ''
    on conflict (user_id, run_id, game_date, player_name) do update
       set nba_player_id = excluded.nba_player_id, plays_left = excluded.plays_left,
           plays_total = excluded.plays_total, captured_at = excluded.captured_at;
    get diagnostics v_cards = row_count;
    select count(*) into v_unresolved
      from public.fast_break_topshot_cards
     where user_id = v_user and run_id = v_run and game_date = v_today and nba_player_id is null;

    if p->>'wallet' is not null then
      insert into public.fast_break_player_uses as u
        (user_id, run_id, nba_player_id, highest_tier_owned, total_allowed, times_used,
         dates_used, best_moment_id, best_serial, updated_at)
      select v_user, v_run, c.nba_player_id, e.highest_tier::tier_type, c.plays_total,
             c.plays_total - c.plays_left, '{}'::date[], e.best_moment_id, e.best_serial, now()
        from public.fast_break_topshot_cards c
        join public.get_fb_eligible_players_v3(p->>'wallet', v_run, v_user) e
          on e.nba_player_id = c.nba_player_id
       where c.user_id = v_user and c.run_id = v_run and c.game_date = v_today
         and c.plays_total is not null and c.plays_left is not null
         and c.plays_total - c.plays_left > 0
      on conflict (user_id, run_id, nba_player_id) do update
         set times_used = excluded.times_used,
             total_allowed = excluded.total_allowed, updated_at = now();
      get diagnostics v_uses = row_count;
    end if;
  end if;

  return jsonb_build_object('run_id', v_run, 'run', v_name, 'mode', v_mode,
                            'active', v_today between v_start and v_end,
                            'nights_upserted', v_nights, 'nights_unparsed', v_unparsed,
                            'cards', v_cards, 'cards_unresolved', v_unresolved, 'uses_synced', v_uses);
end
$function$;
-- anon-exec: unchanged (fast_break_ingest_topshot) — CREATE OR REPLACE of an existing fn, same signature; ACL preserved (revoked in the page-sync migration).
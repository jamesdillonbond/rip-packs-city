-- audit_20261128_fast_break_topshot_page_sync — repo file supabase/migrations/<version>_audit_20261128_fast_break_topshot_page_sync.sql
set local lock_timeout = '3s';

alter table public.fast_break_runs
  add column if not exists mode text not null default 'classic',
  add column if not exists contest_id text;
alter table public.fast_break_runs drop constraint if exists fast_break_runs_mode_check;
alter table public.fast_break_runs add constraint fast_break_runs_mode_check
  check (mode = any (array['classic', 'pro', 'historic']));
create unique index if not exists fast_break_runs_contest_id_key
  on public.fast_break_runs (contest_id) where contest_id is not null;

update public.fast_break_runs
   set contest_id = 'contest-run-nba-classic-2026-11-16-2026-11-29'
 where name = 'Classic Run — Nov 16–29' and contest_id is null;

create table if not exists public.fast_break_topshot_cards (
  user_id        uuid not null,
  run_id         uuid not null references public.fast_break_runs(id) on delete cascade,
  game_date      date not null,
  player_name    text not null,
  nba_player_id  uuid references public.nba_players(id) on delete set null,
  plays_left     smallint,
  plays_total    smallint,
  captured_at    timestamptz not null default now(),
  primary key (user_id, run_id, game_date, player_name)
);
create index if not exists fast_break_topshot_cards_run_date_idx
  on public.fast_break_topshot_cards (run_id, game_date, user_id);
alter table public.fast_break_topshot_cards enable row level security;
revoke all on public.fast_break_topshot_cards from anon, authenticated;
comment on table public.fast_break_topshot_cards is
  'What nbatopshot.com/fastbreak lists for one collector, run and night: the players the mode '
  'allows (Pro eligibility) and Top Shot''s own "N of M plays left". Written by '
  'fast_break_ingest_topshot() from a scheduled read of the collector''s signed-in page. Service role only.';

create or replace function public.fast_break_parse_targets(p_objective text)
returns jsonb
language plpgsql immutable
set search_path to 'pg_catalog'
as $function$
declare
  v_body text;
  v_clause text;
  v_m text[];
  v_key text;
  v_out jsonb := '{}'::jsonb;
begin
  if p_objective is null then return '{}'::jsonb; end if;
  v_body := regexp_replace(trim(p_objective), '^Combine for\s+', '', 'i');
  foreach v_clause in array regexp_split_to_array(v_body, '\s*\+\s*') loop
    v_m := regexp_match(trim(v_clause), '^(\d+)\s+(.+)$');
    if v_m is null then return '{}'::jsonb; end if;
    v_key := case lower(trim(v_m[2]))
      when 'points' then 'pts' when 'rebounds' then 'reb' when 'assists' then 'ast'
      when 'steals' then 'stl' when 'blocks' then 'blk' when 'turnovers' then 'tov'
      when '3-pointers made' then 'fg3m' when '3-pointers attempted' then 'fg3a'
      when 'field goals made' then 'fgm' when 'field goals attempted' then 'fga'
      when 'free throws made' then 'ftm' when 'free throws attempted' then 'fta'
      else null end;
    if v_key is null then return '{}'::jsonb; end if;
    v_out := v_out || jsonb_build_object(v_key, v_m[1]::int);
  end loop;
  return v_out;
end
$function$;
-- anon-exec: revoked (fast_break_parse_targets) — new pure helper for the ingest only.
revoke execute on function public.fast_break_parse_targets(text) from public, anon, authenticated;

create or replace function public.fast_break_ingest_topshot(p jsonb)
returns jsonb
language plpgsql
set search_path to 'pg_catalog', 'public'
as $function$
declare
  v_contest text := p->>'contest_id';
  v_m text[];
  v_mode text;
  v_start date;
  v_end date;
  v_today date := coalesce((p->>'today')::date, (now() at time zone 'America/Los_Angeles')::date);
  v_user uuid := (p->>'user_id')::uuid;
  v_run uuid;
  v_name text;
  v_nights int := 0;
  v_unparsed int := 0;
  v_cards int := 0;
  v_unresolved int := 0;
  v_uses int := 0;
begin
  v_m := regexp_match(coalesce(v_contest, ''), '^contest-run-nba-(classic|pro)-(\d{4}-\d{2}-\d{2})-(\d{4}-\d{2}-\d{2})$');
  if v_m is null then
    raise exception 'fast_break_ingest_topshot: unrecognised contest id %', v_contest;
  end if;
  v_mode := v_m[1]; v_start := v_m[2]::date; v_end := v_m[3]::date;
  v_name := initcap(v_mode) || ' Run — ' || to_char(v_start, 'Mon FMDD') || '–' ||
            case when date_trunc('month', v_start) = date_trunc('month', v_end)
                 then to_char(v_end, 'FMDD') else to_char(v_end, 'Mon FMDD') end;

  insert into public.fast_break_runs as r
    (name, start_date, end_date, lineup_size, format, objective, has_captain, is_active, mode, contest_id)
  values (v_name, v_start, v_end, 5, v_mode, 'thresholds', true, false, v_mode, v_contest)
  on conflict (contest_id) where contest_id is not null
  do update set start_date = excluded.start_date, end_date = excluded.end_date, mode = excluded.mode
  returning id into v_run;

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
-- anon-exec: revoked (fast_break_ingest_topshot) — new writer; only the scheduled page sync (postgres via MCP) calls it.
revoke execute on function public.fast_break_ingest_topshot(jsonb) from public, anon, authenticated;
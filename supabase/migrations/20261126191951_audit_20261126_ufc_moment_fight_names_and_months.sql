-- audit_20261126_ufc_moment_fight_names_and_months
--
-- get_ufc_moment_fight (20261126191332) resolved 500 of 625 UFC Strike Moments, every one a WIN for
-- the Moment's fighter (a KO / submission Moment is the winner's — the check that the pairing is
-- right). The misses, read one by one (11-26):
--   * Strike writes months in full: "UFC FIGHT NIGHT JUNE 23 2018", "JULY 28 2018" (56 Moments) —
--     the first three letters are the month;
--   * Strike and ESPN name some fighters differently: "Shogun Rua" / "Mauricio Rua", "Ian Garry" /
--     "Ian Machado Garry", "Jun Yong Park" / "JunYong Park" (22) — on ONE card, a surname is a person
--     when exactly one fighter carries it (a suffix like Jr. or II is not the surname);
--   * two Fight Nights are named by their main event ("UFC FIGHT NIGHT GARCIA VS ONAMA").
-- Measured with this body before applying: 563 of 587 event-named Moments resolve, 563 wins, 0
-- losses. Still NULL (no claim): an event ESPN files on another date (6), two events on one date (2),
-- a fighter in two bouts of one night (UFC 4 / UFC 10 tournaments), a surname shared or not found (12).
--
-- Revert: re-apply get_ufc_moment_fight from 20261126191332.

CREATE OR REPLACE FUNCTION public.get_ufc_moment_fight(p_edition_id uuid)
returns jsonb
language plpgsql stable security definer
set search_path = pg_catalog, public
as $$
declare
  v_set    text;
  v_name   text;
  v_last   text;
  v_num    text;
  v_date   date;
  v_parts  text[];
  v_events text[];
  v_n      int;
  v_side   public.espn_mma_fight_sides%rowtype;
begin
  select e.set_name, public.ufc_name_key(e.player_name)
    into v_set, v_name
    from public.editions e
    join public.collections c on c.id = e.collection_id and c.slug = 'ufc_strike'
   where e.id = p_edition_id;
  if v_set is null or v_name is null then
    return null;
  end if;

  v_num := substring(v_set from '^UFC (\d+)(?:\s|$)');
  if v_num is not null then
    select array_agg(distinct s.event_id) into v_events
      from public.espn_mma_fight_sides s
     where s.event_name ~* ('^UFC ' || v_num || '([^0-9]|$)');
  elsif v_set ~ '^UFC FIGHT NIGHT [A-Z][A-Z'' -]* VS [A-Z]' then
    -- a Fight Night named by its main event ("UFC FIGHT NIGHT GARCIA VS ONAMA KO TKO"): ESPN's
    -- "UFC Fight Night: Garcia vs. Onama" — both names, in order, right after the colon
    v_parts := regexp_match(v_set, '^UFC FIGHT NIGHT ([A-Z][A-Z'' -]*?) VS ([A-Z][A-Z''-]*)');
    select array_agg(distinct s.event_id) into v_events
      from public.espn_mma_fight_sides s
     where public.ufc_name_key(s.event_name) like 'ufc fight night ' || public.ufc_name_key(v_parts[1]) || ' vs ' || public.ufc_name_key(v_parts[2]) || '%';
  else
    -- Strike writes both "JUN 23 2018" and "JUNE 23 2018" (and "SEPT"): the first three letters are the month
    v_parts := regexp_match(v_set, '^UFC FIGHT NIGHT (JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)[A-Z]* (\d{1,2}) (\d{4})');
    if v_parts is null or v_parts[2]::int not between 1 and 31 then
      return null;
    end if;
    v_date := make_date(v_parts[3]::int,
                        array_position(array['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'], v_parts[1]),
                        v_parts[2]::int);
    select array_agg(distinct s.event_id) into v_events
      from public.espn_mma_fight_sides s
     where (s.event_at at time zone 'UTC')::date in (v_date, v_date + 1)
       and s.event_name !~* 'contender';
  end if;
  if coalesce(array_length(v_events, 1), 0) <> 1 then
    return null;
  end if;

  select count(*) into v_n
    from public.espn_mma_fight_sides s
   where s.event_id = v_events[1] and public.ufc_name_key(s.athlete_name) = v_name;
  if v_n = 1 then
    select s.* into v_side
      from public.espn_mma_fight_sides s
     where s.event_id = v_events[1] and public.ufc_name_key(s.athlete_name) = v_name;
  elsif v_n = 0 then
    -- Strike and ESPN name some fighters differently ("Shogun Rua" / "Mauricio Rua", "Ian Garry" /
    -- "Ian Machado Garry", "Raul Rosas" / "Raul Rosas Jr."). On ONE card, a surname is a person when
    -- exactly one fighter carries it (a suffix like Jr. or II is not the surname).
    v_last := (regexp_match(regexp_replace(v_name, '( (jr|sr|ii|iii|iv))+$', ''), '([a-z0-9]+)$'))[1];
    if v_last is null or length(v_last) < 3 then
      return null;
    end if;
    select count(*) into v_n
      from public.espn_mma_fight_sides s
     where s.event_id = v_events[1]
       and (regexp_match(regexp_replace(public.ufc_name_key(s.athlete_name), '( (jr|sr|ii|iii|iv))+$', ''), '([a-z0-9]+)$'))[1] = v_last;
    if v_n <> 1 then
      return null;
    end if;
    select s.* into v_side
      from public.espn_mma_fight_sides s
     where s.event_id = v_events[1]
       and (regexp_match(regexp_replace(public.ufc_name_key(s.athlete_name), '( (jr|sr|ii|iii|iv))+$', ''), '([a-z0-9]+)$'))[1] = v_last;
  else
    return null;
  end if;

  return jsonb_build_object(
    'event_id', v_side.event_id,
    'event_name', v_side.event_name,
    -- the card's date as ESPN shows it (US Eastern: a 00:00Z start is the night before)
    'event_date', to_char(v_side.event_at at time zone 'America/New_York', 'YYYY-MM-DD'),
    'weight_class', v_side.weight_class,
    'rounds', v_side.rounds,
    'end_period', v_side.end_period,
    'end_clock', v_side.end_clock,
    'completed', v_side.completed,
    'winner', v_side.winner,
    'opponent_name', v_side.opponent_name,
    'set_name', v_set
  );
end
$$;
-- anon-exec: unchanged (get_ufc_moment_fight) — CREATE OR REPLACE of an existing fn; ACL preserved, verified anon=false (has_function_privilege, 11-26).

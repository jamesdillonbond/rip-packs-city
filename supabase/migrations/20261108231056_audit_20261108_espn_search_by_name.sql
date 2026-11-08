-- audit_20261108_espn_search_by_name
--
-- espn_search_tick queried ESPN's player search with the name SLUG (dashes -> spaces), which splits
-- initials and apostrophes into fragments ESPN cannot match: "J.T. Realmuto" -> "j t realmuto",
-- "Tyler O'Neill" -> "tyler o neill", "Ke'Bryan Hayes" -> "ke bryan hayes", "D'Moi Hodge" — all
-- total_found 0 (measured 2026-11-08; the same names searched as written return the player). Now the
-- player label is sent, percent-encoded by a new public.rpc_urlencode(text). The LINK rule is unchanged:
-- a hit counts only when rpc_name_slug(displayName) equals the key.
-- Re-search: single-person keys (no " | " — a multi-player card has no one bio) that came back with
-- 0 hits and whose name carries punctuation are dropped from the queue so the tick asks again.
-- Base: live prosrc md5 847a0e34892c7100bbd89dff2d72443d (= 20261108214928 body), re-read 2026-11-08.
--
-- Revert: re-apply the 20261108214928 body of espn_search_tick; drop function public.rpc_urlencode(text);

create or replace function public.rpc_urlencode(p text)
returns text language sql immutable strict parallel safe
set search_path = pg_catalog
as $$
  select coalesce(string_agg(case when c ~ '^[A-Za-z0-9._~-]$' then c
                                  else regexp_replace(upper(encode(convert_to(c, 'UTF8'), 'hex')), '(..)', '%\1', 'g') end,
                             '' order by ord), '')
    from regexp_split_to_table(p, '') with ordinality as t(c, ord)
$$;
revoke all on function public.rpc_urlencode(text) from public, anon, authenticated;
-- anon-exec: revoked (rpc_urlencode) — new fn; REVOKE FROM PUBLIC, anon, authenticated; owner-only; verified anon=false via has_function_privilege 2026-11-08.

create or replace function public.espn_search_tick()
returns jsonb language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_started   timestamptz := clock_timestamp();
  v_drained   int := 0;
  v_errs      int := 0;
  v_requested int := 0;
  v_xw        jsonb;
  v_ok_run    boolean;
begin
  if not pg_try_advisory_xact_lock(hashtext('espn_search_tick')::bigint) then
    return jsonb_build_object('skipped', 'concurrent');
  end if;

  -- 1. Drain: total player hits + the hits whose name slug equals the key in the key's sport.
  with r as (
    select q.collection_slug, q.name_slug, q.sport, h.status_code, h.error_msg,
           case when h.status_code = 200 and not coalesce(h.timed_out, false)
                     and pg_input_is_valid(h.content, 'jsonb')
                then h.content::jsonb end as body
      from public.espn_search_queue q
      left join net._http_response h on h.id = q.request_id
     where q.request_id is not null
       and (h.id is not null or q.requested_at < now() - interval '10 minutes')
  ), p as (
    select r.*,
           (select (t->>'totalFound')::int from jsonb_array_elements(r.body->'resultTypes') t where t->>'type' = 'player' limit 1) as total,
           (select coalesce(jsonb_agg(distinct jsonb_build_object(
                     'espn_id', substring(x->>'uid' from 'a:(\d+)$'), 'name', x->>'displayName',
                     'league', x->>'defaultLeagueSlug')), '[]'::jsonb)
              from jsonb_array_elements(coalesce(r.body->'results', '[]'::jsonb)) res
             cross join lateral jsonb_array_elements(coalesce(res->'contents', '[]'::jsonb)) x
             where res->>'type' = 'player' and x->>'sport' = r.sport
               and public.rpc_name_slug(x->>'displayName') = r.name_slug
               and substring(x->>'uid' from 'a:(\d+)$') is not null) as exact
      from r
  ), u as (
    update public.espn_search_queue q
       set status      = case when p.body is null then 'error' else 'done' end,
           total_found = case when p.body is null then q.total_found else coalesce(p.total, 0) end,
           exact       = case when p.body is null then q.exact else p.exact end,
           fetched_at  = now(),
           request_id  = null,
           last_error  = case when p.body is null
                              then left('espn search ' || coalesce(p.status_code::text, 'no-response') || ' ' || coalesce(p.error_msg, ''), 200) end
      from p
     where q.collection_slug = p.collection_slug and q.name_slug = p.name_slug and q.sport = p.sport
    returning q.status
  )
  select count(*), count(*) filter (where status = 'error') into v_drained, v_errs from u;

  -- 2. Rebuild the UFC / Panini crosswalk (also called by the bio tick once DOBs land).
  if v_drained > 0 then
    v_xw := public.refresh_espn_search_crosswalk();
  end if;

  -- 3. Dispatch: never-searched keys first; an error retries after a day, 3 tries max.
  with need as (
    select p.collection_slug, p.name_slug, p.sport, p.player_label
      from public.espn_search_population() p
      left join public.espn_search_queue q
        on q.collection_slug = p.collection_slug and q.name_slug = p.name_slug and q.sport = p.sport
     where q.name_slug is null
        or (q.request_id is null and q.status = 'error' and q.attempts < 3 and q.fetched_at < now() - interval '1 day')
     order by (q.name_slug is not null), p.collection_slug, p.name_slug
     limit 150
  ), req as (
    select n.*,
           -- Query by the NAME, percent-encoded — the slug split initials and apostrophes into
           -- fragments ("j t realmuto", "tyler o neill", "ke bryan hayes") that ESPN answers with 0
           -- hits (measured 2026-11-08). The match is still the exact slug equality below.
           net.http_get(format('https://site.web.api.espn.com/apis/search/v2?query=%s&limit=25&type=player',
                               public.rpc_urlencode(coalesce(nullif(btrim(n.player_label), ''), replace(n.name_slug, '-', ' ')))),
                        timeout_milliseconds := 15000) as request_id
      from need n
  ), ins as (
    insert into public.espn_search_queue as q (collection_slug, name_slug, sport, player_label, status, request_id, requested_at, attempts)
    select collection_slug, name_slug, sport, player_label, 'new', request_id, now(), 1 from req
    on conflict (collection_slug, name_slug, sport) do update set
      player_label = excluded.player_label, request_id = excluded.request_id, requested_at = now(), attempts = q.attempts + 1
    returning 1
  )
  select count(*) into v_requested from ins;

  if v_drained = 0 and v_requested = 0 then
    return jsonb_build_object('idle', true);
  end if;

  v_ok_run := v_errs = 0 or v_errs < v_drained / 4.0;
  perform public.log_pipeline_run(
    'espn-search-crosswalk', v_started, v_drained + v_requested, v_drained - v_errs, 0, v_ok_run,
    case when v_errs > 0 then v_errs || ' of ' || v_drained || ' ESPN searches failed' end,
    null, null, null,
    jsonb_build_object('drained', v_drained, 'errors', v_errs, 'requested', v_requested, 'crosswalk', v_xw,
                       'duration_ms', (extract(epoch from clock_timestamp() - v_started) * 1000)::int));
  return jsonb_build_object('ok', v_ok_run, 'drained', v_drained, 'errors', v_errs, 'requested', v_requested, 'crosswalk', v_xw);
end
$$;
-- anon-exec: unchanged (espn_search_tick) — CREATE OR REPLACE of an existing fn; ACL preserved, verified anon=false via has_function_privilege 2026-11-08.

delete from public.espn_search_queue
 where status = 'done' and coalesce(total_found, 0) = 0 and request_id is null
   and player_label !~ ' \| ' and player_label ~ '[^A-Za-z ]';

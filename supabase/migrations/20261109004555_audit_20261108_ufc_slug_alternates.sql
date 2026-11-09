-- audit_20261108_ufc_slug_alternates
--
-- UFC.com's athlete slug is not always the card's name (measured 2026-11-08, 19 real fighters
-- not_found): Sean O'Malley -> sean-omalley, Daniel Hooker -> dan-hooker, Shogun Rua -> mauricio-rua,
-- Renato Carneiro -> renato-moicano, Jair Rozenstruik -> jairzinho-rozenstruik … The queue gains
-- alt_slugs: generic variants (apostrophes dropped, "-jr", short first names, first + last token)
-- plus a small explicit alias list. On a not-found the tick moves to the next alternate. An alternate
-- can never publish a wrong person: every page still has to pass ufc-dob-agrees / ufc-event-confirmed.
-- Base: live prosrc md5 3b200088d005a386b5496670b4ae2d8b (= 20261108224008 body), re-read 2026-11-08.
--
-- Revert: re-apply the 20261108224008 body of ufc_athlete_bio_tick; alter table public.ufc_athlete_bio
--   drop column alt_slugs; drop function public.ufc_slug_alternates(text);

alter table public.ufc_athlete_bio add column if not exists alt_slugs text[] not null default '{}';

create or replace function public.ufc_slug_alternates(p_label text)
returns text[] language sql immutable
set search_path = pg_catalog, public
as $$
  with base as (select public.rpc_name_slug(p_label) as s),
  explicit(k, v) as (values
    ('shogun-rua', 'mauricio-rua'), ('renato-carneiro', 'renato-moicano'), ('jailton-malhadinho', 'jailton-almeida'),
    ('maria-godinez-gonzalez', 'loopy-godinez'), ('mayra-bueno', 'mayra-bueno-silva'), ('jair-rozenstruik', 'jairzinho-rozenstruik'),
    ('natalia-cristina-da-silva', 'natalia-silva'), ('quinton-jackson', 'quinton-rampage-jackson'), ('raul-rosas', 'raul-rosas-jr'),
    ('mingyang-zhang', 'zhang-mingyang'), ('daniel-hooker', 'dan-hooker'), ('stephen-erceg', 'steve-erceg'),
    ('nicholas-maximov', 'nick-maximov'), ('sean-o-malley', 'sean-omalley'), ('da-mon-blackshear', 'damon-blackshear')),
  short(f, t) as (values ('daniel', 'dan'), ('stephen', 'steve'), ('nicholas', 'nick'), ('michael', 'mike'), ('christopher', 'chris'),
                         ('alexander', 'alex'), ('joseph', 'joe'), ('matthew', 'matt'), ('anthony', 'tony'), ('william', 'will')),
  cand as (
    select v as alt, 1 as ord from explicit, base where k = base.s
    union all select public.rpc_name_slug(replace(p_label, '''', '')), 2 from base
    union all select base.s || '-jr', 3 from base
    union all select regexp_replace(base.s, '^' || f || '-', t || '-'), 4 from base, short where base.s like f || '-%'
    union all select split_part(base.s, '-', 1) || '-' || reverse(split_part(reverse(base.s), '-', 1)), 5 from base
  )
  select coalesce(array_agg(alt order by ord) filter (where alt is not null and alt <> (select s from base)), '{}')
    from (select distinct on (alt) alt, ord from cand order by alt, ord) d
$$;
revoke all on function public.ufc_slug_alternates(text) from public, anon, authenticated;
-- anon-exec: revoked (ufc_slug_alternates) — new fn; REVOKE FROM PUBLIC, anon, authenticated; owner-only; verified anon=false via has_function_privilege 2026-11-08.

create or replace function public.ufc_athlete_bio_tick()
returns jsonb language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_drained int := 0;
  v_slug text;
  v_ufc text;
  v_req bigint;
begin
  if not pg_try_advisory_xact_lock(hashtext('ufc_athlete_bio_tick')) then
    return jsonb_build_object('skipped', 'locked');
  end if;

  insert into public.ufc_athlete_bio (name_slug, player_label, ufc_slug)
  select public.rpc_name_slug(p.name), max(p.name::text), public.rpc_name_slug(p.name)
    from public.players p
    join public.collections c on c.id = p.collection_id and c.slug = 'ufc_strike'
   where public.rpc_name_slug(p.name) is not null
   group by 1
  on conflict (name_slug) do nothing;

  -- Drain: responses to earlier ticks' requests (pg_net sends at commit).
  with r as (
    select b.name_slug, h.status_code, h.content,
           substring(h.content from '"url":\s*"(https://www\.ufc\.com/athlete/[^"]+)"') as page_url,
           -- The fighter's own record only (results cards + Fight History); the page head carries
           -- site-wide promos for upcoming events (e.g. a JSON-LD subjectOf "UFC 329" on every page).
           substr(h.content, nullif(strpos(h.content, 'athlete-results'), 0)) as tail
      from public.ufc_athlete_bio b
      join net._http_response h on h.id = b.request_id
     where b.status = 'queued'
  ), d as (
    update public.ufc_athlete_bio b set
      http_status = r.status_code,
      status = case when r.status_code = 200 and r.page_url is not null then 'ok'
                    -- UFC.com's slug may differ from the card name: try the next alternate before giving up.
                    when r.status_code in (200, 404) and cardinality(b.alt_slugs) > 0 then 'pending'
                    when r.status_code in (200, 404) then 'not_found'
                    when b.attempts >= 3 then 'error'
                    else 'pending' end,
      page_url = r.page_url,
      page_name = case when r.page_url is not null then trim(substring(r.content from '<h1[^>]*>\s*([^<]+?)\s*<')) end,
      date_of_birth = case when r.page_url is not null and substring(r.content from '"birthDate":\s*"([0-9]{4}-[0-9]{2}-[0-9]{2})"') is not null
                           then substring(r.content from '"birthDate":\s*"([0-9]{4}-[0-9]{2}-[0-9]{2})"')::date end,
      birth_place = case when r.page_url is not null
                         then nullif(trim(substring(r.content from 'Place of Birth</div>\s*<div class="c-bio__text">([^<]*)</div>')), '') end,
      division = case when r.page_url is not null then trim(substring(r.content from '>\s*([A-Za-z'' ]+ Division)\s*<')) end,
      event_numbers = case when r.page_url is not null then
                        (select array_agg(distinct m[1]::int) from regexp_matches(r.tail, 'UFC ([0-9]{2,3})(?![0-9])', 'g') m) end,
      event_dates = case when r.page_url is not null then
                        (select array_agg(distinct d) from (
                           select to_date(replace(replace(m[1], 'Sept', 'Sep'), '.', ''), 'Mon DD, YYYY') as d
                             from regexp_matches(r.tail, '((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sept|Sep|Oct|Nov|Dec)\.? [0-9]{1,2}, (?:19|20)[0-9]{2})', 'g') m
                           union
                           select to_date(m[1], 'MM/DD/YY')
                             from regexp_matches(r.tail, '\(([0-9]{1,2}/[0-9]{1,2}/[0-9]{2})\)', 'g') m) t) end,
      fetched_at = now(),
      request_id = null,
      ufc_slug = case when r.page_url is null and r.status_code in (200, 404) and cardinality(b.alt_slugs) > 0
                      then b.alt_slugs[1] else b.ufc_slug end,
      alt_slugs = case when r.page_url is null and r.status_code in (200, 404) and cardinality(b.alt_slugs) > 0
                       then b.alt_slugs[2:] else b.alt_slugs end,
      attempts = case when r.page_url is null and r.status_code in (200, 404) and cardinality(b.alt_slugs) > 0
                      then 0 else b.attempts end
    from r
    where r.name_slug = b.name_slug
    returning 1
  )
  select count(*) into v_drained from d;

  -- A request whose response never arrived (pg_net drops after its TTL) goes back to the queue.
  update public.ufc_athlete_bio
     set status = case when attempts >= 3 then 'error' else 'pending' end, request_id = null
   where status = 'queued' and dispatched_at < now() - interval '15 minutes';

  -- Dispatch ONE (robots.txt crawl-delay 15; this runs every 20 s).
  select name_slug, ufc_slug into v_slug, v_ufc
    from public.ufc_athlete_bio
   where status = 'pending'
   order by attempts, name_slug
   limit 1;
  if v_slug is not null then
    v_req := net.http_get('https://www.ufc.com/athlete/' || v_ufc,
                          headers := '{"User-Agent":"Mozilla/5.0 (compatible; RipPacksCity/1.0; +https://www.rippackscity.com)"}'::jsonb,
                          timeout_milliseconds := 30000);
    update public.ufc_athlete_bio
       set status = 'queued', request_id = v_req, attempts = attempts + 1, dispatched_at = now()
     where name_slug = v_slug;
  end if;

  if v_drained > 0 then perform public.refresh_ufc_official_bio(); end if;
  return jsonb_build_object('drained', v_drained, 'dispatched', v_slug);
end
$$;
-- anon-exec: unchanged (ufc_athlete_bio_tick) — CREATE OR REPLACE of an existing fn; ACL preserved, verified anon=false via has_function_privilege 2026-11-08.

-- Re-queue the not-found fighters with their alternates (quote titles find no page on any of them).
update public.ufc_athlete_bio u
   set alt_slugs = a.alts[2:], ufc_slug = a.alts[1], status = 'pending', attempts = 0, request_id = null
  from (select name_slug, public.ufc_slug_alternates(player_label) as alts from public.ufc_athlete_bio where status = 'not_found') a
 where u.name_slug = a.name_slug and cardinality(a.alts) > 0;

-- audit_20261126_candy_properties_taxonomy
--
-- Candy's leagues and brands, the same level Panini got in 20261126185023: publisher -> property ->
-- collection -> card. A collection's property comes from the publisher's own brand code
-- (candy_collections.brand_symbol, read from its official metadata by 20261126201206), never from a guess
-- at its name. "property" is a URL / code word only; on screen these sit under "Leagues" / "Entertainment".
--
--   candy_property_slug(symbol, name, kind)   brand code -> property (NULL = not placed, shown as such)
--   candy_collection_program(property, name)  display grouping inside a big property (DC, MLB)
--   candy_collections.property_slug / program kept by trigger
--   get_candy_property_board()                the coverage grid + set -> property map
--   get_candy_property_page(slug, limit)      one league / brand's page
--
-- Revert: remove the callers of the two get_ functions first (lib/candy/properties.ts), then the functions.

insert into public.publisher_properties (publisher, slug, name, heading, category, subject_word, group_word, team_league, sort_order) values
  ('candy','mlb','MLB','leagues','Baseball','player','team','mlb',10),
  ('candy','nascar','NASCAR','leagues','Racing','driver','team',null,20),
  ('candy','sweet-futures','Sweet Futures','leagues','College','player','school',null,30),
  ('candy','wwe','WWE','leagues','Wrestling','superstar',null,null,40),
  ('candy','dc','DC','entertainment','Comics','character',null,null,110),
  ('candy','netflix','Netflix','entertainment','TV','character',null,null,120),
  ('candy','getty-images','Getty Images','entertainment','Photography','artist',null,null,130),
  ('candy','palm-garden','Palm Garden','entertainment','Art','artist',null,null,140),
  ('candy','sex-pistols','Sex Pistols','entertainment','Music','artist',null,null,150)
on conflict (publisher, slug) do nothing;

CREATE OR REPLACE FUNCTION public.candy_property_slug(p_symbol text, p_name text, p_kind text)
returns text language sql immutable
set search_path = pg_catalog, public
as $fn$
  select case
    when p_kind = 'test' then null
    when p_symbol = 'MLB' then 'mlb'
    when p_symbol = 'CANDY' and p_name ~* '(\mMLB\M|Base Series)' then 'mlb'
    when p_symbol is null and p_name ~* '\mMLB\M' then 'mlb'
    when p_symbol = 'DC' then 'dc'
    when p_symbol = 'NSC' then 'nascar'
    when p_symbol = 'SWF' then 'sweet-futures'
    when p_symbol = 'WWE' then 'wwe'
    when p_symbol = 'NTX' then 'netflix'
    when p_symbol = 'GTY' then 'getty-images'
    when p_symbol = 'PG' then 'palm-garden'
    when p_symbol = 'SP' then 'sex-pistols'
    else null
  end
$fn$;
-- anon-exec: revoked (candy_property_slug) — new function; revoked from PUBLIC, anon, authenticated below.
revoke execute on function public.candy_property_slug(text, text, text) from public, anon, authenticated;
grant execute on function public.candy_property_slug(text, text, text) to postgres, service_role;

CREATE OR REPLACE FUNCTION public.candy_collection_program(p_property text, p_name text)
returns text language sql immutable
set search_path = pg_catalog, public
as $fn$
  select case
    when p_property = 'dc' then case
      when p_name ~* 'Super Power Pack' then 'DC3 Super Power Packs'
      when p_name ~* 'Cowl' then 'Bat Cowls'
      when p_name ~* 'Epic Artist Editions' then 'Epic Artist Editions'
      when p_name ~* '(GCDK|Gotham City District Knightwatch)' then 'Gotham City District Knightwatch'
      when p_name ~ '(#[0-9]+|\((19|20)[0-9]{2})' then 'Comics'
      else 'More from DC' end
    when p_property = 'mlb' then case
      when p_name ~* 'ICON' then 'ICONs'
      when p_name ~* '\mGems\M' then 'Gems'
      when p_name ~* '(Plays? of|This Month in Baseball|Players of the Month|Player Highlights|Postseason MVPs)' then 'Plays and highlights'
      else 'Rewards and commemoratives' end
    else null
  end
$fn$;
-- anon-exec: revoked (candy_collection_program) — new function; revoked from PUBLIC, anon, authenticated below.
revoke execute on function public.candy_collection_program(text, text) from public, anon, authenticated;
grant execute on function public.candy_collection_program(text, text) to postgres, service_role;

alter table public.candy_collections
  add column if not exists property_slug text,
  add column if not exists program text;

CREATE OR REPLACE FUNCTION public.candy_collections_fill_property()
returns trigger language plpgsql
set search_path = pg_catalog, public
as $fn$
begin
  new.property_slug := public.candy_property_slug(new.brand_symbol, new.name, new.kind);
  new.program := public.candy_collection_program(new.property_slug, new.name);
  return new;
end;
$fn$;
-- anon-exec: revoked (candy_collections_fill_property) — new trigger function; revoked from PUBLIC, anon, authenticated below.
revoke execute on function public.candy_collections_fill_property() from public, anon, authenticated;
grant execute on function public.candy_collections_fill_property() to postgres, service_role;

create trigger candy_collections_fill_property_trg
  before insert or update of brand_symbol, name, kind on public.candy_collections
  for each row execute function public.candy_collections_fill_property();

update public.candy_collections set kind = kind;

CREATE OR REPLACE FUNCTION public.get_candy_property_board()
returns jsonb language sql stable security definer
set search_path = pg_catalog, public
as $fn$
  with ed as (
    select e.id, e.set_id, e.set_name from public.editions e
    where e.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'
  ), sl as (
    select s.edition_id, count(*) n, sum(s.price_usd) usd from public.sales s
    where s.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713' and s.sold_at > now() - interval '90 days'
    group by 1
  ), ls as (
    select l.edition_id from public.candy_listings l
    where l.is_active and l.edition_id is not null and l.price_usd > 0 group by 1
  ), es as (
    select ed.set_id, min(ed.set_name) set_name, count(*) editions, count(f.fmv_usd) priced,
           count(ls.edition_id) listed, coalesce(sum(sl.n), 0) sales, sum(sl.usd) usd
    from ed
    left join public.candy_fmv_current f on f.edition_id = ed.id
    left join ls on ls.edition_id = ed.id
    left join sl on sl.edition_id = ed.id
    group by 1
  ), cc as (
    select c.address, c.property_slug, c.current_size,
           substring(c.name from '^((?:19|20)[0-9]{2})\M') season,
           regexp_replace(lower(es.set_name), '[^a-z0-9]+', '-', 'g') set_slug,
           coalesce(es.editions, 0) editions, coalesce(es.priced, 0) priced, coalesce(es.listed, 0) listed,
           coalesce(es.sales, 0) sales, es.usd
    from public.candy_collections c left join es on es.set_id = c.set_id
    where c.kind <> 'test'
  ), pp as (
    select p.slug, p.name, p.heading, p.category, p.subject_word, p.team_league, p.sort_order,
           count(cc.address) collections, coalesce(sum(cc.current_size), 0) cards,
           coalesce(sum(cc.editions), 0) editions, coalesce(sum(cc.priced), 0) priced_editions,
           coalesce(sum(cc.listed), 0) listed_editions, coalesce(sum(cc.sales), 0) sales_90d,
           sum(cc.usd) sales_90d_volume_usd, min(cc.season) first_season, max(cc.season) last_season
    from public.publisher_properties p left join cc on cc.property_slug = p.slug
    where p.publisher = 'candy'
    group by 1, 2, 3, 4, 5, 6, 7
  ), sp as (
    select set_slug, min(property_slug) property_slug from cc
    where set_slug is not null and property_slug is not null
    group by 1 having count(distinct property_slug) = 1
  )
  select jsonb_build_object(
    'computed_at', now(),
    'unplaced_collections', (select count(*) from cc where property_slug is null),
    'properties', coalesce((select jsonb_agg(to_jsonb(pp) order by pp.sort_order) from pp where pp.collections > 0), '[]'::jsonb),
    'set_property', coalesce((select jsonb_object_agg(sp.set_slug, sp.property_slug) from sp), '{}'::jsonb))
$fn$;
-- anon-exec: revoked (get_candy_property_board) — new function; revoked from PUBLIC, anon, authenticated below.
revoke execute on function public.get_candy_property_board() from public, anon, authenticated;
grant execute on function public.get_candy_property_board() to postgres, service_role;

CREATE OR REPLACE FUNCTION public.get_candy_property_page(p_slug text, p_limit integer default 12)
returns jsonb language sql stable security definer
set search_path = pg_catalog, public
as $fn$
  with prop as (
    select * from public.publisher_properties where publisher = 'candy' and slug = p_slug
  ), cols as (
    select c.address, c.name, c.program, c.set_id, c.current_size,
           substring(c.name from '^((?:19|20)[0-9]{2})\M') season
    from public.candy_collections c
    where c.property_slug = p_slug and c.kind <> 'test' and exists (select 1 from prop)
  ), ed as (
    select e.id, e.set_id, e.set_name, e.external_id, e.name, e.player_name, e.tier::text tier, e.circulation_count
    from public.editions e join cols on cols.set_id = e.set_id
    where e.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'
  ), fm as (
    select f.edition_id, f.fmv_usd from public.candy_fmv_current f where f.fmv_usd > 0
  ), sl as (
    select s.edition_id, s.price_usd, s.sold_at, s.serial_number from public.sales s
    where s.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713' and s.sold_at > now() - interval '90 days'
      and s.edition_id in (select id from ed)
  ), sa as (
    select edition_id, count(*) n, sum(price_usd) usd, max(sold_at) last_at from sl group by 1
  ), ls as (
    select l.edition_id from public.candy_listings l
    where l.is_active and l.edition_id is not null and l.price_usd > 0 group by 1
  ), es as (
    select ed.set_id, min(ed.set_name) set_name, count(*) editions, count(fm.fmv_usd) priced,
           count(ls.edition_id) listed, coalesce(sum(sa.n), 0) sales, sum(sa.usd) usd, max(sa.last_at) last_at
    from ed
    left join fm on fm.edition_id = ed.id
    left join ls on ls.edition_id = ed.id
    left join sa on sa.edition_id = ed.id
    group by 1
  ), cl as (
    select cols.name, cols.program, cols.season, coalesce(cols.current_size, 0) cards,
           regexp_replace(lower(es.set_name), '[^a-z0-9]+', '-', 'g') set_slug,
           coalesce(es.editions, 0) editions, coalesce(es.priced, 0) priced_editions,
           coalesce(es.listed, 0) listed_editions, coalesce(es.sales, 0) sales_90d,
           es.usd sales_90d_volume_usd, es.last_at newest_sale_at
    from cols left join es on es.set_id = cols.set_id
  )
  select case when not exists (select 1 from prop) then null else jsonb_build_object(
    'property', (select jsonb_build_object('slug', slug, 'name', name, 'heading', heading, 'category', category,
                   'subject_word', subject_word, 'group_word', group_word, 'team_league', team_league) from prop),
    'computed_at', now(),
    'totals', (select jsonb_build_object('collections', count(*), 'cards', coalesce(sum(cards), 0),
                   'editions', coalesce(sum(editions), 0), 'priced_editions', coalesce(sum(priced_editions), 0),
                   'listed_editions', coalesce(sum(listed_editions), 0), 'sales_90d', coalesce(sum(sales_90d), 0),
                   'sales_90d_volume_usd', sum(sales_90d_volume_usd), 'newest_sale_at', max(newest_sale_at),
                   'first_season', min(season), 'last_season', max(season)) from cl),
    'collections', coalesce((select jsonb_agg(to_jsonb(cl) order by cl.name) from cl), '[]'::jsonb),
    'top_editions', coalesce((select jsonb_agg(to_jsonb(t)) from (
        select ed.external_id, ed.name, ed.player_name, ed.set_name, ed.tier, ed.circulation_count, fm.fmv_usd
        from ed join fm on fm.edition_id = ed.id
        order by fm.fmv_usd desc, ed.external_id limit greatest(1, least(p_limit, 50))) t), '[]'::jsonb),
    'top_sales_90d', coalesce((select jsonb_agg(to_jsonb(t)) from (
        select ed.external_id, ed.name, ed.player_name, ed.set_name, sl.serial_number, sl.price_usd, sl.sold_at
        from sl join ed on ed.id = sl.edition_id
        order by sl.price_usd desc, sl.sold_at desc limit greatest(1, least(p_limit, 50))) t), '[]'::jsonb),
    'top_subjects', coalesce((select jsonb_agg(to_jsonb(t)) from (
        select ed.player_name, count(*) editions, count(fm.fmv_usd) priced_editions
        from ed left join fm on fm.edition_id = ed.id
        where ed.player_name is not null and ed.player_name <> ''
        group by 1 order by count(*) desc, ed.player_name limit greatest(1, least(p_limit, 50))) t), '[]'::jsonb)
  ) end
$fn$;
-- anon-exec: revoked (get_candy_property_page) — new function; revoked from PUBLIC, anon, authenticated below.
revoke execute on function public.get_candy_property_page(text, integer) from public, anon, authenticated;
grant execute on function public.get_candy_property_page(text, integer) to postgres, service_role;

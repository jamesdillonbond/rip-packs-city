-- audit_20261126_candy_kind_follows_brand_and_brand_lane_no_symbol
--
-- Two loose ends from the 11-26 leagues-and-brands work.
--
-- (1) candy_collections.kind was a NAME guess made at discovery ('mlb' if the name looked like baseball). It
--     misfiled 28 collections: 10 marked 'mlb' that are DC (4, "All-Star ..."), NASCAR (3), Sweet Futures (2)
--     and MCNY (1), and 18 MLB collections marked 'other' (Milestone Mark, Players of the Month, ...). Its
--     readers, audited: every reader tests only kind <> 'test' EXCEPT the Trophy Room (v_insights_trophies and
--     get_insights_trophies), which keeps Candy rows from kind = 'mlb' collections only (Trevor 11-09:
--     "Baseball cards only"). So the board showed 4 DC comics and 5 Sweet Futures basketball cards as baseball
--     grails and hid up to 19 real MLB ones.
--     Fix: once a collection's brand has been READ from its official metadata, kind follows the brand —
--     'mlb' for the MLB brand, 'other' for any other read brand. 'test' never changes; a collection whose
--     brand has not been read keeps its name guess. Done in the existing fill trigger, so it holds for new
--     collections. No view or function body that reads kind is changed.
--
-- (2) candy_collections_brand_step() counted a document that was READ and carries no symbol as a failed
--     fetch, retried it 5 times and logged ok=false each hour (5 red runs 11-26 for "2026 MLB All-Star Game
--     ICONs"). Such a document is an answer: it now stops retrying at once and is counted as
--     no_symbol_in_document, not failed. A fetch that did not return a document is still a failure.
--
-- Revert: (1) re-apply candy_collections_fill_property() from 20261126201654 and
--   update candy_collections set kind = b.kind from audit_20261126_candy_kind_backup b where b.address = candy_collections.address;
--   (2) re-apply candy_collections_brand_step() from 20261126201206.

create table if not exists public.audit_20261126_candy_kind_backup as
  select address, kind, property_slug, now() as saved_at from public.candy_collections;
alter table public.audit_20261126_candy_kind_backup enable row level security;
revoke all on public.audit_20261126_candy_kind_backup from public, anon, authenticated;

CREATE OR REPLACE FUNCTION public.candy_collections_fill_property()
returns trigger language plpgsql
set search_path = pg_catalog, public
as $fn$
begin
  new.property_slug := public.candy_property_slug(new.brand_symbol, new.name, new.kind);
  new.program := public.candy_collection_program(new.property_slug, new.name);
  -- kind follows the brand once the brand has been read ('test' is never changed)
  if new.kind <> 'test' then
    if new.property_slug = 'mlb' then
      new.kind := 'mlb';
    elsif new.brand_symbol is not null then
      new.kind := 'other';
    end if;
  end if;
  return new;
end;
$fn$;
-- anon-exec: unchanged (candy_collections_fill_property) — CREATE OR REPLACE of an existing trigger fn; ACL preserved (anon=false).

update public.candy_collections set kind = kind;

CREATE OR REPLACE FUNCTION public.candy_collections_brand_step()
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, public
as $fn$
declare
  v_started timestamptz := clock_timestamp();
  v_collected int := 0;
  v_failed int := 0;
  v_no_symbol int := 0;
  v_requested int := 0;
  v_left int := 0;
  r record;
begin
  if not pg_try_advisory_xact_lock(hashtext('candy_collections_brand_step')::bigint) then
    return jsonb_build_object('skipped', 'locked');
  end if;

  -- 1. collect finished responses
  with done as (
    select c.address, h.status_code, h.timed_out, h.error_msg,
           case when h.status_code = 200 and h.content is not null
                     and pg_input_is_valid(h.content, 'jsonb')
                then h.content::jsonb end as doc
    from public.candy_collections c
    join net._http_response h on h.id = c.brand_request_id
    where c.brand_request_id is not null
  ), upd as (
    update public.candy_collections c
    set brand_symbol = coalesce(nullif(btrim(d.doc->>'symbol'), ''), c.brand_symbol),
        brand_description = coalesce(nullif(btrim(d.doc->>'description'), ''), c.brand_description),
        brand_checked_at = clock_timestamp(),
        brand_request_id = null,
        -- a document that was read and carries no symbol is an answer, not a failure: stop asking for it
        brand_attempts = case when d.doc is not null and nullif(btrim(d.doc->>'symbol'), '') is null then 5 else c.brand_attempts end,
        brand_error = case
          when nullif(btrim(d.doc->>'symbol'), '') is not null then null
          when d.doc is not null then 'no symbol in metadata'
          when d.timed_out then 'timed out'
          else left(coalesce(d.error_msg, 'http ' || coalesce(d.status_code::text, '?')), 200) end
    from done d
    where d.address = c.address
    returning (nullif(btrim(d.doc->>'symbol'), '') is not null) as ok, (d.doc is not null) as was_read
  )
  select count(*) filter (where ok), count(*) filter (where not ok and not was_read), count(*) filter (where not ok and was_read)
    into v_collected, v_failed, v_no_symbol from upd;

  -- a request whose response aged out of pg_net (6 h) is released for a retry
  update public.candy_collections
  set brand_request_id = null, brand_error = 'response not found'
  where brand_request_id is not null and brand_requested_at < now() - interval '2 hours';

  -- 2. request the next batch; only the official arweave.net document is ever fetched
  for r in
    select address, uri from public.candy_collections
    where brand_symbol is null and brand_request_id is null and brand_attempts < 5
      and uri ~ '^https://arweave\.net/[A-Za-z0-9_-]{43}$'
    order by brand_attempts, address
    limit 120
  loop
    update public.candy_collections
    set brand_request_id = net.http_get(r.uri, timeout_milliseconds => 20000),
        brand_requested_at = clock_timestamp(),
        brand_attempts = brand_attempts + 1
    where address = r.address;
    v_requested := v_requested + 1;
  end loop;

  select count(*) into v_left from public.candy_collections where brand_symbol is null;

  perform public.log_pipeline_run(
    'candy-collection-brand',
    v_failed = 0,
    jsonb_build_object('collected', v_collected, 'failed', v_failed, 'no_symbol_in_document', v_no_symbol,
                       'requested', v_requested, 'without_symbol', v_left,
                       'ms', (extract(epoch from clock_timestamp() - v_started) * 1000)::int));

  return jsonb_build_object('collected', v_collected, 'failed', v_failed, 'no_symbol_in_document', v_no_symbol,
                            'requested', v_requested, 'without_symbol', v_left);
end;
$fn$;
-- anon-exec: unchanged (candy_collections_brand_step) — CREATE OR REPLACE of an existing fn; ACL preserved (anon=false).

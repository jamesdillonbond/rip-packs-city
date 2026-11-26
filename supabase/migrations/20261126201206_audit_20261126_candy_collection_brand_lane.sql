-- audit_20261126_candy_collection_brand_lane
--
-- Candy covers many brands (MLB, DC, ...). Until now a collection's brand was guessed
-- from its NAME, which is wrong for e.g. "Achievements" (a DC collection). Every Candy
-- collection's official metadata document (candy_collections.uri, always on arweave.net)
-- carries the publisher's own brand code in `symbol`. This lane reads it server-side.
--
--   candy_collections_brand_step()  pg_cron :54 hourly
--     1. collect: finished pg_net responses -> brand_symbol / brand_description
--     2. request: up to 120 collections with no symbol yet (max 5 tries each)
--   A failed or unparseable read leaves brand_symbol NULL (unknown), never a guess.
--
-- Revert: select cron.unschedule('rpc-candy-collection-brand');
--         (the brand_* columns are written by this lane only and can stay)

alter table public.candy_collections
  add column if not exists brand_symbol text,
  add column if not exists brand_description text,
  add column if not exists brand_request_id bigint,
  add column if not exists brand_requested_at timestamptz,
  add column if not exists brand_checked_at timestamptz,
  add column if not exists brand_attempts integer not null default 0,
  add column if not exists brand_error text;

CREATE OR REPLACE FUNCTION public.candy_collections_brand_step()
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, public
as $fn$
declare
  v_started timestamptz := clock_timestamp();
  v_collected int := 0;
  v_failed int := 0;
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
        brand_error = case
          when nullif(btrim(d.doc->>'symbol'), '') is not null then null
          when d.doc is not null then 'no symbol in metadata'
          when d.timed_out then 'timed out'
          else left(coalesce(d.error_msg, 'http ' || coalesce(d.status_code::text, '?')), 200) end
    from done d
    where d.address = c.address
    returning (nullif(btrim(d.doc->>'symbol'), '') is not null) as ok
  )
  select count(*) filter (where ok), count(*) filter (where not ok)
    into v_collected, v_failed from upd;

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
    jsonb_build_object('collected', v_collected, 'failed', v_failed,
                       'requested', v_requested, 'without_symbol', v_left,
                       'ms', (extract(epoch from clock_timestamp() - v_started) * 1000)::int));

  return jsonb_build_object('collected', v_collected, 'failed', v_failed,
                            'requested', v_requested, 'without_symbol', v_left);
end;
$fn$;

-- anon-exec: revoked (candy_collections_brand_step) — new function; revoked from PUBLIC, anon, authenticated below.
revoke execute on function public.candy_collections_brand_step() from public, anon, authenticated;
grant execute on function public.candy_collections_brand_step() to postgres, service_role;

select cron.schedule('rpc-candy-collection-brand', '54 * * * *', 'select public.candy_collections_brand_step()');

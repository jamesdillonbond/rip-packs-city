-- Full block-range walk of Flowty's NFTStorefrontV2 ListingCompleted events on the Flow history
-- nodes -> flowty_archive.flowty_chain_listing_completed. One-off scratch (execute_sql), kept
-- for reproducibility. Table DDL: supabase/migrations/20261004015121_flowty_chain_listing_completed.sql
--
-- Windows: 250 blocks (the node maximum) from the mainnet24 root to the mainnet28 floor.
-- Spork -> node: <=85,981,134 mn24 · <=88,226,266 mn25 · <=130,290,658 mn26 · <=137,390,145 mn27.
-- A window is done ONLY on HTTP 200; 429 / 5xx / no response are re-fired (free retries, per
-- docs/reference/apis-and-cadence.md). Coverage proof: count(*) FILTER (WHERE NOT done) = 0.
--
-- Rate: these nodes are shared with run_pack_mint_probe_lane (jobid 622, minutes 3-58/5, 25 per
-- node). The tick idles during the first 20 s of those minutes, sends at most 20 per node per
-- tick, and drops a node to 4 per tick for 2 minutes after any 429 from it, because any
-- unattributed 4xx in net._http_response raises check_edge_fn_http_failures.
-- Drive: SELECT cron.schedule('flowty-chain-walk-scratch', '5 seconds', 'select flowty_archive.scratch_fcw_tick()');

CREATE TABLE IF NOT EXISTS flowty_archive.scratch_20261004_walk (
  win_start bigint PRIMARY KEY,
  win_end   bigint NOT NULL,
  node      text   NOT NULL,
  req_id    bigint,
  fired_at  timestamptz,
  attempts  int    NOT NULL DEFAULT 0,
  last_status int,
  n_events  int,
  done      boolean NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS scratch_20261004_walk_todo ON flowty_archive.scratch_20261004_walk (node, win_start) WHERE NOT done;
CREATE INDEX IF NOT EXISTS scratch_20261004_walk_req ON flowty_archive.scratch_20261004_walk (req_id) WHERE req_id IS NOT NULL;

INSERT INTO flowty_archive.scratch_20261004_walk (win_start, win_end, node)
SELECT s, least(s + 249, e), n
FROM (VALUES (65264619::bigint, 85981134::bigint, 'mn24'), (85981135, 88226266, 'mn25'),
             (88226267, 130290658, 'mn26'), (130290659, 137390145, 'mn27')) v(b, e, n),
     generate_series(b, e, 250) s
ON CONFLICT DO NOTHING;

CREATE OR REPLACE FUNCTION flowty_archive.scratch_fcw_tick()
RETURNS jsonb LANGUAGE plpgsql AS $f$
declare
  v_collected int := 0; v_events int := 0; v_retry int := 0; v_fired int := 0; v_429 int := 0;
  nd text; v_n int;
begin
  -- (1) collect
  with land as (
    select w.win_start, r.status_code, r.content
    from flowty_archive.scratch_20261004_walk w join net._http_response r on r.id = w.req_id
    where w.req_id is not null
  ), ok as (
    select * from land where status_code = 200 and pg_input_is_valid(content, 'jsonb')
  ), ev as (
    insert into flowty_archive.flowty_chain_listing_completed (tx_hash, event_index, block_height, block_ts,
      listing_resource_id, storefront_resource_id, seller, buyer, nft_type, nft_id, nft_uuid, collection_id,
      price, payment_vault, commission_amount, commission_receiver, custom_id, expiry)
    select e->>'transaction_id', (e->>'event_index')::int, (b->>'block_height')::bigint, (b->>'block_timestamp')::timestamptz,
      fl->>'listingResourceID', fl->>'storefrontResourceID', lower(fl->>'storefrontAddress'), lower(fl->>'buyer'),
      fl->>'nftType', fl->>'nftID', fl->>'nftUUID', public.flowty_collection_id_from_nft_type(fl->>'nftType'),
      (fl->>'salePrice')::numeric, fl->>'salePaymentVaultType', (fl->>'commissionAmount')::numeric,
      lower(fl->>'commissionReceiver'), fl->>'customID', (fl->>'expiry')::bigint
    from ok, jsonb_array_elements(ok.content::jsonb) b, jsonb_array_elements(coalesce(b->'events', '[]'::jsonb)) e,
      lateral (
        select jsonb_object_agg(x->>'name',
                 case when x->'value'->>'type' = 'Optional' then x->'value'->'value'->>'value' else x->'value'->>'value' end) fl
        from jsonb_array_elements((convert_from(decode(e->>'payload', 'base64'), 'utf8')::jsonb)->'value'->'fields') x
      ) p
    where (fl->>'purchased') = 'true'
    on conflict do nothing
    returning 1
  ), cnt as (
    select ok.win_start, (select count(*) from jsonb_array_elements(ok.content::jsonb) b, jsonb_array_elements(coalesce(b->'events','[]'::jsonb)) e) n from ok
  ), upd_ok as (
    update flowty_archive.scratch_20261004_walk w set done = true, req_id = null, last_status = 200, n_events = c.n
    from cnt c where c.win_start = w.win_start returning 1
  ), upd_bad as (
    update flowty_archive.scratch_20261004_walk w set req_id = null, last_status = l.status_code
    from land l where l.win_start = w.win_start and not (l.status_code = 200 and pg_input_is_valid(l.content, 'jsonb'))
    returning l.status_code
  )
  select (select count(*) from upd_ok), (select count(*) from ev), (select count(*) from upd_bad),
         (select count(*) from upd_bad where status_code = 429)
    into v_collected, v_events, v_retry, v_429;

  -- lost requests (pg_net never answered within 3 min)
  update flowty_archive.scratch_20261004_walk w set req_id = null, last_status = -1
   where w.req_id is not null and w.fired_at < now() - interval '3 minutes'
     and not exists (select 1 from net._http_response r where r.id = w.req_id);

  -- (2) dispatch, clear of the pack-mint probe lane's minute
  if extract(minute from now())::int % 5 = 3 and extract(second from now()) < 20 then
    return jsonb_build_object('collected', v_collected, 'events', v_events, 'retry', v_retry, 'http_429', v_429, 'fired', 0, 'note', 'yield_to_probe_lane');
  end if;
  foreach nd in array array['mn24','mn25','mn26','mn27'] loop
    v_n := case when exists (select 1 from flowty_archive.scratch_20261004_walk
                              where node = nd and last_status = 429 and fired_at > now() - interval '2 minutes') then 4 else 20 end;
    v_n := v_n - (select count(*) from flowty_archive.scratch_20261004_walk where node = nd and req_id is not null);
    if v_n <= 0 then continue; end if;
    with pick as (
      select win_start from flowty_archive.scratch_20261004_walk
       where node = nd and not done and req_id is null order by win_start limit v_n
    )
    update flowty_archive.scratch_20261004_walk w set attempts = attempts + 1, fired_at = now(),
      req_id = net.http_get('http://access-001.mainnet' || substr(nd, 3) || '.nodes.onflow.org:8070/v1/events?type=A.3cdbb3d569211ff3.NFTStorefrontV2.ListingCompleted&start_height='
                            || w.win_start || '&end_height=' || w.win_end, timeout_milliseconds => 60000)
    from pick p where p.win_start = w.win_start;
    get diagnostics v_n = row_count;
    v_fired := v_fired + v_n;
  end loop;
  return jsonb_build_object('collected', v_collected, 'events', v_events, 'retry', v_retry, 'http_429', v_429, 'fired', v_fired);
end $f$;

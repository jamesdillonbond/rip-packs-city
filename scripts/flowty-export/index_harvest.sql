-- Flowty event index -> flowty_archive.flowty_index_sales (all users), via pg_net.
-- One-off scratch functions, created with execute_sql and dropped when done; kept here so the
-- harvest is reproducible. Table DDL: supabase/migrations/20261004014121_flowty_index_sales_archive.sql
--
-- The Firestore web API key (public, from Flowty's archived web bundle — see
-- docs/reference/apis-and-cadence.md "Flowty's own event index") is read from a scratch
-- config row at run time and sent as the x-goog-api-key HEADER; it is never in this file:
--   CREATE TABLE flowty_archive.scratch_20261004_cfg (k text PRIMARY KEY, v text);
--   INSERT INTO flowty_archive.scratch_20261004_cfg VALUES ('firestore_key', '<key>');
--
-- Partitions: [lo, hi) ranges of the document id, seeded with the server's own
-- runAggregationQuery count per range (sum 2,880,364 on 2026-10-03). A partition is done when
-- a page returns < 1000 docs; reconciliation (rows_landed = server_count) is asserted after.
-- Drive: SELECT cron.schedule('flowty-index-harvest', '20 seconds', 'select flowty_archive.scratch_fih_tick()');

CREATE OR REPLACE FUNCTION flowty_archive.scratch_fih_body(p_lo text, p_hi text, p_cursor text)
RETURNS jsonb LANGUAGE sql STABLE AS $f$
  select jsonb_build_object('structuredQuery', jsonb_build_object(
    'from', jsonb_build_array(jsonb_build_object('collectionId', 'storefrontEvents')),
    'where', jsonb_build_object('compositeFilter', jsonb_build_object('op', 'AND', 'filters', jsonb_build_array(
      jsonb_build_object('fieldFilter', jsonb_build_object('field', jsonb_build_object('fieldPath', 'type'), 'op', 'IN',
        'value', jsonb_build_object('arrayValue', jsonb_build_object('values', jsonb_build_array(
          jsonb_build_object('stringValue', 'STOREFRONT_PURCHASED'), jsonb_build_object('stringValue', 'STOREFRONT_OFFER_ACCEPTED')))))),
      jsonb_build_object('fieldFilter', jsonb_build_object('field', jsonb_build_object('fieldPath', '__name__'), 'op', 'GREATER_THAN_OR_EQUAL',
        'value', jsonb_build_object('referenceValue', 'projects/flowty-prod/databases/(default)/documents/storefrontEvents/' || p_lo))),
      jsonb_build_object('fieldFilter', jsonb_build_object('field', jsonb_build_object('fieldPath', '__name__'), 'op', 'LESS_THAN',
        'value', jsonb_build_object('referenceValue', 'projects/flowty-prod/databases/(default)/documents/storefrontEvents/' || p_hi)))))),
    'select', jsonb_build_object('fields', (select jsonb_agg(jsonb_build_object('fieldPath', f)) from unnest(array[
      'type','transactionId','blockTimestamp','blockchainType','accountAddress',
      'data.buyer','data.nftID','data.nftType','data.nftUUID','data.salePrice','data.salePaymentVaultType',
      'data.listingResourceID','data.storefrontAddress','data.commissionAmount','data.commissionReceiver',
      'data.storefrontResourceID','data.customID',
      'data.payer','data.taker','data.amount','data.usdValue','data.paymentTokenType','data.paymentTokenName',
      'data.offerResourceID','data.offerId','data.offerAddress','data.offerKind','data.offerType',
      'data.resolverKind','data.globalOffer','data.offerResourceType','data.remainingValue']) f)),
    'orderBy', jsonb_build_array(jsonb_build_object('field', jsonb_build_object('fieldPath', '__name__'), 'direction', 'ASCENDING')),
    'limit', 1000)
    || case when p_cursor is null then '{}'::jsonb else jsonb_build_object('startAt', jsonb_build_object(
         'values', jsonb_build_array(jsonb_build_object('referenceValue', p_cursor)), 'before', false)) end)
$f$;

CREATE OR REPLACE FUNCTION flowty_archive.scratch_fih_tick()
RETURNS jsonb LANGUAGE plpgsql AS $f$
declare
  r record; resp record; docs jsonb; n int; landed int; fired int := 0; parsed int := 0;
  v_key text := (select v from flowty_archive.scratch_20261004_cfg where k = 'firestore_key');
begin
  for r in select * from flowty_archive.flowty_index_harvest where pending_req is not null loop
    select status_code, content into resp from net._http_response where id = r.pending_req;
    if not found then
      if r.updated_at < now() - interval '3 minutes' then   -- lost/timeout: re-fire
        update flowty_archive.flowty_index_harvest set pending_req = null, last_status = -1, updated_at = now() where part = r.part;
      end if;
      continue;
    end if;
    if resp.status_code <> 200 then
      update flowty_archive.flowty_index_harvest set pending_req = null, last_status = resp.status_code, updated_at = now() where part = r.part;
      continue;
    end if;
    docs := (select coalesce(jsonb_agg(e->'document'), '[]'::jsonb) from jsonb_array_elements(resp.content::jsonb) e where e ? 'document');
    n := jsonb_array_length(docs);
    with d as (
      select x->>'name' as name, x->'fields' as f, x->'fields'->'data'->'mapValue'->'fields' as g
      from jsonb_array_elements(docs) x
    ), ins as (
      insert into flowty_archive.flowty_index_sales (doc_id, event_type, chain_event, tx_hash, block_ts, nft_type, nft_id, nft_uuid,
        collection_id, price, usd_value, payment_vault, buyer, seller, account_address, listing_resource_id,
        storefront_resource_id, commission_amount, commission_receiver, custom_id, extra)
      select split_part(name, '/', 7),
        flowty_archive.scratch_fsv(f->'type'),
        flowty_archive.scratch_fsv(f->'blockchainType'),
        flowty_archive.scratch_fsv(f->'transactionId'),
        flowty_archive.scratch_fsv(f->'blockTimestamp')::timestamptz,
        flowty_archive.scratch_fsv(g->'nftType'),
        flowty_archive.scratch_fsv(g->'nftID'),
        flowty_archive.scratch_fsv(g->'nftUUID'),
        public.flowty_collection_id_from_nft_type(flowty_archive.scratch_fsv(g->'nftType')),
        coalesce(flowty_archive.scratch_fsv(g->'salePrice'), flowty_archive.scratch_fsv(g->'amount'))::numeric,
        flowty_archive.scratch_fsv(g->'usdValue')::numeric,
        coalesce(flowty_archive.scratch_fsv(g->'salePaymentVaultType'), flowty_archive.scratch_fsv(g->'paymentTokenType')),
        lower(coalesce(flowty_archive.scratch_fsv(g->'buyer'), flowty_archive.scratch_fsv(g->'payer'), flowty_archive.scratch_fsv(g->'offerAddress'))),
        lower(coalesce(flowty_archive.scratch_fsv(g->'storefrontAddress'), flowty_archive.scratch_fsv(g->'taker'))),
        lower(flowty_archive.scratch_fsv(f->'accountAddress')),
        coalesce(flowty_archive.scratch_fsv(g->'listingResourceID'), flowty_archive.scratch_fsv(g->'offerResourceID'), flowty_archive.scratch_fsv(g->'offerId')),
        flowty_archive.scratch_fsv(g->'storefrontResourceID'),
        flowty_archive.scratch_fsv(g->'commissionAmount')::numeric,
        lower(flowty_archive.scratch_fsv(g->'commissionReceiver')),
        flowty_archive.scratch_fsv(g->'customID'),
        nullif(jsonb_strip_nulls(jsonb_build_object(
          'offerKind', flowty_archive.scratch_fsv(g->'offerKind'), 'offerType', flowty_archive.scratch_fsv(g->'offerType'),
          'resolverKind', flowty_archive.scratch_fsv(g->'resolverKind'), 'globalOffer', flowty_archive.scratch_fsv(g->'globalOffer'),
          'offerResourceType', flowty_archive.scratch_fsv(g->'offerResourceType'), 'paymentTokenName', flowty_archive.scratch_fsv(g->'paymentTokenName'),
          'remainingValue', flowty_archive.scratch_fsv(g->'remainingValue'), 'taker', flowty_archive.scratch_fsv(g->'taker'),
          'payer', flowty_archive.scratch_fsv(g->'payer'), 'offerAddress', flowty_archive.scratch_fsv(g->'offerAddress'))), '{}'::jsonb)
      from d
      on conflict (doc_id) do nothing
      returning 1)
    select count(*) into landed from ins;
    update flowty_archive.flowty_index_harvest set pending_req = null, last_status = 200, pages = pages + 1,
      rows_landed = rows_landed + landed,
      cursor_name = coalesce(docs->(n - 1)->>'name', cursor_name),
      done = (n < 1000), updated_at = now()
    where part = r.part;
    parsed := parsed + n;
  end loop;

  for r in select * from flowty_archive.flowty_index_harvest where not done and pending_req is null order by part limit 28 loop
    update flowty_archive.flowty_index_harvest set updated_at = now(), pending_req = net.http_post(
      url := 'https://firestore.googleapis.com/v1/projects/flowty-prod/databases/(default)/documents:runQuery',
      body := flowty_archive.scratch_fih_body(r.lo, r.hi, r.cursor_name),
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-goog-api-key', v_key),
      timeout_milliseconds := 90000)
    where part = r.part;
    fired := fired + 1;
  end loop;
  return jsonb_build_object('parsed', parsed, 'fired', fired);
end $f$;

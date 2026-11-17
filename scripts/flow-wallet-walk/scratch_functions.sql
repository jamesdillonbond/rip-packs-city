-- Scratch pg_net lanes used for Trevor's Flowty export (2026-10-02/03), preserved here when the
-- live objects were dropped. NOT a migration: reference code for the wallet-walk technique in
-- docs/reference/apis-and-cadence.md (key sequence-number bisection, per-node rate caps, loan /
-- listing flag bisection, Flowty-index verification). The tables they read/wrote were
-- flowty_archive.scratch_2026100{2,3}_* (dropped). To reuse: recreate a scratch table set and
-- schedule the *_tick() function on a 20-30 s pg_cron job; keep calls <= 20 per node per tick.

CREATE OR REPLACE FUNCTION flowty_archive.scratch_flag_req(h bigint, ids bigint[], detail boolean)
 RETURNS bigint
 LANGUAGE sql
AS $function$
 select net.http_post(url := flowty_archive.scratch_node(h) || '/v1/scripts?block_height=' || h,
   body := jsonb_build_object('script', translate(encode(convert_to(flowty_archive.scratch_flag_script(h, detail), 'UTF8'), 'base64'), E'\n', ''),
     'arguments', jsonb_build_array(translate(encode(convert_to(jsonb_build_object('type','Array','value',(select jsonb_agg(jsonb_build_object('type','UInt64','value',i::text)) from unnest(ids) i))::text,'UTF8'),'base64'), E'\n', ''))),
   headers := '{"Content-Type": "application/json"}'::jsonb, timeout_milliseconds := 30000) $function$
;

CREATE OR REPLACE FUNCTION flowty_archive.scratch_flag_script(h bigint, detail boolean)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
AS $function$
 select case when not detail then
   case when h <= 85981134 then E'import Flowty from 0x5c57f79c6694797f\npub fun main(ids: [UInt64]): [String] {\n let m = Flowty.borrowMarketplacePublic()\n let out: [String] = []\n for id in ids {\n  if let f = m.borrowFunding(fundingResourceID: id) {\n   let d = f.getDetails()\n   if d.repaid || d.settled { out.append(id.toString()) }\n  } else { out.append(id.toString()) }\n }\n return out\n}'
   else E'import Flowty from 0x5c57f79c6694797f\naccess(all) fun main(ids: [UInt64]): [String] {\n let m = Flowty.borrowMarketplacePublic()\n let out: [String] = []\n for id in ids {\n  if let f = m.borrowFunding(fundingResourceID: id) {\n   let d = f.getDetails()\n   if d.repaid || d.settled { out.append(id.toString()) }\n  } else { out.append(id.toString()) }\n }\n return out\n}' end
 else
   replace(E'import Flowty from 0x5c57f79c6694797f\nPUBK fun main(ids: [UInt64]): [String] {\n let m = Flowty.borrowMarketplacePublic()\n let out: [String] = []\n for id in ids {\n  if let f = m.borrowFunding(fundingResourceID: id) {\n   let d = f.getDetails()\n   let l = f.getListingDetails()\n   out.append(id.toString().concat(\",\").concat(d.repaid ? \"1\" : \"0\").concat(\",\").concat(d.settled ? \"1\" : \"0\").concat(\",\").concat(d.startTime.toString()).concat(\",\").concat(d.term.toString()).concat(\",\").concat(d.repaymentAmount.toString()).concat(\",\").concat(l.amount.toString()).concat(\",\").concat(l.interestRate.toString()).concat(\",\").concat(l.nftID.toString()).concat(\",\").concat(d.paymentVaultType.identifier))\n  } else { out.append(id.toString().concat(\",missing\")) }\n }\n return out\n}', 'PUBK', case when h <= 85981134 then 'pub' else 'access(all)' end) end $function$
;

CREATE OR REPLACE FUNCTION flowty_archive.scratch_fs_verify_tick()
 RETURNS void
 LANGUAGE plpgsql
AS $function$
begin
  update flowty_archive.scratch_20261003_fs_verify v set status_code = r.status_code,
    ok = (r.status_code = 200 and (r.content::jsonb)->>'status' = 'Sealed' and coalesce((r.content::jsonb)->>'error_message','') = ''),
    event_types = (select string_agg(distinct e->>'type', ' ') from jsonb_array_elements(case when r.status_code = 200 then (r.content::jsonb)->'events' else '[]'::jsonb end) e),
    block_height = null
  from net._http_response r where r.id = v.req_id and v.status_code is null and v.req_id is not null;
  -- retry failures/timeouts once they are known
  update flowty_archive.scratch_20261003_fs_verify v set req_id = null
  where v.status_code is null and v.req_id is not null and v.fired_at < now() - interval '3 minutes'
    and not exists (select 1 from net._http_response r where r.id = v.req_id);
  with pick as (
    select tx, node from (select tx, node, row_number() over (partition by node order by tx) rn
      from flowty_archive.scratch_20261003_fs_verify where status_code is null and req_id is null) s where rn <= 15)
  update flowty_archive.scratch_20261003_fs_verify v set req_id = net.http_get(p.node || '/v1/transaction_results/' || p.tx, timeout_milliseconds => 60000), fired_at = now()
  from pick p where p.tx = v.tx;
end $function$
;

CREATE OR REPLACE FUNCTION flowty_archive.scratch_fsv(v jsonb)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
AS $function$ select coalesce(v->>'stringValue', v->>'integerValue', v->>'doubleValue', v->>'booleanValue', v->>'timestampValue') $function$
;

CREATE OR REPLACE FUNCTION flowty_archive.scratch_listing_req(h bigint, sf text, ids bigint[])
 RETURNS bigint
 LANGUAGE sql
AS $function$
 select net.http_post(url := flowty_archive.scratch_node(h) || '/v1/scripts?block_height=' || h,
   body := jsonb_build_object('script', translate(encode(convert_to(
     case when h <= 85981134 then
E'import NFTStorefrontV2 from 0x3cdbb3d569211ff3\npub fun main(sf: Address, ids: [UInt64]): [String] {\n let out: [String] = []\n let s = getAccount(sf).getCapability<&NFTStorefrontV2.Storefront{NFTStorefrontV2.StorefrontPublic}>(NFTStorefrontV2.StorefrontPublicPath).borrow()\n if s == nil { for id in ids { out.append(id.toString().concat(\":nostore\")) }\n return out }\n for id in ids {\n  if let l = s!.borrowListing(listingResourceID: id) { if l.getDetails().purchased { out.append(id.toString()) } } else { out.append(id.toString()) }\n }\n return out\n}'
     else
E'import NFTStorefrontV2 from 0x3cdbb3d569211ff3\naccess(all) fun main(sf: Address, ids: [UInt64]): [String] {\n let out: [String] = []\n let s = getAccount(sf).capabilities.borrow<&{NFTStorefrontV2.StorefrontPublic}>(NFTStorefrontV2.StorefrontPublicPath)\n if s == nil { for id in ids { out.append(id.toString().concat(\":nostore\")) }\n return out }\n for id in ids {\n  if let l = s!.borrowListing(listingResourceID: id) { if l.getDetails().purchased { out.append(id.toString()) } } else { out.append(id.toString()) }\n }\n return out\n}' end,
     'UTF8'), 'base64'), E'\n', ''),
     'arguments', jsonb_build_array(
       translate(encode(convert_to(jsonb_build_object('type','Address','value',sf)::text,'UTF8'),'base64'), E'\n', ''),
       translate(encode(convert_to(jsonb_build_object('type','Array','value',(select jsonb_agg(jsonb_build_object('type','UInt64','value',i::text)) from unnest(ids) i))::text,'UTF8'),'base64'), E'\n', ''))),
   headers := '{"Content-Type": "application/json"}'::jsonb, timeout_milliseconds := 30000) $function$
;

CREATE OR REPLACE FUNCTION flowty_archive.scratch_listing_req(h bigint, sf text, ids bigint[], kind text DEFAULT 'sf'::text)
 RETURNS bigint
 LANGUAGE sql
AS $function$
 select net.http_post(url := flowty_archive.scratch_node(h) || '/v1/scripts?block_height=' || h,
   body := jsonb_build_object('script', translate(encode(convert_to(
     replace(replace(flowty_archive.scratch_listing_script(h, kind), 'import CONTRACT from ADDR',
       case kind when 'sf' then 'import NFTStorefrontV2 from 0x3cdbb3d569211ff3' when 'loan' then 'import Flowty from 0x5c57f79c6694797f' else 'import FlowtyRentals from 0x5c57f79c6694797f' end), 'XX', 'XX'),
     'UTF8'), 'base64'), E'\n', ''),
     'arguments', jsonb_build_array(
       translate(encode(convert_to(jsonb_build_object('type','Address','value',sf)::text,'UTF8'),'base64'), E'\n', ''),
       translate(encode(convert_to(jsonb_build_object('type','Array','value',(select jsonb_agg(jsonb_build_object('type','UInt64','value',i::text)) from unnest(ids) i))::text,'UTF8'),'base64'), E'\n', ''))),
   headers := '{"Content-Type": "application/json"}'::jsonb, timeout_milliseconds := 30000) $function$
;

CREATE OR REPLACE FUNCTION flowty_archive.scratch_listing_script(h bigint, kind text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
AS $function$
 select replace(replace(replace(replace(
  case when h <= 85981134 then
E'import CONTRACT from ADDR\npub fun main(sf: Address, ids: [UInt64]): [String] {\n let out: [String] = []\n let s = getAccount(sf).getCapability<PRE_TYPE>(PATH).borrow()\n if s == nil { for id in ids { out.append(id.toString().concat(\":nostore\")) }\n return out }\n for id in ids {\n  if let l = s!.borrowListing(listingResourceID: id) { if l.getDetails().FLAG { out.append(id.toString()) } } else { out.append(id.toString()) }\n }\n return out\n}'
  else
E'import CONTRACT from ADDR\naccess(all) fun main(sf: Address, ids: [UInt64]): [String] {\n let out: [String] = []\n let s = getAccount(sf).capabilities.borrow<C1_TYPE>(PATH)\n if s == nil { for id in ids { out.append(id.toString().concat(\":nostore\")) }\n return out }\n for id in ids {\n  if let l = s!.borrowListing(listingResourceID: id) { if l.getDetails().FLAG { out.append(id.toString()) } } else { out.append(id.toString()) }\n }\n return out\n}' end,
  'PRE_TYPE', case kind when 'sf' then '&NFTStorefrontV2.Storefront{NFTStorefrontV2.StorefrontPublic}' when 'loan' then '&Flowty.FlowtyStorefront{Flowty.FlowtyStorefrontPublic}' else '&FlowtyRentals.FlowtyRentalsStorefront{FlowtyRentals.FlowtyRentalsStorefrontPublic}' end),
  'C1_TYPE', case kind when 'sf' then '&{NFTStorefrontV2.StorefrontPublic}' when 'loan' then '&{Flowty.FlowtyStorefrontPublic}' else '&{FlowtyRentals.FlowtyRentalsStorefrontPublic}' end),
  'PATH', case kind when 'sf' then 'NFTStorefrontV2.StorefrontPublicPath' when 'loan' then 'Flowty.FlowtyStorefrontPublicPath' else 'FlowtyRentals.FlowtyRentalsStorefrontPublicPath' end),
  'FLAG', case kind when 'sf' then 'purchased' when 'loan' then 'funded' else 'rented' end)
  -- CONTRACT / ADDR substituted below
 $function$
;

CREATE OR REPLACE FUNCTION flowty_archive.scratch_listing_tick()
 RETURNS jsonb
 LANGUAGE plpgsql
AS $function$
declare r record; v_disp int := 0; v_body jsonb; v_ids text[];
begin
  insert into flowty_archive.scratch_20261002_listing_probe (listing_id, storefront, nft_id, nft_type, price, token, list_tx, list_h, list_ts, lo, hi)
  select (fields->>'listingResourceID')::bigint, fields->>'storefrontAddress', (fields->>'nftID')::bigint, fields->>'nftType', (fields->>'salePrice')::numeric,
         fields->>'salePaymentVaultType', tx_id, height, block_ts, height, 166500000
  from flowty_archive.scratch_20261002_walk_found
  where fields->>'_type' = 'A.3cdbb3d569211ff3.NFTStorefrontV2.ListingAvailable' and fields->>'storefrontAddress' in ('0x3d0b274c80263484','0xd96dc67ae64ee202','0xbd94cade097e50ac')
  on conflict do nothing;
  for r in select p.*, h.status_code sc, h.content body from flowty_archive.scratch_20261002_listing_probe p join net._http_response h on h.id = p.req_id loop
    if r.sc <> 200 then
      update flowty_archive.scratch_20261002_listing_probe set req_id = null, attempts = attempts + 1 where storefront = r.storefront and listing_id = r.listing_id; continue;
    end if;
    if r.state in ('check_end','bisect') then
      v_body := convert_from(decode(r.body::jsonb #>> '{}', 'base64'), 'UTF8')::jsonb;
      select array_agg(x->>'value') into v_ids from jsonb_array_elements(v_body->'value') x;
      if r.listing_id::text = any (coalesce(v_ids, '{}')) or (r.listing_id::text || ':nostore') = any (coalesce(v_ids, '{}')) then
        update flowty_archive.scratch_20261002_listing_probe set req_id = null, hi = r.mid, state = 'bisect' where storefront = r.storefront and listing_id = r.listing_id;
      elsif r.state = 'check_end' then
        update flowty_archive.scratch_20261002_listing_probe set req_id = null, state = 'open_at_end' where storefront = r.storefront and listing_id = r.listing_id;
      else
        update flowty_archive.scratch_20261002_listing_probe set req_id = null, lo = r.mid where storefront = r.storefront and listing_id = r.listing_id;
      end if;
    elsif r.state = 'window' then
      update flowty_archive.scratch_20261002_listing_probe p set state = 'done', end_tx = m.tx, end_h = m.bh, end_ts = m.bts, end_fields = m.fl, req_id = null
        from (select e->>'transaction_id' tx, (b->>'block_height')::bigint bh, (b->>'block_timestamp')::timestamptz bts,
                (select jsonb_object_agg(f->>'name', coalesce(f->'value'->'value'->>'value', f->'value'->>'value')) from jsonb_array_elements(convert_from(decode(e->>'payload','base64'),'UTF8')::jsonb->'value'->'fields') f) fl
              from jsonb_array_elements(r.body::jsonb) b, jsonb_array_elements(b->'events') e) m
       where p.storefront = r.storefront and p.listing_id = r.listing_id and m.fl->>'listingResourceID' = r.listing_id::text;
      update flowty_archive.scratch_20261002_listing_probe set req_id = null, types_done = types_done + 1, state = case when kind = 'rental' and types_done = 0 then 'window' else 'no_event' end where storefront = r.storefront and listing_id = r.listing_id and state = 'window';
    end if;
  end loop;
  update flowty_archive.scratch_20261002_listing_probe set state = 'window'
   where state = 'bisect' and req_id is null and hi - lo <= 250 and flowty_archive.scratch_node(lo + 1) = flowty_archive.scratch_node(hi);
  for r in
    with q as (select p.*, case when state = 'check_end' then hi when state = 'window' then hi else
                 case when hi - lo <= 250 then flowty_archive.scratch_spork_end(lo + 1)
                      when (lo + hi) / 2 between 85981135 and 86031699 then case when 86031700 < hi then 86031700 else 85981134 end
                      else (lo + hi) / 2 end end as at_h
               from flowty_archive.scratch_20261002_listing_probe p where state in ('check_end','bisect','window') and req_id is null and attempts < 30),
         rk as (select q.*, flowty_archive.scratch_node(at_h) node, row_number() over (partition by flowty_archive.scratch_node(at_h) order by random()) rn from q)
    select * from rk where rn <= case when node like '%rest-mainnet%' then 20 when node like '%mainnet24%' then 6 else 10 end
  loop
    if r.state = 'window' then
      update flowty_archive.scratch_20261002_listing_probe set req_id = net.http_get(url := r.node || '/v1/events?type=' || case r.kind when 'sf' then 'A.3cdbb3d569211ff3.NFTStorefrontV2.ListingCompleted' when 'loan' then 'A.5c57f79c6694797f.Flowty.ListingCompleted' else (array['A.5c57f79c6694797f.FlowtyRentals.ListingRented','A.5c57f79c6694797f.FlowtyRentals.ListingDestroyed'])[r.types_done + 1] end || '&start_height=' || (r.lo + 1) || '&end_height=' || r.hi, timeout_milliseconds := 30000)
       where storefront = r.storefront and listing_id = r.listing_id;
    else
      update flowty_archive.scratch_20261002_listing_probe set mid = r.at_h, req_id = flowty_archive.scratch_listing_req(r.at_h, r.storefront, array[r.listing_id], r.kind) where storefront = r.storefront and listing_id = r.listing_id;
    end if;
    v_disp := v_disp + 1;
  end loop;
  return jsonb_build_object('disp', v_disp);
end $function$
;

CREATE OR REPLACE FUNCTION flowty_archive.scratch_loan_tick()
 RETURNS jsonb
 LANGUAGE plpgsql
AS $function$
declare r record; v_disp int := 0; v_body jsonb; v_ids text[]; v_mid bigint;
  v_types text[] := array['A.5c57f79c6694797f.Flowty.FundingRepaid','A.5c57f79c6694797f.Flowty.FundingSettled'];
begin
  insert into flowty_archive.scratch_20261002_loan_probe (funding_id, listing_id, borrower, lender, nft_id, nft_type, repayment_amount, fund_tx, fund_h, fund_ts, state, lo, hi)
  select (fields->>'fundingResourceID')::bigint, (fields->>'listingResourceID')::bigint, fields->>'borrower', fields->>'lender', (fields->>'nftID')::bigint, fields->>'nftType',
         (fields->>'repaymentAmount')::numeric, tx_id, height, block_ts, 'detail', height, 166500000
  from flowty_archive.scratch_20261002_walk_found
  where fields->>'_type' = 'A.5c57f79c6694797f.Flowty.FundingAvailable' and fields->>'lender' in ('0x3d0b274c80263484','0xd96dc67ae64ee202')
  on conflict do nothing;
  -- collect
  for r in select p.*, h.status_code sc, h.content body from flowty_archive.scratch_20261002_loan_probe p join net._http_response h on h.id = p.req_id loop
    if r.sc <> 200 then
      update flowty_archive.scratch_20261002_loan_probe set req_id = null, attempts = attempts + 1 where funding_id = r.funding_id; continue;
    end if;
    if r.state = 'detail' then
      v_body := convert_from(decode(r.body::jsonb #>> '{}', 'base64'), 'UTF8')::jsonb;
      update flowty_archive.scratch_20261002_loan_probe set req_id = null, cur = to_jsonb(string_to_array(v_body->'value'->0->>'value', ',')), state = 'bisect' where funding_id = r.funding_id;
    elsif r.state = 'bisect' then
      v_body := convert_from(decode(r.body::jsonb #>> '{}', 'base64'), 'UTF8')::jsonb;
      select array_agg(x->>'value') into v_ids from jsonb_array_elements(v_body->'value') x;
      if r.funding_id::text = any (coalesce(v_ids, '{}')) then
        update flowty_archive.scratch_20261002_loan_probe set req_id = null, hi = r.mid where funding_id = r.funding_id;
      else
        update flowty_archive.scratch_20261002_loan_probe set req_id = null, lo = r.mid where funding_id = r.funding_id;
      end if;
    elsif r.state = 'window' then
      select b->>'block_height', b->>'block_timestamp', e into v_body
        from jsonb_array_elements(r.body::jsonb) b, jsonb_array_elements(b->'events') e limit 0;
      update flowty_archive.scratch_20261002_loan_probe p set state = 'done', end_type = m.typ, end_tx = m.tx, end_h = m.bh, end_ts = m.bts, end_fields = m.fl, req_id = null
        from (select e->>'type' typ, e->>'transaction_id' tx, (b->>'block_height')::bigint bh, (b->>'block_timestamp')::timestamptz bts,
                (select jsonb_object_agg(f->>'name', coalesce(f->'value'->'value'->>'value', f->'value'->>'value')) from jsonb_array_elements(convert_from(decode(e->>'payload','base64'),'UTF8')::jsonb->'value'->'fields') f) fl
              from jsonb_array_elements(r.body::jsonb) b, jsonb_array_elements(b->'events') e) m
       where p.funding_id = r.funding_id and m.fl->>'fundingResourceID' = r.funding_id::text;
      update flowty_archive.scratch_20261002_loan_probe set req_id = null, types_done = types_done + 1,
        state = case when types_done + 1 >= 2 then 'no_event' else 'window' end
       where funding_id = r.funding_id and state = 'window';
    end if;
  end loop;
  -- advance bisect -> window
  update flowty_archive.scratch_20261002_loan_probe set state = 'window', types_done = 0
   where state = 'bisect' and req_id is null and hi - lo <= 250 and flowty_archive.scratch_node(lo + 1) = flowty_archive.scratch_node(hi);
  -- dispatch
  for r in
    with q as (select p.*, case when state = 'detail' then fund_h when state = 'window' then hi else
                 case when hi - lo <= 250 then flowty_archive.scratch_spork_end(lo + 1)
                      when (lo + hi) / 2 between 85981135 and 86031699 then case when 86031700 < hi then 86031700 else 85981134 end
                      else (lo + hi) / 2 end end as at_h
               from flowty_archive.scratch_20261002_loan_probe p where state in ('detail','bisect','window') and req_id is null and attempts < 30),
         rk as (select q.*, flowty_archive.scratch_node(at_h) node, row_number() over (partition by flowty_archive.scratch_node(at_h) order by funding_id) rn from q)
    select * from rk where rn <= case when node like '%rest-mainnet%' then 20 when node like '%mainnet24%' then 4 else 8 end
  loop
    if r.state = 'window' then
      update flowty_archive.scratch_20261002_loan_probe set req_id = net.http_get(url := r.node || '/v1/events?type=' || v_types[r.types_done + 1] || '&start_height=' || (r.lo + 1) || '&end_height=' || r.hi, timeout_milliseconds := 30000)
       where funding_id = r.funding_id;
    else
      update flowty_archive.scratch_20261002_loan_probe set mid = r.at_h, req_id = flowty_archive.scratch_flag_req(r.at_h, array[r.funding_id], r.state = 'detail') where funding_id = r.funding_id;
    end if;
    v_disp := v_disp + 1;
  end loop;
  return jsonb_build_object('disp', v_disp);
end $function$
;

CREATE OR REPLACE FUNCTION flowty_archive.scratch_nft_meta_tick()
 RETURNS void
 LANGUAGE plpgsql
AS $function$
begin
  update flowty_archive.scratch_20261003_nft_meta m set status_code = r.status_code,
    title = case when r.status_code = 200 then (r.content::jsonb)->'card'->>'title' end,
    serial = case when r.status_code = 200 then coalesce((r.content::jsonb)->'nftView'->>'serial', (r.content::jsonb)->'card'->>'num') end,
    set_name = case when r.status_code = 200 then (select t->>'value' from jsonb_array_elements((r.content::jsonb)->'nftView'->'traits'->'traits') t where t->>'name' in ('SetName','setName','Set') limit 1) end,
    tier = case when r.status_code = 200 then (select t->>'value' from jsonb_array_elements((r.content::jsonb)->'nftView'->'traits'->'traits') t where t->>'name' in ('Tier','tier','Rarity','rarity') limit 1) end
  from net._http_response r where r.id = m.req_id and m.status_code is null and m.req_id is not null;
  update flowty_archive.scratch_20261003_nft_meta set status_code = null, req_id = null where status_code = 429;
  update flowty_archive.scratch_20261003_nft_meta m set req_id = null
   where m.status_code is null and m.req_id is not null and m.fired_at < now() - interval '3 minutes' and not exists (select 1 from net._http_response r where r.id = m.req_id);
  with p as (select addr, cname, nft_id from flowty_archive.scratch_20261003_nft_meta where status_code is null and req_id is null limit 30)
  update flowty_archive.scratch_20261003_nft_meta m set fired_at = now(),
    req_id = net.http_get('https://api2.flowty.io/nft/' || p.addr || '/' || p.cname || '/' || p.nft_id, headers => '{"Origin":"https://www.flowty.io"}'::jsonb, timeout_milliseconds => 30000)
  from p where (m.addr, m.cname, m.nft_id) = (p.addr, p.cname, p.nft_id);
end $function$
;

CREATE OR REPLACE FUNCTION flowty_archive.scratch_node(h bigint)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
AS $function$
 select CASE WHEN h <= 85981134 THEN 'http://access-001.mainnet24.nodes.onflow.org:8070' WHEN h <= 88226266 THEN 'http://access-001.mainnet25.nodes.onflow.org:8070' WHEN h <= 130290658 THEN 'http://access-001.mainnet26.nodes.onflow.org:8070' WHEN h <= 137390145 THEN 'http://access-001.mainnet27.nodes.onflow.org:8070' ELSE 'https://rest-mainnet.onflow.org' END $function$
;

CREATE OR REPLACE FUNCTION flowty_archive.scratch_rental_req(h bigint, id bigint)
 RETURNS bigint
 LANGUAGE sql
AS $function$
 select net.http_post(url := flowty_archive.scratch_node(h) || '/v1/scripts?block_height=' || h,
   body := jsonb_build_object('script', translate(encode(convert_to(
     case when h <= 85981134 then
E'import FlowtyRentals from 0x5c57f79c6694797f\npub fun main(id: UInt64): String {\n if let r = FlowtyRentals.borrowMarketplacePublic().borrowRental(rentalResourceID: id) {\n  let d = r.getDetails()\n  return (d.returned ? \"returned\" : \"open\").concat(\",\").concat(d.settled ? \"settled\" : \"unsettled\").concat(\",\").concat(d.startTime.toString()).concat(\",\").concat(d.term.toString())\n }\n return \"missing\"\n}'
     else
E'import FlowtyRentals from 0x5c57f79c6694797f\naccess(all) fun main(id: UInt64): String {\n if let r = FlowtyRentals.borrowMarketplacePublic().borrowRental(rentalResourceID: id) {\n  let d = r.getDetails()\n  return (d.returned ? \"returned\" : \"open\").concat(\",\").concat(d.settled ? \"settled\" : \"unsettled\").concat(\",\").concat(d.startTime.toString()).concat(\",\").concat(d.term.toString())\n }\n return \"missing\"\n}' end, 'UTF8'), 'base64'), E'\n', ''),
     'arguments', jsonb_build_array(translate(encode(convert_to(jsonb_build_object('type','UInt64','value',id::text)::text,'UTF8'),'base64'), E'\n', ''))),
   headers := '{"Content-Type": "application/json"}'::jsonb, timeout_milliseconds := 30000) $function$
;

CREATE OR REPLACE FUNCTION flowty_archive.scratch_snap_req(h bigint)
 RETURNS bigint
 LANGUAGE sql
AS $function$
 select net.http_post(
   url := flowty_archive.scratch_node(h) || '/v1/scripts?block_height=' || h,
   body := jsonb_build_object('script', translate(encode(convert_to(
     case when h <= 88226266 then E'import Flowty from 0x5c57f79c6694797f\npub fun main(): [UInt64] { return Flowty.borrowMarketplacePublic().getFundingIDs() }'
          else E'import Flowty from 0x5c57f79c6694797f\naccess(all) fun main(): [UInt64] { return Flowty.borrowMarketplacePublic().getFundingIDs() }' end, 'UTF8'), 'base64'), E'\n', ''),
     'arguments', '[]'::jsonb),
   headers := '{"Content-Type": "application/json"}'::jsonb, timeout_milliseconds := 30000) $function$
;

CREATE OR REPLACE FUNCTION flowty_archive.scratch_spork_end(h bigint)
 RETURNS bigint
 LANGUAGE sql
 IMMUTABLE
AS $function$
 select case when h <= 85981134 then 85981134 when h <= 88226266 then 88226266 when h <= 130290658 then 130290658 when h <= 137390145 then 137390145 else 999999999 end $function$
;

CREATE OR REPLACE FUNCTION flowty_archive.scratch_walk_tick()
 RETURNS jsonb
 LANGUAGE plpgsql
AS $function$
declare v_pts int; v_win int; v_split int; v_disp int := 0; r record;
  v_types text[] := array['A.5c57f79c6694797f.Flowty.FundingAvailable','A.5c57f79c6694797f.Flowty.FundingSettled','A.3cdbb3d569211ff3.NFTStorefrontV2.ListingCompleted','A.3cdbb3d569211ff3.NFTStorefrontV2.ListingAvailable','A.5c57f79c6694797f.Flowty.ListingAvailable','A.5c57f79c6694797f.FlowtyRentals.ListingAvailable','A.5c57f79c6694797f.FlowtyRentals.ListingRented'];
begin
  with c as (
    update flowty_archive.scratch_20261002_walk_point p set
      seq = case when h.status_code = 200 then (select sum((k->>'sequence_number')::int) from jsonb_array_elements(h.content::jsonb->'keys') k)
                 when h.status_code = 404 and h.content like '%account not found%' then 0 end,
      req_id = case when h.status_code = 200 or (h.status_code = 404 and h.content like '%account not found%') then p.req_id end,
      attempts = p.attempts + 1
    from net._http_response h where h.id = p.req_id and p.seq is null returning 1)
  select count(*) into v_pts from c;
  insert into flowty_archive.scratch_20261002_walk_found (wallet, lo, hi, tx_id, height, event_index, block_ts, fields)
  select i.wallet, i.lo, i.hi, e->>'transaction_id', (b->>'block_height')::bigint, (e->>'event_index')::int, (b->>'block_timestamp')::timestamptz,
         (select jsonb_object_agg(f->>'name', coalesce(f->'value'->'value'->>'value', f->'value'->>'value'))
            from jsonb_array_elements(convert_from(decode(e->>'payload','base64'),'UTF8')::jsonb->'value'->'fields') f) || jsonb_build_object('_type', e->>'type')
  from flowty_archive.scratch_20261002_walk_iv i join net._http_response h on h.id = i.req_id and h.status_code = 200,
       jsonb_array_elements(h.content::jsonb) b, jsonb_array_elements(b->'events') e
  where i.state = 'window'
  on conflict do nothing;
  with c as (
    update flowty_archive.scratch_20261002_walk_iv i set
      types_done = i.types_done + case when h.status_code = 200 then 1 else 0 end,
      state = case when h.status_code = 200 and i.types_done + 1 >= case when i.wallet = '0xbd94cade097e50ac' then 1 else 7 end then 'done' else 'window' end,
      req_id = null, attempts = i.attempts + 1
    from net._http_response h where h.id = i.req_id and i.state = 'window' returning 1)
  select count(*) into v_win from c;
  update flowty_archive.scratch_20261002_walk_point p set req_id = null where p.seq is null and p.req_id is not null
    and not exists (select 1 from net._http_response h where h.id = p.req_id) and p.req_id < (select max(id) - 3000 from net._http_response);
  update flowty_archive.scratch_20261002_walk_iv i set req_id = null where i.state = 'window' and i.req_id is not null
    and not exists (select 1 from net._http_response h where h.id = i.req_id) and i.req_id < (select max(id) - 3000 from net._http_response);
  update flowty_archive.scratch_20261002_walk_iv i set state = case when b.seq = a.seq then 'empty' else 'window' end
    from flowty_archive.scratch_20261002_walk_point a, flowty_archive.scratch_20261002_walk_point b
   where i.state = 'open' and a.wallet = i.wallet and a.h = i.lo and b.wallet = i.wallet and b.h = i.hi and a.seq is not null and b.seq is not null
     and (b.seq = a.seq or i.hi - i.lo <= 250);
  with s as (
    delete from flowty_archive.scratch_20261002_walk_iv i using flowty_archive.scratch_20261002_walk_point a, flowty_archive.scratch_20261002_walk_point b
     where i.state = 'open' and a.wallet = i.wallet and a.h = i.lo and b.wallet = i.wallet and b.h = i.hi and a.seq is not null and b.seq is not null
     returning i.wallet, i.lo, i.hi, (i.lo + i.hi) / 2 as mid),
  pts as (insert into flowty_archive.scratch_20261002_walk_point (wallet, h) select wallet, mid from s on conflict do nothing returning 1),
  kids as (insert into flowty_archive.scratch_20261002_walk_iv (wallet, lo, hi) select wallet, lo, mid from s union all select wallet, mid, hi from s on conflict do nothing returning 1)
  select count(*) into v_split from s;
  for r in
    with q as (
      select 'pt' k, wallet, h lo, h hi, 0 td, flowty_archive.scratch_node(h) node from flowty_archive.scratch_20261002_walk_point where seq is null and req_id is null and attempts < 20
      union all
      select 'win', wallet, lo, hi, types_done, flowty_archive.scratch_node(hi) from flowty_archive.scratch_20261002_walk_iv where state = 'window' and req_id is null and attempts < 40),
    rk as (select q.*, row_number() over (partition by node order by (wallet = '0xbd94cade097e50ac'), random()) rn from q)
    select * from rk where rn <= case when node like '%rest-mainnet%' then 30 when node like '%mainnet24%' then 16 else 20 end
  loop
    if r.k = 'pt' then
      update flowty_archive.scratch_20261002_walk_point set req_id = net.http_get(url := r.node || '/v1/accounts/' || replace(r.wallet,'0x','') || '?block_height=' || r.lo || '&expand=keys', timeout_milliseconds := 30000)
       where wallet = r.wallet and h = r.lo;
    else
      update flowty_archive.scratch_20261002_walk_iv set req_id = net.http_get(url := r.node || '/v1/events?type=' || case when r.wallet = '0xbd94cade097e50ac' then 'A.3cdbb3d569211ff3.NFTStorefrontV2.ListingCompleted' else v_types[r.td + 1] end || '&start_height=' || (r.lo + 1) || '&end_height=' || r.hi, timeout_milliseconds := 30000)
       where wallet = r.wallet and lo = r.lo and hi = r.hi;
    end if;
    v_disp := v_disp + 1;
  end loop;
  return jsonb_build_object('pts', v_pts, 'win', v_win, 'split', v_split, 'disp', v_disp);
end $function$
;

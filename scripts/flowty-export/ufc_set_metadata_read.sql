-- 2026-10-04 (PT) — how public.ufc_chain_set_editions (migration 20261004160834) was filled: every UFC setId the
-- checkpoint saw, read from the chain (UFC_NFT at 0x329feb3ab062d289, deployed source read the same day:
-- getSetMetadata(setId:) and getSetMaxEditions(setId:) are contract-level `access(all)` functions), 100 sets per
-- script, through pg_net (6 requests — a fast endpoint; never put slow history-node walks on pg_net).
create table flowty_archive.scratch_20261004_ufc_sets_req as
with s as (select a set_id, row_number() over (order by a) rn from (select distinct a from public.checkpoint_nft_meta where c='ufc') x),
b as (select (rn-1)/100 batch, array_agg(set_id order by set_id) ids from s group by 1)
select b.batch, b.ids, net.http_post(
  url := 'https://rest-mainnet.onflow.org/v1/scripts',
  headers := '{"Content-Type":"application/json"}'::jsonb,
  body := jsonb_build_object(
    'script', translate(encode(convert_to('import UFC_NFT from 0x329feb3ab062d289
access(all) fun main(ids: [UInt32]): {UInt32: {String: String}} {
  let out: {UInt32: {String: String}} = {}
  for id in ids {
    if let m = UFC_NFT.getSetMetadata(setId: id) {
      let r: {String: String} = {}
      for k in m.keys { if !k.contains("royalty") { r[k] = m[k]! } }
      r["_max_editions"] = (UFC_NFT.getSetMaxEditions(setId: id) ?? 0).toString()
      out[id] = r
    }
  }
  return out
}', 'UTF8'), 'base64'), E'\n', ''),
    'arguments', jsonb_build_array(translate(encode(convert_to(jsonb_build_object('type','Array','value',(select jsonb_agg(jsonb_build_object('type','UInt32','value',i::text)) from unnest(b.ids) i))::text, 'UTF8'), 'base64'), E'\n', '')))
) req_id from b;

-- parse (slug = slugifyUfcEdition in app/api/cron/ufc-sales-history-backfill/route.ts)
create table flowty_archive.scratch_20261004_ufc_sets as
with r as (select convert_from(decode(x.content::jsonb #>> '{}', 'base64'), 'UTF8')::jsonb body
             from net._http_response x where x.id in (select req_id from flowty_archive.scratch_20261004_ufc_sets_req) and x.status_code = 200),
kv as (select (e->'key'->>'value')::int set_id, e->'value'->'value' md from r, jsonb_array_elements(r.body->'value') e),
f as (select set_id, (select jsonb_object_agg(m->'key'->>'value', m->'value'->>'value') from jsonb_array_elements(md) m) meta from kv)
select set_id, meta, meta->>'name' name, nullif(meta->>'_max_editions','0')::int max_ed,
  trim(both '-' from regexp_replace(upper(meta->>'name'), '[^A-Z0-9]+', '-', 'g')) || coalesce('-' || nullif(meta->>'_max_editions','0'), '') slug
from f;

-- load (editions.external_id keeps mixed case: match case-insensitively; 0 collisions checked)
insert into public.ufc_chain_set_editions (set_id, set_name, max_editions, slug, edition_id, edition_external_id)
select s.set_id, s.name, s.max_ed, s.slug, e.id, e.external_id
from flowty_archive.scratch_20261004_ufc_sets s
left join public.editions e on e.collection_id = '9b4824a8-736d-4a96-b450-8dcc0c46b023' and upper(e.external_id) = upper(s.slug);

-- 2026-10-04 ~1:58 PM PT follow-up: the sale-block reads named 116 UFC NFTs in 12 sets the first read had not
-- seen (509 510 518 522 529 553 555 570 601 602 611 622). The same script, one request, into
-- flowty_archive.scratch_20261004_ufc_sets_req2 (ids = the setIds in checkpoint_nft_meta c='ufc' absent from
-- ufc_chain_set_editions); parsed and loaded with the same slug rule, ON CONFLICT DO NOTHING. 3 of 12 match a
-- catalog edition (509, 510, 601); 9 load with edition_id NULL (sets RPC's catalog lacks).

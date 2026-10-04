-- Scratch driver for flowty_archive.promote_flowty_chain_sales (migration 20261004025556) + the
-- index verification stamps, one 250,000-block slice per tick, only once EVERY 250-block window
-- of the slice is in flowty_archive.flowty_chain_walk_coverage. Created with execute_sql (2026-10-03);
-- kept for reproducibility. Driven by pg_cron 'flowty-promote-scratch'. A slice is promoted once
-- per pass; to re-run after a checkpoint back-fill, move the logged rows aside
-- (UPDATE ... SET slice_start = -slice_start) — the promotion is idempotent (NOT EXISTS on tx+nft).
CREATE TABLE IF NOT EXISTS flowty_archive.scratch_20261004_promoted (slice_start bigint PRIMARY KEY, slice_end bigint NOT NULL,
  pass int NOT NULL DEFAULT 1, result jsonb, promoted_at timestamptz NOT NULL DEFAULT now());

CREATE OR REPLACE FUNCTION flowty_archive.scratch_promote_tick() RETURNS jsonb LANGUAGE plpgsql AS $f$
declare r record; v jsonb; n_sealed int; n_mis int;
begin
  select s.a, s.b into r from (
    select g a, least(g + 249999, sp.e) b, ceil((least(g + 249999, sp.e) - g + 1) / 250.0)::int need
    from (values (65264619::bigint, 85981134::bigint), (85981135, 88226266), (88226267, 130290658), (130290659, 137390145)) sp(s, e),
         generate_series(sp.s, sp.e, 250000) g) s
  where not exists (select 1 from flowty_archive.scratch_20261004_promoted p where p.slice_start = s.a)
    and (select count(*) from flowty_archive.flowty_chain_walk_coverage c where c.win_start between s.a and s.b) = s.need
  order by s.a limit 1;
  if not found then return jsonb_build_object('idle', true); end if;
  v := flowty_archive.promote_flowty_chain_sales(r.a, r.b);
  -- verification stamps for Flowty's index docs whose listing completed on chain in this slice
  with j as (
    select i.doc_id, (i.tx_hash = c.tx_hash and i.nft_id = c.nft_id and i.price = c.price
                      and i.seller is not distinct from c.seller and i.buyer is not distinct from c.buyer
                      and i.payment_vault = c.payment_vault) exact, c.tx_hash, c.block_height
      from flowty_archive.flowty_chain_listing_completed c
      join flowty_archive.flowty_index_sales i on i.doc_id = c.listing_resource_id || '_STOREFRONT_PURCHASED'
     where c.block_height between r.a and r.b and i.verify_status is null
  ), u as (
    update flowty_archive.flowty_index_sales i
       set verify_status = case when j.exact then 'chain_sealed' else 'chain_mismatch' end, verified_at = now(),
           verify_detail = jsonb_build_object('chain_tx', j.tx_hash, 'block_height', j.block_height, 'exact', j.exact)
      from j where i.doc_id = j.doc_id
    returning i.verify_status)
  select count(*) filter (where verify_status = 'chain_sealed'), count(*) filter (where verify_status = 'chain_mismatch') into n_sealed, n_mis from u;
  v := v || jsonb_build_object('index_chain_sealed', n_sealed, 'index_chain_mismatch', n_mis);
  insert into flowty_archive.scratch_20261004_promoted (slice_start, slice_end, result) values (r.a, r.b, v);
  return v;
end $f$;

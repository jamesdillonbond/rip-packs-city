-- Scratch driver for flowty_archive.promote_flowty_chain_sales (migration 20261004025556) + the
-- index verification stamps, one 50,000-block slice per tick (250k slices hit the 120 s
-- statement_timeout on dense mainnet26 ranges — 2026-10-03 ~11:30 PM PT; a logged 250k slice still
-- covers its five sub-slices), only once EVERY 250-block window
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
    select g a, least(g + 49999, sp.e) b, ceil((least(g + 49999, sp.e) - g + 1) / 250.0)::int need
    from (values (65264619::bigint, 85981134::bigint), (85981135, 88226266), (88226267, 130290658), (130290659, 137390145), (137390146, 152500000)) sp(s, e),
         generate_series(sp.s, sp.e, 50000) g) s
  where not exists (select 1 from flowty_archive.scratch_20261004_promoted p where p.slice_start > 0 and s.a between p.slice_start and p.slice_end)
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
     where c.block_height between r.a and r.b and (i.verify_status is null or i.verify_status = 'rpc_chain_match')
  ), u as (
    update flowty_archive.flowty_index_sales i
       set verify_status = case when j.exact then 'chain_sealed' else 'chain_mismatch' end, verified_at = now(),
           verify_detail = coalesce(i.verify_detail, '{}'::jsonb) || jsonb_build_object('chain_tx', j.tx_hash, 'block_height', j.block_height, 'exact', j.exact, 'method', 'walk')
      from j where i.doc_id = j.doc_id
    returning i.verify_status)
  select count(*) filter (where verify_status = 'chain_sealed'), count(*) filter (where verify_status = 'chain_mismatch') into n_sealed, n_mis from u;
  v := v || jsonb_build_object('index_chain_sealed', n_sealed, 'index_chain_mismatch', n_mis);
  insert into flowty_archive.scratch_20261004_promoted (slice_start, slice_end, result) values (r.a, r.b, v);
  return v;
end $f$;

-- mainnet24 era (per-transaction verified, migration 20261004031134): cycle the 43 weeks of
-- 2023-11-08 .. 2024-09-04 oldest-run-first and promote whatever the verifier has sealed so far.
-- pg_cron 'flowty-promote-tx-scratch' (every 2 minutes). Idempotent (NOT EXISTS on tx+nft).
-- (2-day windows since ~11:30 PM PT: a 7-day window hit the 120 s statement_timeout once.)
CREATE TABLE IF NOT EXISTS flowty_archive.scratch_20261004_promoted_tx2 (win_start timestamptz PRIMARY KEY,
  runs int NOT NULL DEFAULT 0, last_result jsonb, last_run_at timestamptz);
CREATE OR REPLACE FUNCTION flowty_archive.scratch_promote_tx_tick() RETURNS jsonb LANGUAGE plpgsql AS $f$
declare w timestamptz; v jsonb;
begin
  select win_start into w from flowty_archive.scratch_20261004_promoted_tx2 where last_run_at is null order by win_start limit 1;
  if not found then return jsonb_build_object('idle', true); end if;   -- 2026-10-04 ~2:00 PM PT: one pass per reset, then idle
  v := flowty_archive.promote_flowty_tx_verified_sales(w, least(w + interval '2 days', '2024-09-04 12:02:35+00'::timestamptz));
  update flowty_archive.scratch_20261004_promoted_tx2 set runs = runs + 1, last_result = v, last_run_at = now() where win_start = w;
  return v;
end $f$;

-- Dapper-contract sales (migrations 20261004114808 + 20261004123055): cycle 7-day windows from the
-- mainnet24 root to now, oldest-run-first, promoting whatever dapper-tx-verify.yml has sealed so far.
-- pg_cron 'dapper-promote-scratch' (job 699, every 30 s; created 2026-10-04 ~5:30 AM PT). Idempotent:
-- tx + nft NOT EXISTS, and a same-NFT sale within 10 minutes from ANY source is skipped (atlas rows
-- carry no tx hash).
CREATE TABLE IF NOT EXISTS flowty_archive.scratch_20261004_promoted_dapper (win_start timestamptz PRIMARY KEY,
  runs int NOT NULL DEFAULT 0, last_result jsonb, last_run_at timestamptz);
INSERT INTO flowty_archive.scratch_20261004_promoted_dapper (win_start)
SELECT g FROM generate_series('2023-11-08 16:07:03+00'::timestamptz, now(), interval '7 days') g ON CONFLICT DO NOTHING;
CREATE OR REPLACE FUNCTION flowty_archive.scratch_promote_dapper_tick() RETURNS jsonb LANGUAGE plpgsql AS $f$
declare w timestamptz; v jsonb;
begin
  select win_start into w from flowty_archive.scratch_20261004_promoted_dapper where last_run_at is null order by win_start limit 1;
  if not found then return jsonb_build_object('idle', true); end if;   -- 2026-10-04 ~2:00 PM PT: one pass per reset, then idle
  v := flowty_archive.promote_dapper_tx_verified_sales(w, w + interval '7 days');
  update flowty_archive.scratch_20261004_promoted_dapper set runs = runs + 1, last_result = v, last_run_at = now() where win_start = w;
  return v;
end $f$;

-- Candidate build for the Dapper-contract verifier (migration 20261004124451): one 20,000-row chunk of the
-- unverified index rows per tick, cursor in scratch_20261004_cfg ('dapper_cand_cursor'; 'done' when the
-- scan ends). pg_cron 'dapper-candidates-scratch' (job 700, every 30 s; created ~5:45 AM PT 2026-10-04).
CREATE OR REPLACE FUNCTION flowty_archive.scratch_dapper_candidates_tick() RETURNS jsonb LANGUAGE plpgsql AS $f$
declare c text; r jsonb;
begin
  select v into c from flowty_archive.scratch_20261004_cfg where k = 'dapper_cand_cursor';
  if c = 'done' then return jsonb_build_object('idle', true); end if;
  r := flowty_archive.dapper_tx_candidates_build(c, 20000);
  update flowty_archive.scratch_20261004_cfg set v = case when (r->>'done')::boolean then 'done' else r->>'last_doc' end where k = 'dapper_cand_cursor';
  return r;
end $f$;

-- UFC chain-named promotion (migration 20261004160834): one 45-day slice per tick, oldest first, over
-- 2023-11-01 .. 2026-10-05. pg_cron 'ufc-promote-scratch' (job 702, every 20 s; created ~9:08 AM PT 2026-10-04).
create table flowty_archive.scratch_20261004_ufc_slices as
select g as win_start, least(g + interval '45 days', '2026-10-05'::timestamptz) win_end, null::jsonb result, null::timestamptz ran_at
from generate_series('2023-11-01'::timestamptz, '2026-10-04'::timestamptz, interval '45 days') g;
create or replace function flowty_archive.scratch_ufc_promote_tick() returns jsonb language plpgsql as $f$
declare w record; v jsonb;
begin
  select * into w from flowty_archive.scratch_20261004_ufc_slices where ran_at is null order by win_start limit 1;
  if not found then return jsonb_build_object('idle', true); end if;
  v := flowty_archive.promote_ufc_chain_named_sales(w.win_start, w.win_end);
  update flowty_archive.scratch_20261004_ufc_slices set result = v, ran_at = now() where win_start = w.win_start;
  return v;
end $f$;

-- Sale-block read candidates (migration 20261004161541): one calendar month per tick, 2023-11 .. 2026-10,
-- from the per-tx lanes (method 'tx' / 'tx_dapper', block_id) and the chain walk (block_height), keeping only
-- sales whose NFT no checkpoint holds and that are not in `sales` (tx + nft, nor a same-NFT sale ±10 min).
-- pg_cron 'sbr-candidates-scratch' (job 703, every 30 s; created ~9:20 AM PT 2026-10-04). Body as created:
-- see flowty_archive.scratch_sbr_candidates_tick() — the INSERT … SELECT of the session log 2026-10-04.
-- 2026-10-04 ~3:25 PM PT: two walk ticks (one from each end) halve the re-promotion. Each takes a per-slice
-- advisory xact lock and re-checks "not yet promoted" after taking it, so the two never promote one slice together
-- (the check-then-insert promoter is not safe to run twice concurrently over the same blocks: 7 duplicates, 3:05 PM PT).
CREATE OR REPLACE FUNCTION flowty_archive.scratch_promote_tick_dir(p_desc boolean) RETURNS jsonb LANGUAGE plpgsql AS $f$
declare r record; c record; v jsonb; n_sealed int; n_mis int; got boolean := false;
begin
  for c in
    select s.a, s.b from (
      select g a, least(g + 49999, sp.e) b, ceil((least(g + 49999, sp.e) - g + 1) / 250.0)::int need
      from (values (65264619::bigint, 85981134::bigint), (85981135, 88226266), (88226267, 130290658), (130290659, 137390145), (137390146, 152500000)) sp(s, e),
           generate_series(sp.s, sp.e, 50000) g) s
    where not exists (select 1 from flowty_archive.scratch_20261004_promoted p where p.slice_start > 0 and s.a between p.slice_start and p.slice_end)
      and (select count(*) from flowty_archive.flowty_chain_walk_coverage cv where cv.win_start between s.a and s.b) = s.need
    order by case when p_desc then -s.a else s.a end
  loop
    if pg_try_advisory_xact_lock(20261004, c.a::int)
       and not exists (select 1 from flowty_archive.scratch_20261004_promoted p where p.slice_start > 0 and c.a between p.slice_start and p.slice_end) then
      r := c; got := true; exit;
    end if;
  end loop;
  if not got then return jsonb_build_object('idle', true); end if;
  v := flowty_archive.promote_flowty_chain_sales(r.a, r.b);
  with j as (
    select i.doc_id, (i.tx_hash = c2.tx_hash and i.nft_id = c2.nft_id and i.price = c2.price
                      and i.seller is not distinct from c2.seller and i.buyer is not distinct from c2.buyer
                      and i.payment_vault = c2.payment_vault) exact, c2.tx_hash, c2.block_height
      from flowty_archive.flowty_chain_listing_completed c2
      join flowty_archive.flowty_index_sales i on i.doc_id = c2.listing_resource_id || '_STOREFRONT_PURCHASED'
     where c2.block_height between r.a and r.b and (i.verify_status is null or i.verify_status = 'rpc_chain_match')
  ), u as (
    update flowty_archive.flowty_index_sales i
       set verify_status = case when j.exact then 'chain_sealed' else 'chain_mismatch' end, verified_at = now(),
           verify_detail = coalesce(i.verify_detail, '{}'::jsonb) || jsonb_build_object('chain_tx', j.tx_hash, 'block_height', j.block_height, 'exact', j.exact, 'method', 'walk')
      from j where i.doc_id = j.doc_id
    returning i.verify_status)
  select count(*) filter (where verify_status = 'chain_sealed'), count(*) filter (where verify_status = 'chain_mismatch') into n_sealed, n_mis from u;
  v := v || jsonb_build_object('index_chain_sealed', n_sealed, 'index_chain_mismatch', n_mis, 'dir', case when p_desc then 'desc' else 'asc' end);
  insert into flowty_archive.scratch_20261004_promoted (slice_start, slice_end, result) values (r.a, r.b, v);
  return v;
end $f$;

CREATE OR REPLACE FUNCTION flowty_archive.scratch_promote_tick() RETURNS jsonb LANGUAGE sql AS $f$
  select flowty_archive.scratch_promote_tick_dir(false)
$f$;

-- Pinnacle metadata backfill: complete, bounded discovery for Q3 and Q4.
--
-- WHY (measured 2026-09-11 PT on a quiet instance — 1 active backend, 0 IO waiters):
-- the route's Q3 and Q4 discovery pools were PostgREST reads with `.limit(5000)`
-- / `.limit(8000)` and NO `.order()`. The matching population is 56,440 rows
-- (register #71 said ">= 9,000"; re-derived today), so PostgREST returned its
-- 1,000-row cap and the effective pool was an UNDEFINED physical head. Effect,
-- measured rather than asserted: 419 distinct composite edition_keys exist and
-- 9 of them lack a complete pinnacle_editions row, but the lane saw 2-3 per tick
-- (`q4_eligible` 2-3 on every one of the last 63 hourly runs) and `q3_eligible`
-- was 0 on every one of them while FIVE real wmc-vs-map disagreements sit in the
-- collection. The unreachable ones were unreachable forever: nothing in the read
-- advanced.
--
-- WHY NOT "just page the whole pool": measured, both ways.
--   DISTINCT ON over the pool          38,398 buffers /  8,076 ms  (external sort)
--   full wmc x pinnacle_nft_map join  213,341 buffers / 12,110 ms  (nested loop)
--   the same join, hash/merge forced  145,054 buffers / 28,145 ms
-- An hourly lane cannot pay that on a 2-core / 22 MB/s instance; it is the
-- `sales-counterparty-backfill` shape (a full rescan to find nothing).
--
-- WHAT THIS DOES INSTEAD:
--   * one LOOSE INDEX SCAN (skip scan) over idx_wmc_coll_ek_serial_cover returns
--     all 423 distinct edition_keys for 2,154 buffers / 255 ms — 18x cheaper than
--     the DISTINCT ON above, and COMPLETE rather than a 1,000-row head.
--   * Q4 then resolves its targets from that complete key list (9 of 9 reachable,
--     2,300 buffers / 98 ms end-to-end) and publishes `q4_targets_total`, so
--     convergence is observable instead of inferred.
--   * Q3 walks the SAME key list behind a persisted cursor, p_q3_keys keys per
--     tick, wrapping at the end. Measured at 25 keys / 1,280 rows: 5,966 buffers
--     / 877 ms cold. A full pass is ~17 ticks (~17 h) and ~100k buffers, i.e. the
--     per-tick cost is bounded AND the per-pass cost is half the single full scan
--     it replaces. The cursor advances on KEY BOUNDARIES, so a key is always
--     scanned whole (max rows for one key today: 1,510) and no row can fall
--     between two slices.
--
-- The cursor is the point: this is the queue-walk-from-the-top shape CLAUDE.md
-- names, and an unordered head that never moves is how it presents.

create table if not exists public.pinnacle_metadata_backfill_state (
  id                    text primary key,
  q3_cursor_edition_key text,
  q3_passes             integer not null default 0,
  q3_keys_scanned_total bigint  not null default 0,
  updated_at            timestamptz not null default now()
);

alter table public.pinnacle_metadata_backfill_state enable row level security;
revoke all on table public.pinnacle_metadata_backfill_state from public, anon, authenticated;

insert into public.pinnacle_metadata_backfill_state (id) values ('default')
on conflict (id) do nothing;

comment on table public.pinnacle_metadata_backfill_state is
  'Cursor state for /api/cron/pinnacle-metadata-backfill Q3 (wmc-vs-pinnacle_nft_map disagreement walk). One row, id = ''default''. q3_cursor_edition_key is the LAST edition_key fully scanned; NULL means start-of-list. q3_passes counts completed wraps. Written only by pinnacle_metadata_discovery().';

create or replace function public.pinnacle_metadata_discovery(
  p_q3_keys  integer default 25,
  p_q3_limit integer default 25,
  p_q4_limit integer default 60
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  c_collection constant uuid := '7dd9dd11-e8b6-45c4-ac99-71331f959714';
  v_all_keys   text[];
  v_keys       text[];
  v_cursor     text;
  v_next       text;
  v_wrapped    boolean := false;
  v_q3         jsonb;
  v_q4         jsonb;
  v_q4_total   integer;
  v_pass       integer;
begin
  p_q3_keys  := greatest(1, least(coalesce(p_q3_keys, 25), 200));
  p_q3_limit := greatest(1, least(coalesce(p_q3_limit, 25), 500));
  p_q4_limit := greatest(1, least(coalesce(p_q4_limit, 60), 500));

  select s.q3_cursor_edition_key, s.q3_passes
    into v_cursor, v_pass
    from public.pinnacle_metadata_backfill_state s
   where s.id = 'default'
     for update;
  if not found then
    insert into public.pinnacle_metadata_backfill_state (id) values ('default')
      on conflict (id) do nothing;
    v_cursor := null;
    v_pass := 0;
  end if;

  -- Every distinct Pinnacle edition_key, via a loose index scan over
  -- idx_wmc_coll_ek_serial_cover. COMPLETE by construction: each step asks the
  -- index for the next key strictly greater than the last, so the walk cannot
  -- skip one, and it touches ~1 index page per key instead of every row.
  with recursive k as (
    (select w.edition_key
       from public.wallet_moments_cache w
      where w.collection_id = c_collection
        and w.edition_key is not null
      order by w.edition_key
      limit 1)
    union all
    (select (select w2.edition_key
               from public.wallet_moments_cache w2
              where w2.collection_id = c_collection
                and w2.edition_key > k.edition_key
              order by w2.edition_key
              limit 1)
       from k
      where k.edition_key is not null)
  )
  select array_agg(k.edition_key order by k.edition_key)
    into v_all_keys
    from k
   where k.edition_key is not null;

  v_all_keys := coalesce(v_all_keys, array[]::text[]);

  -- Q3 slice: the next p_q3_keys keys after the cursor; wrap when exhausted.
  v_keys := array(select x from unnest(v_all_keys) x
                   where v_cursor is null or x > v_cursor
                   order by x limit p_q3_keys);
  if cardinality(v_keys) = 0 and cardinality(v_all_keys) > 0 then
    v_wrapped := true;
    v_cursor := null;
    v_keys := array(select x from unnest(v_all_keys) x order by x limit p_q3_keys);
  end if;

  select coalesce(jsonb_agg(to_jsonb(d)), '[]'::jsonb)
    into v_q3
    from (
      select w.id::text  as wmc_id,
             w.wallet_address,
             w.moment_id,
             w.edition_key as wmc_key,
             m.edition_key as map_key
        from public.wallet_moments_cache w
        join public.pinnacle_nft_map m on m.nft_id = w.moment_id
       where w.collection_id = c_collection
         and w.edition_key = any(v_keys)
         and w.edition_key like '%:%'   -- composite vs composite only, per the
         and m.edition_key like '%:%'   -- route's original spec: an integer key
         and m.edition_key <> w.edition_key
       order by w.edition_key, w.id
       limit p_q3_limit
    ) d;

  -- Q4: keys with no COMPLETE pinnacle_editions row, plus one sample holder each.
  -- The total is published alongside the capped list so a reader can tell "the
  -- cap is binding" from "the backlog is not shrinking" — the #70 trap, one level
  -- down: a per-step count with no population next to it cannot show convergence.
  with targets as (
    select x as edition_key
      from unnest(v_all_keys) x
     where x like '%:%:%'
       and not exists (
             select 1 from public.pinnacle_editions pe
              where pe.id = x
                and pe.character_name is not null
                and pe.character_name <> 'Unknown'
                and pe.edition_key is not null)
  ), capped as (
    select edition_key from targets order by edition_key limit p_q4_limit
  ), sampled as (
    select c.edition_key, s.wallet_address, s.moment_id
      from capped c
      cross join lateral (
        select w.wallet_address, w.moment_id
          from public.wallet_moments_cache w
         where w.collection_id = c_collection
           and w.edition_key = c.edition_key
         order by w.serial_number nulls last
         limit 1) s
  )
  select (select count(*) from targets),
         coalesce((select jsonb_agg(to_jsonb(sampled)) from sampled), '[]'::jsonb)
    into v_q4_total, v_q4;

  v_next := case when cardinality(v_keys) > 0
                 then v_keys[cardinality(v_keys)]
                 else v_cursor end;

  update public.pinnacle_metadata_backfill_state
     set q3_cursor_edition_key = v_next,
         q3_passes             = q3_passes + (case when v_wrapped then 1 else 0 end),
         q3_keys_scanned_total = q3_keys_scanned_total + cardinality(v_keys),
         updated_at            = now()
   where id = 'default';

  return jsonb_build_object(
    'q3',                    v_q3,
    'q3_keys_scanned',       cardinality(v_keys),
    'q3_cursor_before',      v_cursor,
    'q3_cursor_after',       v_next,
    'q3_wrapped',            v_wrapped,
    'q3_pass',               coalesce(v_pass, 0) + (case when v_wrapped then 1 else 0 end),
    'q4',                    v_q4,
    'q4_targets_total',      v_q4_total,
    'distinct_edition_keys', cardinality(v_all_keys),
    'generated_at',          now()
  );
end;
$fn$;

comment on function public.pinnacle_metadata_discovery(integer, integer, integer) is
  'Discovery for /api/cron/pinnacle-metadata-backfill Q3 + Q4. Replaces two unordered PostgREST reads that were clamped to a 1,000-row physical head of a 56,440-row pool (register #71). Q4 coverage is COMPLETE (all distinct edition_keys, via a loose index scan); Q3 is a cursored key-boundary walk so every key is scanned whole and the walk advances. Service-role only.';

revoke all on function public.pinnacle_metadata_discovery(integer, integer, integer) from public, anon, authenticated;
grant execute on function public.pinnacle_metadata_discovery(integer, integer, integer) to service_role;

-- Q4's completeness predicate was an infinite repair loop for three editions.
--
-- MEASURED 2026-09-11 PT (quiet instance). `pinnacle_metadata_discovery` — and
-- the route's JS before it — called a catalog row COMPLETE only when
-- `character_name <> 'Unknown'`. But the route's own writer converts an EMPTY
-- on-chain characterName to the literal 'Unknown' (deliberately: it must not
-- invent a name), so for an edition whose Pinnacle shape metadata carries no
-- character, the repair WRITES THE EXACT CONDITION THAT RE-SELECTS IT. Those
-- rows were re-upserted forever, reporting `catalog_upserted: 1-2` every tick
-- while nothing converged.
--
-- The three, with their real on-chain mint counts and the tick that last
-- rewrote them:
--   PAS-LEEV2-TS30:Radiant Chrome:1   mint 270   updated 2026-09-10 09:22Z
--   PAS-LEV1-PTRE:Standard:1          mint 299   updated 2026-09-12 04:22Z
--   WDAS-LEEV2-P100:Radiant Chrome:1  mint 148   updated 2026-09-09 20:22Z
-- Of 569 catalog rows, 11 read 'Unknown'; 3 are these (chain-written) and the
-- rest are fetch-missing stubs with a NULL edition_key, which is the real stub
-- tell. 'Unknown' alone never was one.
--
-- COMPLETE now means WRITTEN FROM CHAIN: edition_key AND mint_count both present.
-- That is a claim about provenance, which is what Q4 can actually establish, and
-- it cannot be un-satisfied by the writer's own output. Measured effect:
-- q4_targets_total 9 -> 7. Three chain-written rows leave the queue; one row
-- JOINS it (STAR-GEN-LFGE:Genesis:1 — a real character name but a NULL
-- mint_count, i.e. Q1's own never-filling candidate), which is correct: it is
-- not chain-written either.
--
-- The exclusion is PUBLISHED, not silent: `q4_unknown_name_chain_written`
-- reports how many rows the new predicate keeps out that the old one would have
-- kept in. An exclusion nobody can count is how a guard goes quietly blind.
--
-- KNOWN COST, stated rather than discovered later: if Pinnacle later populates
-- the shape metadata for one of these three, nothing here will pick it up —
-- Q4 will never re-read them. That is the deliberate trade for a lane that
-- terminates. Re-check by hand if the count above ever matters.

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
  v_unknown    integer;
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

  -- Q4: keys with no CHAIN-WRITTEN pinnacle_editions row, plus one sample holder
  -- each. The total is published alongside the capped list so a reader can tell
  -- "the cap is binding" from "the backlog is not shrinking" — the #70 trap, one
  -- level down: a per-step count with no population next to it cannot show
  -- convergence.
  with targets as (
    select x as edition_key
      from unnest(v_all_keys) x
     where x like '%:%:%'
       and not exists (
             select 1 from public.pinnacle_editions pe
              where pe.id = x
                and pe.edition_key is not null
                and pe.mint_count is not null)
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

  -- What the predicate change EXCLUDES, counted where a reader will meet it.
  select count(*)
    into v_unknown
    from public.pinnacle_editions pe
   where pe.character_name = 'Unknown'
     and pe.edition_key is not null
     and pe.mint_count is not null;

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
    'q4_unknown_name_chain_written', v_unknown,
    'distinct_edition_keys', cardinality(v_all_keys),
    'generated_at',          now()
  );
end;
$fn$;

comment on function public.pinnacle_metadata_discovery(integer, integer, integer) is
  'Discovery for /api/cron/pinnacle-metadata-backfill Q3 + Q4. Replaces two unordered PostgREST reads that were clamped to a 1,000-row physical head of a 56,440-row pool (register #71). Q4 coverage is COMPLETE (all distinct edition_keys, via a loose index scan) and COMPLETENESS means CHAIN-WRITTEN (edition_key + mint_count), not a character_name, because the writer turns an empty on-chain name into the literal ''Unknown'' and the old predicate therefore re-selected its own output forever. Q3 is a cursored key-boundary walk. Service-role only.';

revoke all on function public.pinnacle_metadata_discovery(integer, integer, integer) from public, anon, authenticated;
grant execute on function public.pinnacle_metadata_discovery(integer, integer, integer) to service_role;

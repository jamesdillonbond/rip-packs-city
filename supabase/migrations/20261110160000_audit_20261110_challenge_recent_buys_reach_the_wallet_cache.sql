-- 2026-11-10 (Trevor: "How can we fix that moving forward?" → "Do all of them").
--
-- spitehouse stopped at 5 of 6 in Dame Time while HOLDING a sixth Lillard. He
-- bought it 11-09 12:43 PM PT; his wallet_moments_cache rows were last walked at
-- 9:32 AM that day. Every challenge path reads ONLY that cache — the pin picker
-- (/api/profile/top-moments), the ownership gate (checkChallengePin), "Fill my
-- case" and the admin fill_partial_challenge_cases — so a piece bought after the
-- last walk is invisible to all four until the next full walk.
--
-- Two functions close that gap without a full five-collection walk:
--
--   get_unwalked_topshot_buys(wallet)  — Top Shot moments this wallet BOUGHT
--     since (its newest cache row − 1 h) that are not in its cache yet. A
--     CANDIDATE LIST, never a holding claim: a bought piece may have been sold
--     or gifted since.
--
--   record_verified_topshot_buys(wallet, ids_held, locked_ids)  — writes ONLY
--     ids that are BOTH in that candidate list (re-derived here, so a caller
--     cannot plant an arbitrary moment) AND confirmed held on-chain by the
--     caller (lib/giveaways/topshot-holdings.ts readTopShotHoldings, the same
--     Cadence the lock-check cron runs). Names/sets/tiers come from `editions`,
--     never from the caller.
--
-- ⚠ last_seen_at is written as the wallet's EXISTING newest row (the walk
-- anchor), NOT now(). The fill paths treat a row as held when it was seen
-- within a day of the wallet's newest row; stamping now() would make the new
-- row the newest and silently disqualify every older row of a wallet last
-- walked >1 day ago. lock_checked_at = now() records the on-chain read itself.
--
-- Revert: DROP FUNCTION public.record_verified_topshot_buys(text, text[], text[]);
--         DROP FUNCTION public.get_unwalked_topshot_buys(text, integer);
--         Rows written carry lock_checked_at from this lane and are ordinary
--         cache rows the next full walk reconciles.

create or replace function public.get_unwalked_topshot_buys(p_wallet text, p_limit integer default 200)
returns table (moment_id text, edition_key text, serial_number integer, sold_at timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  with anchor as (
    select coalesce(
      (select max(w.last_seen_at) - interval '1 hour'
         from public.wallet_moments_cache w
        where w.wallet_address = p_wallet
          and w.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid),
      now() - interval '30 days') as since
  ),
  buys as (
    select distinct on (s.nft_id::text)
           s.nft_id::text as moment_id, e.external_id as edition_key,
           s.serial_number, s.sold_at
      from public.sales s
      join public.editions e on e.id = s.edition_id
     cross join anchor a
     where s.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid
       and s.buyer_address = p_wallet
       and s.sold_at >= greatest(a.since, now() - interval '30 days')
       and s.nft_id is not null
       and e.external_id is not null
     order by s.nft_id::text, s.sold_at desc
  )
  select b.moment_id, b.edition_key, b.serial_number, b.sold_at
    from buys b
   where not exists (
     select 1 from public.wallet_moments_cache w
      where w.wallet_address = p_wallet
        and w.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid
        and w.moment_id = b.moment_id)
   order by b.sold_at desc
   limit greatest(1, least(coalesce(p_limit, 200), 500));
$$;

create or replace function public.record_verified_topshot_buys(
  p_wallet text,
  p_held_ids text[],
  p_locked_ids text[] default '{}'
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_anchor timestamptz;
  v_written integer;
begin
  if p_wallet is null or p_wallet !~ '^0x[0-9a-f]{16}$' then
    raise exception 'not a Flow address: %', p_wallet;
  end if;
  if coalesce(array_length(p_held_ids, 1), 0) = 0 then
    return 0;
  end if;

  select max(w.last_seen_at) into v_anchor
    from public.wallet_moments_cache w
   where w.wallet_address = p_wallet
     and w.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid;

  with cand as (
    select c.* from public.get_unwalked_topshot_buys(p_wallet, 500) c
     where c.moment_id = any (p_held_ids)
  ),
  ins as (
    insert into public.wallet_moments_cache as w (
      wallet_address, collection_id, moment_id, edition_key, serial_number,
      player_name, set_name, tier, mint_count, fmv_usd,
      last_seen_at, acquired_at, is_locked, lock_checked_at)
    select p_wallet, '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid, c.moment_id, c.edition_key, c.serial_number,
           e.player_name, e.set_name, e.tier::text, e.circulation_count,
           (select f.fmv_usd from public.edition_fmv_current f where f.edition_id = e.id limit 1),
           coalesce(v_anchor, now()), c.sold_at, c.moment_id = any (coalesce(p_locked_ids, '{}')), now()
      from cand c
      join public.editions e
        on e.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid
       and e.external_id = c.edition_key
    on conflict (wallet_address, collection_id, moment_id) do nothing
    returning 1
  )
  select count(*) into v_written from ins;
  return v_written;
end;
$$;

-- anon-exec: revoked — both are service-role lanes (fill route, picker sync route, hourly cron route).
revoke all on function public.get_unwalked_topshot_buys(text, integer) from public, anon, authenticated;
revoke all on function public.record_verified_topshot_buys(text, text[], text[]) from public, anon, authenticated;
grant execute on function public.get_unwalked_topshot_buys(text, integer) to service_role;
grant execute on function public.record_verified_topshot_buys(text, text[], text[]) to service_role;

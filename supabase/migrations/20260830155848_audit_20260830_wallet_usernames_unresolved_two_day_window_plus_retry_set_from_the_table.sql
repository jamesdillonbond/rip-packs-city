-- audit_20260830: wallet_usernames_unresolved scanned 21 days of sales every
-- 30 minutes to find wallets that first appeared in the last one.
--
-- MEASURED 2026-08-30 15:5xZ. get_pipeline_alerts(): wallet-username-resolver
-- 10/19 runs failed over 2 days, every one "canceling statement due to
-- statement timeout" (the function's own 60 s). EXPLAIN ANALYZE on a calm
-- instance (0 active backends): 34,843 hits + 23,758 reads, 8.5 s -- 58k
-- buffers per tick, 48 ticks/day, ~1.1M disk reads/day -- for a candidate
-- list that is, by construction, (a) wallets seen in sales/pack_purchases
-- that have no wallet_usernames row yet, plus (b) rows in wallet_usernames
-- with a NULL username not attempted for 14 days. The 08-10 fix halved this
-- by scanning sales once; the window itself is the remaining cost, and the
-- window exists only for (b): a wallet that traded in the last 21 days
-- and failed resolution 14 days ago.
--
-- CHANGE: (a) is taken from a 2-DAY window (the resolver runs every 30 min
-- with p_limit 200; new distinct addresses per 2 days are in the low
-- hundreds, so nothing is left behind), ordered newest-seen first exactly as
-- before. (b) is taken from wallet_usernames itself (9,364 rows, pkey probe)
-- -- 1,007 rows today -- ordered by last_attempted_at NULLS FIRST, and
-- appended AFTER the new wallets. Difference stated: the retry set is no
-- longer restricted to wallets seen in the last 21 days, so a wallet that
-- went quiet can be retried once per 14 days (<= 200 GQL calls per tick,
-- the same cap as before; the route already spaces requests 200 ms apart).
-- The escrow-seller exclusion, the lower() normalisation and the return
-- shape are unchanged. wallet_usernames.wallet_addr is already lowercase
-- (0 of 9,364 rows differ), so the anti-join uses the pkey directly.
--
-- Not pinned before (no test); not pinned now.
-- anon-exec: wallet_usernames_unresolved -- unchanged (CREATE OR REPLACE
-- keeps the existing grants; service_role caller).
--
-- Exit (48 h): wallet-username-resolver failure_rate leaves
-- get_pipeline_alerts(); the function's mean falls from seconds toward
-- tens of ms; resolved usernames/day unchanged. Falsifier: rows_written per
-- run falls -> a class of new wallets appears only in the 3-21-day band
-- (widen to 7 days, still cheap).
-- Revert: re-apply 20260810050000_audit_20260810_wallet_usernames_unresolved_single_sales_scan.sql.

CREATE OR REPLACE FUNCTION public.wallet_usernames_unresolved(p_limit integer DEFAULT 200)
 RETURNS text[]
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '60s'
AS $function$
  with candidates as (
    -- New wallets: a 2-day window is enough for a 30-minute resolver.
    select lower(a.addr) as addr, s.sold_at as last_seen
      from public.sales s
      cross join lateral (values (s.buyer_address), (s.seller_address)) a(addr)
     where s.sold_at >= now() - interval '2 days'
       and a.addr is not null
    union all
    select lower(buyer_address) as addr, max(sealed_at)
      from public.pack_purchases
     where sealed_at >= now() - interval '2 days' and buyer_address is not null
     group by 1
    union all
    select lower(seller_address) as addr, max(sealed_at)
      from public.pack_purchases
     where sealed_at >= now() - interval '2 days' and seller_address is not null
       and lower(seller_address) <> '0x18eb4ee6b3c026d2'
     group by 1
  ),
  agg as (
    select addr, max(last_seen) as last_seen from candidates group by addr
  ),
  fresh as (
    select a.addr, a.last_seen, 0 as tier
    from agg a
    left join public.wallet_usernames wu on wu.wallet_addr = a.addr
    where wu.wallet_addr is null
       or (wu.username is null
           and (wu.last_attempted_at is null or wu.last_attempted_at < now() - interval '14 days'))
  ),
  -- Retries come from the table itself instead of a 21-day sales scan.
  retry as (
    select wu.wallet_addr as addr, coalesce(wu.last_attempted_at, '-infinity'::timestamptz) as last_seen, 1 as tier
    from public.wallet_usernames wu
    where wu.username is null
      and (wu.last_attempted_at is null or wu.last_attempted_at < now() - interval '14 days')
      and not exists (select 1 from fresh f where f.addr = wu.wallet_addr)
  )
  select coalesce(array_agg(addr order by tier, last_seen desc), array[]::text[])
  from (
    select addr, last_seen, tier from fresh
    union all
    select addr, last_seen, tier from retry
    order by tier, last_seen desc
    limit greatest(p_limit, 1)
  ) picked;
$function$;

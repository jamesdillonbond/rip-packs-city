-- Perf: wallet_usernames_unresolved scanned the 21-day sales window TWICE (once
-- for buyer_address, once for seller_address), doubling the dominant I/O. Under
-- the DB's disk-IO saturation this timed out ~half the time (pipeline
-- `wallet-username-resolver` failing ~54% with "canceling statement due to
-- statement timeout").
--
-- Fix: scan `sales` ONCE and unnest buyer+seller per row (provably equivalent —
-- the two not-null branches become one scan whose rows are max()'d per address
-- downstream exactly as before). pack_purchases is kept as its original two
-- branches so the escrow-seller exclusion (0x18eb4ee6b3c026d2) stays byte-exact.
-- No behavior change (same 21-day window, same address set); planner cost
-- ~165k → ~91k, and the runtime reads `sales` once instead of twice.
--
-- Revert: re-apply the prior definition (two separate sales branches).

CREATE OR REPLACE FUNCTION public.wallet_usernames_unresolved(p_limit integer DEFAULT 200)
 RETURNS text[]
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '60s'
AS $function$
  with candidates as (
    -- Sales: ONE scan, unnesting buyer + seller (was two full-window scans).
    select lower(a.addr) as addr, s.sold_at as last_seen
      from public.sales s
      cross join lateral (values (s.buyer_address), (s.seller_address)) a(addr)
     where s.sold_at >= now() - interval '21 days'
       and a.addr is not null
    union all
    -- Pack purchases kept as two branches to preserve the escrow-seller exclusion.
    select lower(buyer_address) as addr, max(sealed_at)
      from public.pack_purchases
     where sealed_at >= now() - interval '21 days' and buyer_address is not null
     group by 1
    union all
    select lower(seller_address) as addr, max(sealed_at)
      from public.pack_purchases
     where sealed_at >= now() - interval '21 days' and seller_address is not null
       and lower(seller_address) <> '0x18eb4ee6b3c026d2'
     group by 1
  ),
  agg as (
    select addr, max(last_seen) as last_seen from candidates group by addr
  )
  select coalesce(array_agg(addr order by last_seen desc), array[]::text[])
  from (
    select a.addr, a.last_seen
    from agg a
    left join public.wallet_usernames wu on lower(wu.wallet_addr) = a.addr
    where wu.wallet_addr is null
       or (wu.username is null
           and (wu.last_attempted_at is null or wu.last_attempted_at < now() - interval '14 days'))
    order by a.last_seen desc
    limit greatest(p_limit, 1)
  ) picked;
$function$;

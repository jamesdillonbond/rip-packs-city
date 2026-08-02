-- Snapshot migration: public.check_set_completion(text).
--
-- MCP-applied to prod with no committed migration → UNPINNABLE. This commits the
-- CURRENT LIVE body verbatim (pg_get_functiondef 2026-08-02) so it can carry a
-- drift-guarded pinned test. Applying it is a no-op vs prod (byte-identical).
--
-- Returns TRUE when a wallet owns EVERY edition of at least one set (drives the
-- set-completion badge/challenge). Ownership is counted as DISTINCT editions the
-- wallet holds per set (via wmc.edition_key = editions.external_id), compared to
-- the set's DISTINCT edition total; complete = owned_count >= total AND total > 0.
-- A regression that miscounts either side hands out (or withholds) a completion
-- reward the wallet didn't (or did) earn.
--
-- Pinned by supabase/tests/check_set_completion.sql.

CREATE OR REPLACE FUNCTION public.check_set_completion(p_wallet text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  with owned as (
    select distinct e.set_id, e.external_id
    from wallet_moments_cache w
    join editions e on e.external_id = w.edition_key
    where w.wallet_address = p_wallet
      and e.set_id is not null
  ),
  owned_counts as (
    select set_id, count(*)::int as owned_count
    from owned
    group by set_id
  ),
  set_totals as (
    select e.set_id, count(distinct e.external_id)::int as total
    from editions e
    where e.set_id in (select set_id from owned_counts)
    group by e.set_id
  )
  select exists(
    select 1
    from owned_counts o
    join set_totals s on s.set_id = o.set_id
    where s.total > 0 and o.owned_count >= s.total
  );
$function$;

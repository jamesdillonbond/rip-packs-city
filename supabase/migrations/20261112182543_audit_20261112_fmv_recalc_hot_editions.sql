-- audit_20261112_fmv_recalc_hot_editions — 2026-11-12 ~10:25 AM PT (Cowork cloud; Trevor: "Keep going …
-- Make decisions based upon what makes sense, what is best for RPC long term, and what's best for our users").
--
-- WHY. fmv-recalc walks a sweep order that is FROZEN when the sweep starts (fmv_recalc_sweep_order), 500 editions
-- a run. An edition that sells just after the sweep started waits for the whole sweep; one whose first sale in 30
-- days lands mid-sweep is not in the order at all until the next one. Measured 11-12 on editions that sold after
-- 7 quiet days (sales 1-4 days old): time from that sale to the next snapshot --
--   Top Shot  n 1,141: p50 9.0 h, p90 23.2 h, 483 over 12 h
--   All Day   n   481: p50 7.9 h, p90 23.9 h, 193 over 12 h
-- The case that showed it: Luka Doncic "Top Shot This" (286:9325) published $31 (no sale in 60+ days) for 23.5 h
-- while 68 sales printed at $1-3.
--
-- WHAT. A read-only helper the route calls each run: editions with a sale in the last 36 hours that is NEWER than
-- their latest snapshot AND whose latest snapshot is not sale-backed with depth (HIGH / MEDIUM) -- i.e. exactly
-- where one new sale changes what the price should rest on (no snapshot, NO_DATA, ASK_ONLY, STALE, LOW).
-- NEWEST sale first, bounded by p_limit: an edition the engine cannot price (a withheld phantom, say) stays
-- "hot" for its whole 36 hours, and oldest-first would let 150 of those block every fresh sale behind them. The route appends them to its page; pricing, caps, floors and
-- the cursor are untouched. HIGH / MEDIUM editions are left to the sweep on purpose: they sell hourly, would fill
-- the lane forever, and one more sale barely moves a median of seven.
-- Reads public.sales_market (#169): an issuer buy-back is not price discovery, so it must not make an edition hot
-- (the pricing step would ignore that sale anyway, and the edition would hold a lane slot for 36 hours).
-- Cost (measured): ~18k buffers, ~350 ms over 2,654 editions with a 36-hour sale.
-- anon-exec: fmv_recalc_hot_editions is NOT anon-executable (EXECUTE revoked from public, anon, authenticated;
-- granted to service_role, its only caller, in this file).
-- Revert: remove function public.fmv_recalc_hot_editions(uuid, integer) -- the route treats a failed call as
-- "no hot editions" and runs its page as before.
create or replace function public.fmv_recalc_hot_editions(p_pinnacle_collection_id uuid, p_limit integer default 150)
returns table (edition_id uuid)
language sql stable
set search_path = public, pg_temp
as $fn$
  with recent as (
    select s.edition_id, max(s.sold_at) as last_sold
      from public.sales_market s
     where s.sold_at > now() - interval '36 hours'
       and s.price_usd > 0
       and s.collection_id <> p_pinnacle_collection_id
       and s.edition_id is not null
     group by s.edition_id
  )
  select r.edition_id
    from recent r
    left join lateral (
      select f.computed_at, f.confidence::text as confidence
        from fmv_snapshots f
       where f.edition_id = r.edition_id
       order by f.computed_at desc
       limit 1
    ) l on true
   where (l.computed_at is null or l.computed_at < r.last_sold)
     and coalesce(l.confidence, 'NO_DATA') not in ('HIGH', 'MEDIUM')
   order by r.last_sold desc, r.edition_id
   limit greatest(1, least(coalesce(p_limit, 150), 500));
$fn$;
revoke all on function public.fmv_recalc_hot_editions(uuid, integer) from public, anon, authenticated;
grant execute on function public.fmv_recalc_hot_editions(uuid, integer) to service_role;

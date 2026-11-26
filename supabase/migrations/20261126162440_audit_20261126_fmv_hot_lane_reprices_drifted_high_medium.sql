-- audit_20261126_fmv_hot_lane_reprices_drifted_high_medium
-- anon-exec: unchanged (fmv_recalc_hot_editions) — CREATE OR REPLACE of an existing fn, same signature; ACL preserved, has_function_privilege anon/authenticated = false (re-read after apply).
--
-- 2026-11-26 ~9:15 AM PT (Claude Code cloud; Trevor: "Keep digging"). WHY. The fmv-recalc hot lane re-prices an
-- edition soon after it sells, but never one already at HIGH / MEDIUM — those wait for the daily sweep. On a day the
-- market moves, that price is wrong for the whole trading day. Top Shot, last 30 days, edition-days with >= 5
-- ordinary sales at HIGH / MEDIUM: on 466 of them the first 3 sales' median was > 30 % from the price in force, and
-- the REST of those days' sales (3,313) scored 28.7 % within ±25 % against that price. The engine's own next price,
-- computed after the day, sat at the first-3 median (ratio 1.00) and scored 61.3 % on the same sales; the first-3
-- median itself 63.1 %. The visible case: the Rookie Debut /500 drop (11-10..11-15, ~425 sales) — Lendeborg traded
-- 38 times at a $98 median on 11-11 while FMV read $180 all day; Top Shot $50-200 MEDIUM/HIGH that week read 48.6 %
-- within ±25 (94-98 % in the weeks around it).
--
-- WHAT. One more arm: a HIGH / MEDIUM edition is hot when >= 3 ordinary sales (serial > 25) in the 36 h window
-- landed after its latest snapshot (sold or ingested) and their median is > 30 % from that snapshot's fmv_usd.
-- Everything else is unchanged (window, ingest-time comparison, Pinnacle exclusion, order, cap). Cost measured on
-- live data before apply: 2.2 s cold (the existing snapshot lateral is most of it; the drift arm ran 359 loops,
-- ~3K buffers) against the route's 15 s hot-lane budget. A re-priced edition leaves the set (its snapshot is now
-- newer than those sales), so it does not churn.
-- Pin: supabase/tests/fmv_recalc_hot_editions.sql (H1-H4 unchanged; H5 now "HIGH / MEDIUM are not hot UNLESS
-- drifted"; H6-H9 the drift arm).
--
-- REVERT: re-apply 20261123041110_audit_20261122_fmv_hot_lane_compares_snapshot_to_sale_ingest_time.sql (its
--   CREATE OR REPLACE only) and repoint the pin + drift-guard entry at it.

CREATE OR REPLACE FUNCTION public.fmv_recalc_hot_editions(p_pinnacle_collection_id uuid, p_limit integer default 150)
returns table (edition_id uuid)
language sql stable
set search_path = public, pg_temp
as $fn$
  with recent as (
    -- 2026-11-22: last_ingested is when the newest sale became VISIBLE to the pricer. A snapshot computed
    -- between a sale's sold_at and its ingested_at could not have seen it, so it is compared to that.
    select s.edition_id, max(s.sold_at) as last_sold, max(s.ingested_at) as last_ingested
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
      select f.computed_at, f.confidence::text as confidence, f.fmv_usd
        from fmv_snapshots f
       where f.edition_id = r.edition_id
       order by f.computed_at desc
       limit 1
    ) l on true
   where (l.computed_at is null or l.computed_at < greatest(r.last_sold, r.last_ingested))
     and (coalesce(l.confidence, 'NO_DATA') not in ('HIGH', 'MEDIUM')
          -- 2026-11-26: a HIGH / MEDIUM price is hot too once the market has left it: >= 3 ordinary sales
          -- (serial > 25) it has not seen, whose median is more than 30 % away from it.
          or (l.fmv_usd > 0 and exists (
                select 1 from (
                  select percentile_cont(0.5) within group (order by d.price_usd) as med, count(*) as n
                    from public.sales_market d
                   where d.edition_id = r.edition_id
                     and d.sold_at > now() - interval '36 hours'
                     and d.price_usd > 0
                     and coalesce(d.serial_number, 999) > 25
                     and greatest(d.sold_at, d.ingested_at) > l.computed_at) m
                 where m.n >= 3 and abs(m.med / l.fmv_usd - 1) > 0.3)))
   order by r.last_sold desc, r.edition_id
   limit greatest(1, least(coalesce(p_limit, 150), 500));
$fn$;

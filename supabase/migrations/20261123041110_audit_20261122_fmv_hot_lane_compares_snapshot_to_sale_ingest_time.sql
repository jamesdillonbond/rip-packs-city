-- audit_20261122_fmv_hot_lane_compares_snapshot_to_sale_ingest_time
-- anon-exec: unchanged (fmv_recalc_hot_editions) — CREATE OR REPLACE of an existing fn, same signature; ACL preserved, has_function_privilege anon/authenticated = false (read 2026-11-22).
--
-- 2026-11-22 ~8:10 PM PT (Claude Code cloud, autonomous pass). WHY. The fmv-recalc hot lane re-prices an edition
-- whose latest snapshot is older than its newest sale's SOLD_AT. A sale reaches `sales` minutes to an hour after it
-- prints (median ingest lag over 36 h: Top Shot 20 min, All Day 12, Golazos 10, Candy 58; the 11-18 WNBA drop ~1 h).
-- Any snapshot written in that gap (another writer, or the sweep) is newer than sold_at but could not have read the
-- sale, so the edition never became hot again: it kept a price that ignores its newest sale until the next full
-- sweep. Live at 8:05 PM PT 11-22: 12 editions in this state (Golazos 10, Top Shot 2), e.g. Golazos #349 ASK_ONLY
-- $0.90 (golazos-listing-ask-v1, 4:55 PM PT) for 3+ hours over a $0.20 sale sold 4:54 PM, ingested 5:11 PM PT.
-- Found splitting the "first price lands a median 1.6 h after the first sale" drop-day lever
-- (strategy-2026-11-22.md Move 1 item 2).
--
-- WHAT. Compare the latest snapshot to greatest(max(sold_at), max(ingested_at)) instead of max(sold_at). Nothing
-- else changes: same window, same HIGH/MEDIUM exclusion, same newest-sold-first order and cap.
-- Pin: supabase/tests/fmv_recalc_hot_editions.sql (H1-H5; the 11-12 body fails H3).
--
-- REVERT: re-apply 20261112182543_audit_20261112_fmv_recalc_hot_editions.sql (its CREATE OR REPLACE only; the
--   REVOKE/GRANT lines there are already in force).

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
      select f.computed_at, f.confidence::text as confidence
        from fmv_snapshots f
       where f.edition_id = r.edition_id
       order by f.computed_at desc
       limit 1
    ) l on true
   where (l.computed_at is null or l.computed_at < greatest(r.last_sold, r.last_ingested))
     and coalesce(l.confidence, 'NO_DATA') not in ('HIGH', 'MEDIUM')
   order by r.last_sold desc, r.edition_id
   limit greatest(1, least(coalesce(p_limit, 150), 500));
$fn$;

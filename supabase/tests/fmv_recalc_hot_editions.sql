-- DB invariant: public.fmv_recalc_hot_editions — the editions fmv-recalc re-prices each run beside its page:
-- a sale in the last 36 h that the edition's latest snapshot could not have seen, unless that snapshot is
-- already sale-backed with depth (HIGH / MEDIUM) AND still agrees with the market. Added 2026-11-22; drift arm
-- 2026-11-26.
-- Claims:
--   H1. No snapshot at all -> hot.
--   H2. A LOW snapshot older than the newest sale -> hot.
--   H3. (2026-11-22, the defect) A LOW / ASK_ONLY snapshot computed AFTER the sale was sold but BEFORE it was
--       ingested could not have read it -> hot. The 11-12 body compared to sold_at only and missed it
--       (live 11-22: Golazos #349 ASK_ONLY $0.90 for 3 h over a $0.20 sale).
--   H4. A LOW snapshot computed after the sale was ingested -> not hot.
--   H5. HIGH / MEDIUM are not hot while the market agrees; Pinnacle is excluded; a sale older than 36 h does not count.
--   H6. (2026-11-26) A HIGH / MEDIUM snapshot with >= 3 unseen ordinary sales whose median is > 30 % away -> hot
--       (both directions). The 11-22 body never returns it (live: Rookie Debut /500, FMV $180 all day over a $98 median).
--   H7. Two such sales are not enough -> not hot.
--   H8. Three unseen sales within 30 % of the price -> not hot.
--   H9. Serials <= 25 do not count toward the drift (a #1 sale is not the market).
--
-- The function DDL below is VERBATIM from the committed migration
-- (supabase/migrations/20261126162440_audit_20261126_fmv_hot_lane_reprices_drifted_high_medium.sql).
-- __tests__/db-invariants-drift-guard.test.ts fails CI on drift.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE public.sales_market (edition_id uuid, collection_id uuid, sold_at timestamptz, ingested_at timestamptz, price_usd numeric, serial_number integer);
CREATE TABLE public.fmv_snapshots (edition_id uuid, computed_at timestamptz, confidence text, fmv_usd numeric);

-- >>> BEGIN verbatim fmv_recalc_hot_editions (body byte-identical to the migration) >>>
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
-- <<< END verbatim <<<

DO $$
DECLARE
  ts constant uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  pin constant uuid := '7dd9dd11-e8b6-45c4-ac99-71331f959714';
  e1 constant uuid := '00000000-0000-0000-0000-0000000000e1';
  e2 constant uuid := '00000000-0000-0000-0000-0000000000e2';
  e3 constant uuid := '00000000-0000-0000-0000-0000000000e3';
  e4 constant uuid := '00000000-0000-0000-0000-0000000000e4';
  e5 constant uuid := '00000000-0000-0000-0000-0000000000e5';
  e6 constant uuid := '00000000-0000-0000-0000-0000000000e6';
  e7 constant uuid := '00000000-0000-0000-0000-0000000000e7';
  e8 constant uuid := '00000000-0000-0000-0000-0000000000e8';
  d1 constant uuid := '00000000-0000-0000-0000-0000000000d1';  -- HIGH, 3 sales at half the price
  d2 constant uuid := '00000000-0000-0000-0000-0000000000d2';  -- MEDIUM, 3 sales at 1.6x the price
  d3 constant uuid := '00000000-0000-0000-0000-0000000000d3';  -- HIGH, only 2 drifted sales
  d4 constant uuid := '00000000-0000-0000-0000-0000000000d4';  -- HIGH, 3 sales within 30 %
  d5 constant uuid := '00000000-0000-0000-0000-0000000000d5';  -- HIGH, 3 drifted sales but 2 are serial <= 25
  hot uuid[];
BEGIN
  INSERT INTO public.sales_market (edition_id, collection_id, sold_at, ingested_at, price_usd) VALUES
    (e1, ts, now() - interval '2 hours', now() - interval '2 hours', 1),
    (e2, ts, now() - interval '2 hours', now() - interval '2 hours', 1),
    (e3, ts, now() - interval '3 hours', now() - interval '1 hour', 1),   -- sold 3 h ago, ingested 1 h ago
    (e4, ts, now() - interval '3 hours', now() - interval '2 hours', 1),
    (e5, ts, now() - interval '2 hours', now() - interval '2 hours', 1),
    (e6, pin, now() - interval '2 hours', now() - interval '2 hours', 1),
    (e7, ts, now() - interval '40 hours', now() - interval '1 hour', 1),
    (e8, ts, now() - interval '3 hours', now() - interval '1 hour', 1);
  INSERT INTO public.fmv_snapshots (edition_id, computed_at, confidence, fmv_usd) VALUES
    (e2, now() - interval '5 hours', 'LOW', 1),
    (e3, now() - interval '2 hours', 'ASK_ONLY', 1),  -- after the sale, before it was ingested
    (e4, now() - interval '1 hour', 'LOW', 1),        -- after the sale was ingested
    (e5, now() - interval '5 hours', 'MEDIUM', 1),    -- one unseen sale AT the price: not drifted
    (e8, now() - interval '2 hours', 'HIGH', 1),      -- one unseen sale AT the price: not drifted
    (d1, now() - interval '5 hours', 'HIGH', 180),
    (d2, now() - interval '5 hours', 'MEDIUM', 10),
    (d3, now() - interval '5 hours', 'HIGH', 180),
    (d4, now() - interval '5 hours', 'HIGH', 100),
    (d5, now() - interval '5 hours', 'HIGH', 180);
  INSERT INTO public.sales_market (edition_id, collection_id, sold_at, ingested_at, price_usd, serial_number) VALUES
    (d1, ts, now() - interval '4 hours', now() - interval '4 hours', 98, 300),
    (d1, ts, now() - interval '3 hours', now() - interval '3 hours', 95, 301),
    (d1, ts, now() - interval '2 hours', now() - interval '2 hours', 92, 302),
    (d2, ts, now() - interval '4 hours', now() - interval '4 hours', 16, 300),
    (d2, ts, now() - interval '3 hours', now() - interval '3 hours', 16, 301),
    (d2, ts, now() - interval '2 hours', now() - interval '2 hours', 17, 302),
    (d3, ts, now() - interval '4 hours', now() - interval '4 hours', 98, 300),
    (d3, ts, now() - interval '3 hours', now() - interval '3 hours', 95, 301),
    (d4, ts, now() - interval '4 hours', now() - interval '4 hours', 90, 300),
    (d4, ts, now() - interval '3 hours', now() - interval '3 hours', 110, 301),
    (d4, ts, now() - interval '2 hours', now() - interval '2 hours', 95, 302),
    (d5, ts, now() - interval '4 hours', now() - interval '4 hours', 98, 1),
    (d5, ts, now() - interval '3 hours', now() - interval '3 hours', 95, 25),
    (d5, ts, now() - interval '2 hours', now() - interval '2 hours', 92, 302);
  SELECT array_agg(edition_id) INTO hot FROM public.fmv_recalc_hot_editions(pin, 150);
  PERFORM _assert(e1 = ANY(hot), 'H1: an edition with no snapshot is hot');
  PERFORM _assert(e2 = ANY(hot), 'H2: a LOW snapshot older than the sale is hot');
  PERFORM _assert(e3 = ANY(hot), 'H3: a snapshot computed before the sale was INGESTED is hot');
  PERFORM _assert(NOT (e4 = ANY(hot)), 'H4: a snapshot computed after the sale was ingested is not hot');
  PERFORM _assert(NOT (e5 = ANY(hot)) AND NOT (e8 = ANY(hot)), 'H5: HIGH / MEDIUM that the market agrees with are not hot');
  PERFORM _assert(NOT (e6 = ANY(hot)), 'H5: Pinnacle is excluded');
  PERFORM _assert(NOT (e7 = ANY(hot)), 'H5: a sale older than 36 h does not count');
  PERFORM _assert(d1 = ANY(hot), 'H6: HIGH with 3 unseen sales at about half the price is hot');
  PERFORM _assert(d2 = ANY(hot), 'H6: MEDIUM with 3 unseen sales at 1.6x the price is hot');
  PERFORM _assert(NOT (d3 = ANY(hot)), 'H7: two drifted sales are not enough');
  PERFORM _assert(NOT (d4 = ANY(hot)), 'H8: three sales within 30 % do not make it hot');
  PERFORM _assert(NOT (d5 = ANY(hot)), 'H9: serials <= 25 do not count toward drift');
  PERFORM _assert_eq(array_length(hot, 1)::text, '5', 'exactly e1, e2, e3, d1, d2');
END $$;

ROLLBACK;

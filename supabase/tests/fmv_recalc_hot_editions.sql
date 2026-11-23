-- DB invariant: public.fmv_recalc_hot_editions — the editions fmv-recalc re-prices each run beside its page:
-- a sale in the last 36 h that the edition's latest snapshot could not have seen, unless that snapshot is
-- already sale-backed with depth (HIGH / MEDIUM). Added 2026-11-22.
-- Claims:
--   H1. No snapshot at all -> hot.
--   H2. A LOW snapshot older than the newest sale -> hot.
--   H3. (2026-11-22, the defect) A LOW / ASK_ONLY snapshot computed AFTER the sale was sold but BEFORE it was
--       ingested could not have read it -> hot. The 11-12 body compared to sold_at only and missed it
--       (live 11-22: Golazos #349 ASK_ONLY $0.90 for 3 h over a $0.20 sale).
--   H4. A LOW snapshot computed after the sale was ingested -> not hot.
--   H5. HIGH / MEDIUM are never hot; Pinnacle is excluded; a sale older than 36 h does not count.
--
-- The function DDL below is VERBATIM from the committed migration
-- (supabase/migrations/20261123041110_audit_20261122_fmv_hot_lane_compares_snapshot_to_sale_ingest_time.sql).
-- __tests__/db-invariants-drift-guard.test.ts fails CI on drift.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE public.sales_market (edition_id uuid, collection_id uuid, sold_at timestamptz, ingested_at timestamptz, price_usd numeric);
CREATE TABLE public.fmv_snapshots (edition_id uuid, computed_at timestamptz, confidence text);

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
  hot uuid[];
BEGIN
  INSERT INTO public.sales_market VALUES
    (e1, ts, now() - interval '2 hours', now() - interval '2 hours', 1),
    (e2, ts, now() - interval '2 hours', now() - interval '2 hours', 1),
    (e3, ts, now() - interval '3 hours', now() - interval '1 hour', 1),   -- sold 3 h ago, ingested 1 h ago
    (e4, ts, now() - interval '3 hours', now() - interval '2 hours', 1),
    (e5, ts, now() - interval '2 hours', now() - interval '2 hours', 1),
    (e6, pin, now() - interval '2 hours', now() - interval '2 hours', 1),
    (e7, ts, now() - interval '40 hours', now() - interval '1 hour', 1),
    (e8, ts, now() - interval '3 hours', now() - interval '1 hour', 1);
  INSERT INTO public.fmv_snapshots VALUES
    (e2, now() - interval '5 hours', 'LOW'),
    (e3, now() - interval '2 hours', 'ASK_ONLY'),  -- after the sale, before it was ingested
    (e4, now() - interval '1 hour', 'LOW'),        -- after the sale was ingested
    (e5, now() - interval '5 hours', 'MEDIUM'),
    (e8, now() - interval '2 hours', 'HIGH');
  SELECT array_agg(edition_id) INTO hot FROM public.fmv_recalc_hot_editions(pin, 150);
  PERFORM _assert(e1 = ANY(hot), 'H1: an edition with no snapshot is hot');
  PERFORM _assert(e2 = ANY(hot), 'H2: a LOW snapshot older than the sale is hot');
  PERFORM _assert(e3 = ANY(hot), 'H3: a snapshot computed before the sale was INGESTED is hot');
  PERFORM _assert(NOT (e4 = ANY(hot)), 'H4: a snapshot computed after the sale was ingested is not hot');
  PERFORM _assert(NOT (e5 = ANY(hot)) AND NOT (e8 = ANY(hot)), 'H5: HIGH / MEDIUM are never hot');
  PERFORM _assert(NOT (e6 = ANY(hot)), 'H5: Pinnacle is excluded');
  PERFORM _assert(NOT (e7 = ANY(hot)), 'H5: a sale older than 36 h does not count');
  PERFORM _assert_eq(array_length(hot, 1)::text, '3', 'exactly e1, e2, e3');
END $$;

ROLLBACK;

-- DB invariant: public.compute_pinnacle_serial_fmv_multipliers(integer, integer, numeric)
-- — the Pinnacle serial-FMV band multipliers. Pins: the serial→band buckets
-- (first / low5≤5% / low20≤20% / normal); the per-band MEDIAN price/render-median
-- ratio; NORMALIZATION so 'normal' = 1.0; the FLOOR at 1.0 (a scarce serial never
-- values below normal); the CAP at p_cap (a thin outlier can't run away);
-- is_reliable = sample ≥ p_min_sample; the total_minted > 1 filter; and the
-- delete-then-insert replace. All exercised in ONE call — the function's
-- `create temp table … on commit drop` cannot be re-created within one test
-- transaction, so a second call in the same txn would fail.
--
-- The function DDL below is a VERBATIM copy of the committed migration
-- (supabase/migrations/20260802203000_audit_20260802_snapshot_compute_pinnacle_serial_fmv_multipliers.sql);
-- __tests__/db-invariants-drift-guard.test.ts fails CI if this copy drifts from it.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE pinnacle_sales (
  render_id      text,
  serial_number  integer,
  sale_price_usd numeric,
  sold_at        timestamptz
);

CREATE TABLE pinnacle_catalog (
  render_id    text,
  total_minted integer
);

CREATE TABLE pinnacle_serial_fmv_multipliers (
  band        text,
  sample_size integer,
  multiplier  numeric,
  is_reliable boolean,
  computed_at timestamptz
);

-- >>> BEGIN verbatim compute_pinnacle_serial_fmv_multipliers (keep byte-identical to the migration) >>>
CREATE OR REPLACE FUNCTION public.compute_pinnacle_serial_fmv_multipliers(p_lookback_days integer DEFAULT 365, p_min_sample integer DEFAULT 30, p_cap numeric DEFAULT 40.0)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '120s'
AS $function$
declare
  v_normal numeric;
  v_written integer;
begin
  create temporary table _psf_bands on commit drop as
  with rmed as (
    select render_id, percentile_cont(0.5) within group (order by sale_price_usd) as render_med
    from public.pinnacle_sales
    where sold_at > now() - make_interval(days => p_lookback_days)
      and serial_number is not null and serial_number > 0 and sale_price_usd > 0
    group by render_id
  ),
  base as (
    select ps.serial_number, ps.sale_price_usd, pc.total_minted, rm.render_med
    from public.pinnacle_sales ps
    join public.pinnacle_catalog pc on pc.render_id = ps.render_id
    join rmed rm on rm.render_id = ps.render_id
    where ps.sold_at > now() - make_interval(days => p_lookback_days)
      and ps.serial_number is not null and ps.serial_number > 0 and ps.sale_price_usd > 0
      and pc.total_minted is not null and pc.total_minted > 1 and rm.render_med > 0
  ),
  banded as (
    select case
             when serial_number = 1 then 'first'
             when serial_number::numeric / total_minted <= 0.05 then 'low5'
             when serial_number::numeric / total_minted <= 0.20 then 'low20'
             else 'normal'
           end as band,
           sale_price_usd / render_med as ratio
    from base
  )
  select band, count(*)::int as sample_size,
         percentile_cont(0.5) within group (order by ratio) as median_ratio
  from banded group by band;

  select median_ratio into v_normal from _psf_bands where band = 'normal';
  if v_normal is null or v_normal <= 0 then v_normal := 1.0; end if;

  delete from public.pinnacle_serial_fmv_multipliers;
  insert into public.pinnacle_serial_fmv_multipliers (band, sample_size, multiplier, is_reliable, computed_at)
  select band, sample_size,
         least(greatest(median_ratio / v_normal, 1.0), p_cap) as multiplier,
         sample_size >= p_min_sample as is_reliable,
         now()
  from _psf_bands;

  get diagnostics v_written = row_count;
  return v_written;
end;
$function$;
-- <<< END verbatim compute_pinnacle_serial_fmv_multipliers <<<

INSERT INTO pinnacle_catalog (render_id, total_minted) VALUES
  ('R1', 100), ('R2', 100), ('R3', 1);  -- R3 total_minted=1 must be filtered out

-- R1: first (serial 1, $5000 → ratio 50, tests the CAP), low5 (serials 2-5, $200
-- → ratio 2.0), normal (serials 21-41, $100). render_med(R1)=100 (normal dominates).
INSERT INTO pinnacle_sales (render_id, serial_number, sale_price_usd, sold_at) VALUES
  ('R1', 1, 5000, now() - interval '10 days');
INSERT INTO pinnacle_sales (render_id, serial_number, sale_price_usd, sold_at)
SELECT 'R1', s, 200, now() - interval '10 days' FROM generate_series(2,5) s;
INSERT INTO pinnacle_sales (render_id, serial_number, sale_price_usd, sold_at)
SELECT 'R1', s, 100, now() - interval '10 days' FROM generate_series(21,41) s;

-- R2: normal (serials 21-36, $300, 16 rows), low20 (serials 6-20, $150, 15 rows).
-- render_med(R2)=300 → normal ratio 1.0, low20 ratio 0.5 (tests the FLOOR).
INSERT INTO pinnacle_sales (render_id, serial_number, sale_price_usd, sold_at)
SELECT 'R2', s, 300, now() - interval '10 days' FROM generate_series(21,36) s;
INSERT INTO pinnacle_sales (render_id, serial_number, sale_price_usd, sold_at)
SELECT 'R2', s, 150, now() - interval '10 days' FROM generate_series(6,20) s;

-- R3: total_minted=1 → excluded by the total_minted > 1 filter (would otherwise
-- add a 2nd 'first' sample).
INSERT INTO pinnacle_sales (render_id, serial_number, sale_price_usd, sold_at) VALUES
  ('R3', 1, 999, now() - interval '10 days');

-- A stale pre-existing row that the delete-then-insert must remove.
INSERT INTO pinnacle_serial_fmv_multipliers (band, sample_size, multiplier, is_reliable, computed_at)
VALUES ('garbage', 999, 7.0, true, now() - interval '30 days');

-- One call: p_min_sample=5, default cap 40.
SELECT _assert_eq(compute_pinnacle_serial_fmv_multipliers(365, 5, 40.0)::text, '4', 'writes exactly 4 bands');

-- delete-then-insert removed the stale row.
SELECT _assert_eq((SELECT count(*)::text FROM pinnacle_serial_fmv_multipliers), '4', 'total rows = 4 (stale row deleted)');
SELECT _assert_eq((SELECT count(*)::text FROM pinnacle_serial_fmv_multipliers WHERE band='garbage'), '0', 'stale garbage band removed');

-- Multipliers: first CAPPED at 40 (raw ratio 50), low5 = 2.0, low20 FLOORED to 1.0
-- (raw ratio 0.5), normal = 1.0 (the normalizer).
SELECT _assert(( (SELECT multiplier FROM pinnacle_serial_fmv_multipliers WHERE band='first') = 40.0 ), 'first ratio 50 → capped at 40');
SELECT _assert(( (SELECT multiplier FROM pinnacle_serial_fmv_multipliers WHERE band='low5')  = 2.0 ), 'low5 → 2.0x');
SELECT _assert(( (SELECT multiplier FROM pinnacle_serial_fmv_multipliers WHERE band='low20') = 1.0 ), 'low20 raw ratio 0.5 → floored to 1.0');
SELECT _assert(( (SELECT multiplier FROM pinnacle_serial_fmv_multipliers WHERE band='normal')= 1.0 ), 'normal → 1.0 (normalizer)');

-- Sample sizes (R3 excluded by the total_minted > 1 filter → first stays 1).
SELECT _assert_eq((SELECT sample_size::text FROM pinnacle_serial_fmv_multipliers WHERE band='first'), '1', 'first sample 1 (R3 total_minted=1 excluded)');
SELECT _assert_eq((SELECT sample_size::text FROM pinnacle_serial_fmv_multipliers WHERE band='low5'), '4', 'low5 sample 4');
SELECT _assert_eq((SELECT sample_size::text FROM pinnacle_serial_fmv_multipliers WHERE band='low20'), '15', 'low20 sample 15');
SELECT _assert_eq((SELECT sample_size::text FROM pinnacle_serial_fmv_multipliers WHERE band='normal'), '37', 'normal sample 37 (R1 21 + R2 16)');

-- is_reliable at p_min_sample=5: first(1)/low5(4) below → false; low20(15)/normal(37) → true.
SELECT _assert_eq((SELECT is_reliable::text FROM pinnacle_serial_fmv_multipliers WHERE band='first'), 'false', 'first sample 1 < 5 → not reliable');
SELECT _assert_eq((SELECT is_reliable::text FROM pinnacle_serial_fmv_multipliers WHERE band='low5'), 'false', 'low5 sample 4 < 5 → not reliable');
SELECT _assert_eq((SELECT is_reliable::text FROM pinnacle_serial_fmv_multipliers WHERE band='low20'), 'true', 'low20 sample 15 ≥ 5 → reliable');
SELECT _assert_eq((SELECT is_reliable::text FROM pinnacle_serial_fmv_multipliers WHERE band='normal'), 'true', 'normal sample 37 ≥ 5 → reliable');

SELECT '✓ compute_pinnacle_serial_fmv_multipliers invariants pass' AS result;
ROLLBACK;

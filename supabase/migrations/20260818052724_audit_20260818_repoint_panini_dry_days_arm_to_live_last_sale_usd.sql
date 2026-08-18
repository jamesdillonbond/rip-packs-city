-- audit_20260818_repoint_panini_dry_days_arm_to_live_last_sale_usd
--
-- WHAT: rpc_thp_leg_panini — the `panini_sale_price_capture_dry_days` streak now counts on
-- `column_last_sale_usd` (the LIVE field) instead of `raw_supplied_sale_price` (the DEAD one).
-- Two token changes inside the src/runs CTEs. Signature, SECDEF, search_path, the 60s
-- statement_timeout, the EXCEPTION→999 path and the mapping_shortfall metric are UNCHANGED.
--
-- ⛔ WHY — the arm was CRYING WOLF, and focus.md already said so
-- `raw_supplied_sale_price` counts `raw->>'brought_at_price'`, an upstream field deliberately
-- ABANDONED and replaced on 2026-08-08. Measured 2026-08-18 over the view's full 30-day window:
--
--   | capture_day | brought_at_price (dead) | last_sale_usd (live) | pct live |
--   |-------------|------------------------:|---------------------:|---------:|
--   | 08-18       |                       0 |                  470 |   23.4 % |
--   | 08-17       |                       0 |                3,728 |   22.2 % |
--   | 08-16       |                       0 |                  882 |   23.5 % |
--   | 08-14       |                       0 |                  303 |   23.1 % |
--   | 08-12       |                       0 |                1,283 |   21.1 % |
--   | 08-09       |                       0 |                  909 |   23.1 % |
--   | 08-08       |                       0 |                  147 |    9.3 % |  ← replacement lands
--   | 08-07       |                       0 |                  103 |    5.2 % |
--
-- **The dead field is 0 on EVERY ONE of the last 30 days.** The arm therefore counts +1/day
-- forever and can never clear — it read 20 at the time of this change. The replacement has run at
-- a steady 22–24 % since 08-09. The arm was measuring the absence of a field nobody supplies.
--
-- 💡 The PINS comment already anticipated this: *"Dry days is a CURRENT-STREAK counter … one
-- captured day resets it to 0 immediately."* Re-pointed, the streak resets to **0** on the next
-- leg run, because every day in the window has live supply.
--
-- ⚠ SCOPE — `mapping_shortfall` IS ALSO BUILT ON THE DEAD FIELD AND IS DELIBERATELY NOT TOUCHED.
-- Its definition is `raw_supplied(dead) − mapped`, so with the first term pinned at 0 it publishes
-- meaningless negatives (−103, −3,028, −722 on recent days; the arm reads −19). Fixing it means
-- DECIDING what "shortfall" should mean now that the source changed, which is a semantic call, not
-- a re-point. Left alone rather than redesigned silently. **Do not read that arm until it is.**
--
-- ✅ POSITIVE CONTROL — the pinned test now DISCRIMINATES
-- The pgTAP fixture keeps `raw_supplied_sale_price` all-zero (mirroring prod) and carries the
-- supply signal in `column_last_sale_usd`. Verified against the real streak logic before shipping:
--   re-pointed  → dry_days = 2  (the value the test already asserts, unchanged)
--   reverted    → dry_days = 5  (test FAILS)
-- So a future revert to the dead column cannot pass CI silently.
--
-- REVERT: re-apply the prior definition (swap `column_last_sale_usd` back to
-- `raw_supplied_sale_price` in both the src SELECT and the runs bool_or), and restore the test's
-- fixture. Monitoring-only: this function writes solely to rpc_trust_health_precompute and no
-- product surface reads it. ⚠ Expect the dry-days arm to start climbing again.
-- -----------------------------------------------------------------------------

DO $guard$
DECLARE v_src text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'rpc_thp_leg_panini';

  IF v_src IS NULL THEN
    RAISE EXCEPTION 'rpc_thp_leg_panini not found -- aborting';
  END IF;
  IF position('raw_supplied_sale_price' in v_src) = 0 THEN
    RAISE EXCEPTION 'anchor "raw_supplied_sale_price" absent -- drifted or already applied, aborting';
  END IF;
  IF position('column_last_sale_usd' in v_src) <> 0 THEN
    RAISE EXCEPTION 'column_last_sale_usd already referenced -- appears already applied, aborting';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='v_panini_serial_sale_field_supply'
       AND column_name='column_last_sale_usd'
  ) THEN
    RAISE EXCEPTION 'view lacks column_last_sale_usd -- aborting';
  END IF;
END
$guard$;

CREATE OR REPLACE FUNCTION public.rpc_thp_leg_panini()
 RETURNS void LANGUAGE plpgsql SECURITY DEFINER
 SET search_path TO 'public','pg_temp' SET statement_timeout TO '60s'
AS $fn$
DECLARE t1 timestamptz := clock_timestamp(); v_short numeric; v_dry numeric;
BEGIN
  BEGIN
    WITH src AS (
      SELECT v.capture_day, v.column_last_sale_usd, v.mapping_shortfall
      FROM public.v_panini_serial_sale_field_supply v
    ),
    runs AS (
      SELECT bool_or(s.column_last_sale_usd > 0) OVER (
               ORDER BY s.capture_day DESC ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
             ) AS seen_supply
      FROM src s
    )
    SELECT COALESCE(max(s2.mapping_shortfall), 0)::numeric,
           (SELECT count(*) FROM runs r WHERE NOT r.seen_supply)::numeric
      INTO v_short, v_dry
    FROM src s2;
    INSERT INTO public.rpc_trust_health_precompute (metric, value, computed_at, duration_ms)
    VALUES ('panini_sale_field_mapping_shortfall', v_short, now(),
            round(EXTRACT(epoch FROM clock_timestamp() - t1) * 1000)),
           ('panini_sale_price_capture_dry_days', COALESCE(v_dry, 0), now(),
            round(EXTRACT(epoch FROM clock_timestamp() - t1) * 1000))
    ON CONFLICT (metric) DO UPDATE
      SET value = EXCLUDED.value, computed_at = EXCLUDED.computed_at, duration_ms = EXCLUDED.duration_ms;
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO public.rpc_trust_health_precompute (metric, value, computed_at, duration_ms)
    SELECT m, 999, now(), round(EXTRACT(epoch FROM clock_timestamp() - t1) * 1000)
    FROM unnest(ARRAY['panini_sale_field_mapping_shortfall','panini_sale_price_capture_dry_days']) AS m
    ON CONFLICT (metric) DO UPDATE
      SET value = EXCLUDED.value, computed_at = EXCLUDED.computed_at, duration_ms = EXCLUDED.duration_ms;
  END;
END;
$fn$;

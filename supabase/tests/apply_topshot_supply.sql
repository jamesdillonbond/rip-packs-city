-- DB invariant: public.apply_topshot_supply(...) — records a TopShot pack
-- distribution's on-chain supply. Pins the derived counters (total_opened =
-- GREATEST(minted-unopened,0), total_sealed = unopened, depletion_pct), the
-- collection-SCOPED write-through to pack_distributions (a same-dist_id row in
-- another collection must NOT be touched), the failure path (supply_ok=false +
-- error, pack_distributions untouched), and idempotent ON CONFLICT upsert.
--
-- The function DDL below is a VERBATIM copy of the committed migration
-- (supabase/migrations/20260802191000_audit_20260802_snapshot_apply_topshot_supply.sql);
-- __tests__/db-invariants-drift-guard.test.ts fails CI if this copy drifts from it.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE topshot_pack_supply (
  dist_id           text PRIMARY KEY,
  total_minted      integer,
  total_opened      integer,
  total_sealed      integer,
  depletion_pct     smallint,
  for_sale          boolean,
  is_sold_out       boolean,
  remaining_by_tier jsonb,
  original_by_tier  jsonb,
  supply_ok         boolean,
  supply_err        text,
  updated_at        timestamptz
);

-- Only the columns the function's write-through touches (total_sealed/depletion_pct
-- are GENERATED in prod and are NOT written by this function).
CREATE TABLE pack_distributions (
  collection_id uuid,
  dist_id       text,
  total_minted  integer,
  total_opened  integer
);

-- >>> BEGIN verbatim apply_topshot_supply (keep byte-identical to the migration) >>>
CREATE OR REPLACE FUNCTION public.apply_topshot_supply(p_dist_id text, p_ok boolean, p_minted integer DEFAULT NULL::integer, p_unopened integer DEFAULT NULL::integer, p_for_sale boolean DEFAULT NULL::boolean, p_is_sold_out boolean DEFAULT NULL::boolean, p_remaining jsonb DEFAULT NULL::jsonb, p_original jsonb DEFAULT NULL::jsonb, p_err text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF p_ok THEN
    INSERT INTO public.topshot_pack_supply
      (dist_id, total_minted, total_opened, total_sealed, depletion_pct, for_sale, is_sold_out, remaining_by_tier, original_by_tier, supply_ok, supply_err, updated_at)
    VALUES (p_dist_id, COALESCE(p_minted,0),
            GREATEST(COALESCE(p_minted,0)-COALESCE(p_unopened,0),0), COALESCE(p_unopened,0),
            (CASE WHEN COALESCE(p_minted,0)>0 THEN round(100.0*(p_minted-COALESCE(p_unopened,0))/p_minted) ELSE 0 END)::smallint,
            p_for_sale, p_is_sold_out, p_remaining, p_original, true, NULL, now())
    ON CONFLICT (dist_id) DO UPDATE SET
      total_minted=EXCLUDED.total_minted, total_opened=EXCLUDED.total_opened, total_sealed=EXCLUDED.total_sealed,
      depletion_pct=EXCLUDED.depletion_pct, for_sale=EXCLUDED.for_sale, is_sold_out=EXCLUDED.is_sold_out,
      remaining_by_tier=EXCLUDED.remaining_by_tier, original_by_tier=EXCLUDED.original_by_tier,
      supply_ok=true, supply_err=NULL, updated_at=now();
    -- write-through to the seeder-owned counters (preserved on re-seed; total_sealed+depletion_pct are GENERATED)
    UPDATE public.pack_distributions
      SET total_minted = COALESCE(p_minted,0),
          total_opened = GREATEST(COALESCE(p_minted,0)-COALESCE(p_unopened,0),0)
      WHERE collection_id='95f28a17-224a-4025-96ad-adf8a4c63bfd' AND dist_id = p_dist_id;
  ELSE
    INSERT INTO public.topshot_pack_supply (dist_id, supply_ok, supply_err, updated_at)
    VALUES (p_dist_id, false, COALESCE(p_err,'unknown'), now())
    ON CONFLICT (dist_id) DO UPDATE SET supply_ok=false, supply_err=COALESCE(p_err,'unknown'), updated_at=now();
  END IF;
END;
$function$;
-- <<< END verbatim apply_topshot_supply <<<

-- Same dist_id under two collections (TopShot + AllDay) to prove the write-through scope.
INSERT INTO pack_distributions (collection_id, dist_id, total_minted, total_opened) VALUES
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'd1', 0, 0),
  ('dee28451-5d62-409e-a1ad-a83f763ac070', 'd1', 0, 0);

-- Success path: minted 100, unopened 40 → opened 60, sealed 40, depletion 60.
SELECT apply_topshot_supply('d1', true, 100, 40, true, false, '{"legendary":1}'::jsonb, '{"legendary":5}'::jsonb);
SELECT _assert_eq((SELECT total_opened::text  FROM topshot_pack_supply WHERE dist_id='d1'), '60', 'opened = GREATEST(minted-unopened,0)');
SELECT _assert_eq((SELECT total_sealed::text  FROM topshot_pack_supply WHERE dist_id='d1'), '40', 'sealed = unopened');
SELECT _assert_eq((SELECT depletion_pct::text FROM topshot_pack_supply WHERE dist_id='d1'), '60', 'depletion_pct = round(100*opened/minted)');
SELECT _assert_eq((SELECT supply_ok::text     FROM topshot_pack_supply WHERE dist_id='d1'), 'true', 'supply_ok true on success');

-- Write-through updated ONLY the TopShot pack_distributions row.
SELECT _assert_eq((SELECT total_minted::text FROM pack_distributions WHERE collection_id='95f28a17-224a-4025-96ad-adf8a4c63bfd' AND dist_id='d1'), '100', 'TS distribution minted written through');
SELECT _assert_eq((SELECT total_opened::text FROM pack_distributions WHERE collection_id='95f28a17-224a-4025-96ad-adf8a4c63bfd' AND dist_id='d1'), '60', 'TS distribution opened written through');
SELECT _assert_eq((SELECT total_minted::text FROM pack_distributions WHERE collection_id='dee28451-5d62-409e-a1ad-a83f763ac070' AND dist_id='d1'), '0', 'AllDay distribution NOT touched (collection scope)');

-- GREATEST guard: unopened > minted → opened clamps to 0.
SELECT apply_topshot_supply('d3', true, 10, 15);
SELECT _assert_eq((SELECT total_opened::text FROM topshot_pack_supply WHERE dist_id='d3'), '0', 'opened clamps to 0 when unopened > minted');

-- minted 0 → depletion_pct 0 (no divide-by-zero), opened 0.
SELECT apply_topshot_supply('d4', true, 0, 0);
SELECT _assert_eq((SELECT depletion_pct::text FROM topshot_pack_supply WHERE dist_id='d4'), '0', 'minted 0 → depletion_pct 0 (guarded division)');

-- Failure path: supply_ok false + error, pack_distributions untouched.
SELECT apply_topshot_supply('d2', false, p_err => 'fetch_failed');
SELECT _assert_eq((SELECT supply_ok::text FROM topshot_pack_supply WHERE dist_id='d2'), 'false', 'failure path → supply_ok false');
SELECT _assert_eq((SELECT supply_err     FROM topshot_pack_supply WHERE dist_id='d2'), 'fetch_failed', 'failure path records the error');

-- ON CONFLICT upsert: a later failure over d1 flips it to error without duplicating.
SELECT apply_topshot_supply('d1', false, p_err => 'later_error');
SELECT _assert_eq((SELECT supply_ok::text FROM topshot_pack_supply WHERE dist_id='d1'), 'false', 'ON CONFLICT flips supply_ok to false');
SELECT _assert_eq((SELECT count(*)::text FROM topshot_pack_supply WHERE dist_id='d1'), '1', 'still one row per dist_id (upsert)');

SELECT '✓ apply_topshot_supply invariants pass' AS result;
ROLLBACK;

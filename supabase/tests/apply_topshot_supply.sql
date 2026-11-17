-- DB invariant: public.apply_topshot_supply(...) — records a TopShot pack
-- distribution's on-chain supply. Pins the derived counters (total_opened =
-- GREATEST(minted-unopened,0), total_sealed = unopened, depletion_pct), the
-- collection-SCOPED write-through to pack_distributions (a same-dist_id row in
-- another collection must NOT be touched), the failure path (supply_ok=false +
-- error, pack_distributions untouched), and idempotent ON CONFLICT upsert.
--
-- ⭐ AND, since 2026-09-11, THE ASYMMETRY BETWEEN THE TWO TIMESTAMPS — the reason
-- last_success_at exists. `updated_at` is bumped by BOTH branches, so it answers
-- "when did we last TRY"; `last_success_at` is written by the success branch ONLY,
-- so it answers "when did we last KNOW". The failure branch also leaves the
-- previous counters in place, so a row can carry 73-day-old numbers under a fresh
-- `updated_at` — which is why pack_table_rows.supply_as_of reads last_success_at,
-- and why a future edit that "tidies" the failure branch by adding
-- last_success_at=now() to it must fail HERE rather than quietly turn every pack
-- page's as-of into a lie. The fixture builds that row deliberately: d1 succeeds,
-- is stamped back to a distinguishable 2026-08-26, and is then failed.
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
  updated_at        timestamptz,
  last_success_at   timestamptz
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
      (dist_id, total_minted, total_opened, total_sealed, depletion_pct, for_sale, is_sold_out, remaining_by_tier, original_by_tier, supply_ok, supply_err, updated_at, last_success_at)
    VALUES (p_dist_id, COALESCE(p_minted,0),
            GREATEST(COALESCE(p_minted,0)-COALESCE(p_unopened,0),0), COALESCE(p_unopened,0),
            (CASE WHEN COALESCE(p_minted,0)>0 THEN round(100.0*(p_minted-COALESCE(p_unopened,0))/p_minted) ELSE 0 END)::smallint,
            p_for_sale, p_is_sold_out, p_remaining, p_original, true, NULL, now(), now())
    ON CONFLICT (dist_id) DO UPDATE SET
      total_minted=EXCLUDED.total_minted, total_opened=EXCLUDED.total_opened, total_sealed=EXCLUDED.total_sealed,
      depletion_pct=EXCLUDED.depletion_pct, for_sale=EXCLUDED.for_sale, is_sold_out=EXCLUDED.is_sold_out,
      remaining_by_tier=EXCLUDED.remaining_by_tier, original_by_tier=EXCLUDED.original_by_tier,
      supply_ok=true, supply_err=NULL, updated_at=now(), last_success_at=now();
    -- write-through to the seeder-owned counters (preserved on re-seed; total_sealed+depletion_pct are GENERATED)
    UPDATE public.pack_distributions
      SET total_minted = COALESCE(p_minted,0),
          total_opened = GREATEST(COALESCE(p_minted,0)-COALESCE(p_unopened,0),0)
      WHERE collection_id='95f28a17-224a-4025-96ad-adf8a4c63bfd' AND dist_id = p_dist_id;
  ELSE
    -- last_success_at is DELIBERATELY ABSENT from both halves of this branch. It
    -- is the whole point of the column: a failed fetch must not disturb the
    -- record of when we last knew. updated_at still moves, so liveness is intact.
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

-- The success path stamps last_success_at, on BOTH of its halves.
SELECT _assert_eq((SELECT (last_success_at IS NOT NULL)::text FROM topshot_pack_supply WHERE dist_id='d3'), 'true', 'success stamps last_success_at (fresh INSERT)');

-- ⚠ AND ON THE ON CONFLICT HALF, WHICH IS THE ONE PRODUCTION ACTUALLY TAKES —
-- every one of the 2,085 rows already exists, so a fresh INSERT is the path that
-- never runs live. Asserting only the INSERT left the DO UPDATE unpinned, and a
-- mutation deleting `last_success_at=now()` from it passed the whole file.
SELECT apply_topshot_supply('d5', true, 50, 10);
UPDATE topshot_pack_supply SET last_success_at='2026-08-26 08:15:05+00'::timestamptz WHERE dist_id='d5';
SELECT apply_topshot_supply('d5', true, 50, 5);
SELECT _assert_eq((SELECT (last_success_at > '2026-08-26 08:15:05+00'::timestamptz)::text FROM topshot_pack_supply WHERE dist_id='d5'), 'true', 'a REPEAT success ADVANCES last_success_at (ON CONFLICT path)');

-- ── THE ASYMMETRY ───────────────────────────────────────────────────────────
-- Reproduces production's shape on 2026-09-11: last success 2026-08-26, a failed
-- fetch today, and the 08-26 counters still sitting in the row.
--
-- ⚠ THE BACKDATING IS NOT COSMETIC, IT IS WHAT MAKES THE TEST POSSIBLE. `now()`
-- is the TRANSACTION timestamp, so every now() in this rolled-back transaction is
-- the same instant. Without forcing a distinct earlier value, "the stamp did not
-- move" and "the stamp moved to now()" are indistinguishable, and the assertion
-- below would pass against a function that writes last_success_at in BOTH
-- branches — i.e. it would be vacuous against the one mutation it exists to catch.
UPDATE topshot_pack_supply
   SET last_success_at = '2026-08-26 08:15:05+00'::timestamptz,
       updated_at      = '2026-08-26 08:15:05+00'::timestamptz
 WHERE dist_id='d1';

-- ON CONFLICT upsert: a later failure over d1 flips it to error without duplicating.
SELECT apply_topshot_supply('d1', false, p_err => 'later_error');
SELECT _assert_eq((SELECT supply_ok::text FROM topshot_pack_supply WHERE dist_id='d1'), 'false', 'ON CONFLICT flips supply_ok to false');
SELECT _assert_eq((SELECT count(*)::text FROM topshot_pack_supply WHERE dist_id='d1'), '1', 'still one row per dist_id (upsert)');

SELECT _assert_eq((SELECT (last_success_at = '2026-08-26 08:15:05+00'::timestamptz)::text FROM topshot_pack_supply WHERE dist_id='d1'), 'true', 'a FAILED fetch must NOT move last_success_at');
SELECT _assert_eq((SELECT (updated_at > last_success_at)::text FROM topshot_pack_supply WHERE dist_id='d1'), 'true', 'a failed fetch DOES move updated_at -- the two columns answer different questions');
-- ⭐ The counters survive the failure. This is the fact that makes an as-of read
-- off `updated_at` a false claim, and it is asserted rather than described,
-- because pack_table_rows.supply_as_of depends on it being true.
SELECT _assert_eq((SELECT total_minted::text FROM topshot_pack_supply WHERE dist_id='d1'), '100', 'a failed fetch leaves the STALE counters in place');
SELECT _assert_eq((SELECT depletion_pct::text FROM topshot_pack_supply WHERE dist_id='d1'), '60', 'a failed fetch leaves the stale depletion_pct in place');

SELECT '✓ apply_topshot_supply invariants pass' AS result;
ROLLBACK;

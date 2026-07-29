-- DB invariant: public.backfill_null_serial_sales_from_moments — recovers a
-- missing serial_number on a recent `sales` row from ground truth, feeding the
-- serial-FMV estimators (a wrong/absent serial mis-prices a #1/low-serial moment).
-- The behavior that must hold:
--   (a) source PRECEDENCE: moments.serial_number (>0) first, then
--       wallet_moments_cache.serial_number (>0) as the fallback.
--   (b) a non-positive source serial (0/negative) is IGNORED (the `> 0` guards) —
--       never write a fake serial #0.
--   (c) it only touches sales with serial_number IS NULL, a real nft_id, sold
--       within p_max_age_days; and it is IDEMPOTENT (never clobbers a serial that
--       is already set — the UPDATE re-checks s.serial_number IS NULL).
--   (d) returns the count actually updated.
--
-- The function DDL below is a VERBATIM copy of the committed migration
-- (supabase/migrations/20260705193000_audit_20260705_recover_null_serial_sales_from_moments.sql);
-- __tests__/db-invariants-drift-guard.test.ts fails CI if this copy drifts.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE public.sales (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nft_id text,
  collection_id uuid,
  serial_number integer,
  sold_at timestamptz
);
CREATE TABLE public.moments (
  nft_id text,
  serial_number integer
);
CREATE TABLE public.wallet_moments_cache (
  collection_id uuid,
  moment_id text,
  serial_number integer
);

-- One collection.
-- sales rows: recent + null serial unless noted.
INSERT INTO public.sales (id, nft_id, collection_id, serial_number, sold_at) VALUES
  ('50000000-0000-0000-0000-000000000001', 'nftFromMoment', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', NULL, now() - interval '1 day'),
  ('50000000-0000-0000-0000-000000000002', 'nftFromWmc',    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', NULL, now() - interval '1 day'),
  ('50000000-0000-0000-0000-000000000003', 'nftBoth',       'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', NULL, now() - interval '1 day'),
  ('50000000-0000-0000-0000-000000000004', 'nftAlready',    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 500,  now() - interval '1 day'),
  ('50000000-0000-0000-0000-000000000005', 'nftZeroSrc',    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', NULL, now() - interval '1 day'),
  ('50000000-0000-0000-0000-000000000006', 'nftOld',        'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', NULL, now() - interval '100 days'),
  ('50000000-0000-0000-0000-000000000007', '',              'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', NULL, now() - interval '1 day');

INSERT INTO public.moments (nft_id, serial_number) VALUES
  ('nftFromMoment', 11),
  ('nftBoth', 22),      -- moments wins over wmc for nftBoth
  ('nftAlready', 999),  -- would-be source, but sale already has a serial
  ('nftZeroSrc', 0),    -- non-positive → ignored
  ('nftOld', 33);       -- valid source, but the sale is too old

INSERT INTO public.wallet_moments_cache (collection_id, moment_id, serial_number) VALUES
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'nftFromWmc', 44),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'nftBoth', 66),      -- loses to moments (22)
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'nftZeroSrc', 0);    -- also non-positive

-- >>> BEGIN verbatim backfill_null_serial_sales_from_moments (keep byte-identical to the migration) >>>
CREATE OR REPLACE FUNCTION public.backfill_null_serial_sales_from_moments(p_max_age_days integer DEFAULT 45)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
SET statement_timeout TO '60s'
AS $function$
DECLARE
  v_updated integer;
BEGIN
  WITH cand AS (
    SELECT
      s.id AS sale_id,
      COALESCE(
        (SELECT m.serial_number
           FROM moments m
          WHERE m.nft_id = s.nft_id
            AND m.serial_number > 0
          LIMIT 1),
        (SELECT w.serial_number
           FROM wallet_moments_cache w
          WHERE w.collection_id = s.collection_id
            AND w.moment_id = s.nft_id
            AND w.serial_number > 0
          LIMIT 1)
      ) AS serial_number
    FROM sales s
    WHERE s.serial_number IS NULL
      AND s.nft_id IS NOT NULL
      AND s.nft_id <> ''
      AND s.sold_at > now() - make_interval(days => p_max_age_days)
  )
  UPDATE sales s
     SET serial_number = c.serial_number
    FROM cand c
   WHERE s.id = c.sale_id
     AND c.serial_number IS NOT NULL
     AND s.serial_number IS NULL;   -- idempotent: never clobber a resolved serial

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated;
END;
$function$;
-- <<< END verbatim backfill_null_serial_sales_from_moments <<<

-- (1) Exactly 3 sales get a serial: FromMoment, FromWmc, Both. Already (has one),
-- ZeroSrc (source is 0), Old (out of age window), and '' nft_id are all skipped.
SELECT _assert_eq(
  public.backfill_null_serial_sales_from_moments()::text,
  '3', 'only the 3 eligible null-serial sales are backfilled');

-- (2) source precedence + fallback landed correctly.
SELECT _assert_eq((SELECT serial_number::text FROM public.sales WHERE nft_id='nftFromMoment'),
  '11', 'serial recovered from moments');
SELECT _assert_eq((SELECT serial_number::text FROM public.sales WHERE nft_id='nftFromWmc'),
  '44', 'serial recovered from wmc fallback when moments has none');
SELECT _assert_eq((SELECT serial_number::text FROM public.sales WHERE nft_id='nftBoth'),
  '22', 'moments (22) wins over wmc (66) when both exist');

-- (3) the guards held.
SELECT _assert_eq((SELECT serial_number::text FROM public.sales WHERE nft_id='nftAlready'),
  '500', 'a sale that already had a serial is never clobbered');
SELECT _assert_eq((SELECT serial_number FROM public.sales WHERE nft_id='nftZeroSrc')::text,
  NULL, 'a non-positive (0) source serial is ignored — stays NULL, never a fake #0');
SELECT _assert_eq((SELECT serial_number FROM public.sales WHERE nft_id='nftOld')::text,
  NULL, 'a sale older than p_max_age_days is out of scope');

-- (4) idempotent: a second run changes nothing.
SELECT _assert_eq(
  public.backfill_null_serial_sales_from_moments()::text,
  '0', 'second run is a no-op');

SELECT '✓ backfill_null_serial_sales_from_moments invariants pass' AS result;
ROLLBACK;

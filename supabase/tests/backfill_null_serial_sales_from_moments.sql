-- DB invariant: public.backfill_null_serial_sales_from_moments — recovers a
-- missing serial_number on a recent `sales` row from ground truth, feeding the
-- serial-FMV estimators (a wrong/absent serial mis-prices a #1/low-serial moment).
-- The behavior that must hold:
--   (a) source PRECEDENCE, THREE sources in strict order: moments.serial_number
--       (>0) first, then wallet_moments_cache.serial_number (>0), then
--       nft_edition_map.serial_number (>0) last. The third leg was added
--       2026-09-02; it is LAST precisely so it can never overwrite either of the
--       two that predate it, and the tests below pin that it loses to both.
--   (b) a non-positive source serial (0/negative) is IGNORED (the `> 0` guards) —
--       never write a fake serial #0. This binds all three legs.
--   (c) it only touches sales with serial_number IS NULL, a real nft_id, sold
--       within p_max_age_days; and it is IDEMPOTENT (never clobbers a serial that
--       is already set — the UPDATE re-checks s.serial_number IS NULL).
--       ⚠ The DEFAULT is 3650 days as of 2026-09-02, not 45. The hourly job calls
--       this with no argument, and the `*-sales-history-backfill` walkers write
--       sales whose `sold_at` is by construction far older than 45 days — so the
--       old default made every row they produce permanently unreachable (measured:
--       499 AllDay rows, 0 inside the window, 100% resolvable). Both the explicit
--       45 and the wide default are driven below, so neither can drift unnoticed.
--   (d) returns the count actually updated.
--   (e) the wmc and nft_edition_map legs are COLLECTION-SCOPED — a row for the
--       same nft_id under a different collection_id must not match. (moments is
--       keyed on nft_id alone, which is the pre-existing shape.)
--
-- The function DDL below is a VERBATIM copy of the committed migration
-- (supabase/migrations/20260902102507_audit_20260902_null_serial_recovery_default_window_covers_the_history_backfills.sql);
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
CREATE TABLE public.nft_edition_map (
  collection_id uuid,
  nft_id text,
  serial_number integer
);

-- One collection ('aaaa…'); 'bbbb…' exists only to prove collection scoping.
-- sales rows: recent + null serial unless noted.
INSERT INTO public.sales (id, nft_id, collection_id, serial_number, sold_at) VALUES
  ('50000000-0000-0000-0000-000000000001', 'nftFromMoment',  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', NULL, now() - interval '1 day'),
  ('50000000-0000-0000-0000-000000000002', 'nftFromWmc',     'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', NULL, now() - interval '1 day'),
  ('50000000-0000-0000-0000-000000000003', 'nftBoth',        'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', NULL, now() - interval '1 day'),
  ('50000000-0000-0000-0000-000000000004', 'nftAlready',     'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 500,  now() - interval '1 day'),
  ('50000000-0000-0000-0000-000000000005', 'nftZeroSrc',     'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', NULL, now() - interval '1 day'),
  ('50000000-0000-0000-0000-000000000006', 'nftOld',         'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', NULL, now() - interval '100 days'),
  ('50000000-0000-0000-0000-000000000007', '',               'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', NULL, now() - interval '1 day'),
  -- the nft_edition_map leg (added 2026-09-02)
  ('50000000-0000-0000-0000-000000000008', 'nftFromNem',     'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', NULL, now() - interval '1 day'),
  ('50000000-0000-0000-0000-000000000009', 'nftAllThree',    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', NULL, now() - interval '1 day'),
  ('50000000-0000-0000-0000-00000000000a', 'nftWmcOverNem',  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', NULL, now() - interval '1 day'),
  ('50000000-0000-0000-0000-00000000000b', 'nftNemZero',     'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', NULL, now() - interval '1 day'),
  ('50000000-0000-0000-0000-00000000000c', 'nftNemOtherColl','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', NULL, now() - interval '1 day'),
  -- Older than the 3650-day DEFAULT, so the parameter still bounds something even
  -- at its widest setting — otherwise the age filter would be pinned by nothing.
  ('50000000-0000-0000-0000-00000000000d', 'nftAncient',     'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', NULL, now() - interval '4000 days');

INSERT INTO public.moments (nft_id, serial_number) VALUES
  ('nftFromMoment', 11),
  ('nftBoth', 22),        -- moments wins over wmc for nftBoth
  ('nftAlready', 999),    -- would-be source, but sale already has a serial
  ('nftZeroSrc', 0),      -- non-positive → ignored
  ('nftOld', 33),         -- too old for an explicit 45, INSIDE the 3650-day default
  ('nftAllThree', 88),    -- outranks BOTH wmc (99) and nft_edition_map (111)
  ('nftAncient', 44);     -- a valid source, but the sale predates even the 3650-day default

INSERT INTO public.wallet_moments_cache (collection_id, moment_id, serial_number) VALUES
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'nftFromWmc', 44),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'nftBoth', 66),        -- loses to moments (22)
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'nftZeroSrc', 0),      -- also non-positive
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'nftAllThree', 99),    -- loses to moments (88)
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'nftWmcOverNem', 55);  -- outranks nem (123)

INSERT INTO public.nft_edition_map (collection_id, nft_id, serial_number) VALUES
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'nftFromNem', 77),      -- the only source → wins
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'nftAllThree', 111),    -- loses to moments (88)
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'nftWmcOverNem', 123),  -- loses to wmc (55)
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'nftNemZero', 0),       -- non-positive → ignored
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'nftZeroSrc', 0),       -- all three sources non-positive
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'nftNemOtherColl', 999); -- WRONG collection → must not match

-- >>> BEGIN verbatim backfill_null_serial_sales_from_moments (keep byte-identical to the migration) >>>
CREATE OR REPLACE FUNCTION public.backfill_null_serial_sales_from_moments(p_max_age_days integer DEFAULT 3650)
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
          LIMIT 1),
        (SELECT nem.serial_number
           FROM nft_edition_map nem
          WHERE nem.collection_id = s.collection_id
            AND nem.nft_id = s.nft_id
            AND nem.serial_number > 0
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

-- (1) Under an EXPLICIT 45-day window, exactly 6 sales get a serial: FromMoment,
-- FromWmc, Both, FromNem, AllThree, WmcOverNem. Already (has one), ZeroSrc (every
-- source is 0), NemZero (its only source is 0), NemOtherColl (mapped under another
-- collection), Old and Ancient (out of window), and '' nft_id are all skipped.
SELECT _assert_eq(
  public.backfill_null_serial_sales_from_moments(45)::text,
  '6', 'an explicit 45-day window backfills only the 6 eligible recent sales');

-- (2) source precedence + fallback landed correctly, across all three legs.
SELECT _assert_eq((SELECT serial_number::text FROM public.sales WHERE nft_id='nftFromMoment'),
  '11', 'serial recovered from moments');
SELECT _assert_eq((SELECT serial_number::text FROM public.sales WHERE nft_id='nftFromWmc'),
  '44', 'serial recovered from wmc fallback when moments has none');
SELECT _assert_eq((SELECT serial_number::text FROM public.sales WHERE nft_id='nftBoth'),
  '22', 'moments (22) wins over wmc (66) when both exist');
SELECT _assert_eq((SELECT serial_number::text FROM public.sales WHERE nft_id='nftFromNem'),
  '77', 'serial recovered from nft_edition_map when neither moments nor wmc has one');
-- ⛔ The two load-bearing precedence assertions for the 2026-09-02 leg. The new
-- source is the LEAST trusted of the three; if either of these flips, the leg
-- has started overwriting ground truth it was only ever meant to backstop.
SELECT _assert_eq((SELECT serial_number::text FROM public.sales WHERE nft_id='nftAllThree'),
  '88', 'moments (88) outranks BOTH wmc (99) and nft_edition_map (111)');
SELECT _assert_eq((SELECT serial_number::text FROM public.sales WHERE nft_id='nftWmcOverNem'),
  '55', 'wmc (55) outranks nft_edition_map (123) — the new leg is strictly last');

-- (3) the guards held.
SELECT _assert_eq((SELECT serial_number::text FROM public.sales WHERE nft_id='nftAlready'),
  '500', 'a sale that already had a serial is never clobbered');
SELECT _assert_eq((SELECT serial_number FROM public.sales WHERE nft_id='nftZeroSrc')::text,
  NULL, 'a non-positive (0) source serial is ignored — stays NULL, never a fake #0');
SELECT _assert_eq((SELECT serial_number FROM public.sales WHERE nft_id='nftNemZero')::text,
  NULL, 'the > 0 guard binds the nft_edition_map leg too — a 0 there stays NULL');
SELECT _assert_eq((SELECT serial_number FROM public.sales WHERE nft_id='nftNemOtherColl')::text,
  NULL, 'the nft_edition_map leg is collection-scoped — another collection does not match');
SELECT _assert_eq((SELECT serial_number FROM public.sales WHERE nft_id='nftOld')::text,
  NULL, 'a sale older than an EXPLICIT p_max_age_days is out of scope');

-- (4) ⛔ THE DEFAULT IS WIDE, AND THIS IS THE CALL THE HOURLY JOB ACTUALLY MAKES.
-- pg_cron jobid 76 runs `SELECT public.backfill_null_serial_sales_from_moments()`
-- with no argument, so the default alone decides what the platform recovers. It
-- must now reach the 100-day-old sale that the explicit 45 above left alone —
-- exactly the rows the `*-sales-history-backfill` walkers produce. If this drops
-- back to 0 the default has been narrowed and that whole population is stranded
-- again, silently.
SELECT _assert_eq(
  public.backfill_null_serial_sales_from_moments()::text,
  '1', 'the DEFAULT window reaches a 100-day-old sale that an explicit 45 does not');
SELECT _assert_eq((SELECT serial_number::text FROM public.sales WHERE nft_id='nftOld'),
  '33', 'the 100-day-old sale is recovered under the default window');

-- (5) …and the parameter STILL BOUNDS at its widest: a sale older than 3650 days
-- is out of scope even with no argument, so the age filter is pinned by a live
-- case rather than by its absence.
SELECT _assert_eq((SELECT serial_number FROM public.sales WHERE nft_id='nftAncient')::text,
  NULL, 'a sale older than the 3650-day DEFAULT is still out of scope');

-- (6) idempotent: a second run at the default changes nothing.
SELECT _assert_eq(
  public.backfill_null_serial_sales_from_moments()::text,
  '0', 'second run is a no-op');

SELECT '✓ backfill_null_serial_sales_from_moments invariants pass' AS result;
ROLLBACK;

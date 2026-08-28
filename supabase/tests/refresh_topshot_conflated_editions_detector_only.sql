-- DB invariant: public.refresh_topshot_conflated_editions_detector_only — the
-- second of the two SCHEDULED SECDEF deleters that were unpinned as of
-- 2026-08-15, and the higher-stakes one.
--
-- WHAT IT DETECTS. A Top Shot edition is CONFLATED when the same
-- (edition_id, serial_number) has traded under more than one nft_id — two
-- physically distinct moments sharing one key. This rebuilds the full set over a
-- trailing 365-day window.
--
-- ⚠ WHY IT MATTERS MORE THAN ITS SIZE SUGGESTS. `topshot_deals_vs_fmv` EXCLUDES
-- the editions in this table. So an under-populated result does NOT break a
-- page — it publishes conflated editions on the PUBLIC deals board as genuine
-- deals, priced off a serial that belongs to two different moments. It fails
-- silently in the direction of showing MORE rows, which is the direction nobody
-- notices.
--
-- ⚠ AND IT HAS TWO CALLERS, WHICH HAS ALREADY MISLED ONE SESSION. Besides step 5
-- of /api/cron/drain-conflated-subeditions (a route that has been dying at its
-- ceiling since 2026-07-31), pg_cron jobid 62 `rpc-remap-misattributed-sales`
-- (`23 */6 * * *`) calls it independently. Deep-audit R7 inferred from the dead
-- route that the guard must be ~15 days stale; measured live it is 0.0 days
-- stale over 931 rows. Do not re-derive R7's conclusion from one caller.
--
-- THE FOUR PROPERTIES:
--   1. It flags a serial sold under 2+ DISTINCT nft_ids, and counts how many
--      such serials an edition has (`shared_serials`).
--   2. It does NOT flag a serial that simply traded twice under the SAME nft_id
--      — that is an ordinary resale, and flagging it would drop a legitimate
--      edition off the public deals board.
--   3. It is a FULL REBUILD: stale rows from a previous detection must be gone,
--      so an edition that is no longer conflated stops being suppressed.
--   4. It is scoped to Top Shot and to a 365-day window.
--
-- The function DDL below is VERBATIM from the committed snapshot migration
-- (supabase/migrations/20260815180000_audit_20260815_snapshot_refresh_topshot_conflated_editions_detector_only.sql),
-- which was itself pulled from live prod via pg_get_functiondef on 2026-08-15
-- (md5 511458579340501cbb8f7e608f4877f1).
-- __tests__/db-invariants-drift-guard.test.ts fails CI on drift.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

-- Minimal stand-ins for the two real tables. `sales` is partitioned in prod;
-- the function's predicate does not depend on partitioning.
CREATE TABLE public.sales (
  edition_id    uuid,
  serial_number integer,
  nft_id        text,
  collection_id uuid,
  sold_at       timestamptz
);

CREATE TABLE public.topshot_conflated_editions (
  edition_id     uuid,
  shared_serials integer,
  detected_at    timestamptz
);

-- >>> BEGIN verbatim refresh_topshot_conflated_editions_detector_only (byte-identical to the migration/prod) >>>
CREATE OR REPLACE FUNCTION public.refresh_topshot_conflated_editions_detector_only()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '110s'
AS $function$
DECLARE n integer;
BEGIN
  DROP TABLE IF EXISTS _confd;
  CREATE TEMP TABLE _confd ON COMMIT DROP AS
    SELECT ms.edition_id, count(*)::int AS shared_serials
    FROM (
      SELECT edition_id, serial_number
      FROM sales
      WHERE collection_id='95f28a17-224a-4025-96ad-adf8a4c63bfd'
        AND serial_number > 0 AND nft_id IS NOT NULL
        AND sold_at > now() - interval '365 days'
      GROUP BY edition_id, serial_number HAVING count(DISTINCT nft_id) > 1
    ) ms
    GROUP BY ms.edition_id;
  DELETE FROM public.topshot_conflated_editions WHERE true;
  INSERT INTO public.topshot_conflated_editions (edition_id, shared_serials, detected_at)
    SELECT edition_id, shared_serials, now() FROM _confd;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $function$;
-- <<< END verbatim refresh_topshot_conflated_editions_detector_only <<<

\set TS '''95f28a17-224a-4025-96ad-adf8a4c63bfd'''
\set OTHER '''dee28451-5d62-409e-a1ad-a83f763ac070'''
\set conf '''aaaaaaaa-1111-1111-1111-111111111111'''
\set clean '''bbbbbbbb-2222-2222-2222-222222222222'''
\set old '''cccccccc-3333-3333-3333-333333333333'''
\set foreign_ '''dddddddd-4444-4444-4444-444444444444'''
\set nulled '''eeeeeeee-5555-5555-5555-555555555555'''
\set zeroser '''ffffffff-6666-6666-6666-666666666666'''

INSERT INTO public.sales (edition_id, serial_number, nft_id, collection_id, sold_at) VALUES
  -- CONFLATED: serial 7 traded under two different nft_ids, serial 9 likewise.
  -- Two distinct shared serials on one edition -> shared_serials = 2.
  (:conf::uuid,     7, 'nftA', :TS::uuid,     now() - interval '10 days'),
  (:conf::uuid,     7, 'nftB', :TS::uuid,     now() - interval '9 days'),
  (:conf::uuid,     9, 'nftC', :TS::uuid,     now() - interval '8 days'),
  (:conf::uuid,     9, 'nftD', :TS::uuid,     now() - interval '7 days'),

  -- ⚠ NOT conflated: serial 3 traded TWICE under the SAME nft_id. This is an
  -- ordinary resale — the single most important negative case, because flagging
  -- it would suppress a legitimate edition from the public deals board.
  (:clean::uuid,    3, 'nftE', :TS::uuid,     now() - interval '10 days'),
  (:clean::uuid,    3, 'nftE', :TS::uuid,     now() - interval '2 days'),

  -- Outside the 365-day window on BOTH legs -> not detected.
  (:old::uuid,      4, 'nftF', :TS::uuid,     now() - interval '400 days'),
  (:old::uuid,      4, 'nftG', :TS::uuid,     now() - interval '380 days'),

  -- Conflated but in a DIFFERENT collection -> out of scope.
  (:foreign_::uuid, 5, 'nftH', :OTHER::uuid,  now() - interval '10 days'),
  (:foreign_::uuid, 5, 'nftI', :OTHER::uuid,  now() - interval '9 days'),

  -- NULL nft_id is excluded, so these two cannot count as distinct ids.
  (:nulled::uuid,   6, NULL,   :TS::uuid,     now() - interval '10 days'),
  (:nulled::uuid,   6, NULL,   :TS::uuid,     now() - interval '9 days'),

  -- serial_number 0 is excluded (unnumbered / sentinel).
  (:zeroser::uuid,  0, 'nftJ', :TS::uuid,     now() - interval '10 days'),
  (:zeroser::uuid,  0, 'nftK', :TS::uuid,     now() - interval '9 days');

-- A stale row from a previous detection: this edition is NOT conflated in the
-- current window, so a full rebuild must drop it. If it survived, the edition
-- would stay suppressed from the deals board forever.
INSERT INTO public.topshot_conflated_editions (edition_id, shared_serials, detected_at)
  VALUES (:clean::uuid, 99, now() - interval '2 days');

SELECT _assert_eq(
  public.refresh_topshot_conflated_editions_detector_only()::text, '1',
  'exactly one edition is conflated in the current window'
);

SELECT _assert_eq(
  (SELECT count(*)::text FROM public.topshot_conflated_editions), '1',
  'the rebuild leaves exactly the detected set'
);

SELECT _assert_eq(
  (SELECT edition_id::text FROM public.topshot_conflated_editions), :conf,
  'the conflated edition is the one with two nft_ids on one serial'
);

SELECT _assert_eq(
  (SELECT shared_serials::text FROM public.topshot_conflated_editions), '2',
  'shared_serials counts DISTINCT SERIALS affected, not sale rows (4 rows, 2 serials)'
);

-- ⚠ The single most important negative assertion. A same-nft_id resale is an
-- ordinary trade; treating it as conflation would drop a real edition off the
-- public deals board, and nothing downstream would report the omission.
SELECT _assert_eq(
  (SELECT count(*)::text FROM public.topshot_conflated_editions WHERE edition_id = :clean::uuid),
  '0',
  'a serial resold under the SAME nft_id must NOT be flagged'
);

SELECT _assert_eq(
  (SELECT count(*)::text FROM public.topshot_conflated_editions
    WHERE edition_id IN (:old::uuid, :foreign_::uuid, :nulled::uuid, :zeroser::uuid)),
  '0',
  'out-of-window, other-collection, null-nft_id and serial-0 rows are all excluded'
);

-- ── The full-rebuild property, asserted directly ─────────────────────────────
-- ⚠ Deliberately a SECOND run rather than an assertion about the first. The stale
-- row above is dropped by the DELETE, but so is every row — what distinguishes a
-- correct rebuild from one that merely appends is that an edition which STOPS
-- being conflated stops being listed. Removing the second nft_id makes :conf
-- clean, and the next rebuild must forget it.
DELETE FROM public.sales WHERE edition_id = :conf::uuid AND nft_id IN ('nftB', 'nftD');

SELECT _assert_eq(
  public.refresh_topshot_conflated_editions_detector_only()::text, '0',
  'an edition that is no longer conflated must be forgotten on the next rebuild'
);

SELECT _assert_eq(
  (SELECT count(*)::text FROM public.topshot_conflated_editions), '0',
  'a full rebuild with nothing to detect empties the table — it does not append'
);

-- ── The boundary: exactly 365 days ───────────────────────────────────────────
-- ⚠ ON the boundary deliberately. A fixture a week inside the window passes with
-- `>` or `>=` and with 365 or 400 days, so it would assert nothing about the
-- window at all. now() is transaction-stable, so this row sits just inside.
INSERT INTO public.sales (edition_id, serial_number, nft_id, collection_id, sold_at) VALUES
  (:conf::uuid, 11, 'nftX', :TS::uuid, now() - interval '365 days' + interval '1 minute'),
  (:conf::uuid, 11, 'nftY', :TS::uuid, now() - interval '1 day');

SELECT _assert_eq(
  public.refresh_topshot_conflated_editions_detector_only()::text, '1',
  'a leg one minute inside the 365-day window still counts'
);

DELETE FROM public.sales WHERE nft_id = 'nftX';
INSERT INTO public.sales (edition_id, serial_number, nft_id, collection_id, sold_at) VALUES
  (:conf::uuid, 11, 'nftX', :TS::uuid, now() - interval '365 days' - interval '1 minute');

SELECT _assert_eq(
  public.refresh_topshot_conflated_editions_detector_only()::text, '0',
  'a leg one minute outside the window does not — only one distinct nft_id remains in range'
);

ROLLBACK;

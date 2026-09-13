-- DB invariant: public.rollup_allday_rip_pull_value — pg_cron
-- `rpc-allday-rollup-rip-value` @ `14 * * * *`.
--
-- WHAT IT DOES. Denormalizes each All Day pack rip's TOTAL PULL VALUE onto
-- `pack_rips.pull_value_usd`. ⚠ RE-PINNED 2026-09-13: that value is now the
-- CURRENT fmv of each pulled moment's edition — the latest `fmv_snapshots` row —
-- NOT the at-open `allday_pack_pull.fmv_usd` this file used to pin. That is the
-- Trevor-delegated decision of 2026-09-12 closing register #92: the column means
-- CURRENT fair-market value for EVERY collection, because the whole Top Shot
-- pack-reality estate already read it that way and All Day's at-open basis was an
-- accident of having a different writer.
--
-- ── THE FOUR PROPERTIES ────────────────────────────────────────────────────
--
--   1. ⚠ ALL-OR-NOTHING: `agg.valued_pulls = agg.total_pulls`. A rip's value is
--      written only when EVERY pull in it is priced. This is the important one,
--      and it fails in the reassuring direction if removed: a partial sum is a
--      SMALLER number that reads exactly like a real one — a 3-moment rip with
--      2 priced pulls would publish those 2 as the pack's total value, making a
--      good pull look like a bad pack, with nothing anywhere reporting it.
--      ⚠ WHAT "UNPRICED" MEANS CHANGED WITH THE BASIS. It used to be
--      `allday_pack_pull.fmv_usd IS NULL`; it is now "the edition has no
--      `fmv_snapshots` row" — which the LEFT JOIN LATERAL surfaces as a NULL
--      `fc.fmv_usd`. A pull whose `edition_id` is itself NULL lands in the same
--      place, and is asserted separately below.
--   2. ⚠ CURRENT, NOT AT-OPEN — the #92 decision, asserted rather than described.
--      The fixtures give every P-FULL pull an at-open `fmv_usd` of 1000.00 while
--      its snapshot says 10.00/20.00/5.505. A revert to `sum(p.fmv_usd)` would
--      publish 3000.00 where the assertion demands 35.51, so this file now FAILS
--      on the old body instead of passing on it — which is the whole reason it
--      needed re-pinning: the previous copy was green against a definition that
--      had not run in production since 2026-09-12.
--   3. ⚠ THE LATEST SNAPSHOT WINS (`ORDER BY s.computed_at DESC LIMIT 1`). Pinned
--      with a stale 99.00 sitting behind a current 7.00 on the same edition. Drop
--      the ORDER BY and the row Postgres happens to return first decides a user's
--      P&L — non-deterministically, so it would pass a careless test most runs.
--   4. ⚠ THE WATERMARK IS CAPTURED BEFORE THE READ, NOT AFTER. `t_start` is
--      `clock_timestamp()` at entry, and it is what gets stored — so a pull
--      updated WHILE the rollup runs has `updated_at >= t_start` and is picked
--      up on the NEXT tick. Storing `now()` at the end instead would skip that
--      row permanently: it changed after the read but before the watermark
--      moved past it. The window is small and the failure is silent and
--      unrecoverable, which is the worst combination.
--      ⚠ Paired with `updated_at >= w` (INCLUSIVE), so the boundary row is
--      re-processed rather than skipped. Re-processing is free because the
--      UPDATE carries `IS DISTINCT FROM` change-detection; skipping is not.
--      ⚠ The INCLUSIVE half IS asserted below. The before-vs-after half is NOT
--      and cannot be: the difference only appears when another session writes
--      DURING the run, which a single-session rolled-back test cannot produce.
--      Swapping `t_start` for `clock_timestamp()` at the end passes every
--      assertion here. Recorded so the omission is a known limit of the harness
--      rather than an oversight — same treatment as the concurrency backstops in
--      attribute_topshot_rips_empirical and fill_ts_artless_from_rep_moments.
--
-- ⚠ `total_fmv IS NOT NULL` beside guard 1 is UNREACHABLE: a rip with no pulls
-- never enters `agg` at all (the CTE groups over `allday_pack_pull` rows), so
-- every group has at least one row, and `valued_pulls = total_pulls >= 1`
-- already guarantees a non-NULL SUM. Kept as intent, documented rather than
-- asserted, and load-bearing again the moment guard 1 is relaxed.
--
-- ⚠ THIS ROLLUP IS A "NEW PULLS" TRIGGER, NOT A "VALUE CHANGED" ONE, and that is
-- correct. It keys on `allday_pack_pull.updated_at`; under a current-FMV basis a
-- pack's value also moves when the SNAPSHOT moves with no pull row changing. The
-- 7-day `stale_valued` leg in backfill_pack_rip_metadata is the drift handler.
-- Do NOT "fix" this to watch snapshots — it would re-scan 1.48M pull rows a tick.
--
-- ALSO: `COALESCE(w, '-infinity')` makes a never-run state a FULL sweep rather
-- than a no-op, and the update is scoped to the All Day collection_id.
--
-- ⚠ The watermark advances even when zero rips are updated — deliberately.
-- Nothing left to do is not a reason to re-scan the same window next hour.
--
-- The function DDL below is VERBATIM from the committed migration
-- (supabase/migrations/20260913032000_audit_20260912_pull_value_usd_is_current_fmv_for_every_collection.sql),
-- which the migration's own header states is pg_get_functiondef output read back
-- from production after the apply. Confirmed against live pg_get_functiondef on
-- 2026-09-13. __tests__/db-invariants-drift-guard.test.ts fails CI on drift.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE public.allday_rip_rollup_state (
  singleton   boolean PRIMARY KEY DEFAULT true,
  last_run_at timestamptz
);

-- ⚠ `fmv_usd` is the AT-OPEN column. It is deliberately present and deliberately
-- NEVER read by this function since 2026-09-12 — property 2 asserts exactly that.
CREATE TABLE public.allday_pack_pull (
  pack_nft_id text,
  edition_id  uuid,
  fmv_usd     numeric,
  updated_at  timestamptz
);

CREATE TABLE public.fmv_snapshots (
  edition_id  uuid,
  fmv_usd     numeric,
  computed_at timestamptz
);

CREATE TABLE public.pack_rips (
  collection_id       uuid,
  pack_nft_id         text,
  pull_value_usd      numeric,
  metadata_updated_at timestamptz
);

-- >>> BEGIN verbatim rollup_allday_rip_pull_value (byte-identical to the migration/prod) >>>
CREATE OR REPLACE FUNCTION public.rollup_allday_rip_pull_value()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  n int;
  w timestamptz;
  t_start timestamptz := clock_timestamp();
BEGIN
  SELECT last_run_at INTO w FROM allday_rip_rollup_state WHERE singleton;
  w := COALESCE(w, '-infinity'::timestamptz);

  WITH changed AS (
    SELECT DISTINCT pack_nft_id
    FROM allday_pack_pull
    WHERE updated_at >= w
  ),
  agg AS (
    SELECT p.pack_nft_id,
           sum(fc.fmv_usd)                                  AS total_fmv,
           count(*) FILTER (WHERE fc.fmv_usd IS NOT NULL)   AS valued_pulls,
           count(*)                                         AS total_pulls
    FROM allday_pack_pull p
    JOIN changed c ON c.pack_nft_id = p.pack_nft_id
    -- CURRENT fmv, same source and same shape as the Top Shot path.
    LEFT JOIN LATERAL (
      SELECT s.fmv_usd FROM public.fmv_snapshots s
      WHERE s.edition_id = p.edition_id
      ORDER BY s.computed_at DESC
      LIMIT 1
    ) fc ON true
    GROUP BY p.pack_nft_id
  )
  UPDATE pack_rips r
  SET pull_value_usd = round(agg.total_fmv,2), metadata_updated_at = now()
  FROM agg
  WHERE r.collection_id='dee28451-5d62-409e-a1ad-a83f763ac070'
    AND r.pack_nft_id = agg.pack_nft_id
    -- all-or-nothing per pack: a partly priced pack contributes nothing
    AND agg.valued_pulls = agg.total_pulls AND agg.total_fmv IS NOT NULL
    AND r.pull_value_usd IS DISTINCT FROM round(agg.total_fmv,2);
  GET DIAGNOSTICS n = ROW_COUNT;

  UPDATE allday_rip_rollup_state SET last_run_at = t_start WHERE singleton;

  RETURN n;
END
$function$;
-- <<< END verbatim rollup_allday_rip_pull_value <<<

\set AD '''dee28451-5d62-409e-a1ad-a83f763ac070'''
\set TS '''95f28a17-224a-4025-96ad-adf8a4c63bfd'''

\set E1     '''11111111-1111-1111-1111-111111111111'''
\set E2     '''22222222-2222-2222-2222-222222222222'''
\set E3     '''33333333-3333-3333-3333-333333333333'''
\set ENONE  '''44444444-4444-4444-4444-444444444444'''
\set ESAME  '''55555555-5555-5555-5555-555555555555'''
\set ELATE  '''66666666-6666-6666-6666-666666666666'''
\set EWRONG '''77777777-7777-7777-7777-777777777777'''

INSERT INTO public.allday_rip_rollup_state (singleton, last_run_at) VALUES (true, NULL);

-- ⚠ EVERY at-open fmv_usd here is 1000.00 — a value NO assertion expects. If the
-- body ever reverts to sum(p.fmv_usd), every total below becomes a multiple of
-- 1000 and this file fails loudly instead of quietly agreeing.
--
-- P-FULL    : 3 pulls, all editions have snapshots     -> written (10+20+5.505)
-- P-PARTIAL : 3 pulls, ONE edition has NO snapshot     -> NOT written (the important case)
-- P-NULLED  : 1 pull with edition_id NULL              -> NOT written (same class, different cause)
-- P-EMPTY   : 0 pulls                                  -> not written
-- P-SAME    : already carries its computed value       -> not rewritten
-- P-LATEST  : edition has a STALE 99.00 and a live 7.00-> written at 7.00
-- P-WRONGC  : a Top Shot rip                           -> never touched
INSERT INTO public.allday_pack_pull (pack_nft_id, edition_id, fmv_usd, updated_at) VALUES
  ('P-FULL',    :E1::uuid,     1000.00, '2026-06-01T00:00:00Z'),
  ('P-FULL',    :E2::uuid,     1000.00, '2026-06-01T00:00:00Z'),
  ('P-FULL',    :E3::uuid,     1000.00, '2026-06-01T00:00:00Z'),
  ('P-PARTIAL', :E1::uuid,     1000.00, '2026-06-01T00:00:00Z'),
  ('P-PARTIAL', :E2::uuid,     1000.00, '2026-06-01T00:00:00Z'),
  ('P-PARTIAL', :ENONE::uuid,  1000.00, '2026-06-01T00:00:00Z'),
  ('P-NULLED',  NULL,          1000.00, '2026-06-01T00:00:00Z'),
  ('P-SAME',    :ESAME::uuid,  1000.00, '2026-06-01T00:00:00Z'),
  ('P-LATEST',  :ELATE::uuid,  1000.00, '2026-06-01T00:00:00Z'),
  ('P-WRONGC',  :EWRONG::uuid, 1000.00, '2026-06-01T00:00:00Z');

-- ⚠ :ENONE deliberately has NO row here — that is what "unpriced" now means.
-- ⚠ :ELATE has TWO rows and their INSERT ORDER IS LOAD-BEARING: the stale 99.00
-- goes in FIRST so a body that drops `ORDER BY computed_at DESC` reads it off the
-- heap first and FAILS. Written the other way round the mutation survives — it
-- did, on the first draft of this file, and the mutation run is what caught it.
-- ⚠ Heap order is not a SQL guarantee, so this makes the mutation DETECTABLE in
-- practice rather than impossible in principle. Do not reorder these two rows.
INSERT INTO public.fmv_snapshots (edition_id, fmv_usd, computed_at) VALUES
  (:E1::uuid,     10.00,  '2026-06-02T00:00:00Z'),
  (:E2::uuid,     20.00,  '2026-06-02T00:00:00Z'),
  (:E3::uuid,      5.505, '2026-06-02T00:00:00Z'),
  (:ESAME::uuid,  50.00,  '2026-06-02T00:00:00Z'),
  (:EWRONG::uuid, 99.00,  '2026-06-02T00:00:00Z'),
  (:ELATE::uuid,  99.00,  '2026-06-01T00:00:00Z'),
  (:ELATE::uuid,   7.00,  '2026-06-05T00:00:00Z');

INSERT INTO public.pack_rips (collection_id, pack_nft_id, pull_value_usd) VALUES
  (:AD::uuid, 'P-FULL',    NULL),
  (:AD::uuid, 'P-PARTIAL', NULL),
  (:AD::uuid, 'P-NULLED',  NULL),
  (:AD::uuid, 'P-EMPTY',   NULL),
  (:AD::uuid, 'P-SAME',    50.00),
  (:AD::uuid, 'P-LATEST',  NULL),
  (:TS::uuid, 'P-WRONGC',  NULL);

SELECT _assert_eq(
  public.rollup_allday_rip_pull_value()::text, '2',
  'only the two fully-priced rips are written — P-SAME is unchanged, so it does not count'
);

SELECT _assert_eq(
  (SELECT pull_value_usd::text FROM public.pack_rips WHERE pack_nft_id = 'P-FULL'),
  '35.51',
  'a fully-priced rip gets the ROUNDED sum of its pulls CURRENT fmvs'
);

-- ⚠ THE #92 DECISION, ASSERTED. Every at-open fmv_usd for P-FULL is 1000.00, so
-- the old at-open body would write 3000.00 here. 35.51 is only reachable through
-- fmv_snapshots. This is the assertion the previous pin could not make.
SELECT _assert_eq(
  (SELECT (pull_value_usd = 35.51)::text FROM public.pack_rips WHERE pack_nft_id = 'P-FULL'),
  'true',
  'pull_value_usd is CURRENT fmv, never the at-open allday_pack_pull.fmv_usd (3000.00)'
);

-- ⚠ THE ASSERTION THIS FILE EXISTS FOR. A partial sum is a smaller number that
-- reads exactly like a real one: 30.00 would say this pack was worth $30 when
-- one of its three moments is simply unpriced. It fails in the reassuring
-- direction, so nothing downstream would ever report it.
SELECT _assert_eq(
  (SELECT coalesce(pull_value_usd::text, 'NULL') FROM public.pack_rips WHERE pack_nft_id = 'P-PARTIAL'),
  'NULL',
  'a rip with ANY unpriced pull is left NULL — a partial sum would understate the pack and look real'
);

-- ⚠ Same property, reached the other way: no edition at all, so no snapshot to
-- join. Worth its own case because the two causes take different code paths.
SELECT _assert_eq(
  (SELECT coalesce(pull_value_usd::text, 'NULL') FROM public.pack_rips WHERE pack_nft_id = 'P-NULLED'),
  'NULL',
  'a pull with a NULL edition_id counts as unpriced, so its rip is left NULL'
);

SELECT _assert_eq(
  (SELECT pull_value_usd::text FROM public.pack_rips WHERE pack_nft_id = 'P-LATEST'),
  '7.00',
  'the LATEST snapshot wins — a stale 99.00 behind a current 7.00 is not used'
);

SELECT _assert_eq(
  (SELECT coalesce(pull_value_usd::text, 'NULL') FROM public.pack_rips WHERE pack_nft_id = 'P-EMPTY'),
  'NULL',
  'a rip with no pulls at all is left NULL, not written as 0'
);

SELECT _assert_eq(
  (SELECT coalesce(metadata_updated_at::text, 'NULL') FROM public.pack_rips WHERE pack_nft_id = 'P-SAME'),
  'NULL',
  'an unchanged value is not rewritten — metadata_updated_at stays meaningful'
);

SELECT _assert_eq(
  (SELECT coalesce(pull_value_usd::text, 'NULL') FROM public.pack_rips WHERE pack_nft_id = 'P-WRONGC'),
  'NULL',
  'another collection is never touched'
);

-- ── The watermark ──────────────────────────────────────────────────────────
SELECT _assert_eq(
  (SELECT (last_run_at IS NOT NULL)::text FROM public.allday_rip_rollup_state),
  'true',
  'the watermark advances after a run'
);

-- A second run with nothing new does nothing, and still advances.
SELECT _assert_eq(
  public.rollup_allday_rip_pull_value()::text, '0',
  'a second run with no new pulls writes nothing'
);

-- ⚠ THE WATERMARK IS INCLUSIVE (`updated_at >= w`), so a pull stamped EXACTLY at
-- the stored watermark is re-processed rather than skipped. Re-processing is
-- free — the UPDATE carries change-detection — while skipping loses the row for
-- good. This is the boundary where an off-by-one silently drops data.
-- ⚠ Under the current-FMV basis the pull row itself carries no price, so the
-- change that must be picked up is a SNAPSHOT change on that pull's edition.
UPDATE public.fmv_snapshots SET fmv_usd = 11.00
  WHERE edition_id = :E1::uuid;
UPDATE public.allday_pack_pull SET updated_at =
  (SELECT last_run_at FROM public.allday_rip_rollup_state)
WHERE pack_nft_id = 'P-FULL' AND edition_id = :E1::uuid;

SELECT _assert_eq(
  public.rollup_allday_rip_pull_value()::text, '1',
  'a pull stamped EXACTLY at the watermark is re-processed, not skipped'
);
SELECT _assert_eq(
  (SELECT pull_value_usd::text FROM public.pack_rips WHERE pack_nft_id = 'P-FULL'),
  '36.51',
  '...and the new total lands'
);

-- ⚠ A never-run state is a FULL sweep, not a no-op: COALESCE(NULL, '-infinity')
-- makes the first-ever tick see everything rather than nothing.
UPDATE public.allday_rip_rollup_state SET last_run_at = NULL;
UPDATE public.pack_rips SET pull_value_usd = NULL WHERE pack_nft_id = 'P-FULL';

SELECT _assert_eq(
  public.rollup_allday_rip_pull_value()::text, '1',
  'a NULL watermark sweeps everything — the first-ever run is not a silent no-op'
);

ROLLBACK;

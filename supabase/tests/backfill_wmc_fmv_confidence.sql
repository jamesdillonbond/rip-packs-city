-- DB invariant: public.backfill_wmc_fmv_confidence — pg_cron
-- `rpc-backfill-wmc-fmv-confidence` @ `2-59/5 * * * *`.
--
-- WHAT IT DOES. Fills `wallet_moments_cache.fmv_confidence` (and re-writes
-- `fmv_usd` alongside it) from the latest priced `fmv_snapshots` row, in batches,
-- every five minutes. wmc is the portfolio store — ~34 DB functions sum
-- `wmc.fmv_usd` — so this is what puts a confidence LABEL next to the value at
-- the point a portfolio total is computed.
--
-- ── THE PROPERTY WORTH THE PIN ─────────────────────────────────────────────
-- ⚠ VALUE AND LABEL COME FROM THE SAME SNAPSHOT ROW. One `CROSS JOIN LATERAL`
-- selects `fmv_usd, confidence` together, and both are written in one UPDATE.
-- Reading them from two lookups — even two correct ones — would let a row carry
-- one snapshot's price under another snapshot's confidence, which is worse than
-- either being missing: a STALE price wearing a HIGH label is a number a
-- collector has no way to distrust.
--
-- THE OTHERS:
--   • `FOR UPDATE SKIP LOCKED` — two overlapping ticks take disjoint batches
--     rather than one blocking on the other. On a 5-minute cron over a ~2.3 GB
--     table that is what stops a slow tick queueing behind itself.
--   • `fmv_confidence IS NULL` — it is a BACKFILL, so an already-labelled row is
--     never revisited. That is also why the batch is cheap while the queue
--     lasts, and exactly why CLAUDE.md records it becoming the #1 disk reader on
--     the instance (113 GB) once its queue DRAINED: a LIMITed scan that stops
--     early only stops early while the batch EXISTS.
--   • `p_collection_id IS NULL OR ...` — a NULL argument means ALL collections,
--     not none.
--   • ⚠ `edition_key IS NOT NULL` is REDUNDANT for correctness and deliberately
--     not asserted: a NULL key matches no edition, so the CROSS JOIN drops the
--     row anyway (mutation-confirmed). What it buys is THROUGHPUT — without it,
--     every keyless row consumes a batch slot on every tick forever, joining the
--     permanent floor described below.
--   • ⚠ `CROSS JOIN LATERAL`, not LEFT. An edition with no priced snapshot is
--     DROPPED, so its wmc rows keep a NULL confidence and are re-selected on
--     every tick, forever. Asserted, because that is a permanent floor on the
--     backlog rather than a transient one — and the reason a "drained" queue can
--     still be non-empty.
--
-- The function DDL below is VERBATIM from the committed snapshot migration
-- (supabase/migrations/20260816080000_audit_20260816_snapshot_remaining_scheduled_mv_and_rollup_writers.sql),
-- pulled from live prod via pg_get_functiondef on 2026-08-16
-- (md5 731012fa08c138028f425e43598fddb8).
-- __tests__/db-invariants-drift-guard.test.ts fails CI on drift.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TYPE public.fmv_confidence AS ENUM
  ('HIGH','MEDIUM','LOW','NO_DATA','ASK_ONLY','SALES_ONLY','STALE');

CREATE TABLE public.wallet_moments_cache (
  id             bigint PRIMARY KEY,
  collection_id  uuid,
  edition_key    text,
  fmv_usd        numeric,
  fmv_confidence public.fmv_confidence
);

CREATE TABLE public.editions (
  id            uuid,
  collection_id uuid,
  external_id   text
);

CREATE TABLE public.fmv_snapshots (
  edition_id  uuid,
  fmv_usd     numeric,
  confidence  public.fmv_confidence,
  computed_at timestamptz
);

-- >>> BEGIN verbatim backfill_wmc_fmv_confidence (byte-identical to the migration/prod) >>>
CREATE OR REPLACE FUNCTION public.backfill_wmc_fmv_confidence(p_collection_id uuid DEFAULT NULL::uuid, p_limit integer DEFAULT 25000)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '120s'
AS $function$
DECLARE
  v_updated integer;
BEGIN
  WITH targets AS (
    SELECT wmc.id, wmc.collection_id, wmc.edition_key
    FROM public.wallet_moments_cache wmc
    WHERE wmc.fmv_confidence IS NULL
      AND wmc.edition_key IS NOT NULL
      AND (p_collection_id IS NULL OR wmc.collection_id = p_collection_id)
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  ),
  snapped AS (
    SELECT t.id AS wmc_id, fs.fmv_usd, fs.confidence
    FROM targets t
    JOIN public.editions e
      ON e.collection_id = t.collection_id
     AND e.external_id   = t.edition_key
    CROSS JOIN LATERAL (
      SELECT fmv_usd, confidence
      FROM public.fmv_snapshots
      WHERE edition_id = e.id
        AND fmv_usd IS NOT NULL
      ORDER BY computed_at DESC
      LIMIT 1
    ) fs
  ),
  updated AS (
    UPDATE public.wallet_moments_cache wmc
       SET fmv_usd        = s.fmv_usd,
           fmv_confidence = s.confidence
      FROM snapped s
     WHERE wmc.id = s.wmc_id
     RETURNING 1
  )
  SELECT COUNT(*)::int INTO v_updated FROM updated;

  RETURN COALESCE(v_updated, 0);
END;
$function$;
-- <<< END verbatim backfill_wmc_fmv_confidence <<<

\set TS '''95f28a17-224a-4025-96ad-adf8a4c63bfd'''
\set AD '''dee28451-5d62-409e-a1ad-a83f763ac070'''
\set eOK '''a0000000-0000-0000-0000-00000000000a'''
\set eNP '''a0000000-0000-0000-0000-00000000000b'''
\set eAD '''a0000000-0000-0000-0000-00000000000c'''

INSERT INTO public.editions (id, collection_id, external_id) VALUES
  (:eOK::uuid, :TS::uuid, '10:1'),
  (:eNP::uuid, :TS::uuid, '10:2'),
  (:eAD::uuid, :AD::uuid, '20:1'),
  -- ⚠ The same external_id '30:1' under BOTH collections — CLAUDE.md states
  -- external_id is not unique across them. The Top Shot one has no priced
  -- snapshot and the All Day one does, which makes the edition join's collection
  -- scope observable AND deterministic: with the scope the wmc row stays
  -- unlabelled, without it the row is priced from ANOTHER COLLECTION'S edition.
  ('a0000000-0000-0000-0000-00000000000d'::uuid, :TS::uuid, '30:1'),
  ('a0000000-0000-0000-0000-00000000000e'::uuid, :AD::uuid, '30:1');

-- ⚠ THREE snapshots on the priced edition, and the NEWEST is the one to use.
-- The middle row is a NULL-priced snapshot stamped LATEST — it must be skipped
-- by `fmv_usd IS NOT NULL` rather than taken as "the latest".
INSERT INTO public.fmv_snapshots (edition_id, fmv_usd, confidence, computed_at) VALUES
  (:eOK::uuid, 10.00, 'LOW',    '2026-01-01T00:00:00Z'),
  (:eOK::uuid, 25.00, 'HIGH',   '2026-06-01T00:00:00Z'),
  (:eOK::uuid, NULL,  'NO_DATA','2026-07-01T00:00:00Z'),
  (:eAD::uuid, 99.00, 'MEDIUM', '2026-06-01T00:00:00Z'),
  ('a0000000-0000-0000-0000-00000000000e'::uuid, 777.00, 'LOW', '2026-06-01T00:00:00Z');
-- eNP deliberately has NO snapshot at all.

INSERT INTO public.wallet_moments_cache (id, collection_id, edition_key, fmv_usd, fmv_confidence) VALUES
  (1, :TS::uuid, '10:1', NULL,  NULL),      -- fillable
  (2, :TS::uuid, '10:2', NULL,  NULL),      -- edition has NO priced snapshot
  (3, :TS::uuid, '10:1', 999.00,'STALE'),   -- already labelled -> never revisited
  (4, :TS::uuid, NULL,   NULL,  NULL),      -- no edition_key
  (5, :AD::uuid, '20:1', NULL,  NULL),      -- another collection
  (6, :TS::uuid, '30:1', NULL,  NULL);      -- key collides across collections

SELECT _assert_eq(
  public.backfill_wmc_fmv_confidence()::text, '2',
  'both fillable rows are labelled — a NULL collection argument means ALL collections'
);

-- ⚠ THE ASSERTION THIS FILE EXISTS FOR: value and label from the SAME snapshot.
-- 25.00 belongs to HIGH; pairing 25.00 with LOW, or 10.00 with HIGH, would be a
-- number a collector has no way to distrust.
SELECT _assert_eq(
  (SELECT fmv_usd::text || '/' || fmv_confidence::text
     FROM public.wallet_moments_cache WHERE id = 1),
  '25.00/HIGH',
  'the value and its confidence come from the SAME snapshot row — never two lookups'
);

-- ...and the newest snapshot is the priced one, not the NULL-priced row stamped
-- later. Taking that would have written a NULL price under a NO_DATA label.
SELECT _assert_eq(
  (SELECT (fmv_usd = 25.00)::text FROM public.wallet_moments_cache WHERE id = 1),
  'true',
  'a NULL-priced snapshot stamped LATEST is skipped, not taken as the latest'
);

-- ⚠ CROSS JOIN, not LEFT: an edition with no priced snapshot is DROPPED, so this
-- row keeps a NULL confidence and is re-selected on every 5-minute tick forever.
-- That is a permanent floor on the backlog, and the reason a "drained" queue can
-- still be non-empty.
SELECT _assert_eq(
  (SELECT coalesce(fmv_confidence::text,'NULL') FROM public.wallet_moments_cache WHERE id = 2),
  'NULL',
  'an edition with no priced snapshot leaves the row unlabelled — a PERMANENT backlog floor'
);

-- Fill-only: an already-labelled row is never revisited, so a correction made
-- elsewhere survives.
SELECT _assert_eq(
  (SELECT fmv_usd::text || '/' || fmv_confidence::text
     FROM public.wallet_moments_cache WHERE id = 3),
  '999.00/STALE',
  'an already-labelled row is never revisited — this is a backfill, not a refresher'
);

SELECT _assert_eq(
  (SELECT coalesce(fmv_confidence::text,'NULL') FROM public.wallet_moments_cache WHERE id = 4),
  'NULL',
  'a row with no edition_key cannot be resolved and is skipped'
);

SELECT _assert_eq(
  (SELECT fmv_confidence::text FROM public.wallet_moments_cache WHERE id = 5),
  'MEDIUM',
  'a NULL collection argument covers every collection, not none'
);

-- ⚠ The edition join is collection-scoped. Row 6's key exists in BOTH
-- collections; only All Day's copy has a price. Without the scope this row would
-- be priced at 777.00 from an edition in a different collection entirely — a
-- wrong price wearing a real confidence label, on the portfolio store.
SELECT _assert_eq(
  (SELECT coalesce(fmv_confidence::text,'NULL') || '/' || coalesce(fmv_usd::text,'NULL')
     FROM public.wallet_moments_cache WHERE id = 6),
  'NULL/NULL',
  'a colliding external_id is never priced from ANOTHER collection''s edition'
);

-- ── The collection filter, when supplied ───────────────────────────────────
UPDATE public.wallet_moments_cache SET fmv_confidence = NULL, fmv_usd = NULL WHERE id IN (1, 5);

SELECT _assert_eq(
  public.backfill_wmc_fmv_confidence(:AD::uuid)::text, '1',
  'a supplied collection scopes the batch to that collection alone'
);
SELECT _assert_eq(
  (SELECT coalesce(fmv_confidence::text,'NULL') FROM public.wallet_moments_cache WHERE id = 1),
  'NULL',
  '...leaving the other collection''s row untouched'
);

-- ── The batch limit, and what it actually bounds ───────────────────────────
SELECT _assert_eq(
  public.backfill_wmc_fmv_confidence(NULL, 0)::text, '0',
  'a zero limit takes no rows — the batch size is honoured, not ignored'
);

-- ⚠ THE LIMIT BOUNDS ROWS **EXAMINED**, NOT ROWS WRITTEN, and that is the whole
-- mechanism behind the permanent backlog floor above. `LIMIT p_limit` sits in
-- the `targets` CTE, BEFORE the join to a priced snapshot — so an unresolvable
-- row consumes a batch slot and writes nothing. Every tick draws the same
-- unresolvable rows again, and once they are all that remain, a 25,000-row batch
-- does 25,000 rows of work and zero writes, forever.
--
-- ⚠ I found this by writing the assertion the other way round and having it
-- fail: with two candidates and a LIMIT of 1, the run returned 0 because it drew
-- the unresolvable one. The code was right and the expectation was wrong. Made
-- deterministic below by leaving ONLY the unresolvable row.
DELETE FROM public.wallet_moments_cache WHERE id = 1;

SELECT _assert_eq(
  public.backfill_wmc_fmv_confidence(NULL, 1)::text, '0',
  'a batch slot spent on an unresolvable row writes NOTHING — the limit bounds EXAMINED, not written'
);
SELECT _assert_eq(
  (SELECT coalesce(fmv_confidence::text,'NULL') FROM public.wallet_moments_cache WHERE id = 2),
  'NULL',
  '...and that row is still unlabelled, so the next tick draws it again'
);

ROLLBACK;

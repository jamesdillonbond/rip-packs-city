-- DB invariant: public.sync_allday_pack_dist_totals — pg_cron
-- `rpc-sync-allday-pack-dist-totals` @ `24 * * * *`.
--
-- WHAT IT DOES. Copies each All Day pack distribution's minted / opened totals
-- from the on-chain-derived view `v_allday_pack_info` onto `pack_distributions`.
-- Those two numbers drive the depletion percentage a collector reads before
-- buying a pack, so a wrong one moves a purchase decision.
--
-- ⚠ THE PROPERTY WORTH THE PIN: `coalesce(i.packnft_total, 0) > 0`. It refuses
-- to write a ZERO or NULL minted total. That is the difference between "this
-- pack had no mints" — a claim about the pack — and "we have not indexed its
-- mints yet" — a statement about us. The view is fed by an indexer that lags, so
-- a not-yet-indexed distribution legitimately reports 0, and copying that would
-- publish a depletion figure computed against a supply of nothing.
-- ⚠ Note the guard is on `packnft_total` ONLY: a pack with real mints and zero
-- OPENS is a perfectly good state (nobody has ripped one yet) and IS written.
-- Guarding both would freeze every unopened pack's totals forever.
--
-- THE OTHERS:
--   • Change-detection on BOTH columns with `IS DISTINCT FROM`, so `updated_at`
--     keeps meaning "when these totals moved" rather than "when the cron ran" —
--     and a first write over a NULL total happens at all (`<>` would skip it).
--   • Scoped to the All Day collection_id.
--   • `pd.dist_id::text = i.dist_id` — the two sides are different types, and
--     the cast is on the COLUMN side, so this join cannot use an index on
--     `dist_id`. Recorded as a known cost, not a defect to "fix" blindly.
--   • ⚠ LANGUAGE **sql**, not plpgsql, and SECURITY DEFINER — the only writer in
--     this tranche with no procedural body, hence no exception handler and no
--     telemetry of its own. A failure is invisible except as frozen totals.
--
-- The function DDL below is VERBATIM from the committed snapshot migration
-- (supabase/migrations/20260816080000_audit_20260816_snapshot_remaining_scheduled_mv_and_rollup_writers.sql),
-- pulled from live prod via pg_get_functiondef on 2026-08-16
-- (md5 7f8b0b42177523aa7880be64ee2fd787).
-- __tests__/db-invariants-drift-guard.test.ts fails CI on drift.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE public.pack_distributions (
  collection_id uuid,
  dist_id       text,
  total_minted  int,
  total_opened  int,
  updated_at    timestamptz
);

CREATE TABLE public.__allday_pack_info_src (
  dist_id       text,
  packnft_total int,
  opened_count  int
);
CREATE VIEW public.v_allday_pack_info AS SELECT * FROM public.__allday_pack_info_src;

-- >>> BEGIN verbatim sync_allday_pack_dist_totals (byte-identical to the migration/prod) >>>
CREATE OR REPLACE FUNCTION public.sync_allday_pack_dist_totals()
 RETURNS integer
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH upd AS (
    UPDATE pack_distributions pd
    SET total_minted = i.packnft_total,
        total_opened = i.opened_count,
        updated_at = now()
    FROM v_allday_pack_info i
    WHERE pd.collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070'
      AND pd.dist_id::text = i.dist_id
      AND coalesce(i.packnft_total,0) > 0
      AND (pd.total_minted IS DISTINCT FROM i.packnft_total
        OR pd.total_opened IS DISTINCT FROM i.opened_count)
    RETURNING 1
  ) SELECT count(*)::integer FROM upd;
$function$;
-- <<< END verbatim sync_allday_pack_dist_totals <<<

\set AD '''dee28451-5d62-409e-a1ad-a83f763ac070'''
\set TS '''95f28a17-224a-4025-96ad-adf8a4c63bfd'''

-- D-NEW      : totals arrive for the first time      -> written
-- D-MOVED    : opened count went up                  -> written
-- D-ZERO     : packnft_total 0 (not yet indexed)     -> NOT written
-- D-NULLTOT  : packnft_total NULL                    -> NOT written
-- D-UNOPENED : real mints, ZERO opens                -> WRITTEN (0 opens is real)
-- D-SAME     : unchanged                             -> not rewritten
-- D-WRONGC   : Top Shot                              -> never touched
INSERT INTO public.pack_distributions (collection_id, dist_id, total_minted, total_opened, updated_at) VALUES
  (:AD::uuid, 'D-NEW',      NULL, NULL, '2026-01-01T00:00:00Z'),
  (:AD::uuid, 'D-MOVED',    500,  10,   '2026-01-01T00:00:00Z'),
  (:AD::uuid, 'D-ZERO',     500,  10,   '2026-01-01T00:00:00Z'),
  (:AD::uuid, 'D-NULLTOT',  500,  10,   '2026-01-01T00:00:00Z'),
  (:AD::uuid, 'D-UNOPENED', NULL, NULL, '2026-01-01T00:00:00Z'),
  (:AD::uuid, 'D-SAME',     500,  10,   '2026-01-01T00:00:00Z'),
  (:TS::uuid, 'D-WRONGC',   NULL, NULL, '2026-01-01T00:00:00Z');

INSERT INTO public.__allday_pack_info_src (dist_id, packnft_total, opened_count) VALUES
  ('D-NEW',      1000, 250),
  ('D-MOVED',    500,  99),
  ('D-ZERO',     0,    0),
  ('D-NULLTOT',  NULL, 0),
  ('D-UNOPENED', 1000, 0),
  ('D-SAME',     500,  10),
  ('D-WRONGC',   1000, 250);

SELECT _assert_eq(
  public.sync_allday_pack_dist_totals()::text, '3',
  'only the three distributions with real, changed totals are written'
);

SELECT _assert_eq(
  (SELECT total_minted::text || '/' || total_opened::text
     FROM public.pack_distributions WHERE dist_id = 'D-NEW'),
  '1000/250',
  'a first write over NULL totals happens (IS DISTINCT FROM, not <>)'
);

SELECT _assert_eq(
  (SELECT total_opened::text FROM public.pack_distributions WHERE dist_id = 'D-MOVED'),
  '99',
  'a moved opened-count is written'
);

-- ⚠ THE ASSERTION THIS FILE EXISTS FOR, from both sides. A zero or NULL minted
-- total is the indexer saying "not yet", not the chain saying "none" — copying
-- it would publish a depletion percentage computed against a supply of nothing.
SELECT _assert_eq(
  (SELECT total_minted::text || '/' || total_opened::text
     FROM public.pack_distributions WHERE dist_id = 'D-ZERO'),
  '500/10',
  'a ZERO minted total is not indexed yet — the existing totals are kept, not overwritten with 0'
);
SELECT _assert_eq(
  (SELECT total_minted::text || '/' || total_opened::text
     FROM public.pack_distributions WHERE dist_id = 'D-NULLTOT'),
  '500/10',
  'a NULL minted total likewise leaves the existing totals alone'
);

-- ⚠ And the other side of it: zero OPENS is a real state, and must be written.
-- Guarding both columns would freeze every never-ripped pack forever.
SELECT _assert_eq(
  (SELECT total_minted::text || '/' || total_opened::text
     FROM public.pack_distributions WHERE dist_id = 'D-UNOPENED'),
  '1000/0',
  'ZERO OPENS is a real state and IS written — the guard is on minted only'
);

SELECT _assert_eq(
  (SELECT (updated_at = '2026-01-01T00:00:00Z')::text
     FROM public.pack_distributions WHERE dist_id = 'D-SAME'),
  'true',
  'unchanged totals leave updated_at alone'
);

SELECT _assert_eq(
  (SELECT coalesce(total_minted::text,'NULL') FROM public.pack_distributions WHERE dist_id = 'D-WRONGC'),
  'NULL',
  'another collection is never touched, even with matching info rows'
);

ROLLBACK;

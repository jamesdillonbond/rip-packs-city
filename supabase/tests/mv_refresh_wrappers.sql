-- DB invariant: the NINE scheduled materialized-view refresh wrappers.
--
--   fn                                     -> view                              cron
--   refresh_sets_summary                   -> sets_summary                      50 7 * * *
--   refresh_mv_pack_ev_latest              -> mv_pack_ev_latest                 3,33 * * * *
--   refresh_allday_pack_realized           -> mv_allday_pack_realized           35 */6 * * *
--   refresh_allday_pack_sales_agg          -> mv_allday_pack_sales_agg          20 */6 * * *
--   refresh_topshot_pack_sales_agg         -> mv_topshot_pack_sales_agg         50 */6 * * *
--   refresh_topshot_pack_rip_values        -> mv_topshot_pack_rip_values        5 */6 * * *
--   refresh_topshot_edition_median         -> mv_topshot_edition_median_180d    10 */6 * * *
--   refresh_mv_topshot_set_play_catalog    -> mv_topshot_set_play_catalog       52 */3 * * *
--   refresh_topshot_misattrib_candidates   -> mv_topshot_misattrib_candidates   35 15 * * *
--
-- ⚠ WHY NINE NEAR-IDENTICAL ONE-LINERS ARE WORTH A TEST AT ALL. Their bodies are
-- a single statement, so there is no logic to pin — but there are two real
-- invariants, and both live OUTSIDE the function:
--
--   1. ⚠ `CONCURRENTLY` REQUIRES A UNIQUE INDEX ON THE VIEW. Drop that index —
--      a change to a different object entirely, in a different migration, by
--      someone not thinking about these crons — and every one of these jobs
--      starts failing at runtime with `cannot refresh materialized view ...
--      concurrently`. The test below PROVES that coupling rather than asserting
--      it in prose: it drops the index and shows the refresh breaking.
--   2. ⚠ EACH WRAPPER MUST NAME THE VIEW ITS OWN NAME IMPLIES. These were
--      written by copy-paste (five share a body differing only in the view), and
--      a wrapper pointed at the wrong view fails SILENTLY: one view is refreshed
--      twice per cycle and another is never refreshed at all, going quietly
--      stale behind whatever surface reads it. Nothing errors. Pinned by
--      refreshing through each wrapper in turn and checking WHICH view moved.
--
-- ⚠ AND ONE OF THEM IS DELIBERATELY DIFFERENT. `refresh_topshot_misattrib_
-- candidates` does NOT use CONCURRENTLY, and that is not an oversight to
-- "harmonise": it backs an internal candidates MV with no public read path, so
-- the ACCESS EXCLUSIVE lock costs nothing and it does not need the unique index
-- the other eight depend on. Asserted explicitly, in both directions, so a
-- future tidy-up has to make the decision consciously.
--
-- WITHOUT `CONCURRENTLY` a refresh takes an ACCESS EXCLUSIVE lock and blocks
-- every reader of the view for its whole duration. `mv_pack_ev_latest` refreshes
-- twice an hour behind the public pack-EV surface, on an instance CLAUDE.md
-- documents as disk-IO saturated — so that is a user-visible stall, not a
-- theoretical one.
--
-- The function DDL below is VERBATIM from the committed snapshot migration
-- (supabase/migrations/20260816080000_audit_20260816_snapshot_remaining_scheduled_mv_and_rollup_writers.sql),
-- pulled from live prod via pg_get_functiondef on 2026-08-16 — EXCEPT
-- refresh_mv_pack_ev_latest, which 20260830222057 replaced with a watermark
-- gate and which is pinned to THAT migration instead (see §1c).
-- __tests__/db-invariants-drift-guard.test.ts fails CI on drift.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

-- One source table drives every stand-in view, so a refresh is OBSERVABLE: bump
-- the source, refresh through one wrapper, and see which view moved.
CREATE TABLE public.__mv_src (n int);
-- ⚠ TWO rows, and the sentinel -1 never moves. The second row exists so the
-- misattrib wrapper's `count(*)` is 2 rather than 1: with a single row, replacing
-- the count with the constant 1 is unobservable, and that mutation passed.
INSERT INTO public.__mv_src VALUES (1), (-1);

CREATE MATERIALIZED VIEW public.sets_summary AS SELECT max(n) AS n FROM public.__mv_src;
CREATE MATERIALIZED VIEW public.mv_pack_ev_latest AS SELECT max(n) AS n FROM public.__mv_src;
CREATE MATERIALIZED VIEW public.mv_allday_pack_realized AS SELECT max(n) AS n FROM public.__mv_src;
CREATE MATERIALIZED VIEW public.mv_allday_pack_sales_agg AS SELECT max(n) AS n FROM public.__mv_src;
CREATE MATERIALIZED VIEW public.mv_topshot_pack_sales_agg AS SELECT max(n) AS n FROM public.__mv_src;
CREATE MATERIALIZED VIEW public.mv_topshot_pack_rip_values AS SELECT max(n) AS n FROM public.__mv_src;
CREATE MATERIALIZED VIEW public.mv_topshot_edition_median_180d AS SELECT max(n) AS n FROM public.__mv_src;
CREATE MATERIALIZED VIEW public.mv_topshot_set_play_catalog AS SELECT max(n) AS n FROM public.__mv_src;
-- the misattrib stand-in keeps ALL rows, so its row count is a real number
CREATE MATERIALIZED VIEW public.mv_topshot_misattrib_candidates AS SELECT n FROM public.__mv_src;

-- ⚠ The unique index every CONCURRENTLY refresh depends on. The misattrib view
-- deliberately gets none — it is the one wrapper that does not use CONCURRENTLY,
-- and giving it an index would hide that difference.
CREATE UNIQUE INDEX sets_summary_uq ON public.sets_summary (n);
CREATE UNIQUE INDEX mv_pack_ev_latest_uq ON public.mv_pack_ev_latest (n);
CREATE UNIQUE INDEX mv_allday_pack_realized_uq ON public.mv_allday_pack_realized (n);
CREATE UNIQUE INDEX mv_allday_pack_sales_agg_uq ON public.mv_allday_pack_sales_agg (n);
CREATE UNIQUE INDEX mv_topshot_pack_sales_agg_uq ON public.mv_topshot_pack_sales_agg (n);
CREATE UNIQUE INDEX mv_topshot_pack_rip_values_uq ON public.mv_topshot_pack_rip_values (n);
CREATE UNIQUE INDEX mv_topshot_edition_median_180d_uq ON public.mv_topshot_edition_median_180d (n);
CREATE UNIQUE INDEX mv_topshot_set_play_catalog_uq ON public.mv_topshot_set_play_catalog (n);

-- ⚠ FIXTURES FOR THE WATERMARK GATE (added 2026-08-30 with migration
-- 20260830222057). `refresh_mv_pack_ev_latest` is no longer a one-liner: it
-- reads a watermark from `pack_ev_history` and a state row, and SKIPS the
-- refresh when nothing new has landed. Both objects are schema-qualified
-- `public.` inside the function body, so they must exist under those exact
-- names here or the wrapper errors out before it can be tested at all.
--
-- `pack_ev_history` carries one row so `max(snapshotted_at)` is NON-NULL — the
-- production shape. An empty table would make v_hist_max NULL, which fail-opens
-- and would refresh unconditionally, quietly turning every gate assertion below
-- into a test of the empty-table path instead of the real one.
CREATE TABLE public.pack_ev_history (snapshotted_at timestamptz);
INSERT INTO public.pack_ev_history VALUES ('2026-08-30T00:00:00Z');

-- Shape copied from the migration, including the single-row PK/CHECK.
CREATE TABLE public.mv_pack_ev_latest_refresh_state (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  last_seen_snapshot timestamptz,
  refreshed_at timestamptz,
  refreshed_count bigint NOT NULL DEFAULT 0,
  skipped_count bigint NOT NULL DEFAULT 0
);
INSERT INTO public.mv_pack_ev_latest_refresh_state (id) VALUES (true);

-- >>> BEGIN verbatim refresh_sets_summary (byte-identical to the migration/prod) >>>
CREATE OR REPLACE FUNCTION public.refresh_sets_summary()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '300s'
AS $function$
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY sets_summary;
END;
$function$;
-- <<< END verbatim refresh_sets_summary <<<

-- >>> BEGIN verbatim refresh_mv_pack_ev_latest (byte-identical to the migration/prod) >>>
CREATE OR REPLACE FUNCTION public.refresh_mv_pack_ev_latest()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
SET statement_timeout TO '120s'
AS $function$
DECLARE
  v_hist_max timestamptz;
  v_seen timestamptz;
BEGIN
  -- ~1 ms via idx_pack_ev_history_snapshotted_at_desc
  SELECT max(snapshotted_at) INTO v_hist_max FROM public.pack_ev_history;
  SELECT last_seen_snapshot INTO v_seen FROM public.mv_pack_ev_latest_refresh_state WHERE id;
  IF v_hist_max IS NOT NULL AND v_seen IS NOT NULL AND v_hist_max <= v_seen THEN
    -- Nothing new since the last refresh: snapshots land hourly, this job runs
    -- every 30 minutes, so ~half of all ticks take this branch.
    UPDATE public.mv_pack_ev_latest_refresh_state SET skipped_count = skipped_count + 1 WHERE id;
    RETURN;
  END IF;
  REFRESH MATERIALIZED VIEW CONCURRENTLY public.mv_pack_ev_latest;
  UPDATE public.mv_pack_ev_latest_refresh_state
     SET last_seen_snapshot = v_hist_max, refreshed_at = now(), refreshed_count = refreshed_count + 1
   WHERE id;
END;
$function$;
-- <<< END verbatim refresh_mv_pack_ev_latest <<<

-- >>> BEGIN verbatim refresh_allday_pack_realized (byte-identical to the migration/prod) >>>
CREATE OR REPLACE FUNCTION public.refresh_allday_pack_realized()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '600s'
AS $function$
begin
  refresh materialized view concurrently public.mv_allday_pack_realized;
end;
$function$;
-- <<< END verbatim refresh_allday_pack_realized <<<

-- >>> BEGIN verbatim refresh_allday_pack_sales_agg (byte-identical to the migration/prod) >>>
CREATE OR REPLACE FUNCTION public.refresh_allday_pack_sales_agg()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '600s'
AS $function$
begin
  refresh materialized view concurrently public.mv_allday_pack_sales_agg;
end;
$function$;
-- <<< END verbatim refresh_allday_pack_sales_agg <<<

-- >>> BEGIN verbatim refresh_topshot_pack_sales_agg (byte-identical to the migration/prod) >>>
CREATE OR REPLACE FUNCTION public.refresh_topshot_pack_sales_agg()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '600s'
AS $function$
begin
  refresh materialized view concurrently public.mv_topshot_pack_sales_agg;
end;
$function$;
-- <<< END verbatim refresh_topshot_pack_sales_agg <<<

-- >>> BEGIN verbatim refresh_topshot_pack_rip_values (byte-identical to the migration/prod) >>>
CREATE OR REPLACE FUNCTION public.refresh_topshot_pack_rip_values()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '600s'
AS $function$
begin
  refresh materialized view concurrently public.mv_topshot_pack_rip_values;
end;
$function$;
-- <<< END verbatim refresh_topshot_pack_rip_values <<<

-- >>> BEGIN verbatim refresh_topshot_edition_median (byte-identical to the migration/prod) >>>
CREATE OR REPLACE FUNCTION public.refresh_topshot_edition_median()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '600s'
AS $function$
begin
  refresh materialized view concurrently public.mv_topshot_edition_median_180d;
end;
$function$;
-- <<< END verbatim refresh_topshot_edition_median <<<

-- >>> BEGIN verbatim refresh_mv_topshot_set_play_catalog (byte-identical to the migration/prod) >>>
CREATE OR REPLACE FUNCTION public.refresh_mv_topshot_set_play_catalog()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '180s'
AS $function$
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY public.mv_topshot_set_play_catalog;
END;
$function$;
-- <<< END verbatim refresh_mv_topshot_set_play_catalog <<<

-- >>> BEGIN verbatim refresh_topshot_misattrib_candidates (byte-identical to the migration/prod) >>>
CREATE OR REPLACE FUNCTION public.refresh_topshot_misattrib_candidates()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '600s'
AS $function$
DECLARE n integer;
BEGIN
  REFRESH MATERIALIZED VIEW public.mv_topshot_misattrib_candidates;
  SELECT count(*) INTO n FROM public.mv_topshot_misattrib_candidates;
  RETURN n;
END;
$function$;
-- <<< END verbatim refresh_topshot_misattrib_candidates <<<

-- ── 1. Each wrapper refreshes the view its NAME implies ────────────────────
-- ⚠ A copy-paste slip here is SILENT: one view gets refreshed twice a cycle and
-- another never does, going stale behind whatever surface reads it, with nothing
-- logging an error. Each wrapper is driven in turn against a bumped source, and
-- only its own view may move.

UPDATE public.__mv_src SET n = 2 WHERE n <> -1;
SELECT public.refresh_sets_summary();
SELECT _assert_eq(
  (SELECT n::text FROM public.sets_summary), '2',
  'refresh_sets_summary refreshes sets_summary'
);
SELECT _assert_eq(
  (SELECT count(*)::text FROM (SELECT n FROM public.mv_pack_ev_latest UNION ALL SELECT n FROM public.mv_allday_pack_realized UNION ALL SELECT n FROM public.mv_allday_pack_sales_agg UNION ALL SELECT n FROM public.mv_topshot_pack_sales_agg UNION ALL SELECT n FROM public.mv_topshot_pack_rip_values UNION ALL SELECT n FROM public.mv_topshot_edition_median_180d UNION ALL SELECT n FROM public.mv_topshot_set_play_catalog) q WHERE q.n = 2), '0',
  '...and NOTHING else — a wrapper pointed at the wrong view would be silent'
);

UPDATE public.__mv_src SET n = 3 WHERE n <> -1;
-- ⚠ FORCE THE REFRESH BRANCH. Since 20260830222057 this wrapper is gated on a
-- watermark and will SKIP when nothing new has landed — and a skipping wrapper
-- moves no view, so this assertion (and §2's index probe) would be asserting
-- nothing while still reading as coverage. The gate only skips when BOTH sides
-- are non-NULL, so a NULL watermark is the minimal fail-open seed; it needs no
-- pack_ev_history fixture and does not weaken either assertion.
UPDATE public.mv_pack_ev_latest_refresh_state SET last_seen_snapshot = NULL;
SELECT public.refresh_mv_pack_ev_latest();
SELECT _assert_eq(
  (SELECT n::text FROM public.mv_pack_ev_latest), '3',
  'refresh_mv_pack_ev_latest refreshes mv_pack_ev_latest'
);
SELECT _assert_eq(
  (SELECT count(*)::text FROM (SELECT n FROM public.sets_summary UNION ALL SELECT n FROM public.mv_allday_pack_realized UNION ALL SELECT n FROM public.mv_allday_pack_sales_agg UNION ALL SELECT n FROM public.mv_topshot_pack_sales_agg UNION ALL SELECT n FROM public.mv_topshot_pack_rip_values UNION ALL SELECT n FROM public.mv_topshot_edition_median_180d UNION ALL SELECT n FROM public.mv_topshot_set_play_catalog) q WHERE q.n = 3), '0',
  '...and NOTHING else — a wrapper pointed at the wrong view would be silent'
);

UPDATE public.__mv_src SET n = 4 WHERE n <> -1;
SELECT public.refresh_allday_pack_realized();
SELECT _assert_eq(
  (SELECT n::text FROM public.mv_allday_pack_realized), '4',
  'refresh_allday_pack_realized refreshes mv_allday_pack_realized'
);
SELECT _assert_eq(
  (SELECT count(*)::text FROM (SELECT n FROM public.sets_summary UNION ALL SELECT n FROM public.mv_pack_ev_latest UNION ALL SELECT n FROM public.mv_allday_pack_sales_agg UNION ALL SELECT n FROM public.mv_topshot_pack_sales_agg UNION ALL SELECT n FROM public.mv_topshot_pack_rip_values UNION ALL SELECT n FROM public.mv_topshot_edition_median_180d UNION ALL SELECT n FROM public.mv_topshot_set_play_catalog) q WHERE q.n = 4), '0',
  '...and NOTHING else — a wrapper pointed at the wrong view would be silent'
);

UPDATE public.__mv_src SET n = 5 WHERE n <> -1;
SELECT public.refresh_allday_pack_sales_agg();
SELECT _assert_eq(
  (SELECT n::text FROM public.mv_allday_pack_sales_agg), '5',
  'refresh_allday_pack_sales_agg refreshes mv_allday_pack_sales_agg'
);
SELECT _assert_eq(
  (SELECT count(*)::text FROM (SELECT n FROM public.sets_summary UNION ALL SELECT n FROM public.mv_pack_ev_latest UNION ALL SELECT n FROM public.mv_allday_pack_realized UNION ALL SELECT n FROM public.mv_topshot_pack_sales_agg UNION ALL SELECT n FROM public.mv_topshot_pack_rip_values UNION ALL SELECT n FROM public.mv_topshot_edition_median_180d UNION ALL SELECT n FROM public.mv_topshot_set_play_catalog) q WHERE q.n = 5), '0',
  '...and NOTHING else — a wrapper pointed at the wrong view would be silent'
);

UPDATE public.__mv_src SET n = 6 WHERE n <> -1;
SELECT public.refresh_topshot_pack_sales_agg();
SELECT _assert_eq(
  (SELECT n::text FROM public.mv_topshot_pack_sales_agg), '6',
  'refresh_topshot_pack_sales_agg refreshes mv_topshot_pack_sales_agg'
);
SELECT _assert_eq(
  (SELECT count(*)::text FROM (SELECT n FROM public.sets_summary UNION ALL SELECT n FROM public.mv_pack_ev_latest UNION ALL SELECT n FROM public.mv_allday_pack_realized UNION ALL SELECT n FROM public.mv_allday_pack_sales_agg UNION ALL SELECT n FROM public.mv_topshot_pack_rip_values UNION ALL SELECT n FROM public.mv_topshot_edition_median_180d UNION ALL SELECT n FROM public.mv_topshot_set_play_catalog) q WHERE q.n = 6), '0',
  '...and NOTHING else — a wrapper pointed at the wrong view would be silent'
);

UPDATE public.__mv_src SET n = 7 WHERE n <> -1;
SELECT public.refresh_topshot_pack_rip_values();
SELECT _assert_eq(
  (SELECT n::text FROM public.mv_topshot_pack_rip_values), '7',
  'refresh_topshot_pack_rip_values refreshes mv_topshot_pack_rip_values'
);
SELECT _assert_eq(
  (SELECT count(*)::text FROM (SELECT n FROM public.sets_summary UNION ALL SELECT n FROM public.mv_pack_ev_latest UNION ALL SELECT n FROM public.mv_allday_pack_realized UNION ALL SELECT n FROM public.mv_allday_pack_sales_agg UNION ALL SELECT n FROM public.mv_topshot_pack_sales_agg UNION ALL SELECT n FROM public.mv_topshot_edition_median_180d UNION ALL SELECT n FROM public.mv_topshot_set_play_catalog) q WHERE q.n = 7), '0',
  '...and NOTHING else — a wrapper pointed at the wrong view would be silent'
);

UPDATE public.__mv_src SET n = 8 WHERE n <> -1;
SELECT public.refresh_topshot_edition_median();
SELECT _assert_eq(
  (SELECT n::text FROM public.mv_topshot_edition_median_180d), '8',
  'refresh_topshot_edition_median refreshes mv_topshot_edition_median_180d'
);
SELECT _assert_eq(
  (SELECT count(*)::text FROM (SELECT n FROM public.sets_summary UNION ALL SELECT n FROM public.mv_pack_ev_latest UNION ALL SELECT n FROM public.mv_allday_pack_realized UNION ALL SELECT n FROM public.mv_allday_pack_sales_agg UNION ALL SELECT n FROM public.mv_topshot_pack_sales_agg UNION ALL SELECT n FROM public.mv_topshot_pack_rip_values UNION ALL SELECT n FROM public.mv_topshot_set_play_catalog) q WHERE q.n = 8), '0',
  '...and NOTHING else — a wrapper pointed at the wrong view would be silent'
);

UPDATE public.__mv_src SET n = 9 WHERE n <> -1;
SELECT public.refresh_mv_topshot_set_play_catalog();
SELECT _assert_eq(
  (SELECT n::text FROM public.mv_topshot_set_play_catalog), '9',
  'refresh_mv_topshot_set_play_catalog refreshes mv_topshot_set_play_catalog'
);
SELECT _assert_eq(
  (SELECT count(*)::text FROM (SELECT n FROM public.sets_summary UNION ALL SELECT n FROM public.mv_pack_ev_latest UNION ALL SELECT n FROM public.mv_allday_pack_realized UNION ALL SELECT n FROM public.mv_allday_pack_sales_agg UNION ALL SELECT n FROM public.mv_topshot_pack_sales_agg UNION ALL SELECT n FROM public.mv_topshot_pack_rip_values UNION ALL SELECT n FROM public.mv_topshot_edition_median_180d) q WHERE q.n = 9), '0',
  '...and NOTHING else — a wrapper pointed at the wrong view would be silent'
);

-- The non-concurrent one, same property.
UPDATE public.__mv_src SET n = 99 WHERE n <> -1;
SELECT _assert_eq(
  public.refresh_topshot_misattrib_candidates()::text, '2',
  'refresh_topshot_misattrib_candidates refreshes its view and returns its real ROW COUNT'
);
SELECT _assert_eq(
  (SELECT max(n)::text FROM public.mv_topshot_misattrib_candidates), '99',
  '...and it is mv_topshot_misattrib_candidates that moved'
);

-- ── 1c. The watermark GATE's own contract (migration 20260830222057) ───────
-- ⚠ WHY THIS EXISTS. §1 above only proves the wrapper still refreshes when the
-- gate is open, and it is seeded open on purpose — so on its own it would pass
-- just as happily against the pre-gate one-liner. Nothing would then pin the
-- gate itself, and a revert of 20260830222057 would go green through every
-- assertion in this file. The gate's contract is that a second call with no new
-- snapshot SKIPS, and a SKIP is only observable as "the view did NOT move".
--
-- ⚠ The skip must be asserted against a BUMPED source. Calling twice against an
-- unchanged source leaves the view equal either way, so that version of this
-- test passes whether the gate works or not.

UPDATE public.__mv_src SET n = 31 WHERE n <> -1;
UPDATE public.mv_pack_ev_latest_refresh_state
   SET last_seen_snapshot = NULL, refreshed_count = 0, skipped_count = 0;
SELECT public.refresh_mv_pack_ev_latest();
SELECT _assert_eq(
  (SELECT n::text FROM public.mv_pack_ev_latest), '31',
  'gate OPEN (NULL watermark fail-opens): the wrapper refreshes'
);
SELECT _assert_eq(
  (SELECT refreshed_count::text || '/' || skipped_count::text
     FROM public.mv_pack_ev_latest_refresh_state), '1/0',
  '...and it books the call as a REFRESH, not a skip'
);
SELECT _assert_eq(
  (SELECT (last_seen_snapshot = (SELECT max(snapshotted_at) FROM public.pack_ev_history))::text
     FROM public.mv_pack_ev_latest_refresh_state), 'true',
  '...and it adopts the history watermark it just refreshed through'
);

-- The gate is now CLOSED: same watermark, so the next call must skip even though
-- the source moved. If the gate were reverted the view would follow to 32 here.
UPDATE public.__mv_src SET n = 32 WHERE n <> -1;
SELECT public.refresh_mv_pack_ev_latest();
SELECT _assert_eq(
  (SELECT n::text FROM public.mv_pack_ev_latest), '31',
  'gate CLOSED (no new snapshot): the view must NOT move — a revert of the gate fails HERE'
);
SELECT _assert_eq(
  (SELECT refreshed_count::text || '/' || skipped_count::text
     FROM public.mv_pack_ev_latest_refresh_state), '1/1',
  '...and the skip is counted, so a silent no-op is distinguishable from a refresh'
);

-- ...and a genuinely NEW snapshot re-opens it. Without this arm, a gate wedged
-- permanently shut — the failure mode that silently freezes the public pack-EV
-- surface — would pass every assertion above.
INSERT INTO public.pack_ev_history VALUES ('2026-08-30T01:00:00Z');
SELECT public.refresh_mv_pack_ev_latest();
SELECT _assert_eq(
  (SELECT n::text FROM public.mv_pack_ev_latest), '32',
  'a NEW snapshot re-opens the gate — it throttles, it does not wedge'
);
SELECT _assert_eq(
  (SELECT refreshed_count::text || '/' || skipped_count::text
     FROM public.mv_pack_ev_latest_refresh_state), '2/1',
  '...booked as a second refresh'
);

-- ── 1b. CONCURRENTLY is present in EVERY wrapper but the one exception ─────
-- ⚠ Dropping CONCURRENTLY changes nothing OBSERVABLE in a single session — the
-- refresh still works, it just takes an ACCESS EXCLUSIVE lock and blocks every
-- reader for its duration. A rolled-back single-session test cannot see a lock
-- being held, so seven of the eight mutations passed. What IS readable at
-- runtime is the function's own source, via pg_get_functiondef — so the
-- keyword is asserted directly, per function, and in both directions.
SELECT _assert_eq(
  (SELECT coalesce(string_agg(p.proname, ',' ORDER BY p.proname), '')
     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN ('refresh_sets_summary','refresh_mv_pack_ev_latest',
                        'refresh_allday_pack_realized','refresh_allday_pack_sales_agg',
                        'refresh_topshot_pack_sales_agg','refresh_topshot_pack_rip_values',
                        'refresh_topshot_edition_median','refresh_mv_topshot_set_play_catalog')
      AND pg_get_functiondef(p.oid) !~* 'refresh materialized view concurrently'),
  '',
  'all EIGHT public-facing wrappers refresh CONCURRENTLY — without it the refresh blocks every reader'
);

-- ⚠ The exception, asserted as an exception rather than left to inference. It
-- backs an internal candidates MV with no public read path, so the exclusive
-- lock is free and it needs no unique index. A future tidy-up that "harmonises"
-- it has to change this line, i.e. make the decision on purpose.
SELECT _assert_eq(
  (SELECT (pg_get_functiondef(p.oid) ~* 'refresh materialized view concurrently')::text
     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'refresh_topshot_misattrib_candidates'),
  'false',
  'the internal candidates MV deliberately does NOT refresh concurrently'
);

-- ── 2. CONCURRENTLY's hard dependency on a unique index ────────────────────
-- ⚠ THE POINT OF THIS FILE. The index is not part of the function, is not
-- mentioned by it, and can be dropped by a migration touching a different
-- object — after which this cron fails at runtime, forever, with an error that
-- names the view rather than the index. Proven rather than asserted in prose.
-- ⚠ RE-OPEN THE GATE FIRST. §1c deliberately leaves it CLOSED. A skipping
-- wrapper never reaches the REFRESH, so it cannot raise 55000 — this probe
-- would then be asserting that a function which does nothing does nothing, and
-- the CONCURRENTLY/unique-index coupling this whole file exists to prove would
-- be silently untested while still reading as covered.
UPDATE public.mv_pack_ev_latest_refresh_state SET last_seen_snapshot = NULL;

DROP INDEX public.mv_pack_ev_latest_uq;

DO $probe$
BEGIN
  PERFORM public.refresh_mv_pack_ev_latest();
  PERFORM _assert_eq('no error', 'SQLSTATE 55000',
    'dropping the unique index must break the CONCURRENT refresh');
EXCEPTION WHEN OTHERS THEN
  PERFORM _assert_eq(SQLSTATE, '55000',
    'a CONCURRENT refresh without a unique index fails 55000 — the index is a hard dependency');
END $probe$;

-- ⚠ And the mirror: the wrapper that does NOT use CONCURRENTLY is unaffected by
-- having no unique index at all. That is why it can be the one exception.
UPDATE public.__mv_src SET n = 100 WHERE n <> -1;
SELECT _assert_eq(
  public.refresh_topshot_misattrib_candidates()::text, '2',
  'the NON-concurrent wrapper needs no unique index — which is why it is the exception'
);
SELECT _assert_eq(
  (SELECT max(n)::text FROM public.mv_topshot_misattrib_candidates), '100',
  '...and it really did refresh'
);

ROLLBACK;

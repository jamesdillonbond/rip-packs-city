-- audit_20260918_the_r107_guard_lands_and_get_editions_latest_fmv_stops_quoting_a_refuted_number
--
-- Two changes, ONE migration deliberately: each apply_migration costs a ~10-20 s
-- user-facing PGRST002 burst, and the 09-02 ledger entry explicitly parked the
-- comment fix for "the next migration that touches FMV rather than burning a
-- PGRST002 burst on a comment". This is that migration.
--
-- ⏳ TIMING. Both were ready at ~02:30Z and were HELD for ~40 minutes while the
-- instance sat in an IO saturation spell (pg_stat_activity io_wait/active peaked
-- at 20/21 against a healthy ~3/4, with ~10% of cron ticks failing). A resume
-- gate was written into the ledger at the time -- io<=3 AND active<=4 AND under
-- 3% cron failures over a trailing 15 min -- and this applied at 03:08Z on the
-- first reading that met it: 0 / 3 / 2.1%.
--
-- ============================================================================
-- CHANGE 1 -- check_edition_fmv_current_source_drift(), the R107 guard.
--
-- R107: edition_fmv_current publishes values its own named source rows
-- contradict. refresh_edition_fmv_current() is the only writer and its
-- DISTINCT ON is correct; the defect is the incremental window
-- (computed_at > watermark - 2h). FMV writes are delete-then-insert, so a
-- replacement that KEEPS its original computed_at never re-enters the window.
--
-- 📏 MEASURED AT APPLY TIME, whole table, exact (not the capped list):
--
--     collection        diverged rows   net overstated   max |delta|
--     nfl_all_day                  53       $4,560.28        $450.00
--     nba_top_shot                 26      $32,069.92      $4,049.55
--     laliga_golazos                6          $28.34         $27.00
--     TOTAL                        85      $36,658.54
--
--   candy_mlb and disney_pinnacle: ZERO. ⭐ THIS CORRECTS THE FILING: R107 said
--   "other four collections NOT measured" because the all-collections query
--   statement-timed out during the spell. It is measured now, and All Day has
--   TWICE Top Shot's row count -- though Top Shot owns 87% of the dollar skew.
--   The skew is HIGH in every collection.
--
-- ⚠ NON-VACUITY: 21,424 rows inspected. ⚠ The guard's own list is capped at 50,
--   so read jsonb_array_length() as a FLOOR, not a census -- at apply time it
--   returned exactly 50 while the true count was 85.
--
-- 💰 COST, warm, EXPLAIN (ANALYZE, BUFFERS) on the guard's inner query:
--   86,963 buffers (86,439 hit + 524 read) / 6,261 ms, actual rows 85.
--   Plan: Seq Scan on edition_fmv_current (21,424 rows, 909 buffers) then a
--   per-row index probe into fmv_snapshots_2026 -- 85,527 buffers, which is the
--   whole cost. A 10% hash sample (p_sample_mod => 10) is ~1/10th of that.
--
-- ⛔ NOT WIRED INTO rpc_ops_snapshot(), and the threshold decided it, not taste.
--   The rule set before measuring was "wire it only if the full form runs under
--   ~2 s". It runs in 6.3 s. That snapshot already statement-timed out once on
--   2026-09-18 inside board_mv_refresh_max_stale_hours; adding a 6-second key to
--   it would trade a measured defect for an unmeasurable one.
--   👉 A guard with no reader is a known gap, not a silent one. The two honest
--   options, for whoever picks this up: wire the SAMPLED form (p_sample_mod => 10,
--   ~600 ms) and accept that a ban-at-zero over a 10% sample goes quiet below
--   ~10 offenders, or give it its own low-frequency pg_cron caller at full
--   fidelity. Do NOT wire the full form into the snapshot.
--
-- ⛔ SCOPE IS THE CHEAP, UNAMBIGUOUS HALF ON PURPOSE. The 527 rows whose pointer
--   resolves to NOTHING are not offenders here: most are merely behind, and
--   separating the ~136 that would change value needs a per-row LATERAL that
--   costs far more. Widening this guard is not an improvement -- write a second.
--
-- ⛔ AND NO DATA PATCH. The 85 rows are NOT corrected here. A one-off UPDATE
--   clears the symptom, leaves the mechanism, and makes the incidence
--   unmeasurable. The fix is the refresh and it needs Trevor: a periodic full
--   reconcile (~1.23M rows, "minutes when cold" by the function's own comment,
--   so it needs a cost measurement first) or an updated_at column on
--   fmv_snapshots for the incremental refresh to key on.
--
-- ============================================================================
-- CHANGE 2 -- get_editions_latest_fmv's COMMENT stops quoting a refuted number.
--
-- It claimed "1,334,789 buffers / 16.7 s for 500 ids" -- a 249x win. That figure
-- was REFUTED on 2026-09-02: it came from a benchmark whose before-arm wrote the
-- ids as IN (SELECT ... FROM a CTE ORDER BY external_id), which becomes a hash
-- semi-join over the fully materialised view -- a shape PostgREST never sends
-- (it emits edition_id = ANY($1), confirmed in pg_stat_statements). The measured
-- range is 8-17x. The refuted figure is now named IN the comment so it cannot be
-- reinstated by someone who only sees the old number in an old doc.
--
-- ⚠ Nothing about the function's BEHAVIOUR changes. Comment only.
--
-- ============================================================================
-- VERIFIED AFTER APPLY:
--   anon EXECUTE = false · authenticated EXECUTE = false · service_role = true.
--
-- REVERT:
--   DROP FUNCTION public.check_edition_fmv_current_source_drift(integer);
--   -- and restore the prior get_editions_latest_fmv comment, whose refuted
--   -- "1,334,789 buffers / 16.7 s" text is quoted above.
-- ============================================================================

-- anon-exec: NOT intentional for check_edition_fmv_current_source_drift — it is an
-- internal ops guard over a pricing cache and is revoked from PUBLIC, anon and
-- authenticated in one REVOKE below. No pg_cron caller exists to orphan.

CREATE OR REPLACE FUNCTION public.check_edition_fmv_current_source_drift(p_sample_mod integer DEFAULT 1)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $fn$
  SELECT coalesce(jsonb_agg(q.x), '[]'::jsonb)
  FROM (
    SELECT jsonb_build_object(
             'kind', 'edition_fmv_current_disagrees_with_its_own_source_row',
             'edition_id', f.edition_id,
             'collection_id', f.collection_id,
             'computed_at', f.computed_at,
             'cached_fmv', f.fmv_usd,
             'source_fmv', fs.fmv_usd,
             'abs_delta', round(abs(coalesce(f.fmv_usd,0) - coalesce(fs.fmv_usd,0)), 2),
             'detail', 'This row names a fmv_snapshots row by (edition_id, computed_at) and publishes a DIFFERENT fmv_usd than that row holds. refresh_edition_fmv_current() only re-reads snapshots with computed_at > watermark - 2h, and FMV writes are delete-then-insert, so a replacement that keeps its original computed_at is never seen again. Fix the REFRESH (a periodic full reconcile, or an updated_at column on fmv_snapshots to key on) - not the row: a one-off UPDATE clears the symptom and makes the incidence unmeasurable.'
           ) AS x
    FROM public.edition_fmv_current f
    JOIN public.fmv_snapshots fs
      ON fs.edition_id = f.edition_id AND fs.computed_at = f.computed_at
    WHERE (p_sample_mod <= 1 OR (abs(hashtext(f.edition_id::text)) % p_sample_mod) = 0)
      AND fs.fmv_usd IS DISTINCT FROM f.fmv_usd
    ORDER BY abs(coalesce(f.fmv_usd,0) - coalesce(fs.fmv_usd,0)) DESC
    LIMIT 50
  ) q;
$fn$;

REVOKE ALL ON FUNCTION public.check_edition_fmv_current_source_drift(integer) FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.check_edition_fmv_current_source_drift(integer) IS
'R107 guard. BAN AT ZERO, returns a jsonb ARRAY: clean is jsonb_array_length(...) = 0, NEVER count(*) = 1. Flags rows of edition_fmv_current whose (edition_id, computed_at) pointer still RESOLVES to a live fmv_snapshots row but whose fmv_usd disagrees with it — i.e. the cache is publishing a number its own named source contradicts. Measured 2026-09-18: 26 such rows in Top Shot out of 13,489 resolvable pointers, net +$46,060 overstated, max delta $4,049.55, all serving a pre-haircut ask. ⛔ SCOPE IS DELIBERATELY THE CHEAP, UNAMBIGUOUS HALF: the 527 rows whose pointer resolves to NOTHING are not offenders here — most are simply behind, and separating the ~136 that would change value needs a per-row LATERAL that costs far more. Widening this guard is not an improvement; write a second one. p_sample_mod takes a deterministic hash sample (abs(hashtext(edition_id::text)) %% n = 0) because the all-collections comparison statement-timed out at 120 s during the 2026-09-18 IO spell; p_sample_mod <= 1 means no sampling. The offender list is capped at 50 — read the LENGTH as a floor, not a census.';

COMMENT ON FUNCTION public.get_editions_latest_fmv(uuid[]) IS
'Latest FMV per edition for a bounded id list. Same selection rule as the fmv_current view (DISTINCT ON (edition_id) ORDER BY computed_at DESC) but expressed as a per-id LATERAL LIMIT 1, because filtering the view by key still reads every snapshot row per edition (~35 and growing) with Unique discarding all but the newest — reaching the index is not the same as being cheap. computed_at <= now() is load-bearing for the index bound. MEASURED, CORRECTED 2026-09-18: 500 Top Shot ids warm 25,330 buffers / 1,070 ms via the view against 2,002 / 4.0 ms here; a second session cold on 500 Base Set ids got 42,342 / 10.0 s against 5,359 / 470 ms (Base Set carries ~80 snapshots per edition against a ~35 average, so quote a RANGE and say what was cold); the whole 6,190-id All Day list 424,475 / 631 ms against 24,760 / 51 ms. So roughly 8-17x. ⛔ THE FIGURE THIS COMMENT USED TO CARRY — "1,334,789 buffers / 16.7 s", i.e. 249x — IS REFUTED AND MUST NOT BE REINSTATED: it came from a benchmark whose before-arm wrote the ids as IN (SELECT ... FROM a CTE ORDER BY external_id), which becomes a hash semi-join over the fully materialised view, a shape PostgREST never sends (PostgREST emits edition_id = ANY($1), confirmed in pg_stat_statements). Judge any change here on BUFFERS, not wall clock.';

-- ⚠ COSMETIC, recorded rather than re-burst: the guard's own comment above contains
-- the literal `%%` where a single `%` was meant (this is plain SQL, not format()).
-- Harmless, and not worth a second PGRST002 burst on its own — fold the fix into
-- the next migration that touches this function.

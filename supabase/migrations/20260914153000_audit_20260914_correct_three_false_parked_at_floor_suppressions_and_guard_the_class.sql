-- ─────────────────────────────────────────────────────────────────────────────
-- Three pipeline_alert_suppression rows say a cursor is "parked at the spork
-- floor" when it is NOT, and one of the three is a PERMANENT grant on a cursor
-- that moved 2h40m ago. Register #102 part (b). Re-derived live 2026-09-14
-- ~08:1x AM PT; every number below is a measurement, not a copy.
--
--   pipeline                      claimed floor   live cursor      verdict
--   golazos_sales_v1_backfill     137,390,146     142,481,736      +5,091,590 and STILL WALKING
--   ufc_sales_v1_backfill         137,390,146     147,644,766      +10,254,620, lane RETIRED 08-27
--   allday_pack_opens_backfill     65,264,619      83,276,329      +18,011,710, lane UNSCHEDULED 09-04
--
-- FIVE CONTROLS CHECK OUT EXACTLY, which is what makes the three real:
--   allday_sales_v1_backfill / pinnacle_sales_backfill / pinnacle_trades_backfill
--   / topshot_flowty_backfill  all sit at 137,390,146 exactly, and
--   topshot_pack_opens_history_backfill claims parked BELOW 65,264,619 and sits
--   at 61,808,846 — below it. A sixth row (ufc_sales) mentions the floor only as
--   prose ABOUT ANOTHER PIPELINE and is correctly out of scope (see the guard).
--
-- WHY IT MATTERS: get_pipeline_alerts_core() drops every id in an active
-- suppression from the cursor_stalled arm (threshold public.cursor_stall_threshold()
-- = 6 h). A PERMANENT grant justified by a terminal state that has not happened
-- makes a genuine stall on a LIVE lane invisible forever.
--
-- THIS MIGRATION DOES THREE THINGS:
--   1. backs up the three reasons + expiries (revert path),
--   2. rewrites the three reasons to the measured truth and BOUNDS the golazos
--      row (2026-10-15) instead of leaving it permanent,
--   3. installs check_suppression_parked_claim_drift(), a ban-at-zero guard so
--      the class cannot recur silently.
--
-- ⚠ NOT a behaviour change for the other 34 suppression rows: no row is added,
-- deleted, re-activated, or re-scoped except golazos_sales_v1_backfill, whose
-- expires_at goes NULL -> 2026-10-15. Text-only for the other two.
-- ─────────────────────────────────────────────────────────────────────────────

-- 1 ── revert path ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.audit_20260914_suppression_reason_backup (
  pipeline       text PRIMARY KEY,
  old_reason     text NOT NULL,
  old_expires_at timestamptz,
  backed_up_at   timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.audit_20260914_suppression_reason_backup ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.audit_20260914_suppression_reason_backup FROM PUBLIC, anon, authenticated;

INSERT INTO public.audit_20260914_suppression_reason_backup (pipeline, old_reason, old_expires_at)
SELECT pipeline, reason, expires_at
  FROM public.pipeline_alert_suppression
 WHERE pipeline IN ('golazos_sales_v1_backfill', 'ufc_sales_v1_backfill', 'allday_pack_opens_backfill')
ON CONFLICT (pipeline) DO NOTHING;

COMMENT ON TABLE public.audit_20260914_suppression_reason_backup IS
  'Verbatim pipeline_alert_suppression.reason + expires_at for the three rows whose '
  '"parked at the spork floor" claim was measured false on 2026-09-14 (register #102b). '
  'REVERT: UPDATE public.pipeline_alert_suppression s SET reason = b.old_reason, '
  'expires_at = b.old_expires_at FROM public.audit_20260914_suppression_reason_backup b '
  'WHERE b.pipeline = s.pipeline;';

-- 2 ── the three corrections ──────────────────────────────────────────────────

-- 2a. golazos_sales_v1_backfill — the live one. Bounded, not permanent.
UPDATE public.pipeline_alert_suppression
   SET expires_at = '2026-10-15 00:00:00+00'::timestamptz,
       reason = 'NOT parked — this cursor is STILL WALKING, and the row is now BOUNDED because of it. '
         || 'CORRECTED 2026-09-14 ~08:20 AM PT: the previous text claimed this cursor was parked at the spork retention floor and could not advance, '
         || 'which was false by 5,091,590 blocks and ~16 days of walking, and it was PERMANENT, so a genuine stall on a live lane would never have surfaced. '
         || 'MEASURED LIVE, not inferred: event_cursor.last_processed_block = 142,481,736 updated 2026-09-14 12:34:57Z (2h40m before this write), and the three most recent ticks each scanned a fresh 40,000-block band DOWNWARD '
         || '(142,561,736-142,601,735, then 142,521,736-142,561,735, then 142,481,736-142,521,735) with below_floor=false. '
         || 'The parent lane is healthy: 24 runs / 24 ok over the full ~73h pipeline_runs retention, 8 ticks/day = 320,000 blocks/day. '
         || 'So the floor 137,390,146 is 5,091,590 blocks out, ~15.9 days, ETA ~2026-09-30. Route constants: CEILING_INIT 148,721,736, SPORK_FLOOR_HINT 137,390,146, SCAN_RANGE 40,000 (app/api/cron/golazos-sales-history-backfill/route.ts). '
         || 'WHY THE CURSOR IS 5.09M BLOCKS ABOVE WHERE IT WAS ON 2026-07-31 (this row was added that day citing a tick that scanned 137,441,736-137,481,735, about one tick from the floor): the walk was REWOUND to CEILING_INIT and is re-walking. '
         || 'That is the exact defect fixed in main ee90eb54c (2026-09-02) — a failed cursor read fell through with ceiling still at CEILING_INIT and upserted a high block back over the real cursor, silently, at ok:true. '
         || 'That commit asked "did it fire?" and answered "no evidence within retention, and retention is the caveat". THIS IS THE EVIDENCE OUTSIDE IT: 148,721,736 - 142,481,736 = 6,240,000 blocks = 156 ticks = 19.5 days at 8 ticks/day, dating the rewind to ~2026-08-26, about a week before the fix. '
         || 'The UFC twin carries the same fingerprint independently (see the ufc_sales_v1_backfill row). '
         || 'STATED AS THE BEST-SUPPORTED EXPLANATION, NOT A CERTAINTY: a manual cursor reset would look identical, and no migration or ledger entry records one. Post-fix the cursor can only descend — the ?ceiling= override is dryRun-only and dryRun does not write the cursor. '
         || 'WHY THE ROW IS KEPT RATHER THAN DELETED: the walk really will terminate at the floor ~2026-09-30 and cursor_stalled becomes the genuine terminal state then; deleting today would page HIGH from that date with nobody having decided anything. '
         || 'BOUNDED 2026-10-15 rather than permanent because a terminal-state grant must not outlive the terminal state it claims. '
         || 'RESIDUAL RISK, accepted and named: while this row is live, a lane that keeps RUNNING and SUCCEEDING but stops ADVANCING the cursor is invisible to the cursor_stalled arm. It is not invisible to everything — pipeline_cadence_watchlist row golazos-sales-history-backfill (is_active=true, 600 min, medium) catches a total stop, and the failure_rate arm keys on the HYPHENATED pipeline name and is unaffected by this underscored cursor-keyed row. '
         || 'ON LAPSE 2026-10-15, RE-DERIVE RATHER THAN RENEW: if last_processed_block = 137,390,146 the walk finished — make this row permanent with a reason that says so. If it is still above the floor, the walk stalled or rewound again and THAT is the finding. '
         || 'Revert: UPDATE from public.audit_20260914_suppression_reason_backup (old reason + old NULL expiry), or DELETE FROM public.pipeline_alert_suppression WHERE pipeline = ''golazos_sales_v1_backfill'';'
 WHERE pipeline = 'golazos_sales_v1_backfill';

-- 2b. ufc_sales_v1_backfill — stays PERMANENT, but for the real reason.
UPDATE public.pipeline_alert_suppression
   SET reason = 'Terminal because the lane was RETIRED, not because it reached a floor. '
         || 'CORRECTED 2026-09-14 ~08:20 AM PT: the previous text claimed this cursor was parked at the spork retention floor, and a reader acting on it would have concluded the V1 walk COMPLETED. It did not. '
         || 'MEASURED LIVE: event_cursor.last_processed_block = 147,644,766, frozen 2026-08-27 03:49:20Z — 10,254,620 blocks ABOVE the floor 137,390,146. The walk covered about 10.2% of its 11,414,620-block span (CEILING_INIT 148,804,766, app/api/cron/ufc-sales-history-backfill/route.ts) and stopped there. '
         || 'TRUE CAUSE, read from the repo rather than inferred: the "UFC Sales Indexer" step was REMOVED from .github/workflows/sales-indexers-backstop.yml on 2026-08-27 on Trevor''s call, and that workflow was measured to be the LAST live trigger for the route (cron-job.org /api/ufc-pipeline already dead). '
         || 'The pipeline_cadence_watchlist rows for ufc-sales-indexer, ufc-sales-history-backfill and ufc-studio-sales-history-backfill were set is_active=false in the same action — all three read false today. '
         || 'pipeline_runs holds ZERO ufc-sales-history-backfill rows over its full ~73h retention, and the newest pipeline_runs_daily row for it is 2026-08-27 (2 runs). So the cursor freeze IS the retirement. '
         || 'PERMANENT IS STILL THE RIGHT CONCLUSION — the lane has no caller at all, so an un-suppressed arm would be permanently red — but the COVERAGE CLAIM changes and is disclosed rather than hidden: blocks 137,390,146 -> 147,644,766 of UFC V1 secondary history were never scanned. '
         || 'The retirement measured the expected yield first: ufc-sales-history-backfill ran 222x/30d writing 0 rows (57 found, all already held), ufc-sales-indexer 672x/30d writing 0, newest ufc_strike sale 2026-05-13. So the unscanned band is EXPECTED empty, not KNOWN empty. Treat UFC secondary volume as a FLOOR, not a census. '
         || 'SECOND REWIND FINGERPRINT, same class as the golazos twin: on 2026-07-31 this lane was scanning 137,444,766-137,484,765, about one tick from the floor; it is now 10.25M blocks higher. 148,804,766 - 147,644,766 = 1,160,000 = 29 ticks = ~3.6 days at 8 ticks/day, dating a rewind to ~2026-08-23, before the ee90eb54c fix (2026-09-02). Two lanes, two dates, one mechanism. '
         || 'IF UFC-ON-FLOW REVIVES: the revival detector installed 2026-08-08 (20260808160000) breaches on the first sale with sold_at inside 30 days; re-look at this row, the three watchlist rows and the backstop step together, and only then decide whether the unscanned band is worth walking. '
         || 'Revert: UPDATE from public.audit_20260914_suppression_reason_backup, or DELETE FROM public.pipeline_alert_suppression WHERE pipeline = ''ufc_sales_v1_backfill'';'
 WHERE pipeline = 'ufc_sales_v1_backfill';

-- 2c. allday_pack_opens_backfill — headline sentence only. The rest of that
--     reason (the spork-host measurements, the 09-13 watchlist correction) is
--     accurate and is left VERBATIM; replacing the whole text would discard it.
UPDATE public.pipeline_alert_suppression
   SET reason = replace(
         reason,
         'Terminal state at the RAISED spork floor 65,264,619 (mainnet24 root, 2023-11-08).',
         'Terminal because the lane has NO CALLER since 2026-09-04, not because it reached its floor. '
         || 'CORRECTED 2026-09-14 ~08:20 AM PT — the sentence that stood here claimed a terminal state at the RAISED spork floor, and the cursor is 18,011,710 blocks ABOVE that floor (83,276,329 vs 65,264,619), frozen 2026-09-04 04:56:25Z. '
         || 'The walk did not finish; it was stopped. pg_cron jobid 55 was unscheduled and the pipeline_cadence_watchlist row retired on 2026-09-04 because 25 of 25 ticks in four hours died at the pg_net 90 s wall and head-of-line blocked every other pg_net request on the platform (revert: audit_20260904_jobid55_watchlist_retire_backup). '
         || 'The floor raise below is still true and still the reason the remaining walk is NOT worth restarting on public Flow infrastructure — but the terminal state is the retirement, and the unscanned band 65,264,619 -> 83,276,329 is a DISCLOSED COVERAGE LIMIT rather than history that was checked and found empty.'
       )
 WHERE pipeline = 'allday_pack_opens_backfill'
   AND position('Terminal state at the RAISED spork floor 65,264,619 (mainnet24 root, 2023-11-08).' in reason) > 0;

-- 3 ── the guard ──────────────────────────────────────────────────────────────
--
-- BAN AT ZERO over the WHOLE table — a tree walk, not a curated list, so a row
-- added tomorrow is inspected without anyone remembering to add it here.
--
-- ⚠ THE POPULATION IS THE ROW''S OWN HEADLINE CLAIM, and getting that wrong was
-- the first draft''s bug. A suppression reason routinely quotes its own older
-- text and describes OTHER pipelines: an unanchored regex read
-- allday_pack_opens_backfill''s claim out of a QUOTATION of the text it was
-- correcting (wrong floor, so the real violation went UNSEEN), and flagged
-- ufc_sales, whose reason merely mentions that ufc-sales-history-backfill is
-- parked at the floor — prose about a different lane. Anchoring to the first
-- 200 characters, which is the row''s own headline sentence, fixes both:
-- verified live 2026-09-14 that it inspects 8 rows, flags exactly the 3 above,
-- and leaves 5 clean controls (including one whose claim is BELOW its floor).
--
-- ⚠ WHAT THIS GUARD IS STRUCTURALLY SILENT ABOUT, stated rather than discovered
-- later: it reads a PHRASING. A future reason that says "sitting at the floor"
-- or names no number is not inspected at all. It is a ratchet on the phrasing
-- family that produced every instance so far, not a proof that every suppression
-- is honest.
CREATE OR REPLACE FUNCTION public.check_suppression_parked_claim_drift()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_out jsonb := '[]'::jsonb;
BEGIN
  SELECT COALESCE(jsonb_agg(v ORDER BY v->>'pipeline'), '[]'::jsonb)
    INTO v_out
  FROM (
    SELECT jsonb_build_object(
             'kind', CASE
                       WHEN q.claimed_floor IS NOT NULL AND q.last_processed_block > q.claimed_floor
                         THEN 'cursor_above_claimed_floor'
                       ELSE 'permanent_terminal_claim_on_a_live_cursor'
                     END,
             'pipeline', q.pipeline,
             'claimed_floor', q.claimed_floor,
             'cursor_block', q.last_processed_block,
             'cursor_updated_at', q.updated_at,
             'expires_at', q.expires_at,
             'detail',
               CASE
                 WHEN q.claimed_floor IS NOT NULL AND q.last_processed_block > q.claimed_floor
                   THEN 'The suppression reason opens by claiming this cursor is parked at or below block '
                        || q.claimed_floor || ', but it sits at ' || q.last_processed_block || ' — '
                        || (q.last_processed_block - q.claimed_floor)
                        || ' blocks ABOVE it. The terminal state that justifies the row has not happened, '
                        || 'so the cursor_stalled arm is being waived on a claim that is not true yet.'
                 ELSE 'A PERMANENT (expires_at IS NULL) terminal-state suppression on a cursor that moved '
                        || 'within the last 24 hours. A grant with no expiry outlives nothing; if the lane is '
                        || 'still walking, a genuine stall on it can never surface.'
               END
           ) AS v
      FROM (
        SELECT s.pipeline,
               s.expires_at,
               s.reason,
               c.last_processed_block,
               c.updated_at,
               NULLIF(
                 replace(
                   COALESCE(
                     (regexp_match(
                        left(s.reason, 200),
                        '(?:parked|terminal state)[[:space:]]+(?:at|below)[^0-9]{0,80}floor[[:space:]]+([0-9][0-9,]*)',
                        'i'
                      ))[1],
                     ''
                   ),
                   ',', ''
                 ),
                 ''
               )::bigint AS claimed_floor
          FROM public.pipeline_alert_suppression s
          JOIN public.event_cursor c ON c.id = s.pipeline
         WHERE s.expires_at IS NULL OR s.expires_at > now()
      ) q
     WHERE (q.claimed_floor IS NOT NULL AND q.last_processed_block > q.claimed_floor)
        OR (
             q.expires_at IS NULL
         AND q.reason ~* '(terminal state|structurally cannot advance|parked)'
         AND q.updated_at > now() - interval '24 hours'
         AND NOT (q.claimed_floor IS NOT NULL AND q.last_processed_block <= q.claimed_floor)
           )
  ) t;

  RETURN v_out;
END;
$function$;

-- anon-exec: NOT intentional — ops-only guard, revoked below (check_suppression_parked_claim_drift)
REVOKE EXECUTE ON FUNCTION public.check_suppression_parked_claim_drift() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.check_suppression_parked_claim_drift() TO service_role;

COMMENT ON FUNCTION public.check_suppression_parked_claim_drift() IS
  'Ban at zero: a pipeline_alert_suppression row whose HEADLINE sentence claims its cursor is parked '
  'at/below block N must not have a cursor ABOVE N, and a PERMANENT terminal-state grant must not sit '
  'on a cursor that moved in the last 24 h. Returns a jsonb ARRAY — clean is jsonb_array_length() = 0, '
  'NOT count(*) = 1. POPULATION AT INSTALL (2026-09-14): 16 cursor-keyed suppression rows, 8 of them '
  'carrying a headline floor claim, 3 violating, 5 clean controls; after this migration, 0 violations. '
  'Blind spot, by construction: it reads a phrasing, so a claim worded differently is not inspected.';

-- 4 ── verification, in the same transaction ──────────────────────────────────
DO $verify$
DECLARE
  v_violations jsonb;
  v_pop        int;
  v_golazos    timestamptz;
BEGIN
  SELECT count(*) INTO v_pop
    FROM public.pipeline_alert_suppression s
    JOIN public.event_cursor c ON c.id = s.pipeline
   WHERE (regexp_match(left(s.reason, 200),
            '(?:parked|terminal state)[[:space:]]+(?:at|below)[^0-9]{0,80}floor[[:space:]]+([0-9][0-9,]*)',
            'i'))[1] IS NOT NULL;

  -- ⚠ Assert the count the guard INSPECTED, not only that it passed. The three
  -- corrected rows leave the population honestly (they no longer make a floor
  -- claim), so 8 - 3 = 5 must remain. A 0 here would mean the guard went blind.
  IF v_pop <> 5 THEN
    RAISE EXCEPTION 'floor-claim population is %, expected 5 after the three corrections', v_pop;
  END IF;

  v_violations := public.check_suppression_parked_claim_drift();
  IF jsonb_array_length(v_violations) <> 0 THEN
    RAISE EXCEPTION 'guard is not clean after the corrections: %', v_violations::text;
  END IF;

  SELECT expires_at INTO v_golazos
    FROM public.pipeline_alert_suppression WHERE pipeline = 'golazos_sales_v1_backfill';
  IF v_golazos IS NULL THEN
    RAISE EXCEPTION 'golazos_sales_v1_backfill is still a PERMANENT suppression';
  END IF;

  IF (SELECT count(*) FROM public.audit_20260914_suppression_reason_backup) <> 3 THEN
    RAISE EXCEPTION 'revert path incomplete: backup table does not hold all three rows';
  END IF;
END
$verify$;

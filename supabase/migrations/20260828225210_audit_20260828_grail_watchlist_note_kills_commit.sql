-- APPLIED LIVE 2026-08-28 22:52:10Z from Cowork (cloud, NO-PUSH session). COMMIT ONLY — DO NOT RE-APPLY.
-- Version recorded by apply_migration: 20260828225210
--
-- Record the 2026-08-28 commit-control result on the grail-MV watchlist note, so the next reader
-- does not re-derive it. Guarded: anchors on the pipeline KEY (not a bare substring), idempotent
-- via the NOT LIKE clause, and RAISEs unless it matches exactly one row.
--
-- ⚠ REPRODUCED VERBATIM AS APPLIED. It contains the placeholder string "22:5xZ", which I failed to
--   fill in. Migrations 20260828225243 and 20260828225258 correct it (to 22:53Z, then to the exact
--   22:52Z). Replay all four in order; do not "tidy" this one, or the two fixups will no-op and the
--   register will disagree with the note.
--
-- REVERT:
--   UPDATE public.pipeline_cadence_watchlist w SET notes = b.notes
--     FROM public.audit_20260828_grail_watchlist_note_backup b
--    WHERE w.pipeline = b.pipeline;
--   DROP TABLE public.audit_20260828_grail_watchlist_note_backup;

DO $$
DECLARE n int;
BEGIN
  UPDATE public.pipeline_cadence_watchlist
     SET notes = notes || E'\n\n'
       || '⭐ 2026-08-28 22:5xZ — KILLED TICKS COMMIT. MEASURED, n=2, WITH A POSITIVE CONTROL. '
       || 'public.audit_20260828_grail_mv_commit_control (jobid 375, samples :21/:27/:33) bracketed '
       || 'two killed ticks — 20:23:06Z and 22:23:06Z, each with a heartbeat row present and the '
       || 'terminal row ABSENT — and n_tup_ins/n_tup_del moved +1059 and +624 across them. The '
       || 'SURVIVING 21:23:05Z tick between them moved the same counters +733. Every (:33 -> next '
       || ':21) no-change control interval read 0, and last_autoanalyze advanced after each tick '
       || '(20:25:16Z / 21:23:19Z / 22:25:23Z). Only a REFRESH writes those counters on a matview. '
       || E'\n'
       || '⛔ THEREFORE the ~41% missing-terminal-row rate is LOGGING ONLY. The REFRESH ... '
       || 'CONCURRENTLY completes and COMMITs server-side after the lambda is killed, so the public '
       || 'grail-hunter ranking is NOT stale. DO NOT PAGE ON THE 41%, and do not describe this '
       || 'pipeline as losing data. The queued route change (maxDuration 60 -> 240, matching sibling '
       || 'refresh-special-serial-owners-mv) is ROBUSTNESS AND OBSERVABILITY, not a freshness fix.'
       || E'\n'
       || '⚠ n=2. This says the refresh survived the caller''s death on two occasions; it does NOT '
       || 'prove a kill can never truncate one. The instrument samples until 2026-08-31 12:00Z — '
       || 're-read it for further bracketed kills before promoting this to a rule.'
       || E'\n'
       || '⚠ duration_ms_max on this pipeline is a SURVIVORSHIP ARTIFACT (ten days at 47.9-57.6 s '
       || 'against a 60 s ceiling is the truncation point, not the job''s cost); surviving-run p50 is '
       || '14.2 s. And ok_count = runs in pipeline_runs_daily on every day this job was being killed '
       || '— the rollup reads 100% success throughout. Classify kills by cross-referencing the '
       || '-heartbeat rows against the terminal ones; never read either alone.'
       || E'\n'
       || 'ⓘ Outcome alternated perfectly by hour parity 8/8 on 2026-08-28 (15 ok, 16 KILL, 17 ok, '
       || '18 KILL, 19 ok, 20 KILL, 21 ok, 22 KILL). ⛔ Do NOT conclude "even hours die" — the '
       || 'nine-day terminal-row counts (8-18 of 24) are arithmetically incompatible with a strict '
       || 'even-hour rule, which forces exactly 12/24. FALSIFIER: if the alternation still holds '
       || 'after a further 24 h the cause is a deterministic even-hour contender findable in '
       || 'cron.job; if it breaks, drop the idea.'
       || E'\n'
       || 'Prior note text preserved verbatim in public.audit_20260828_grail_watchlist_note_backup.'
   WHERE pipeline = 'refresh-pack-grail-metrics-mv'
     AND notes NOT LIKE '%KILLED TICKS COMMIT%';

  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN
    RAISE EXCEPTION 'guarded splice matched % rows, expected exactly 1 (already applied, or the pipeline key moved)', n;
  END IF;
END $$;

-- POST-FLIGHT, verified from OUTSIDE the migration:
--   note length 115 -> 2370 · marker present · exactly ONE row in pipeline_cadence_watchlist
--   carries the marker · backup row intact at 115 chars · check_secdef_anon_execute_violations() = []

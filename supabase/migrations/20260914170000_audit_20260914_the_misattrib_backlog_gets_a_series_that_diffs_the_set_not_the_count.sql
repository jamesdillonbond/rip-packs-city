-- ─────────────────────────────────────────────────────────────────────────────
-- Register #101's headline number has never been instrumented, and the two
-- rates in circulation disagree by 2.4×.
--
--   #101 records the accumulation as ~117/day (derived from 905 rows over
--   ~7.75 days). The Cowork filing `inbox/2026-09-14T1514Z-…` measured
--   1,315 -> 1,364 = +49 in one day. Nothing can adjudicate: rpc_trust_health_history
--   holds no misattrib metric at all, and `mv_topshot_misattrib_candidates` is a
--   MATERIALIZED view refreshed once a day (jobid 70, `35 23 * * *`), so a
--   re-read inside a day returns the same snapshot and one delta of it is not a rate.
--
-- ⭐ AND A COUNT SERIES ALONE WOULD NOT SETTLE IT EITHER, which is why this
-- table stores a SET DIFF. Re-derived live 2026-09-14 ~09:0x AM PT:
--
--     date        candidates   open    mapped
--     2026-09-05     20,128      410   19,718     (#101's baseline)
--     2026-09-12     18,959    1,315   17,644     (the 09-13 filing's snapshot)
--     2026-09-13     18,254    1,364   16,890     (LIVE today — the MV's newest)
--
-- **The open pile grew 49 while the candidate set SHRANK 705 and the mapped
-- count fell 754.** A pile that moves +49 while its own denominator turns over
-- by 705 is not described by "+49/day of inflow" at all — this is CLAUDE.md's
-- *"Diff the SET, not the count: a total can hold while membership turns over
-- twice"*, and nothing here could see it.
--
-- ⚠ IT ALSO CORRECTS A FIGURE IN CIRCULATION TODAY. Both of today's readings
-- quote **18,959** candidates; the live MV holds **18,254**. The open count
-- (1,364) was re-measured and agrees; the DENOMINATOR was carried forward from
-- the 09-13 text. Re-measure both halves of a ratio, never one.
--
-- ⛔ THIS IS NOT AN ALARM AND MUST NOT BECOME ONE. #101 is DECIDED — *"ACCEPT
-- THE BACKLOG; DO NOT WRITE MOMENTS-DERIVED ROWS"* — because the write's real
-- effect is −12 sales rows, every one a parallel→base downgrade (#110), and the
-- ~0.2% source error is irreducible (`moments` and `topshot_moment_subeditions`
-- share their errors). The `topshot-misattrib-drain` suppression stays exactly
-- as it is. An arm on this count would be permanently red for a lane with no
-- caller — the mistake #102 nearly caused. **This records; it does not page.**
--
-- ⚠ IT CANNOT RECONSTRUCT THE PAST. The three rows above are seeded as recorded
-- history and marked as such in `note`; every later row is measured. The set
-- diff is NULL until there are two consecutive snapshots — a NULL, never a 0,
-- because "no prior snapshot" and "nothing entered" are different facts.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.topshot_misattrib_backlog_history (
  measured_on    date PRIMARY KEY,
  candidates     integer NOT NULL,
  open_count     integer NOT NULL,
  mapped_count   integer NOT NULL,
  entered_open   integer,           -- NULL = no prior snapshot to diff against
  left_open      integer,           -- NULL = same
  mv_refreshed_at timestamptz,
  measured_at    timestamptz NOT NULL DEFAULT now(),
  note           text
);
ALTER TABLE public.topshot_misattrib_backlog_history ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.topshot_misattrib_backlog_history FROM PUBLIC, anon, authenticated;

COMMENT ON TABLE public.topshot_misattrib_backlog_history IS
  'Daily series for register #101''s open misattribution backlog. measured_on is the date of '
  'the MV SNAPSHOT (from cron.job_run_details for jobid 70), not of the job run, so a point is '
  'labelled by the data it describes. entered_open/left_open are a SET diff against the previous '
  'day''s open nft_id set and are NULL when there is no prior snapshot — never 0, because "no '
  'prior snapshot" and "nothing entered" are different facts. RECORDS ONLY; #101 is decided and '
  'nothing here pages.';

CREATE TABLE IF NOT EXISTS public.topshot_misattrib_open_snapshot (
  nft_id      text PRIMARY KEY,
  snapshot_on date NOT NULL
);
ALTER TABLE public.topshot_misattrib_open_snapshot ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.topshot_misattrib_open_snapshot FROM PUBLIC, anon, authenticated;

COMMENT ON TABLE public.topshot_misattrib_open_snapshot IS
  'The LATEST open-backlog nft_id set only, replaced on every run — the thing the next run '
  'diffs against. Bounded at the size of the open pile (1,364 rows on 2026-09-14), not a log.';

-- ── the writer ───────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.record_topshot_misattrib_backlog()
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_mv_at    timestamptz;
  v_on       date;
  v_note     text := 'measured';
  v_cands    int;
  v_open     int;
  v_mapped   int;
  v_prior    int;
  v_entered  int;
  v_left     int;
BEGIN
  -- ⚠ Label the point by the MV's OWN refresh, not by the clock this job ran on.
  -- The MV refreshes 23:35Z and this job runs 00:15Z, so now()::date would file
  -- every point one day AFTER the data it describes.
  SELECT max(start_time) INTO v_mv_at
    FROM cron.job_run_details
   WHERE jobid = 70 AND status = 'succeeded';

  IF v_mv_at IS NULL THEN
    v_on := now()::date;
    v_note := 'measured; MV refresh time unknown (no succeeded jobid 70 run in cron.job_run_details) so measured_on is the RUN date, not the snapshot date';
  ELSE
    v_on := v_mv_at::date;
  END IF;

  CREATE TEMP TABLE _open_now ON COMMIT DROP AS
    SELECT c.nft_id
      FROM public.mv_topshot_misattrib_candidates c
     WHERE NOT EXISTS (
       SELECT 1 FROM public.topshot_misattrib_onchain_map m WHERE m.nft_id = c.nft_id
     );

  SELECT count(*) INTO v_open FROM _open_now;
  SELECT count(*) INTO v_cands FROM public.mv_topshot_misattrib_candidates;
  v_mapped := v_cands - v_open;

  SELECT count(*) INTO v_prior FROM public.topshot_misattrib_open_snapshot;

  IF v_prior = 0 THEN
    -- ⛔ NULL, not 0. A first run has nothing to diff, and a 0 here would read as
    -- "the backlog did not move" — the fabricated-value shape this repo keeps
    -- finding. See CLAUDE.md on `?? 0` and defaulted columns.
    v_entered := NULL;
    v_left    := NULL;
  ELSE
    SELECT count(*) INTO v_entered
      FROM _open_now n
     WHERE NOT EXISTS (SELECT 1 FROM public.topshot_misattrib_open_snapshot s WHERE s.nft_id = n.nft_id);
    SELECT count(*) INTO v_left
      FROM public.topshot_misattrib_open_snapshot s
     WHERE NOT EXISTS (SELECT 1 FROM _open_now n WHERE n.nft_id = s.nft_id);
  END IF;

  INSERT INTO public.topshot_misattrib_backlog_history
    (measured_on, candidates, open_count, mapped_count, entered_open, left_open, mv_refreshed_at, measured_at, note)
  VALUES (v_on, v_cands, v_open, v_mapped, v_entered, v_left, v_mv_at, now(), v_note)
  ON CONFLICT (measured_on) DO UPDATE SET
    candidates = EXCLUDED.candidates,
    open_count = EXCLUDED.open_count,
    mapped_count = EXCLUDED.mapped_count,
    entered_open = EXCLUDED.entered_open,
    left_open = EXCLUDED.left_open,
    mv_refreshed_at = EXCLUDED.mv_refreshed_at,
    measured_at = EXCLUDED.measured_at,
    note = EXCLUDED.note;

  DELETE FROM public.topshot_misattrib_open_snapshot;
  INSERT INTO public.topshot_misattrib_open_snapshot (nft_id, snapshot_on)
    SELECT n.nft_id, v_on FROM _open_now n;

  RETURN jsonb_build_object(
    'ok', true,
    'measured_on', v_on,
    'candidates', v_cands,
    'open', v_open,
    'mapped', v_mapped,
    'entered_open', v_entered,
    'left_open', v_left,
    'had_prior_snapshot', v_prior > 0
  );
END;
$function$;

-- anon-exec: NOT intentional for record_topshot_misattrib_backlog — ops writer, revoked on the next line.
REVOKE EXECUTE ON FUNCTION public.record_topshot_misattrib_backlog() FROM PUBLIC, anon, authenticated;
-- ⚠ Name the pg_cron role explicitly: the REVOKE above would otherwise orphan the
-- caller, and that failure mode is SILENCE (cron.job_run_details shows it, pipeline_runs never does).
GRANT EXECUTE ON FUNCTION public.record_topshot_misattrib_backlog() TO postgres, service_role;

COMMENT ON FUNCTION public.record_topshot_misattrib_backlog() IS
  'Writes one daily point for register #101''s open backlog, labelled by the MV''s refresh date '
  'rather than the run date, with a SET diff (entered/left) against the previous run. Idempotent '
  'per measured_on. Records only — #101 is decided and this pages nothing.';

-- ── seed the three recorded points, marked as recorded rather than measured ──
-- ⚠ These are NOT measurements taken by this instrument. They are the figures
-- #101 and the 09-13 filing recorded, entered so the series has a baseline the
-- day it starts. `entered_open`/`left_open` stay NULL: no set was ever kept.
INSERT INTO public.topshot_misattrib_backlog_history
  (measured_on, candidates, open_count, mapped_count, entered_open, left_open, mv_refreshed_at, measured_at, note)
VALUES
  ('2026-09-05', 20128,  410, 19718, NULL, NULL, NULL, now(),
   'RECORDED, not measured by this instrument — the baseline quoted in the topshot-misattrib-drain suppression (2026-09-05 16:28Z, "410 open of 20128, 98.0% mapped").'),
  ('2026-09-12', 18959, 1315, 17644, NULL, NULL, NULL, now(),
   'RECORDED, not measured by this instrument — register #101 (filed 2026-09-13 against the MV snapshot refreshed 2026-09-12 23:35Z).'),
  ('2026-09-13', 18254, 1364, 16890, NULL, NULL, NULL, now(),
   'RECORDED at seed time from the LIVE MV (refreshed 2026-09-13 23:35Z). ⚠ Corrects the 18,959 denominator both of today''s readings quote — that figure was carried forward from the 09-13 text while only the open count was re-measured.')
ON CONFLICT (measured_on) DO NOTHING;

SELECT cron.schedule('rpc-record-misattrib-backlog', '15 0 * * *',
                     $$SELECT public.record_topshot_misattrib_backlog();$$);

-- ── verification, same transaction ───────────────────────────────────────────
DO $verify$
DECLARE
  v_seeded int;
  v_live   int;
BEGIN
  SELECT count(*) INTO v_seeded FROM public.topshot_misattrib_backlog_history;
  IF v_seeded <> 3 THEN
    RAISE EXCEPTION 'expected 3 seeded points, found %', v_seeded;
  END IF;
  -- The seeded 09-13 row must agree with what the live MV says right now, or the
  -- baseline is already wrong on the day it is written.
  SELECT count(*) INTO v_live
    FROM public.mv_topshot_misattrib_candidates c
   WHERE NOT EXISTS (SELECT 1 FROM public.topshot_misattrib_onchain_map m WHERE m.nft_id = c.nft_id);
  IF v_live <> (SELECT open_count FROM public.topshot_misattrib_backlog_history WHERE measured_on = '2026-09-13') THEN
    RAISE EXCEPTION 'seeded 2026-09-13 open_count disagrees with the live MV (% live)', v_live;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'rpc-record-misattrib-backlog' AND active) THEN
    RAISE EXCEPTION 'the recorder is not scheduled';
  END IF;
END
$verify$;

-- REVERT (all four parts):
--   SELECT cron.unschedule('rpc-record-misattrib-backlog');
--   DROP FUNCTION public.record_topshot_misattrib_backlog();
--   DROP TABLE public.topshot_misattrib_open_snapshot;
--   DROP TABLE public.topshot_misattrib_backlog_history;

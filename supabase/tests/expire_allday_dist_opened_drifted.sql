-- DB invariant: public.expire_allday_dist_opened_drifted(...) — converts the
-- ONE-SHOT AllDay `opened_count` hydrator into a refresher by putting drifted rows
-- back into its candidate set, and unwinds itself if the hydrator does not answer.
--
-- WHY THIS FUNCTION IS PINNED. It is the only scheduled object on this platform that
-- deliberately NULLs a column two public surfaces read (v_allday_pack_info
-- .opened_pct_of_minted, and pack_distributions.total_opened via jobid 75). That is
-- safe ONLY because of three properties that are easy to simplify away and whose loss
-- is SILENT — a mutation removing any of them still produces a function that expires
-- rows and looks like it works:
--   (1) the EVIDENCE predicate — a dist is a candidate only when this repo holds a
--       pack_rip sealed AFTER that dist's own stamp. Widen it to an age window or drop
--       the per-dist comparison and the lane blanks rows that were never wrong.
--   (2) the BREAKER — nothing is expired while anything is still pending. Remove it
--       and a dead upstream turns a bounded batch into a growing hole.
--   (3) the RESTORE — a pending row the hydrator has not refilled inside the window
--       gets its pre-image written back, and that tick reports ok = false. Remove it
--       and the blank is permanent; remove only the ok = false and the failure is
--       invisible, which is the shape this repo has paid for repeatedly.
-- Each is asserted here in the direction that FAILS when the property is removed, not
-- merely in the direction that passes today.
--
-- The function DDL below is a VERBATIM copy of the committed migration
-- (supabase/migrations/20260913060000_audit_20260913_allday_dist_opened_expiry_is_scheduled_and_a_cooldown_is_not_ok.sql,
--  which CREATE OR REPLACEs the body first created in 20260913055000);
-- __tests__/db-invariants-drift-guard.test.ts fails CI if this copy drifts from it.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

-- Only the columns the function touches. In production allday_pack_supply carries 16
-- columns and pack_rips 3.7M rows; neither shape matters to these invariants.
CREATE TABLE allday_pack_supply (
  dist_id           text PRIMARY KEY,
  opened_count      bigint,
  packnft_total     bigint,
  opened_updated_at timestamptz
);

CREATE TABLE pack_rips (
  id            bigserial PRIMARY KEY,
  collection_id uuid,
  dist_id       text,
  sealed_at     timestamptz
);

-- pipeline_runs.duration_ms is GENERATED in production and is never written by the
-- function, so it is omitted here rather than faked.
CREATE TABLE pipeline_runs (
  id              bigserial PRIMARY KEY,
  pipeline        text NOT NULL,
  collection_slug text,
  started_at      timestamptz NOT NULL,
  finished_at     timestamptz NOT NULL DEFAULT now(),
  rows_found      integer DEFAULT 0,
  rows_written    integer DEFAULT 0,
  ok              boolean NOT NULL DEFAULT true,
  error           text,
  extra           jsonb
);

CREATE TABLE allday_dist_opened_expiry (
  dist_id           text PRIMARY KEY,
  opened_count      bigint,
  packnft_total     bigint,
  opened_updated_at timestamptz,
  rips_after        bigint,
  expired_at        timestamptz NOT NULL DEFAULT now(),
  refilled_at       timestamptz,
  restored_at       timestamptz,
  attempts          integer NOT NULL DEFAULT 1
);

-- ── FIXTURE ─────────────────────────────────────────────────────────────────
-- Four dists, two of which are drifted. The two that are NOT drifted are the
-- controls that make assertion A non-vacuous: both have pack_rips rows, so a
-- mutation that expires "any dist with rips" — rather than any dist with rips
-- AFTER ITS OWN STAMP, under THIS collection — passes without them.
INSERT INTO allday_pack_supply (dist_id, opened_count, packnft_total, opened_updated_at) VALUES
  ('d_big',   100, 1000, '2026-08-01 00:00:00+00'),  -- 3 rips after the stamp
  ('d_small',  50,  500, '2026-08-01 00:00:00+00'),  -- 1 rip after the stamp
  ('d_clean',  70,  700, '2026-08-10 00:00:00+00'),  -- 2 rips, both BEFORE the stamp
  ('d_other',  60,  600, '2026-08-01 00:00:00+00');  -- 1 rip after the stamp, wrong collection

INSERT INTO pack_rips (collection_id, dist_id, sealed_at) VALUES
  ('dee28451-5d62-409e-a1ad-a83f763ac070', 'd_big',   '2026-08-05 00:00:00+00'),
  ('dee28451-5d62-409e-a1ad-a83f763ac070', 'd_big',   '2026-08-06 00:00:00+00'),
  ('dee28451-5d62-409e-a1ad-a83f763ac070', 'd_big',   '2026-08-07 00:00:00+00'),
  ('dee28451-5d62-409e-a1ad-a83f763ac070', 'd_small', '2026-08-02 00:00:00+00'),
  -- d_clean's rips clear the scan floor (min stamp = 2026-08-01) and reach the join,
  -- so it is excluded by the PER-DIST comparison and not merely filtered out early.
  ('dee28451-5d62-409e-a1ad-a83f763ac070', 'd_clean', '2026-08-05 00:00:00+00'),
  ('dee28451-5d62-409e-a1ad-a83f763ac070', 'd_clean', '2026-08-06 00:00:00+00'),
  -- Top Shot, same shape as d_big. Nothing about this row may reach an AllDay lane.
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'd_other', '2026-08-05 00:00:00+00');

-- >>> BEGIN verbatim expire_allday_dist_opened_drifted (keep byte-identical to the migration) >>>
CREATE OR REPLACE FUNCTION public.expire_allday_dist_opened_drifted(
  p_limit           integer  DEFAULT 100,
  p_restore_after   interval DEFAULT '60 minutes',
  p_retry_cooldown  interval DEFAULT '24 hours'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
SET statement_timeout = '60s'
AS $fn$
DECLARE
  v_allday   constant uuid := 'dee28451-5d62-409e-a1ad-a83f763ac070';  -- nfl_all_day
  v_started  timestamptz := clock_timestamp();
  v_refilled integer := 0;
  v_restored integer := 0;
  v_pending  integer := 0;
  v_expired  integer := 0;
  v_drifted  integer := 0;
  v_rips     bigint  := 0;
  v_blocked  text    := NULL;
  v_result   jsonb;
BEGIN
  -- 1. SETTLE: the hydrator refilled these.
  UPDATE public.allday_dist_opened_expiry e
     SET refilled_at = now()
    FROM public.allday_pack_supply s
   WHERE s.dist_id = e.dist_id
     AND e.refilled_at IS NULL
     AND e.restored_at IS NULL
     AND s.opened_count IS NOT NULL;
  GET DIAGNOSTICS v_refilled = ROW_COUNT;

  -- 2. RESTORE: it did not, inside the window. Put the pre-image back.
  WITH stale AS (
    SELECT e.dist_id, e.opened_count, e.packnft_total, e.opened_updated_at
      FROM public.allday_dist_opened_expiry e
      JOIN public.allday_pack_supply s ON s.dist_id = e.dist_id
     WHERE e.refilled_at IS NULL
       AND e.restored_at IS NULL
       AND e.expired_at < now() - p_restore_after
       AND s.opened_count IS NULL
  ), put_back AS (
    UPDATE public.allday_pack_supply s
       SET opened_count      = st.opened_count,
           packnft_total     = st.packnft_total,
           opened_updated_at = st.opened_updated_at
      FROM stale st
     WHERE st.dist_id = s.dist_id
    RETURNING s.dist_id
  )
  UPDATE public.allday_dist_opened_expiry e
     SET restored_at = now()
    FROM put_back p
   WHERE p.dist_id = e.dist_id;
  GET DIAGNOSTICS v_restored = ROW_COUNT;

  -- 3. BREAKER.
  SELECT count(*) INTO v_pending
    FROM public.allday_dist_opened_expiry
   WHERE refilled_at IS NULL AND restored_at IS NULL;

  IF v_pending > 0 THEN
    v_blocked := 'pending';
  ELSIF EXISTS (SELECT 1 FROM public.allday_dist_opened_expiry
                 WHERE restored_at > now() - p_retry_cooldown) THEN
    v_blocked := 'cooldown';
  END IF;

  -- Drift is measured on EVERY tick, blocked or not, so the pipeline_runs row records the
  -- size of the problem rather than only the size of this tick's bite.
  WITH last_rip AS (
    SELECT r.dist_id, max(r.sealed_at) AS last_sealed
      FROM public.pack_rips r
     WHERE r.collection_id = v_allday
       AND r.sealed_at > (SELECT min(opened_updated_at) FROM public.allday_pack_supply)
       AND r.dist_id IS NOT NULL
     GROUP BY r.dist_id
  )
  SELECT count(*)::int,
         coalesce(sum((SELECT count(*) FROM public.pack_rips r2
                        WHERE r2.collection_id = v_allday
                          AND r2.dist_id = s.dist_id
                          AND r2.sealed_at > s.opened_updated_at)), 0)
    INTO v_drifted, v_rips
    FROM public.allday_pack_supply s
    JOIN last_rip l ON l.dist_id = s.dist_id
   WHERE s.opened_count IS NOT NULL
     AND s.opened_updated_at IS NOT NULL
     AND l.last_sealed > s.opened_updated_at;

  -- 4. EXPIRE.
  IF v_blocked IS NULL AND v_drifted > 0 THEN
    WITH last_rip AS (
      SELECT r.dist_id, max(r.sealed_at) AS last_sealed
        FROM public.pack_rips r
       WHERE r.collection_id = v_allday
         AND r.sealed_at > (SELECT min(opened_updated_at) FROM public.allday_pack_supply)
         AND r.dist_id IS NOT NULL
       GROUP BY r.dist_id
    ), cand AS (
      SELECT s.dist_id, s.opened_count, s.packnft_total, s.opened_updated_at,
             (SELECT count(*) FROM public.pack_rips r2
               WHERE r2.collection_id = v_allday
                 AND r2.dist_id = s.dist_id
                 AND r2.sealed_at > s.opened_updated_at) AS rips_after
        FROM public.allday_pack_supply s
        JOIN last_rip l ON l.dist_id = s.dist_id
       WHERE s.opened_count IS NOT NULL
         AND s.opened_updated_at IS NOT NULL
         AND l.last_sealed > s.opened_updated_at
       ORDER BY rips_after DESC, s.dist_id
       LIMIT GREATEST(p_limit, 1)
    ), snap AS (
      INSERT INTO public.allday_dist_opened_expiry AS x
             (dist_id, opened_count, packnft_total, opened_updated_at, rips_after, expired_at)
      SELECT dist_id, opened_count, packnft_total, opened_updated_at, rips_after, now()
        FROM cand
      ON CONFLICT (dist_id) DO UPDATE SET
        opened_count      = EXCLUDED.opened_count,
        packnft_total     = EXCLUDED.packnft_total,
        opened_updated_at = EXCLUDED.opened_updated_at,
        rips_after        = EXCLUDED.rips_after,
        expired_at        = now(),
        refilled_at       = NULL,
        restored_at       = NULL,
        attempts          = x.attempts + 1
      RETURNING x.dist_id
    )
    UPDATE public.allday_pack_supply s
       SET opened_count = NULL
      FROM snap
     WHERE snap.dist_id = s.dist_id;
    GET DIAGNOSTICS v_expired = ROW_COUNT;
  END IF;

  v_result := jsonb_build_object(
    'drifted', v_drifted, 'rips_uncounted', v_rips, 'expired', v_expired,
    'refilled', v_refilled, 'restored', v_restored, 'pending', v_pending,
    'blocked', v_blocked, 'limit', p_limit);

  -- 5. LOG. NOTE: duration_ms is GENERATED on pipeline_runs -- never list it here.
  INSERT INTO public.pipeline_runs
         (pipeline, collection_slug, started_at, finished_at, rows_found, rows_written, ok, error, extra)
  VALUES ('allday-dist-opened-expiry', 'nfl_all_day', v_started, clock_timestamp(),
          v_drifted, v_expired, (v_restored = 0 AND v_blocked IS DISTINCT FROM 'cooldown'),
          CASE WHEN v_restored > 0
               THEN 'hydrator did not refill ' || v_restored || ' dist(s) within '
                    || p_restore_after::text || ' - pre-images restored, expiry on cooldown'
               WHEN v_blocked = 'cooldown'
               THEN 'expiry held off after a restore: the hydrator is not answering and '
                    || v_drifted || ' dist(s) remain drifted'
          END,
          v_result);

  RETURN v_result;
END;
$fn$;
-- <<< END verbatim expire_allday_dist_opened_drifted <<<

-- ── A. SELECTION: evidence, collection scope, worst-drift first, limit ──────
SELECT expire_allday_dist_opened_drifted(p_limit := 1);

SELECT _assert_eq((SELECT extra->>'drifted'        FROM pipeline_runs ORDER BY id DESC LIMIT 1), '2', 'drift set is the two dists with rips after their own stamp');
SELECT _assert_eq((SELECT extra->>'rips_uncounted' FROM pipeline_runs ORDER BY id DESC LIMIT 1), '4', 'rips_uncounted sums the per-dist counts (3 + 1)');
SELECT _assert_eq((SELECT extra->>'expired'        FROM pipeline_runs ORDER BY id DESC LIMIT 1), '1', 'p_limit bounds the batch');

-- ⭐ THE CONTROLS. Both of these rows have pack_rips and must survive untouched.
SELECT _assert_eq((SELECT opened_count::text FROM allday_pack_supply WHERE dist_id='d_clean'), '70', 'a dist whose rips all PREDATE its stamp is not drifted (evidence predicate, not an age window)');
SELECT _assert_eq((SELECT opened_count::text FROM allday_pack_supply WHERE dist_id='d_other'), '60', 'a rip under ANOTHER collection is not evidence (collection scope)');

-- Worst drift first: d_big (3) outranks d_small (1).
SELECT _assert_eq((SELECT (opened_count IS NULL)::text FROM allday_pack_supply WHERE dist_id='d_big'),   'true',  'the worst-drifted dist is expired first');
SELECT _assert_eq((SELECT opened_count::text           FROM allday_pack_supply WHERE dist_id='d_small'), '50',    'the lesser-drifted dist waits for a later tick');

-- The pre-image is captured BEFORE the NULL, or the restore path has nothing to restore.
SELECT _assert_eq((SELECT opened_count::text  FROM allday_dist_opened_expiry WHERE dist_id='d_big'), '100', 'pre-image opened_count is snapshotted');
SELECT _assert_eq((SELECT packnft_total::text FROM allday_dist_opened_expiry WHERE dist_id='d_big'), '1000', 'pre-image packnft_total is snapshotted');
SELECT _assert_eq((SELECT rips_after::text    FROM allday_dist_opened_expiry WHERE dist_id='d_big'), '3', 'the evidence count is recorded with the pre-image');
-- opened_updated_at is deliberately LEFT IN PLACE on the live row while opened_count
-- is NULL, so the restore path and any age reader still resolve mid-refetch.
SELECT _assert_eq((SELECT (opened_updated_at = '2026-08-01 00:00:00+00'::timestamptz)::text FROM allday_pack_supply WHERE dist_id='d_big'), 'true', 'expiry NULLs opened_count ONLY, never its stamp');

-- ⭐ rows_found is the WHOLE backlog, rows_written this tick's bite. A reader that
-- only ever sees rows_written cannot tell "nothing to do" from "bounded by p_limit".
SELECT _assert_eq((SELECT rows_found::text   FROM pipeline_runs ORDER BY id DESC LIMIT 1), '2', 'rows_found reports total drift, not the batch');
SELECT _assert_eq((SELECT rows_written::text FROM pipeline_runs ORDER BY id DESC LIMIT 1), '1', 'rows_written reports the batch');

-- ⭐ THE LANE LOGS AT ALL. allday_pack_supply had no pipeline_runs row under any name
-- before this function (register #94), which is why a 32-day freeze went unseen.
SELECT _assert_eq((SELECT pipeline        FROM pipeline_runs ORDER BY id DESC LIMIT 1), 'allday-dist-opened-expiry', 'the lane writes a pipeline_runs row');
SELECT _assert_eq((SELECT collection_slug FROM pipeline_runs ORDER BY id DESC LIMIT 1), 'nfl_all_day', 'the row is attributed to its collection');

-- ── B. BREAKER: a pending row stops the next tick expiring anything ─────────
SELECT expire_allday_dist_opened_drifted(p_limit := 1);

SELECT _assert_eq((SELECT extra->>'blocked' FROM pipeline_runs ORDER BY id DESC LIMIT 1), 'pending', 'expiry is blocked while a row is still in flight');
SELECT _assert_eq((SELECT extra->>'expired' FROM pipeline_runs ORDER BY id DESC LIMIT 1), '0', 'a blocked tick expires nothing');
-- ⭐ The assertion that reds if the breaker is deleted: d_small is drifted and would
-- otherwise be taken now, turning one outstanding blank into two.
SELECT _assert_eq((SELECT opened_count::text FROM allday_pack_supply WHERE dist_id='d_small'), '50', 'the breaker stops the blast radius growing while the hydrator is behind');
-- ⭐ And a blocked tick is NOT an error. "Did nothing" and "failed" must stay apart,
-- or the arm that watches this lane is trained to be ignored.
SELECT _assert_eq((SELECT ok::text         FROM pipeline_runs ORDER BY id DESC LIMIT 1), 'true', 'a blocked tick is ok = true');
SELECT _assert_eq((SELECT (error IS NULL)::text FROM pipeline_runs ORDER BY id DESC LIMIT 1), 'true', 'a blocked tick records no error');

-- ── C. SETTLE: the hydrator answers, the row closes out, the next one goes ──
-- Simulates edge fn backfill-allday-dist-opened: re-counts from upstream and stamps.
UPDATE allday_pack_supply SET opened_count = 103, opened_updated_at = '2026-08-08 00:00:00+00' WHERE dist_id='d_big';

SELECT expire_allday_dist_opened_drifted(p_limit := 1);

SELECT _assert_eq((SELECT extra->>'refilled' FROM pipeline_runs ORDER BY id DESC LIMIT 1), '1', 'a refilled row is settled');
SELECT _assert_eq((SELECT (refilled_at IS NOT NULL)::text FROM allday_dist_opened_expiry WHERE dist_id='d_big'), 'true', 'settle stamps refilled_at');
SELECT _assert_eq((SELECT (restored_at IS NULL)::text     FROM allday_dist_opened_expiry WHERE dist_id='d_big'), 'true', 'a refilled row is never also restored');
SELECT _assert_eq((SELECT extra->>'drifted'  FROM pipeline_runs ORDER BY id DESC LIMIT 1), '1', 'the refilled dist has left the drift set');
SELECT _assert_eq((SELECT (opened_count IS NULL)::text FROM allday_pack_supply WHERE dist_id='d_small'), 'true', 'with the breaker clear the next-worst dist is taken');

-- ── D. RESTORE: the hydrator does NOT answer ───────────────────────────────
-- ⚠ THE BACKDATING IS LOAD-BEARING, NOT COSMETIC. now() is the TRANSACTION
-- timestamp, so every now() in this rolled-back transaction is the same instant and
-- `expired_at < now() - p_restore_after` can never become true on its own. Without
-- forcing an earlier value the restore branch is unreachable and every assertion
-- below would pass against a function that has no restore path at all.
UPDATE allday_dist_opened_expiry SET expired_at = now() - interval '2 hours' WHERE dist_id='d_small';
-- Corrupt packnft_total so "restore wrote it back" is distinguishable from "restore
-- never touched it". Not a state production reaches; it is what makes the next
-- assertion fail when the column is dropped from the restore's SET list.
UPDATE allday_pack_supply SET packnft_total = 999 WHERE dist_id='d_small';

SELECT expire_allday_dist_opened_drifted(p_limit := 1);

SELECT _assert_eq((SELECT extra->>'restored' FROM pipeline_runs ORDER BY id DESC LIMIT 1), '1', 'an unanswered row is restored after p_restore_after');
SELECT _assert_eq((SELECT opened_count::text  FROM allday_pack_supply WHERE dist_id='d_small'), '50',  'restore returns the row to its last KNOWN value, not to blank');
SELECT _assert_eq((SELECT packnft_total::text FROM allday_pack_supply WHERE dist_id='d_small'), '500', 'restore writes back every snapshotted column');
SELECT _assert_eq((SELECT (opened_updated_at = '2026-08-01 00:00:00+00'::timestamptz)::text FROM allday_pack_supply WHERE dist_id='d_small'), 'true', 'restore returns the stamp too, so the row does not claim to be fresher than it is');
SELECT _assert_eq((SELECT (restored_at IS NOT NULL)::text FROM allday_dist_opened_expiry WHERE dist_id='d_small'), 'true', 'restore stamps restored_at');
-- ⭐ AND IT IS REPORTED AS A FAILURE. This is the only signal that the hydrator loop
-- is broken; without it the lane self-heals silently and the freeze returns unseen.
SELECT _assert_eq((SELECT ok::text              FROM pipeline_runs ORDER BY id DESC LIMIT 1), 'false', 'a tick that had to restore reports ok = false');
SELECT _assert_eq((SELECT (error IS NOT NULL)::text FROM pipeline_runs ORDER BY id DESC LIMIT 1), 'true', 'and names what happened');
SELECT _assert_eq((SELECT extra->>'expired'     FROM pipeline_runs ORDER BY id DESC LIMIT 1), '0', 'a tick that restored expires nothing');

-- ── E. COOLDOWN: a restored dist is not immediately re-expired ──────────────
-- d_small is still drifted (its stamp is back at 2026-08-01 with a rip at 08-02), so
-- without the cooldown this tick re-expires it and the lane churns forever against an
-- upstream that has already failed once.
SELECT expire_allday_dist_opened_drifted(p_limit := 1);

SELECT _assert_eq((SELECT extra->>'blocked' FROM pipeline_runs ORDER BY id DESC LIMIT 1), 'cooldown', 'a recent restore holds expiry off');
SELECT _assert_eq((SELECT opened_count::text FROM allday_pack_supply WHERE dist_id='d_small'), '50', 'the restored dist is not re-expired inside the cooldown');
SELECT _assert_eq((SELECT extra->>'drifted' FROM pipeline_runs ORDER BY id DESC LIMIT 1), '1', 'and the tick still REPORTS the drift it is declining to act on');
-- ⭐ A COOLDOWN TICK IS NOT ok, AND THAT IS THE POINT. A cooldown is reachable only after a
-- restore, and a restore only after the hydrator stopped answering, so the lane is genuinely
-- degraded for the whole window. The first version of this function reported ok = true here,
-- which would have shown a dead hydrator as ONE not-ok tick followed by twelve green ones and
-- cleared any no-success arm while the loop was still broken. ⛔ Do NOT "fix" a future amber
-- on this lane by relaxing this back to true — a healthy lane never enters cooldown at all,
-- so this can only be red when something really is wrong.
SELECT _assert_eq((SELECT ok::text FROM pipeline_runs ORDER BY id DESC LIMIT 1), 'false', 'a cooldown tick reports ok = false for as long as the lane is degraded');
SELECT _assert_eq((SELECT (error IS NOT NULL)::text FROM pipeline_runs ORDER BY id DESC LIMIT 1), 'true', 'and says why it is holding off');

-- ── F. THE EVIDENCE PREDICATE, AT A LIMIT THAT CANNOT MASK IT ──────────────
-- 🚨 THIS SECTION EXISTS BECAUSE THE FILE WAS VACUOUS WITHOUT IT, MEASURED RATHER
-- THAN SUSPECTED. Sections A–E all call at p_limit := 1, and at that limit the
-- ORDERING hides the predicate: d_clean sorts last (rips_after = 0), so a mutation
-- widening the candidate set from "rips after this dist's own stamp" to "any rip at
-- all" STILL takes d_big first, and every assertion above passes unchanged. That
-- mutation survived this file until this section was added — the exact failure this
-- repo books as the worst kind, a test whose title names a property its assertions
-- do not hold. A sweep with headroom in the batch is the only shape that sees it.
DELETE FROM allday_dist_opened_expiry;
UPDATE allday_pack_supply SET opened_count = 100, packnft_total = 1000, opened_updated_at = '2026-08-01 00:00:00+00' WHERE dist_id='d_big';
UPDATE allday_pack_supply SET opened_count =  50, packnft_total =  500, opened_updated_at = '2026-08-01 00:00:00+00' WHERE dist_id='d_small';

SELECT expire_allday_dist_opened_drifted(p_limit := 10);

SELECT _assert_eq((SELECT extra->>'expired' FROM pipeline_runs ORDER BY id DESC LIMIT 1), '2', 'a sweep with headroom takes EXACTLY the drifted dists');
SELECT _assert_eq((SELECT count(*)::text FROM allday_dist_opened_expiry), '2', 'and exactly two rows enter the expiry ledger');
SELECT _assert_eq((SELECT opened_count::text FROM allday_pack_supply WHERE dist_id='d_clean'), '70', 'a dist whose rips predate its stamp survives a sweep that had room for it');
SELECT _assert_eq((SELECT opened_count::text FROM allday_pack_supply WHERE dist_id='d_other'), '60', 'a dist whose only rip is under another collection survives it too');

SELECT '✓ expire_allday_dist_opened_drifted invariants pass' AS result;
ROLLBACK;

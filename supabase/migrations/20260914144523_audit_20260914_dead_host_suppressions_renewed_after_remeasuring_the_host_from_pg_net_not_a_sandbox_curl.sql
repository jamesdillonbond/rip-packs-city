-- audit_20260914: the nine dead-host suppressions expired 2026-09-13 while the host
-- is STILL dead. Re-measured, then RE-BOUND to 2026-10-05 -- not extended blindly.
--
-- WHY THIS IS A RENEWAL AND NOT A RUBBER STAMP. Migration 20260830034312 bounded
-- these to 2026-09-13 precisely so someone would have to look again. The bound did
-- its job: the Cadence Collapse arm resurfaced compute-topshot-pack-ev,
-- topshot-moments-hydrator and topshot-pack-pool-backfill this morning. The exit
-- condition it wrote down is testable, so it was tested.
--
-- ⭐ THE MEASUREMENT, 2026-09-14 07:43 AM PT, TWO REQUESTS:
--     POST https://public-api.nbatopshot.com/graphql  {"query":"{__typename}"}
--     -> 530, body "error code: 1033"   (request 353053)
--     -> 530, body "error code: 1033"   (request 353054)
--   Byte-identical to the signature recorded on 08-28. The host has been dead 17 days.
--   EXIT CONDITION NOT MET -> the pauses stay, and the suppressions must too.
--
-- 🚨 AND THE TRAP THAT WOULD HAVE PRODUCED THE OPPOSITE-BUT-IDENTICAL ANSWER:
--   the exit condition is written as a `curl` one-liner, and running it from an agent
--   sandbox returns HTTP **000** -- which reads exactly like a dead host. It is not.
--   It is `curl: (56) CONNECT tunnel failed, response 403`: the agent proxy refusing
--   the host, with a positive control (api.github.com -> 200) proving egress works.
--   ⛔ SO THE SANDBOX CANNOT ANSWER THIS QUESTION AT ALL, in either direction -- a
--   session that trusted 000 would "confirm" a dead host it never reached, and once
--   the host RECOVERS that same 000 would keep these paused forever.
--   ✅ Use pg_net FROM THE DATABASE, which is the plane production actually calls on:
--     select net.http_post(url := '...', body := '...'::jsonb, headers := '...'::jsonb);
--     -- then read status_code + content from net._http_response by the returned id.
--
-- ⛔ NOT DECLARED TERMINAL, deliberately. 17 days is long, but the porting work is
--   live: 20260907051909 and 20260907153117 move pack-pull hydration onto pg_net Flow
--   REST "so it needs no dead host". Marking these retired would discard that.
--
-- ⚠ WHAT THIS DOES NOT FIX, and it is the arm Trevor actually saw:
--   `check_pipeline_cadence_collapse` NEVER READS THIS TABLE -- verified against the
--   live body, there is no reference to pipeline_alert_suppression anywhere in it. So
--   renewing these quiets the failure-rate arms and does NOT quiet Cadence Collapse,
--   which will keep reporting three deliberately-paused lanes as "stopped". Filed as
--   register #117 rather than fixed here: making an arm honour suppressions is a
--   verdict change that needs its own tests, and it must not let a stale suppression
--   hide a REAL collapse.
--
-- REVERT: UPDATE public.pipeline_alert_suppression
--            SET expires_at = '2026-09-13 00:00:00+00',
--                reason = left(reason, position(' | RENEWED 2026-09-14' in reason) - 1)
--          WHERE reason LIKE 'dead host 2026-08-30%';
UPDATE public.pipeline_alert_suppression
   SET expires_at = '2026-10-05 00:00:00+00',
       reason = reason || ' | RENEWED 2026-09-14 07:43 AM PT: re-measured via pg_net from the DB (NOT a sandbox curl, which returns 000 because the agent proxy 403s the host and reads as a dead host either way) -- two POSTs to public-api.nbatopshot.com/graphql both returned 530 "error code: 1033", the same signature as 08-28, so the exit condition is NOT met and the pause is still correct. Re-bound to 2026-10-05, not made permanent: porting work off this host is live (20260907051909, 20260907153117). Re-test with pg_net before renewing again.'
 WHERE reason LIKE 'dead host 2026-08-30%';

DO $$
DECLARE v_renewed int; v_stale int;
BEGIN
  SELECT count(*) FILTER (WHERE expires_at = '2026-10-05 00:00:00+00'),
         count(*) FILTER (WHERE expires_at <> '2026-10-05 00:00:00+00')
    INTO v_renewed, v_stale
    FROM public.pipeline_alert_suppression WHERE reason LIKE 'dead host 2026-08-30%';
  IF v_renewed <> 9 OR v_stale <> 0 THEN
    RAISE EXCEPTION 'POST-STATE FAILED: expected 9 renewed / 0 stale, got % / %', v_renewed, v_stale;
  END IF;
  -- ⚠ the renewal must not have leaked onto any OTHER suppression row.
  IF (SELECT count(*) FROM public.pipeline_alert_suppression
       WHERE reason LIKE '%RENEWED 2026-09-14%' AND reason NOT LIKE 'dead host 2026-08-30%') <> 0 THEN
    RAISE EXCEPTION 'POST-STATE FAILED: renewal note landed on a non-dead-host row';
  END IF;
END $$;

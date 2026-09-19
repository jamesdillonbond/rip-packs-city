-- audit_20260918_site_availability_says_WHEN_it_was_down_not_only_how_often
--
-- WHY (measured 2026-09-18 PT). The "Is the site actually serving" alarm went red
-- on commit 5a8ca4e3 and the badge was CORRECT: 34 failed probes in its 8 h
-- window. Every one of them fell between 16:12Z and 18:57Z -- entirely inside the
-- platform outage that ended ~19:01Z -- and there have been none since.
--
-- THE DEFECT IS NOT THE FIRING, IT IS THAT THE MESSAGE CANNOT BE DATED. The
-- recovered-outage branch says only "$FAILED failed probes in the last $WINDOW
-- (currently serving again)". Two consequences, both of which cost the reader:
--   1. The alarm re-fires on every delivered tick for the whole 8 h it takes the
--      failures to age out -- roughly every 3 h at the measured GHA delivery rate.
--      After a six-hour outage that is several repeats of news the reader already
--      has, and repeats that cannot be recognised AS repeats.
--   2. A GENUINELY NEW outage produces an IDENTICAL message. "34 failed probes in
--      the last 8 h" reads the same whether the last one was three hours ago or
--      three minutes ago, so the one case the reader must act on is
--      indistinguishable from the one they must ignore.
--
-- WHAT THIS DELIBERATELY DOES NOT DO: add a cooldown, or raise a threshold. The
-- workflow's own header records that decision -- "NO COOLDOWN, DELIBERATELY ... the
-- 2026-09-10 failure was silence, not noise" -- and quietening an alarm because it
-- is currently right is how the next outage goes unseen. The fix is to make the
-- repeats LEGIBLE, not fewer: a number without its provenance, which is this repo's
-- own recurring shape, one level up from a fabricated value.
--
-- WHAT CHANGES: three ADDITIVE keys. Every existing key keeps its exact name,
-- type and meaning, so the workflow and any other reader are unaffected.
--   first_fail_at     -- oldest failed probe still inside the window
--   last_fail_at      -- newest failed probe; THIS is the one that dates the event
--   window_clears_at  -- last_fail_at + p_window: when `failed` returns to 0 if
--                        nothing else fails. Lets the alarm state when it stops.
-- All three are NULL when there are no failures in the window, which is the true
-- answer rather than a zero.
--
-- The `resolved_at IS NOT NULL` filter is UNCHANGED and is load-bearing: an
-- in-flight probe is UNKNOWN, not failed. (A hand-written check during this pass
-- used `status_code IS NULL OR status_code >= 400` and counted the in-flight row
-- as a failure, reporting 35 where the function correctly says 34 -- the
-- instrument the reader writes is as suspect as the one they are auditing.)
--
-- REVERT: re-apply the function body from
-- supabase/migrations/20260911041601_audit_20260910_site_availability_probe_from_the_one_plane_a_vercel_pause_cannot_reach.sql
-- and drop the three keys from the workflow message. No data is touched.

CREATE OR REPLACE FUNCTION public.check_site_availability(p_window interval DEFAULT '02:00:00'::interval)
 RETURNS jsonb
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH w AS (
    SELECT * FROM public.site_probe
     WHERE fired_at > now() - p_window AND resolved_at IS NOT NULL
  ),
  latest AS (
    SELECT * FROM w ORDER BY fired_at DESC LIMIT 1
  ),
  -- Consecutive failures from the newest backwards. This is the number an alarm
  -- should key on: one failed probe is a blip, several in a row is an outage.
  streak AS (
    SELECT count(*)::int AS n
      FROM (
        SELECT status_code,
               row_number() OVER (ORDER BY fired_at DESC) AS rn,
               sum(CASE WHEN status_code = 200 THEN 1 ELSE 0 END)
                 OVER (ORDER BY fired_at DESC ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS ok_seen
          FROM w
      ) s
     WHERE ok_seen = 0
  ),
  -- 2026-09-18. WHEN the failures were, not only how many. Without this the
  -- recovered-outage message is undatable, so a repeat of an old event and a
  -- brand-new one read identically -- see this migration's header.
  fails AS (
    SELECT min(fired_at) AS first_fail_at,
           max(fired_at) AS last_fail_at
      FROM w WHERE status_code IS DISTINCT FROM 200
  )
  SELECT jsonb_build_object(
    -- The population is published so a window that probed NOTHING cannot read as
    -- a window in which nothing went wrong.
    'probes',            (SELECT count(*)::int FROM w),
    'ok',                (SELECT count(*) FILTER (WHERE status_code = 200)::int FROM w),
    'failed',            (SELECT count(*) FILTER (WHERE status_code IS DISTINCT FROM 200)::int FROM w),
    'consecutive_fails', COALESCE((SELECT n FROM streak), 0),
    'latest_status',     (SELECT status_code FROM latest),
    'latest_error',      (SELECT left(error_msg, 200) FROM latest),
    'latest_at',         (SELECT fired_at FROM latest),
    'last_ok_at',        (SELECT max(fired_at) FROM w WHERE status_code = 200),
    'window',            p_window::text,
    -- NULL when the window holds no failures: the true answer, not a zero.
    'first_fail_at',     (SELECT first_fail_at FROM fails),
    'last_fail_at',      (SELECT last_fail_at FROM fails),
    'window_clears_at',  (SELECT last_fail_at + p_window FROM fails)
  );
$function$;

comment on function public.check_site_availability(interval) is
  'Reads site_probe back for the availability alarm. Counts only RESOLVED probes — an in-flight probe is UNKNOWN, not failed. Publishes the population (probes) so a window that probed nothing cannot read as healthy, the consecutive-failure streak an alarm should key on, and (2026-09-18) first_fail_at / last_fail_at / window_clears_at so a recovered-outage alert can be DATED — without them a repeat of an old event and a brand-new outage produce an identical message.';

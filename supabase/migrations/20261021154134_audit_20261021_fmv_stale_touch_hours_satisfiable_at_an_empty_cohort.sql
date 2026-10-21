-- 2026-10-21 ~8:45 AM PT (Claude Code cloud; Trevor: "Keep going") — fmv_stale_touch_hours could not be
-- satisfied once Step 6's cohort was empty, and it emptied on 10-18 by design.
--
-- Daytime monitor (inbox 2026-10-21T1515Z) paged: 41.7 h / 260 runs with stale_touch = 0, BREACH at 36.
-- Measured, not a dead step:
--   * every one of those runs carried force_stale (stale_touch_error null, the probe ran);
--   * since 1.8.2 (10-17/18) the re-stamp passes 0 recent sales through gateMediumToRecentSale, so a
--     re-stamped row lands on LOW, which is outside Step 6's HIGH/MEDIUM filter. The step drained its whole
--     cohort in one pass (19 + 45 + 1 touches, 10-18 8-10 PM PT) and the sweep now demotes a newly-cold
--     edition before it is 24 h old;
--   * the live cohort (latest HIGH/MEDIUM, older than 24 h, no 30-day sale): Top Shot 0 of 14,248
--     editions, All Day 0 of 5,767, read 10-21 8:38 AM PT.
-- The arm measured "hours since a run touched something", which a correctly-working step with an empty
-- cohort can never satisfy (a not-vacuous check must be satisfiable at a population of ZERO).
--
-- FIX: /api/fmv-recalc now reports extra.stale_touch_candidates (rows its candidate query handed the
-- re-stamp; null when the query did not run or failed). The arm's clock now also resets on a run whose
-- probe ran clean and found 0 candidates. It still breaches when candidates exist and nothing is
-- written, when the probe errors, and when force_stale stops being sent (both keys then absent/null).
-- Runs before this deploy lack the key, so the arm keeps its old reading until the first new run.
--
-- REVERT: re-run with old_anchor and new_anchor swapped.
DO $mig$
DECLARE
  body text;
  n int;
  old_anchor text := $anc$AND ((pr.extra ->> 'stale_touch'::text)::integer) > 0), 999::numeric) AS "coalesce",
            36::numeric AS "numeric",
            'Step 6 of /api/fmv-recalc -- the force_stale LIVENESS TOUCH -- stopped touching anything. Hours since a fmv-recalc run last reported extra->>stale_touch > 0.$anc$;
  new_anchor text := $new$AND (((pr.extra ->> 'stale_touch'::text)::integer) > 0 OR ((pr.extra ->> 'stale_touch_candidates'::text)::integer) = 0 AND (pr.extra ->> 'stale_touch_error'::text) IS NULL)), 999::numeric) AS "coalesce",
            36::numeric AS "numeric",
            'Step 6 of /api/fmv-recalc -- the force_stale LIVENESS TOUCH -- stopped touching anything. Hours since a fmv-recalc run last reported extra->>stale_touch > 0, OR (2026-10-21) a run whose candidate probe ran clean and found extra->>stale_touch_candidates = 0. Since 1.8.2 a re-stamp lands on LOW and leaves the HIGH/MEDIUM cohort, so the cohort drained on 10-18 and an empty cohort is the normal state (0 TS / 0 All Day measured 10-21); the old shape could not be satisfied at zero and breached at 41.7h on a healthy step. It still breaches when candidates exist and nothing is written, when the probe errors, and when force_stale stops being sent. The text below is the 2026-08-05 rationale.$new$;
BEGIN
  body := pg_get_viewdef('public.v_rpc_trust_health'::regclass, true);
  n := (length(body) - length(replace(body, old_anchor, ''))) / length(old_anchor);
  IF n <> 1 THEN
    RAISE EXCEPTION 'fmv_stale_touch_hours anchor matched % times, expected 1 -- aborting', n;
  END IF;
  body := replace(body, old_anchor, new_anchor);
  EXECUTE 'CREATE OR REPLACE VIEW public.v_rpc_trust_health WITH (security_invoker=on) AS ' || body;
END
$mig$;

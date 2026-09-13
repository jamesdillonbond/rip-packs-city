-- audit_20260912_wire_the_cadence_collapse_arm_with_an_expiring_ack
--
-- WHAT: seeds the `Cadence Collapse` row in `sentinel_threshold_config` — the
-- warn/crit edges for the new sentinel arm, plus a DATED, REASONED, EXPIRING ack
-- covering the ~12 hours in which the arm's own observed window still contains
-- the outage it was built to catch.
--
-- WHY NOW. `public.check_pipeline_cadence_collapse()` shipped 2026-09-12 05:47Z
-- DELIBERATELY UNWIRED, and its own header wrote the exit condition:
--   "NOT WIRED TO ANY ALARM IN THIS MIGRATION, deliberately. It would fire today
--    for the nine lanes whose cron-job.org entries are disabled (#76) and stay red
--    until an operator re-enables them; wiring it before that is the #25 trap.
--    Wire it after those entries are back, when a red means something new."
-- Those nine entries were re-enabled from the console on 2026-09-12 ~21:55 PT and
-- their first post-re-enable runs logged ok = true (`wmc-fmv-populate` 7/7 with 74
-- rows, `snapshot-pack-asks` 1/1 with 27, `alerts-dispatch` 1/1). The precondition
-- is MET, so this is that wiring — not a second arm layered on the first.
--
-- THE EDGES. warn_at = 1 / crit_at = 5.
--   * One lane below its own cadence is a LANE problem -> warn.
--   * Five at once is a CALLER problem — a scheduler, a budget, a console — which
--     is the class that produced both #76 and #80 and the class a human has to act
--     on tonight rather than tomorrow. The 2026-09-10 event read ELEVEN.
-- Both are read through the route's `thr()` helper, so they retune from here with
-- no deploy; the route's hardcoded fallback is the same 1 / 5.
--
-- THE ACK, AND WHY IT IS AN ACK RATHER THAN A LOOSER THRESHOLD. The arm measures
-- a 12 h observed window against a 14 d baseline. On the night it is wired that
-- window still contains the outage, so the arm reads CRITICAL on 11 lanes that are
-- ALREADY FIXED and recovering. Softening the threshold to hide that would be
-- permanent damage done to fix a transient reading — the failure this register
-- keeps paying for. An ack is the instrument built for exactly this: it downgrades
-- critical to warn, never to ok, renders the reason and the date in the report, and
-- COMES BACK ON ITS OWN when it lapses. Expiry 2026-09-13 12:00 PT = 19:00Z, which
-- is ~2 h of margin past the ~10:00 PT point where the 12 h window first excludes
-- the outage entirely.
--
-- WHAT A RED MEANS AFTER 2026-09-13 19:00Z: a caller has stopped calling, again.
-- Check the cron-job.org console for auto-disabled entries FIRST (#76 is the
-- worked example), then pg_cron, then the GHA schedule (#80).
--
-- REVERT: DELETE FROM public.sentinel_threshold_config WHERE check_name = 'Cadence Collapse';
--         (the arm then falls back to its hardcoded 1 / 5 with no ack, i.e. it pages)

INSERT INTO public.sentinel_threshold_config (check_name, warn_at, crit_at, enabled, ack_reason, ack_expires_at, note)
VALUES (
  'Cadence Collapse',
  1,
  5,
  true,
  'The nine cron-job.org entries auto-disabled on 2026-09-10 by the Vercel spend-cap pause were re-enabled from the console 2026-09-12 ~21:55 PT and are confirmed running green. The 11 lanes this arm reads as degraded are downstream of those entries and are already recovering; the arm''s 12h observed window simply still contains the outage. Owner: Claude/Trevor, known-issues #76 and #80. Nothing to do — if this is still critical after the expiry below, a caller has stopped calling AGAIN and the console is the first place to look.',
  '2026-09-13T19:00:00Z',
  'Wired 2026-09-12. warn_at 1 = a lane problem; crit_at 5 = a caller problem (the 2026-09-10 event read 11). Ack lapses 2026-09-13 12:00 PT, ~2h after the 12h window first clears the outage.'
)
ON CONFLICT (check_name) DO UPDATE SET
  warn_at = EXCLUDED.warn_at,
  crit_at = EXCLUDED.crit_at,
  enabled = EXCLUDED.enabled,
  ack_reason = EXCLUDED.ack_reason,
  ack_expires_at = EXCLUDED.ack_expires_at,
  note = EXCLUDED.note,
  updated_at = now();

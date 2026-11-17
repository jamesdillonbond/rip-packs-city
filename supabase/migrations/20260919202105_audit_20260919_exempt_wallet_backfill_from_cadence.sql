-- The seven `wallet-backfill*` lanes were driving Cadence Collapse to CRITICAL
-- (crit_at = 5) on their own: ratios 0.274-0.372 against a 0.40 threshold, all
-- against an identical baseline_per_day of 526.5.
--
-- ⚠ `offers-sweep` is deliberately NOT exempted here. It lands in `stopped`, and
-- lib/sentinel/cadence-collapse.ts scores ONLY `degraded` -- "stopped IS REPORTED
-- AS CONTEXT AND NEVER SCORED". It was never contributing to the severity, so
-- exempting it would suppress a line that costs nothing and is genuinely useful
-- context. Its retirement is recorded in known-issues #81.
INSERT INTO public.cadence_exempt_lanes (pipeline_pattern, reason, evidence, review_by)
VALUES (
  'wallet-backfill%',
  'Run count is DEMAND, not cadence. These lanes fire when a wallet needs indexing — there is no fixed schedule for them to collapse away from, so observed/baseline measures how many people pasted a wallet, and a quiet day reads as a fleet failure.',
  'Measured 2026-09-19 PT. Trigger is /api/public/queue-wallet (anon-reachable; fired when a visitor pastes an address on /share), the same orchestrator a signed-in user triggers, plus the 4x/day GHA backstop wallet-backfill-backstop.yml (cron 38 2,8,14,20). NO pg_cron job writes any wallet-backfill* pipeline (cron.job scanned). The lanes are demonstrably alive, not stalled: wallet-backfill-allday wrote 20,757 / 8,227 / 27,239 rows on 09-17 / 09-18 / 09-19 and its ok rate is 315/317. So the 0.274-0.372 ratio is lower demand against a 526.5/day baseline set in a busier fortnight, not a lane running below its own cadence.',
  DATE '2026-12-19'
)
ON CONFLICT (pipeline_pattern) DO NOTHING;

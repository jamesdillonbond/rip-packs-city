-- ─────────────────────────────────────────────────────────────────────────────
-- jobid 466: `*/5` → `1-56/5`. Same cadence, one minute later, off the
-- congested boundary.
--
-- ── WHY. MY OWN */5 PUT IT ON THE WORST MINUTE IN THE HOUR ──────────────────
-- `20260920164900` moved this job to `*/5`, i.e. minutes 0,5,10,…,55 — every
-- one of them a multiple of five, which is where the most jobs in the estate
-- fire at once. Observed live 2026-09-20:
--   10:25  4 startup timeouts, 1 ok
--   10:26  8 startup timeouts, 0 ok
--   10:30  8 startup timeouts, 0 ok
-- Whole minutes in which NOTHING starts. This is the pg_cron launcher blackout
-- filed 2026-09-20 01:14–01:45: disk saturation at a minute boundary stops the
-- background worker from being started at all, so it is not the job's own cost
-- and no budget can fix it. jobid 466's first two ticks under the new 240 s
-- budget (`20260920175200`) were both lost this way — the budget fix has still
-- not actually been exercised.
--
-- ── MEASURED, NOT GUESSED (12 h, all jobs, by minute mod 5) ─────────────────
--   ≡0: 863 runs,  79 startup timeouts  → 9.15 %   ← where */5 put us
--   ≡1: 926 runs,  53 startup timeouts  → 5.72 %   ← best
--   ≡2: 1226 runs, 109 startup timeouts → 8.89 %
--   ≡3: 946 runs,  61 startup timeouts  → 6.45 %
--   ≡4: 958 runs,  61 startup timeouts  → 6.37 %
-- A 37 % reduction in blackout probability for a one-minute shift, and free.
--
-- ⚠ ≡1 IS ALSO THE ONLY OFFSET THAT KEEPS THE DIAGNOSTIC ALIVE. The tick
-- samples its two ~400k-row diagnostic counts on `minute % 30 < 2`, i.e.
-- minutes 0, 1, 30, 31. `1-56/5` fires on 1, 6, 11, …, 56 — hitting 1 and 31,
-- so the diagnostic still runs exactly twice an hour. `2-57/5` or `3-58/5`
-- would have silently killed it forever, and the tick would have published
-- `unmapped: null` on every run with nothing to say why. Check what a schedule
-- change does to any clock-derived sampling INSIDE the job before moving it.
--
-- EXIT: ticks start (no `job startup timeout`), a tick completes ok=true under
--       the 240 s budget, and `ts_listings.max(ingested_at)` un-freezes from
--       09:01 PT and tracks the events table.
-- FALSIFIER: if blackouts continue at ≡1, minute-of-hour is not the axis and
--       the estate's launcher pressure is broader — measure per absolute minute
--       before moving anything again, and do NOT keep shuffling slots.
-- REVERT: select cron.schedule('rpc-ts-listings-atlas-sync', '*/5 * * * *',
--           'SET statement_timeout = ''240s''; SELECT public.atlas_listing_verify_tick(2)');
-- ─────────────────────────────────────────────────────────────────────────────
SELECT cron.schedule(
  'rpc-ts-listings-atlas-sync',
  '1-56/5 * * * *',
  'SET statement_timeout = ''240s''; SELECT public.atlas_listing_verify_tick(2)'
);

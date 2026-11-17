-- Re-suppress the golazos_offers cursor_stalled HIGH false-positive.
--
-- WHY THIS IS AN UPSERT AND NOT THE ORIGINAL INSERT. The 2026-07-28 migration
-- (audit_20260728_suppress_golazos_offers_cursor_stalled_staged_inert) used
-- `ON CONFLICT (pipeline) DO NOTHING`, correct then because no row existed. A row
-- EXISTS now and is EXPIRED (2026-08-27 08:09:14Z), and get_pipeline_alerts_core
-- selects active suppressions as `expires_at IS NULL OR expires_at > NOW()` — so a
-- repeat of DO NOTHING would be a silent no-op leaving the alert firing. This is a
-- DO UPDATE by construction.
--
-- THE LAPSE WAS THE DESIGN, AND I AM THE RE-EVALUATOR IT ASKED FOR. The original
-- row was bounded 30d with the note "if still inert at expiry it re-fires for
-- re-evaluation". It lapsed 2026-08-27 08:09Z and has paged HIGH (Telegram+email
-- via /api/check-alerts) roughly every ~80 min for ~27h since.
--
-- PREDICATE THAT JUSTIFIES THIS ROW — re-check it rather than trusting this text.
-- Both halves VERIFIED LIVE 2026-08-28 11:08Z inside a rolled-back DO block whose
-- assertions would have aborted the apply had either failed:
--   (1) event_cursor('golazos_offers').updated_at is 754.1 h old — untouched since
--       the single manual seeding tick 2026-07-28 01:01:34Z at block 159,452,130;
--   (2) pipeline_runs holds ZERO 'golazos-offers-indexer' rows over its full ~73 h
--       retention window.
-- Scheduler re-derived from source, not from the prior note: absent from vercel.json
-- (35 crons, none matching), absent from .github/workflows (10 scheduled workflows,
-- none matching), absent from docs/operations/cron-schedule.md. Still staged-inert.
--
-- WHAT IS NOT LOST. This row is keyed to the UNDERSCORED cursor name only. No
-- pipeline_cadence_watchlist row exists for this pipeline, and the failure_rate arm
-- keys on the HYPHENATED 'golazos-offers-indexer' — so the moment the indexer is
-- ever scheduled and fails, that arm reports, unaffected by this row.
--
-- RESIDUAL RISK, accepted deliberately: while this row is live the cursor_stalled
-- arm cannot report on golazos_offers at all. That is nil in practice — a pipeline
-- with no scheduler cannot produce a different fault — and is bounded by the expiry.
--
-- BOUND 90d, NOT 30d and NOT PERMANENT, stated rather than buried. Permanent is
-- wrong: unlike the twins made permanent (topshot_flowty_backfill, allday_pack_opens_backfill,
-- the spork-floor family) this cursor is NOT structurally stuck — it advances the
-- moment anyone wires the indexer. Another 30d is also wrong: the last 30d bound
-- bought no decision and cost a 27h page storm on lapse. 90d lapses 2026-11-26.
--
-- ⛔ THE DECISION IS STILL TREVOR'S AND THIS ROW DOES NOT MAKE IT. Two permanent
-- exits exist: schedule golazos-offers-indexer (go-live; remove this row as part of
-- that work), or DELETE the event_cursor row — which removes the alert at its source
-- but discards resume block 159,452,130, deliberately left advanced on 2026-07-28 so
-- a future wiring is ~3 catch-up ticks instead of a walk from 0.
--
-- Revert: DELETE FROM public.pipeline_alert_suppression WHERE pipeline = 'golazos_offers';
--   (or restore the lapsed state exactly:
--    UPDATE public.pipeline_alert_suppression SET expires_at = '2026-08-27 08:09:14.86708+00'
--    WHERE pipeline = 'golazos_offers';)
-- Target metric: get_pipeline_alerts() carries no golazos_offers cursor_stalled row.

INSERT INTO public.pipeline_alert_suppression (pipeline, reason, added_at, expires_at)
VALUES (
  'golazos_offers',
  'Staged-INERT golazos-offers-indexer (mirror of live allday-offers-indexer, shipped 2026-07-28 for parity/coverage). RE-SUPPRESSED 2026-08-28 after the original 30d row lapsed 2026-08-27 08:09Z and paged HIGH for ~27h. PREDICATE THAT JUSTIFIES THIS ROW (re-check it, do not trust this text): (1) event_cursor(''golazos_offers'') must still be frozen at the 2026-07-28 01:01:34Z seeding tick (block 159452130) — measured 754.1h old on 2026-08-28; (2) pipeline_runs must hold ZERO ''golazos-offers-indexer'' rows over its full ~73h retention — measured 0. Scheduler re-derived from source 2026-08-28, not copied from the prior note: not in vercel.json (35 crons), not in .github/workflows (10 scheduled workflows), not in docs/operations/cron-schedule.md. No surface consumes Golazos offers; the live sibling cursors topshot_offers/allday_offers are fresh (0.2h). WHAT IS NOT LOST: this row is keyed to the UNDERSCORED cursor name; the failure_rate arm keys on the HYPHENATED pipeline name, so a scheduled-then-failing indexer still reports. BOUNDED 90d rather than permanent BECAUSE THIS CURSOR IS NOT STRUCTURALLY STUCK — unlike the spork-floor twins it advances the moment the indexer is wired; and rather than 30d because the last 30d bound bought no decision and cost a page storm on lapse. Lapses 2026-11-26. DECISION STILL PENDING (Trevor): schedule the indexer at Golazos-offers go-live and remove this row, or DELETE the event_cursor row — which kills the false positive permanently but discards resume block 159452130, left advanced on purpose so a future wiring is ~3 catch-up ticks not a walk from 0. Revert: DELETE FROM public.pipeline_alert_suppression WHERE pipeline = ''golazos_offers'';',
  now(),
  now() + interval '90 days'
)
ON CONFLICT (pipeline) DO UPDATE
  SET reason     = EXCLUDED.reason,
      added_at   = EXCLUDED.added_at,
      expires_at = EXCLUDED.expires_at;
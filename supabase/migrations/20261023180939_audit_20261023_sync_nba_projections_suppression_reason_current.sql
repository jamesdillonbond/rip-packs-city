-- audit_20261023_sync_nba_projections_suppression_reason_current
-- The pipeline_alert_suppression row for sync-nba-projections says "Do NOT retire the pipeline: it is
-- the SOLE writer for nba_games". False since 2026-10-23: the ESPN pg_net lane nba-espn-projections
-- (pg_cron 783/784) writes nba_games and nba_player_projections hourly. A suppression is a claim, so
-- its text is brought up to date. expires_at is deliberately NOT moved (2026-10-28 00:00 UTC =
-- 2026-10-27 5 PM PT): when it lapses, the failure-rate arm honestly reports a lane that still fails,
-- which stays true until Trevor disables its cron-job.org caller (job 7568448).
-- Revert: none needed (text only); the previous text is in 20260813 history and in this file's header.
update public.pipeline_alert_suppression
   set reason = 'UPDATED 2026-10-23: SUPERSEDED, NOT SOLE WRITER. The free ESPN lane nba-espn-projections (pg_net, pg_cron 783 dispatch :18 / 784 drain :21,:26; migrations 20261023153445..173727) writes nba_games and nba_player_projections hourly, and Fast Break reads the rankable row from any source (0262dd4). This edge lane (cron-job.org job 7568448, every 3 h) still fails all_upstreams_failed (DraftKings 502, ESPN 403 from edge egress); it is kept only because its DraftKings projections outrank ESPN''s if they ever answer, and the decision to disable its caller is Trevor''s (the console toggle was refused for the session). If DraftKings does answer it writes the same games under DK ids with NY/SA codes (duplicate slate rows) - another reason to disable it. EXPIRY KEPT at 2026-10-27 5 PM PT on purpose: after that the failure-rate arm reports this lane red, which is true until the caller is disabled. Predicate to re-check: error = all_upstreams_failed on every run. Original 2026-08-13 reason (offseason + WAF-blocked upstreams, D28) is superseded by this text.'
 where pipeline = 'sync-nba-projections';

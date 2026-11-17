-- (1) Remove 3 LAPSED alert suppressions (expires_at all in the past).
--   ingest-external-announcements (exp 2026-06-07) — subsystem gone
--   golazos_listings              (exp 2026-06-16) — superseded by the permanent pattern
--   pinnacle-resolve-buyers       (exp 2026-06-18) — its own note said "likely retired…
--     If still active, remove this row." Verified LIVE AND HEALTHY 2026-08-01:
--     181 runs/4d, 0 fail, 1,729 rows, watchlisted at medium/1440min reading ok.
-- Hygiene only — all three are already inert as suppressions.
DELETE FROM public.pipeline_alert_suppression
 WHERE pipeline IN ('ingest-external-announcements','golazos_listings','pinnacle-resolve-buyers');

-- (2) Re-arm the UFC FMV-staleness sentinel: it sat at breach_at 101 against a
-- value of 96.1 — a percentage metric with a >100 threshold is MATHEMATICALLY
-- UNBREACHABLE, i.e. an inert guard that reads green by construction. Its own
-- `catches` text says the threshold exists "so the metric catches further
-- DETERIORATION" from a 72.3 baseline, but it was raised 90 -> 101 while the value
-- climbed 72.3 -> 96.1. The underlying UFC state is HONEST (Flow UFC trading dead
-- since 2026-05-13, permanent — no sales means nothing to reprice), so this does
-- not page today at 98; it just restores the ability to fire.
-- Threshold is inline in the view, so this is a guarded regexp/replace off
-- pg_get_viewdef that ABORTS on no-match rather than silently no-op'ing, leaving
-- the other 22 metric arms byte-identical.
DO $mig$
DECLARE
  src text; out_src text;
  needle CONSTANT text := E'\'ufc_fmv_pct_stale_30d\'::text), 999::numeric) AS "coalesce",\n            101::numeric AS "numeric",';
  repl   CONSTANT text := E'\'ufc_fmv_pct_stale_30d\'::text), 999::numeric) AS "coalesce",\n            98::numeric AS "numeric",';
BEGIN
  SELECT pg_get_viewdef('public.v_rpc_trust_health'::regclass, true) INTO src;
  IF position(needle in src) = 0 THEN
    RAISE EXCEPTION 'ufc_fmv_pct_stale_30d breach_at anchor not found — aborting, nothing changed';
  END IF;
  out_src := replace(src, needle, repl);
  EXECUTE 'CREATE OR REPLACE VIEW public.v_rpc_trust_health AS ' || out_src;
  -- CREATE OR REPLACE VIEW wipes reloptions; re-assert.
  EXECUTE 'ALTER VIEW public.v_rpc_trust_health SET (security_invoker = on)';
END
$mig$;
-- audit_20261126_golazos_offers_suppression_permanent_by_decision
--
-- Claude Code cloud, 2026-11-26 ~8:30 AM PT (Trevor: "work through everything you can … leaving nothing unresolved").
-- The `golazos_offers` cursor-stall suppression becomes permanent (expires_at NULL), like the other retired lanes'
-- rows (topshot_listings, ufc_listings, backfill-topshot-base-parallel-probe). Until now it was re-bounded 30 d → 90 d
-- → 90 d "pending Trevor's decision", and each lapse paged HIGH (08-27 for ~27 h; 11-26 3:09 AM PT).
--
-- THE DECISION IT WAS WAITING ON IS ALREADY MADE, in the route header (app/api/golazos-offers-indexer/route.ts) and
-- known-issues.md: the 2026-07-28 recon found Golazos has NO DapperOffersV2 offers of either type (0 in a contiguous
-- 400k-block window, 0 in six spot samples; same-window positive control: All Day 142, Top Shot 1,979), so "do not
-- schedule it, and do not re-run the recon — re-test only by POSTing the existing inert route and reading
-- offersSeen". So the route stays unscheduled and the cursor stays frozen by design.
--
-- WHY NOT DELETE THE event_cursor ROW: the route reads it with `.single()`, which ERRORS on zero rows
-- ("cursor read error"), so a future re-test or wiring would fail instead of seeding. Keeping the row frozen at
-- block 159452130 (above the spork root 137390146) keeps the route working.
--
-- Re-derived live at apply: cursor frozen at 159452130 (updated 2026-07-27 6:01 PM PT); 0 pipeline_runs rows
-- matching %golazos%offer%; 0 pg_cron jobs; no vercel.json / .github reference. The failure-rate arm keys on the
-- HYPHENATED pipeline name, so a wired-then-failing indexer still pages.
--
-- REVERT: UPDATE public.pipeline_alert_suppression SET expires_at = '2027-02-24 14:03:59.216876+00' WHERE pipeline = 'golazos_offers';
-- (and restore the previous reason text from the 2026-11-26 ~6:05 AM PT ledger entry if needed).

DO $$
BEGIN
  IF (SELECT last_processed_block FROM public.event_cursor WHERE id = 'golazos_offers') IS DISTINCT FROM 159452130 THEN
    RAISE EXCEPTION 'golazos_offers cursor moved; the indexer may be wired — re-derive before making its suppression permanent';
  END IF;
END $$;

UPDATE public.pipeline_alert_suppression
   SET expires_at = NULL,
       reason = 'RETIRED BY DECISION (permanent since 2026-11-26): golazos-offers-indexer is deliberately UNSCHEDULED. The 2026-07-28 recon found Golazos has NO DapperOffersV2 offers of either type (route header app/api/golazos-offers-indexer/route.ts; known-issues.md "do not schedule it ... re-test only by POSTing the inert route and reading offersSeen"). The event_cursor row stays frozen at block 159452130 ON PURPOSE: the route reads it with .single() and would error without it. REMOVE THIS ROW THE DAY THE INDEXER IS SCHEDULED (from then on a frozen cursor IS a stall). PREDICATE (re-check, do not trust this text): cursor still at 159452130; 0 pipeline_runs rows for golazos-offers-indexer; no scheduler references it. The failure_rate arm keys on the hyphenated pipeline name, so a wired-then-failing indexer still pages. Migration audit_20261126_golazos_offers_suppression_permanent_by_decision.'
 WHERE pipeline = 'golazos_offers';

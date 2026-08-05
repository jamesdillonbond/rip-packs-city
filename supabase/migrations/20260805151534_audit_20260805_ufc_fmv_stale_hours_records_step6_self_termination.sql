-- 2026-08-05 · Record the MECHANISM behind ufc_fmv_stale_hours going permanently red.
-- Threshold and value deliberately UNCHANGED -- this migration installs no fix and no
-- re-baseline, it replaces a catches text that says "writers stalled" (implying a
-- defect to repair) with what actually happened. The retire-vs-rebase call is Trevor's.
--
-- THE MECHANISM, traced end to end and verified, not inferred:
--   Step 6 of /api/fmv-recalc (the force_stale liveness touch, route.ts ~1548) selects
--   `WHERE l.confidence IN ('HIGH','MEDIUM') AND rt.edition_id IS NULL` -- i.e. only
--   editions whose LATEST snapshot is HIGH/MEDIUM and which have NO in-window sales.
--   UFC's 15 editions (2 HIGH + 13 MEDIUM, zero priced sales since 2026-05-13) were
--   exactly that population, re-stamped once per day by the
--   `computed_at < now() - interval '24 hours'` gate. That gate is also what produced
--   the observed metronomic +20 min/day drift in first-write time.
--
--   On 2026-08-03 20:11:52Z Step 6 wrote them one final time -- and the BEFORE INSERT
--   trigger fmv_snapshots_cap_closed_market_confidence (shipped that same day) rewrote
--   confidence HIGH/MEDIUM -> STALE on insert, because collections.market_closed_at is
--   set for UFC. STALE fails Step 6's own IN ('HIGH','MEDIUM') predicate, so Step 6 can
--   never select those editions again. A SELF-TERMINATING LOOP: the writer switched
--   itself off, permanently, as a direct and CORRECT consequence of the closure work.
--
-- VERIFIED: UFC now has ZERO latest snapshots at HIGH or MEDIUM (314 NO_DATA /
-- 149 STALE across all algo versions), and the cap trigger guarantees any future
-- HIGH/MEDIUM write is capped on insert. There is no path back.
--
-- ⚠ CORRECTS A CLAIM MADE WHILE DIAGNOSING THIS: that the writer is UFC-specific and
-- this arm is "the only instrument covering it". IT IS NOT. Step 6 is explicitly
-- collection-agnostic (its own comment: "This is collection-agnostic, so it covers Top
-- Shot AND All Day in one shared fix"); it excludes only Pinnacle and tier ULTIMATE,
-- and runs daily for Top Shot, All Day, Golazos and Candy, each of which carries its
-- own freshness arm. Retiring or re-basing this arm therefore loses NO coverage of
-- Step 6. That was the main argument for keeping it red, and it does not hold.
--
-- ⚠ CREATE OR REPLACE VIEW drops reloptions; security_invoker=on is re-set below.
DO $mig$
DECLARE
  v_def text; v_new text; c_old text; c_new text;
BEGIN
  SELECT pg_get_viewdef('public.v_rpc_trust_health'::regclass, true) INTO v_def;

  c_old := 'ALL UFC FMV writers stalled (low-volume; daily sweep should keep <30h)';

  IF position(c_old in v_def) = 0 THEN
    RAISE EXCEPTION 'anchor not found: ufc_fmv_stale_hours catches text';
  END IF;

  c_new := 'UFC FMV is FROZEN BY DESIGN as of 2026-08-03 -- this arm is RED PERMANENTLY and that is not a defect to repair. MECHANISM, traced end to end 2026-08-05: the only writer keeping UFC snapshots fresh was Step 6 of /api/fmv-recalc, the force_stale liveness touch, which selects WHERE confidence IN (HIGH, MEDIUM) AND the edition has no in-window sales. UFC 15 editions (2 HIGH + 13 MEDIUM, zero priced sales since 2026-05-13) were exactly that set, re-stamped daily via the computed_at < now() - 24h gate -- which is also what produced the metronomic +20 min/day drift in first-write time, 01:11 to 04:09 across 07-29..08-03. On 2026-08-03 20:11:52Z Step 6 wrote them a final time and the BEFORE INSERT trigger fmv_snapshots_cap_closed_market_confidence, shipped the same day, rewrote HIGH/MEDIUM to STALE on insert because collections.market_closed_at is set for UFC. STALE fails Step 6 own predicate, so Step 6 can never select them again: a SELF-TERMINATING LOOP in which the writer switched itself off as a direct and correct consequence of the closure work. Verified: UFC now holds ZERO latest snapshots at HIGH or MEDIUM (314 NO_DATA, 149 STALE), and the cap trigger guarantees any future HIGH/MEDIUM write is capped on insert -- there is no path back, so this value grows without bound and NO threshold can make it green. RULED OUT while tracing, each checked not assumed: the 2026-08-05 sweep wedge (UFC last write 08-04 06:31Z, about 22h BEFORE the wedge window -- a plausible causal story adopted before checking the timeline permitted it, and it did not); the sweep itself (fmv_recalc_edition_page filters sold_at >= p_window_start and UFC has zero 30d sales, so it was NEVER a UFC writer); drain_fmv_cold_tail (healthy, and has written only All Day, Top Shot and Golazos in 6 days); and a write guard eating rows (of five BEFORE INSERT triggers only block_stale_ingest_algo drops, and only for algo_version LIKE 1.1.0%; these were 1.7.0). ALSO CORRECTED: the claim that this arm is the only instrument covering that writer. It is not -- Step 6 is collection-agnostic by its own design comment, excludes only Pinnacle and tier ULTIMATE, and runs daily for Top Shot, All Day, Golazos and Candy, all of which carry their own freshness arms. Retiring or re-basing this arm loses NO coverage of Step 6. USER-FACING HARM IS NIL: the market is closed, confidence is capped STALE, the UI renders FMV unavailable and the schema.org payload carries no offers. DECISION OWED (Trevor): retire this arm, or re-point it at something that can still move for a market closed since May. Precedent exists -- the ufc_sales CRITICAL alert arm was suppressed 2026-08-02 for exactly this reason, with the causation documented rather than the threshold weakened blindly. Do NOT simply raise breach_at: an unbounded value defers the crossing without making the reading honest.';

  v_new := replace(v_def, c_old, c_new);
  IF v_new = v_def THEN
    RAISE EXCEPTION 'no change produced -- refusing to replace the view';
  END IF;

  EXECUTE 'CREATE OR REPLACE VIEW public.v_rpc_trust_health AS ' || v_new;
  EXECUTE 'ALTER VIEW public.v_rpc_trust_health SET (security_invoker = on)';
END
$mig$;

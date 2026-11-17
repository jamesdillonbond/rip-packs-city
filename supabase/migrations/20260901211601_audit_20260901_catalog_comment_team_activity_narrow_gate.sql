-- Attach the 2026-09-01 analysis to the object itself, so a later pass reading the
-- catalog (not the docs) cannot re-derive a lever this pass already refuted.
-- REVERT: COMMENT ON FUNCTION public.get_team_activity(uuid,text,integer,integer) IS NULL;

COMMENT ON FUNCTION public.get_team_activity(uuid, text, integer, integer) IS
$c$Recent team sales for /<collection>/team/<slug> (Market Activity). Two candidate paths, gated on v_n_eds*(limit+offset) <= 2000.

MEASURED 2026-09-01 21:0x-21:1xZ, EXPLAIN (ANALYZE, BUFFERS) THROUGH the function:
  before -> after   detroit-shock (5 eds)  78,291 -> 4,241 buffers, 6,953 -> 21 ms
                    seattle-supersonics(36) 24,231 -> 5,219 buffers, 8,476 -> 22 ms
                    los-angeles-lakers(639)  5,537 -> 5,580 buffers, 36 -> 36 ms (ELSE path, unchanged control)
Cause: the wide path walks sales_YYYY_collection_id_sold_at_idx backwards and applies
edition_id = ANY(...) as a post-index Filter, so cost scales with team RARITY. For
detroit-shock the sales_2026 leg alone removed 98,725 rows by Filter to return 30, and
the 8s proconfig cap tripped -> the route degraded the section to an error state.

DO NOT RE-DERIVE, both refuted here with measurements:
 (1) plan_cache_mode = force_custom_plan -> IDENTICAL 78,291 total buffers. The wall-clock
     halving (6,953 -> 3,907 ms) was WARM CACHE only. Not a plan-shape problem.
 (2) Making the per-edition lateral UNCONDITIONAL -> los-angeles-lakers 20,706 buffers /
     4,643 ms, i.e. 3.7x MORE buffers and 129x SLOWER than the wide path. The lateral costs
     ~33 buffers/edition (3 points: 5->177, 36->1,170, 639->20,706). The gate is load-bearing;
     do not delete the ELSE branch.

EQUIVALENCE (verified 2026-09-01 over 18 captured cases across 5 collections): the two paths
return the SAME ROW SET; the only differences are the ORDER of rows sharing an identical
sold_at, which neither path has ever specified (no tiebreak in either). Every case with zero
tied sold_at values was byte-identical; every differing case had ties. All outputs sorted
sold_at DESC. Baselines: public.audit_20260901_team_activity_baseline.$c$;
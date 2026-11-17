-- audit_20260902_pack_reality_ranker_staleness_so_an_empty_board_stops_claiming_the_market_is_empty
--
-- anon-exec: none for public.v_topshot_pack_reality_ranker_staleness — a NEW view
-- lands with default PUBLIC access, so it is explicitly REVOKEd from PUBLIC/anon/
-- authenticated below and GRANTed only to postgres + service_role. It is read
-- solely by app/api/public/insights/pack-reality/route.ts, which uses the admin
-- client, so no anon grant is needed. security_invoker=on is set explicitly (a
-- later CREATE OR REPLACE with no WITH clause silently strips it).
--
-- WHY
-- /insights/pack-reality's "Honest +EV ranker" renders "No +EV packs right now."
-- when its board returns zero rows and the read SUCCEEDED. That is a claim about
-- the MARKET. Measured 2026-09-01 ~19:2x PT it is FALSE:
--
--   pack_ev_latest, Top Shot ......................... 1,210 rows, freshest 03:13Z
--   ...positive EV .......................................... 61
--   ...priced, non-reward, with a dist_id .................... 34
--   ...under 90% depleted, FMV coverage >= 40% ............... 3
--   ...AND snapshotted within 48h ............................ 0   <- the whole loss
--
-- The three survivors are 106.9h, 113.3h and 130.3h old, all price_source
-- 'secondary' — their secondary-ask source is the dead public-api.nbatopshot.com
-- endpoint (known-issues #50, and the 530 class). So the board is empty ONLY
-- because its inputs are stale, and the page states the opposite as fact. This is
-- the platform's top defect class ("a failed read must not render as an answer"),
-- with the twist that the READ is fine and the SOURCE is stale — a third state
-- the page could not see, because nothing told it.
--
-- WHAT THIS IS
-- The MV's own filter with the 48-hour freshness clause REMOVED, aggregated to a
-- single row. It answers exactly one question: "if the ranker is empty, is that
-- because nothing qualifies, or because everything that qualifies is stale?"
--
-- ⚠⚠ COUPLING, STATED LOUDLY BECAUSE IT IS DUPLICATED ON PURPOSE.
-- Every predicate below is copied from mv_topshot_pack_reality_top_ev except
-- `snapshotted_at >= now() - interval '48 hours'`. If you change that MV's
-- filter, CHANGE THIS VIEW IN THE SAME MIGRATION or it silently starts answering
-- a different question — and the page will explain an empty board with a number
-- that no longer describes it. The alternative (make this view the base and have
-- the MV select from it) needs a DROP + CREATE of a live, cron-refreshed MV with
-- indexes, which is a bigger blast radius than the duplication; that trade was
-- made deliberately, not overlooked.
--
-- REVERT: DROP VIEW IF EXISTS public.v_topshot_pack_reality_ranker_staleness;
--         Nothing depends on it until the route change ships; the drop is
--         unconditional and complete.

CREATE OR REPLACE VIEW public.v_topshot_pack_reality_ranker_staleness
WITH (security_invoker = on) AS
SELECT
  count(*)::int                                   AS qualifying_ignoring_freshness,
  max(pev.snapshotted_at)                         AS newest_qualifying_snapshot,
  count(*) FILTER (
    WHERE pev.snapshotted_at >= now() - interval '48 hours'
  )::int                                          AS qualifying_and_fresh
FROM pack_ev_latest pev
LEFT JOIN pack_distributions_v pdv
  ON pdv.collection_id = pev.collection_id
 AND pdv.dist_id       = pev.dist_id
WHERE pev.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid
  AND pev.is_positive_ev = true
  AND COALESCE(pev.pack_price, 0::numeric) > 0::numeric
  AND COALESCE(pdv.is_reward_pack, false) = false
  AND pev.dist_id IS NOT NULL
  AND COALESCE(pev.depletion_pct::integer, 100) < 90
  AND COALESCE(pev.fmv_coverage_pct::integer, 0) >= 40;

REVOKE ALL ON public.v_topshot_pack_reality_ranker_staleness FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.v_topshot_pack_reality_ranker_staleness TO postgres, service_role;

COMMENT ON VIEW public.v_topshot_pack_reality_ranker_staleness IS
  'One row. mv_topshot_pack_reality_top_ev''s filter MINUS its 48h freshness clause, so /insights/pack-reality can tell "nothing qualifies" (an honest market answer) from "everything that qualifies is stale" (a claim about our pipeline, not the market). Measured 2026-09-01: 3 qualifying, all 107-130h old, so the board was empty and the page said "No +EV packs right now." ⚠ Its predicates are COPIED from that MV and must be changed with it.';
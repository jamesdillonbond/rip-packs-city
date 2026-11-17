-- 2026-09-24 (PT) — audit: /dashboard/packs printed "EV $0" on pack rows whose
-- distribution has NO EV — Trevor's own history showed "Metallic Gold LE
-- Standard Pack · EV $0 · Last $46.00" and four "Rookie Revelation Standard
-- Pack · EV $0" rows. `mv_pack_ev_latest` stores a SENTINEL row for a dist the
-- computer could not price (gross_ev = 0 AND edition_count = 0; 294 of 1,858
-- rows at the time of writing, every one with fmv_coverage_pct NULL and
-- total_unopened 0). The public `pack_table_rows` view already NULLs pack_ev on
-- that sentinel and gates on fmv_coverage_pct >= 25; `get_wallet_pack_history`
-- LEFT JOINed the MV raw and published the sentinel as a measured $0 EV — the
-- fabricated-zero shape (CLAUDE.md "Honesty": a failed read must not render
-- as an answer).
--
-- Change: a GUARDED SPLICE of the live function body (never a paste of a
-- stale dump — the 20 KB body was rewritten twice on 09-20). The join now
-- mirrors pack_table_rows' two publish gates. RAISEs if the anchor is not found
-- exactly once, so a drifted body cannot be silently rewritten.
--
-- Revert: re-apply the join without the two added predicates (the anchor
-- text below, unchanged). Grants/ownership untouched by CREATE OR REPLACE.

DO $$
DECLARE
  v_def    text;
  v_anchor text := E'    LEFT JOIN public.mv_pack_ev_latest ev\n      ON p.dist_id IS NOT NULL\n     AND ev.dist_id = p.dist_id AND ev.collection_id = p.collection_id\n';
  v_new    text := E'    LEFT JOIN public.mv_pack_ev_latest ev\n      ON p.dist_id IS NOT NULL\n     AND ev.dist_id = p.dist_id AND ev.collection_id = p.collection_id\n     -- 2026-09-24: mirror pack_table_rows'' publish gates — the MV''s sentinel\n     -- (gross_ev = 0 AND edition_count = 0) is "could not price", not "$0".\n     AND NOT (ev.gross_ev = 0 AND ev.edition_count = 0)\n     AND (ev.fmv_coverage_pct IS NULL OR ev.fmv_coverage_pct >= 25)\n';
  v_n      int;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'get_wallet_pack_history';
  IF v_def IS NULL THEN
    RAISE EXCEPTION 'get_wallet_pack_history not found';
  END IF;
  v_n := (length(v_def) - length(replace(v_def, v_anchor, ''))) / length(v_anchor);
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'get_wallet_pack_history: expected the mv_pack_ev_latest join anchor exactly once, found %', v_n;
  END IF;
  IF position('AND NOT (ev.gross_ev = 0 AND ev.edition_count = 0)' IN v_def) > 0 THEN
    RAISE NOTICE 'get_wallet_pack_history: sentinel gate already present — no-op';
    RETURN;
  END IF;
  v_def := replace(v_def, v_anchor, v_new);
  EXECUTE v_def;
END $$;

-- Post-condition: the gate is in the live body, and no page row can carry a
-- sentinel EV any more.
DO $$
DECLARE v_src text;
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc WHERE proname = 'get_wallet_pack_history';
  IF position('AND NOT (ev.gross_ev = 0 AND ev.edition_count = 0)' IN v_src) = 0 THEN
    RAISE EXCEPTION 'get_wallet_pack_history: sentinel gate missing after splice';
  END IF;
END $$;

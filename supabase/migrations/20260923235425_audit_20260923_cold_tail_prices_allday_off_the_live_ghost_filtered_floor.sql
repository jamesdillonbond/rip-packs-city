-- audit_20260923_cold_tail_prices_allday_off_the_live_ghost_filtered_floor
--
-- The "next writer to re-point" named by 20260923220355 (job 19's re-cap): drain_fmv_cold_tail's
-- ASK_ONLY branch (an edition with no sale in 30 days) priced EVERY collection off
-- `badge_editions.low_ask`. For NFL All Day that is neither live nor ghost-filtered, so after 7
-- quiet days the drain could re-write an All Day price above today's buy-it-now, or from a
-- listing that had already sold (a ghost) — the two defects 20260923011039 / 20260923220355 closed
-- for every OTHER All Day ASK_ONLY writer. Job 19 re-capped it within 6 h; this removes the need.
-- Measured 2026-09-23 ~5 PM PT: 457 All Day editions' latest snapshot is a cold-tail ASK_ONLY
-- row, 0 above the live floor and 2 with NO live floor at all (a price from an ask that is gone).
--
-- CHANGE (All Day only): the ask is read from `allday_edition_floor_ask` — the ghost-filtered live
-- floor every other All Day ASK_ONLY writer reads — with the same ($0, $10,000] bounds. No live,
-- non-ghost ask ⇒ NULL ⇒ the edition falls through to the existing STALE (historical sales) /
-- NO_DATA branches, exactly as for an edition with no ask today. That is the 2026-09-22 rule:
-- an ASK_ONLY price whose only input is gone publishes nothing. Every other collection keeps
-- `badge_editions.low_ask` unchanged.
-- Cost: the per-edition read pushes edition_id into idx_cl_v2_edition — ~12 buffers.
--
-- Built from the LIVE pg_get_functiondef() by a guarded splice (RAISE unless the anchor appears
-- exactly once); CREATE OR REPLACE of the same signature keeps SECURITY DEFINER, proconfig and ACL.
--
-- REVERT: the same splice in reverse (replace the IF/ELSE block below with its ELSE arm), or
-- re-apply the body from 20260826043000.
--
-- anon-exec: unchanged (drain_fmv_cold_tail) — CREATE OR REPLACE of an existing fn keeps its ACL; verified has_function_privilege anon=false, authenticated=false on 2026-09-23.

DO $mig$
DECLARE
  def text;
  anc text;
  n   int;
BEGIN
  SELECT pg_get_functiondef('public.drain_fmv_cold_tail(text, integer)'::regprocedure) INTO def;

  anc := E'      SELECT b.low_ask INTO v_ask_floor\n'
      || E'      FROM editions e\n'
      || E'      JOIN badge_editions b\n'
      || E'        ON b.external_id = e.external_id AND b.collection_id = e.collection_id\n'
      || E'      WHERE e.id = v_edition_row.edition_id\n'
      || E'        AND b.low_ask > 0 AND b.low_ask <= 10000\n'
      || E'      ORDER BY b.low_ask ASC\n'
      || E'      LIMIT 1;\n';
  n := (length(def) - length(replace(def, anc, ''))) / length(anc);
  IF n <> 1 THEN RAISE EXCEPTION 'cold-tail ask anchor found % times, want 1', n; END IF;

  def := replace(def, anc,
         E'      -- All Day: the live, ghost-filtered floor (20260923 re-point). No live ask => NULL\n'
      || E'      -- => falls through to STALE / NO_DATA below, never a price from a gone ask.\n'
      || E'      IF v_collection_id = ''dee28451-5d62-409e-a1ad-a83f763ac070''::uuid THEN\n'
      || E'        SELECT f.floor_ask INTO v_ask_floor\n'
      || E'        FROM allday_edition_floor_ask f\n'
      || E'        WHERE f.edition_id = v_edition_row.edition_id\n'
      || E'          AND f.floor_ask > 0 AND f.floor_ask <= 10000;\n'
      || E'      ELSE\n'
      || replace(anc, E'\n      ', E'\n        ') -- the unchanged badge_editions read, re-indented
      || E'      END IF;\n');

  EXECUTE def;
END
$mig$;

-- audit_20260904_get_top_movers_excludes_stale_current_prices
-- Applied to prod via MCP apply_migration 2026-09-04 04:14Z (version 20260904041433). Superseded
-- minutes later by 20260904041544 (same finding, second cut) — kept because prod carries this
-- version and migration parity matches by NAME.
--
-- FINDING (2026-09-04 new-user walk, founder's own wallet as the control): every one of the five
-- "BIGGEST GAINERS" the public profile's Top Movers panel published was a STALE-confidence price —
-- LeBron Anthology $2,250 -> $5,434 (+141%), Carmelo Holo Icon $90 -> $2,693 (+2,892%), Zion Holo
-- MMXX $720 -> $3,400 (+372%). None of those editions traded in the window; the "move" is the cold-tail
-- re-pricing of an edition with no recent sales. A STALE price is by definition unsupported by recent
-- market activity, so ranking it as a 7-day gainer/loser is a false claim of market movement.
--
-- FIX: the CURRENT side of the comparison must be a live-confidence price. STALE and NO_DATA are
-- excluded; ASK_ONLY/SALES_ONLY/LOW stay (they are market-backed, if thin). Past side unchanged.
-- Shape: guarded splice on the live definition (ACL/SECURITY/search_path carried by pg_get_functiondef).
-- anon-exec: unchanged (get_top_movers) — splice, same signature; anon/authenticated EXECUTE stand as before.
--
-- REVERT: run the same block with v_old/v_new swapped, i.e.
--   v_old := 'WHERE l.fmv_usd IS NOT NULL AND p.fmv_usd IS NOT NULL AND l.confidence NOT IN (''STALE'',''NO_DATA'')'
--   v_new := 'WHERE l.fmv_usd IS NOT NULL AND p.fmv_usd IS NOT NULL'
DO $mig$
DECLARE v_def text; v_def2 text; v_hits int;
  v_old text := $old$WHERE l.fmv_usd IS NOT NULL AND p.fmv_usd IS NOT NULL$old$;
  v_new text := $new$WHERE l.fmv_usd IS NOT NULL AND p.fmv_usd IS NOT NULL
      -- 2026-09-04: a STALE/NO_DATA current price is not a market move (see migration header)
      AND l.confidence NOT IN ('STALE','NO_DATA')$new$;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='get_top_movers';
  IF v_def IS NULL THEN RAISE EXCEPTION 'get_top_movers not found'; END IF;
  v_hits := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
  IF v_hits <> 1 THEN RAISE EXCEPTION 'expected 1 anchor occurrence, found %', v_hits; END IF;
  v_def2 := replace(v_def, v_old, v_new);
  IF v_def2 = v_def THEN RAISE EXCEPTION 'replacement was a no-op'; END IF;
  EXECUTE v_def2;
END $mig$;

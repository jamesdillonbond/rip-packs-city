-- v1 aborted on a wrong anchor (the probe uses `format('… FROM %s', v_reg)`, not
-- `%I` + the name) — the guard did exactly its job and changed nothing. Real anchor used here.
--
-- (1) LATENT HAZARD: one slow board can age EVERY precomputed metric.
-- The probe already wraps each view in BEGIN/EXCEPTION, but an exception handler
-- cannot save the caller from a STATEMENT TIMEOUT: the 12:58 refresh died at
-- 600,095 ms inside `count(*) FROM cross_collection_deals_board` and ROLLED BACK
-- ALL 11 LEGS (a function cannot COMMIT mid-body). It self-heals — 6h cadence vs a
-- 24h staleness window tolerates 3 misses — but `fmv_sanity_flags` was just moved
-- onto this same refresher, so one pathological board now has a bigger blast radius.
-- Fix: give each per-view probe its OWN statement_timeout (its max_ms + 50%,
-- floored 5s, capped 30s). A view that blows its budget now raises INSIDE the
-- existing per-view handler — recorded as slow/errored, which is correct and loud —
-- instead of killing the whole refresher.
--
-- (2) RECALIBRATION: `candy_holder_board` reads 6,169 ms against a 4,000 ms cap, so
-- public_board_slow_count = 1. The cap was 6x a single WARM sample. Measured after
-- today's three optimisation passes (82.3s -> 1.2s warm): ~1.2s warm, ~13s COLD —
-- the wmc index-only scan still does ~10.7k heap fetches on a hot table. Its real
-- consumer budget is the ~30s page read path, so 6.2s is healthy and the THRESHOLD
-- was wrong. 15,000 ms sits above the observed cold path and far under the page
-- budget, so a regression toward the pre-fix 82s still breaches. This is a
-- threshold moved to match a MEASURED distribution, not to silence a true finding.
UPDATE public.public_board_liveness_watchlist
   SET max_ms = 15000,
       note = coalesce(note,'') || ' | max_ms 4000->15000 on 2026-08-02: the 4s cap was 6x a single warm '
              || 'sample; measured 1.2s warm / ~13s cold (wmc index-only scan still ~10.7k heap fetches). '
              || 'Consumer budget is the ~30s page path, so 6.2s is healthy; a regression toward the '
              || 'pre-fix 82s still breaches.'
 WHERE view_name = 'candy_holder_board';

DO $mig$
DECLARE
  src text; out_src text;
  needle CONSTANT text := E'      BEGIN\n        EXECUTE format(''SELECT count(*) FROM %s'', v_reg) INTO v_cnt;';
  repl  CONSTANT text := E'      BEGIN\n        -- Bound THIS probe so a pathological view fails its own probe (recorded as\n        -- slow/errored -> BREACH) instead of timing out the whole refresher and\n        -- rolling back every precomputed metric. SET LOCAL scopes it to this block.\n        PERFORM set_config(''statement_timeout'', greatest(5000, least(30000, (r.max_ms * 1.5)::int))::text, true);\n        EXECUTE format(''SELECT count(*) FROM %s'', v_reg) INTO v_cnt;';
BEGIN
  SELECT pg_get_functiondef(oid) INTO src FROM pg_proc WHERE proname = 'public_board_liveness_probe';
  IF src IS NULL THEN RAISE EXCEPTION 'public_board_liveness_probe not found'; END IF;
  IF position('set_config(''statement_timeout''' in src) > 0 THEN
    RAISE NOTICE 'probe already bounded — skipping'; RETURN;
  END IF;
  IF position(needle in src) = 0 THEN
    RAISE EXCEPTION 'probe body anchor not found — aborting, nothing changed';
  END IF;
  out_src := replace(src, needle, repl);
  EXECUTE out_src;
END
$mig$;

REVOKE EXECUTE ON FUNCTION public.public_board_liveness_probe(integer) FROM PUBLIC, anon, authenticated;
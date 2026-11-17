-- 2026-09-25 (PT) — the Disney Pinnacle collection tab's tiles read "UNLOCKED
-- FMV $0 · 180 unlocked · LOCKED FMV $0 · 6 locked" on a wallet whose table
-- and headline sum $889.13: get_wallet_summary priced moments ONLY through
-- editions.external_id = wmc.edition_key → edition_fmv_current, and for
-- Pinnacle that join resolves 0 of 186 rows (Pinnacle's FMV is keyed
-- differently — the concierge's triple-join), so every FMV tile was a measured
-- zero of a value the cache carries (180 of 186 rows have wmc.fmv_usd).
-- get_wallet_total_fmv already falls back to wmc.fmv_usd; this makes the summary
-- agree with it. Guarded splice on the LIVE body (prosrc md5
-- 9f88bb64af6ec04371f55d05ce78f5c4); everything else byte-identical. ACL
-- untouched (this is an existing anon-executable read; CREATE OR REPLACE keeps
-- the ACL).
-- anon-exec: intentional — SPLICE of get_wallet_summary, an existing anon/authenticated read (its ACL is unchanged by CREATE OR REPLACE).
-- Revert: re-apply the previous defining migration of get_wallet_summary.
DO $$
DECLARE
  v_def text;
  v_a text := $a$      lf.fmv_usd,
      lf.confidence,$a$;
  v_n text := $a$      -- 2026-09-25: fall back to the cache's own FMV like get_wallet_total_fmv
      -- does — Pinnacle resolves 0 rows through edition_fmv_current.
      COALESCE(lf.fmv_usd, wmc.fmv_usd) AS fmv_usd,
      COALESCE(lf.confidence, wmc.fmv_confidence) AS confidence,$a$;
  v_c int;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'get_wallet_summary';
  IF v_def IS NULL THEN RAISE EXCEPTION 'get_wallet_summary not found'; END IF;
  v_c := (length(v_def) - length(replace(v_def, v_a, ''))) / length(v_a);
  IF v_c <> 1 THEN RAISE EXCEPTION 'fmv anchor found % times', v_c; END IF;
  EXECUTE replace(v_def, v_a, v_n);
END $$;
DO $$
DECLARE v json;
BEGIN
  v := public.get_wallet_summary('0xbd94cade097e50ac', '7dd9dd11-e8b6-45c4-ac99-71331f959714');
  IF (v->>'wallet_fmv')::numeric < 800 THEN
    RAISE EXCEPTION 'Pinnacle summary still prices nothing: %', v->>'wallet_fmv';
  END IF;
  -- no-change control: Top Shot's figure is the same number the tab already showed
  v := public.get_wallet_summary('0xbd94cade097e50ac', '95f28a17-224a-4025-96ad-adf8a4c63bfd');
  IF (v->>'wallet_fmv')::numeric < 50000 THEN
    RAISE EXCEPTION 'Top Shot summary regressed: %', v->>'wallet_fmv';
  END IF;
END $$;

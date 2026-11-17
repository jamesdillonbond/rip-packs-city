-- 2026-11-14 (PT, ~8:20 PM) — Candy re-verify + re-date (inbox 2026-11-15T0410Z,
-- daytime monitor "Candy revival overtaking the silent_since disposition").
--
-- READ (Claude Code, 8:00–8:20 PM PT): the revival arm read 9 / 10 — every Candy
-- sale on or after 11-12 PT: 11-12 x2 (2022 Leadoff ICONs $0.32, 2025 Candy
-- Ambassadors $0.08), 11-13 x2 (Absolute Superman #2 $14.45, Batman #423 $7.94),
-- 11-14 x5 (Superman (1939-2011) #1 $144.84 and $289.68, Absolute Batman #7
-- $156.51, Absolute Batman #9 $22.95 and $23.64 = $637.62). All Magic Eden, all
-- legacy candy-coll collections (DC comics + 2022/2025 ICONs), NONE in a 2026 set.
-- ~2 a day against 86-374 a day before 10-12: still a trickle, if a pricier one.
-- So, as on 11-10 / 11-11: re-date the silence to 11-14 (the arm counts from
-- 11-15) and advance last_verified_at.
--
-- NOT a revival signal, measured the same evening: candy_sales_stale_hours read
-- breach_at 0 because 1,175 sales were parked in candy_sales_unresolved at
-- 7:47–7:51 PM PT — one collection's first full-feed Magic Eden walk (the 6:35 PM
-- PT lookback change), sold 2026-08-17..10-10, reason queued_collections_walk,
-- attempts 1. That is history being backfilled, before the silence date, so it
-- cannot move this counter; the indexer drains 300 per tick.
--
-- Revert: this DO block with each (old, new) pair swapped and the guard md5 set
-- to this migration's output md5 (read it with pg_get_viewdef(..., true)).

DO $$
DECLARE
  d text := pg_get_viewdef('public.v_collection_marketplace_status'::regclass, true);
  o1 text := $o$'silent_since_2026_11_11'$o$;
  n1 text := $n$'silent_since_2026_11_14'$n$;
  o2 text := $o$'2026-11-13 03:22:00+00'$o$;
  n2 text := $n$'2026-11-15 04:20:00+00'$n$;
  o3 text := $o$still a trickle -- silent_since date kept, last_verified_at advanced. Facts live$o$;
  n3 text := $n$still a trickle -- silent_since date kept, last_verified_at advanced. RE-VERIFIED + RE-DATED 2026-11-14 8:20 PM PT (Claude Code): the arm read 9 of 10 -- 11-12 x2 ($0.40), 11-13 x2 ($22.39), 11-14 x5 (Superman (1939-2011) #1 $144.84 and $289.68, Absolute Batman #7 $156.51, #9 $22.95 and $23.64; $637.62); all Magic Eden, all legacy collections (DC comics, 2022/2025 ICONs), none in a 2026 set; about 2 a day against 86-374 a day before 10-12 -- still a trickle, though pricier, so the silence is re-dated to 11-14 and last_verified_at advanced. The 1,175 sales parked 11-14 7:47 PM PT by a first full-feed walk were sold 08-17 to 10-10: history, not new trading. Facts live$n$;
  frag text; nf text; n int; i int;
BEGIN
  IF md5(d) <> '9db48ffcbb8a7a98642df1e037575c06' THEN
    RAISE EXCEPTION 'v_collection_marketplace_status drifted (md5 %); re-derive before replacing', md5(d);
  END IF;
  FOR i IN 1..3 LOOP
    frag := CASE i WHEN 1 THEN o1 WHEN 2 THEN o2 ELSE o3 END;
    nf   := CASE i WHEN 1 THEN n1 WHEN 2 THEN n2 ELSE n3 END;
    n := (length(d) - length(replace(d, frag, ''))) / length(frag);
    IF n <> 1 THEN RAISE EXCEPTION 'fragment % found % times, expected 1', i, n; END IF;
    d := replace(d, frag, nf);
  END LOOP;
  EXECUTE 'CREATE OR REPLACE VIEW public.v_collection_marketplace_status WITH (security_invoker = true) AS ' || d;
  IF position(o1 in pg_get_viewdef('public.v_collection_marketplace_status'::regclass, true)) > 0 THEN
    RAISE EXCEPTION 'v_collection_marketplace_status was not rewritten';
  END IF;
  IF (SELECT count(*) FROM public.v_collection_marketplace_status) <> 7 THEN
    RAISE EXCEPTION 'v_collection_marketplace_status row count changed';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE oid = 'public.v_collection_marketplace_status'::regclass AND reloptions @> ARRAY['security_invoker=true']) THEN
    RAISE EXCEPTION 'security_invoker lost';
  END IF;
END $$;

-- ⚠ TIME NOTE (added to the file only): this was applied at 6:42 AM PT 11-20, not
-- "~6:50 AM" as written below and in the view's note; last_verified_at
-- (14:50Z) therefore sat 8 minutes ahead of the apply. Harmless (the stale-hours
-- arm no longer reads it once the status is not silent_since_*), left as applied.
--
-- 2026-11-20 (PT, ~6:50 AM) — Candy re-verified: trading RESUMED, so the recorded
-- silence is retired instead of re-dated a sixth time (inbox 2026-11-20T0705Z;
-- queued by the 11-20 overnight pass as a wording decision; Trevor 6:40 AM PT:
-- "leaving nothing from this thread unresolved").
--
-- READ (Cowork cloud, 6:45 AM PT): Candy sales by PT day — 11-16 x3, 11-17 x8,
-- 11-18 x13 ($17.98, 5 buyers), 11-19 x72 ($461.41, 17 buyers, 9 sellers, 70
-- editions, last 10:35 PM PT, incl. 2026 MLB Base Series ICONs); none yet on
-- 11-20. candy-sales-indexer 8 of 8 ok in 24 h. Seventeen buyers across 70
-- editions in a day is a market, not a wind-down trickle, so "silent_since" would
-- record a falsehood. secondary_status becomes thin_since_2026_11_19 (the Golazos
-- vocabulary). Effects, both by the arms' own definitions: the revival arm reads 0
-- (no closure recorded) and candy_sales_stale_hours returns to its 168 h backstop.
-- Not user-facing: status stays 'healthy', and notes render only for a non-healthy
-- status; no page reads secondary_status except the dormant_* Flowty chip.
--
-- Revert: this DO block with each (old, new) pair swapped and the guard md5 set
-- to this migration's output md5 (read it with pg_get_viewdef(..., true)).

DO $$
DECLARE
  d text := pg_get_viewdef('public.v_collection_marketplace_status'::regclass, true);
  o1 text := $o$'silent_since_2026_11_17'$o$;
  n1 text := $n$'thin_since_2026_11_19'$n$;
  o2 text := $o$'2026-11-19 01:40:00+00'$o$;
  n2 text := $n$'2026-11-20 14:50:00+00'$n$;
  o3 text := $o$last_verified_at advanced. Facts live$o$;
  n3 text := $n$last_verified_at advanced. RE-VERIFIED 2026-11-20 6:50 AM PT (Cowork cloud): TRADING RESUMED -- 11-18 x13 ($17.98, 5 buyers), 11-19 x72 ($461.41, 17 buyers, 9 sellers, 70 editions, including 2026 MLB Base Series ICONs), indexer 8 of 8 ok; that is a thin open market, not a dust trickle, so the recorded silence is RETIRED (secondary_status thin_since_2026_11_19) rather than re-dated a sixth time. With no silent_since recorded the revival arm reads 0 and candy_sales_stale_hours is back on its 7-day backstop: if Candy goes 7 days without a sale that arm breaches, and whoever re-verifies then decides whether to record a new silent_since. Facts live$n$;
  frag text; nf text; n int; i int;
BEGIN
  IF md5(d) <> '813bdb11a7c824252092d60f77ca3789' THEN
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
    RAISE EXCEPTION 'old status still present';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE oid = 'public.v_collection_marketplace_status'::regclass AND reloptions @> ARRAY['security_invoker=true']) THEN
    RAISE EXCEPTION 'security_invoker lost';
  END IF;
END $$;

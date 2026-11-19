-- 2026-11-18 (PT, ~5:40 PM) — Candy re-verify + re-date (inbox 2026-11-19T0105Z,
-- daytime monitor "Candy revival arm breached at 11 (floor 10) but the 11 counted
-- sales are a dust trickle").
--
-- READ (Claude Code cloud, 5:30–5:40 PM PT): every Candy sale since the 11-14
-- re-date (the arm counts from 11-15 PT): 11-16 x3 ($35.89, max $21.84: Action
-- Comics #23, Showcase #4, Superman #199), 11-17 x8 ($8.29, max $3.58: 2022
-- Leadoff ICONs, Teen Titans #12); 11-18 none so far. $44.18 in all, NONE in a
-- 2026 set, against 86-374 a day before 10-12. The indexer is healthy (ok=true on
-- its last 5 runs, 11-18 12:20Z-00:20Z), so the quiet 11-18 is not a capture gap.
-- Same disposition as 11-10 / 11-11 / 11-14: re-date the silence to 11-17 (the
-- arm counts from 11-18) and advance last_verified_at. Base md5 7e92b389… is the
-- 11-14 migration's output, unchanged since.
--
-- Revert: this DO block with each (old, new) pair swapped and the guard md5 set
-- to this migration's output md5 (read it with pg_get_viewdef(..., true)).

DO $$
DECLARE
  d text := pg_get_viewdef('public.v_collection_marketplace_status'::regclass, true);
  o1 text := $o$'silent_since_2026_11_14'$o$;
  n1 text := $n$'silent_since_2026_11_17'$n$;
  o2 text := $o$'2026-11-15 04:20:00+00'$o$;
  n2 text := $n$'2026-11-19 01:40:00+00'$n$;
  o3 text := $o$history, not new trading. Facts live$o$;
  n3 text := $n$history, not new trading. RE-VERIFIED + RE-DATED 2026-11-18 5:40 PM PT (Claude Code): the arm read 11 of 10 -- 11-16 x3 ($35.89, max $21.84; Action Comics #23, Showcase #4, Superman #199), 11-17 x8 ($8.29, max $3.58; 2022 Leadoff ICONs, Teen Titans #12), none 11-18; $44.18 in all, none in a 2026 set, indexer healthy -- a dust trickle, so the silence is re-dated to 11-17 and last_verified_at advanced. Facts live$n$;
  frag text; nf text; n int; i int;
BEGIN
  IF md5(d) <> '7e92b389e9c689187d3943ccc9eef534' THEN
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

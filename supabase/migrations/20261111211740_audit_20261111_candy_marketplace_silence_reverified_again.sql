-- audit_20261111_candy_marketplace_silence_reverified_again
--
-- WHY (Claude Code cloud, 2026-11-11 ~1:20 PM PT; scheduled follow-up of the 11-10 pass). The revival arm
-- candy_revival_sales_since_recorded_silence read 1 again: ONE Magic Eden sale, The Demon (1972-1973) #1, 0.195 SOL /
-- $16.62, sold 11-11 9:05 AM PT. Candy sales by PT day since the 10-12 lock: 11-07 3 ($2.70), 11-08 1 ($0.34), 11-09 1
-- ($0.17), 11-11 1 ($16.62) -- 6 sales / ~$20 in four weeks, against 86-374 a day before 10-12. Still a trickle, so the
-- arm's own prescription applies: re-verify and re-date the candy_mlb row. Same method as 20261110225146: the live
-- definition (md5 asserted) with its three candy_mlb literals replaced, each exactly once, old text asserted gone;
-- security_invoker re-specified; CREATE OR REPLACE keeps the ACL. Re-dating per stray sale is whack-a-mole -- the arm
-- itself should count a revival only above a floor (handoff queue item, not built here).
--
-- REVERT: the same DO block with old/new swapped (guard md5 = the post-change definition).

DO $$
DECLARE
  d text := pg_get_viewdef('public.v_collection_marketplace_status'::regclass, true);
  o1 text := $o$'silent_since_2026_11_10'$o$;
  n1 text := $n$'silent_since_2026_11_11'$n$;
  o2 text := $o$'2026-11-10 22:55:00+00'$o$;
  n2 text := $n$'2026-11-11 21:20:00+00'$n$;
  o3 text := $o$a sale on 11-11 or later trips the arm again.$o$;
  n3 text := $n$a sale on 11-11 or later trips the arm again. RE-VERIFIED + RE-DATED 2026-11-11 (PT, Claude Code cloud): one Magic Eden sale, The Demon (1972-1973) #1, 0.195 SOL / $16.62 on 11-11 9:05 AM PT; 6 sales / ~$20 in four weeks against 86-374 a day before 10-12 -- still a trickle, so the silence is re-dated to 11-11; a sale on 11-12 or later trips the arm again.$n$;
  frag text; nf text; n int; i int;
BEGIN
  IF md5(d) <> 'c3b994f7b7e8b8000f418f9950045f71' THEN
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
END $$;

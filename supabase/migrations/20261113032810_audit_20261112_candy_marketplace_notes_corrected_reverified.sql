-- audit_20261112_candy_marketplace_notes_corrected_reverified
--
-- WHY (Claude Code cloud, 2026-11-12 ~7:30 PM PT; scheduled read-only Candy check, then Trevor: "Address what you
-- can"). Two changes to the candy_mlb row of v_collection_marketplace_status, nothing else:
--   1. CORRECTION. The 11-11 note says ONE sale that day (The Demon #1, $16.62) and "6 sales / ~$20 in four weeks".
--      There were THREE on 11-11 (Absolute Batman #12 $11.03 7:58 AM PT, Absolute Batman #10 $16.65 8:02 AM PT, The
--      Demon #1 $16.62 9:05 AM PT; $44.30) -- the two Batman sales were indexed at 1:20 PM and 4:20 PM PT, around or
--      after that re-verify, so the note was written before they existed in `sales`.
--   2. RE-VERIFIED 11-12 7:22 PM PT. Since 11-11: one more sale, 2022 Leadoff ICONs $0.32 on 11-12 8:55 AM PT. Since
--      the 10-12 lock: 9 sales / ~$48 (11-07 onward), all Magic Eden, all legacy candy-coll-% collections, none in a 2026 set,
--      against 86-374 a DAY before 10-12. Still a trickle. candy-sales-indexer 8/8 ok in 24 h.
--      last_verified_at advances (it drives the 30-day re-verify clock in candy_sales_stale_hours).
--      secondary_status stays silent_since_2026_11_11 ON PURPOSE: since 20261112063348 the revival arm breaches at
--      10 sales, so a trickle no longer needs a re-date per sale; the arm keeps counting from 11-12 (reads 1 now).
-- Method = 20261111211740: the live definition (md5 asserted) with its candy_mlb literals replaced, each exactly
-- once; security_invoker re-specified; CREATE OR REPLACE keeps the ACL.
--
-- REVERT: the same DO block with old/new swapped (guard md5 = the post-change definition).

DO $$
DECLARE
  d text := pg_get_viewdef('public.v_collection_marketplace_status'::regclass, true);
  o1 text := $o$'2026-11-11 21:20:00+00'$o$;
  n1 text := $n$'2026-11-13 03:22:00+00'$n$;
  o2 text := $o$RE-VERIFIED + RE-DATED 2026-11-11 (PT, Claude Code cloud): one Magic Eden sale, The Demon (1972-1973) #1, 0.195 SOL / $16.62 on 11-11 9:05 AM PT; 6 sales / ~$20 in four weeks against 86-374 a day before 10-12 -- still a trickle, so the silence is re-dated to 11-11; a sale on 11-12 or later trips the arm again.$o$;
  n2 text := $n$RE-VERIFIED + RE-DATED 2026-11-11 (PT, Claude Code cloud): Magic Eden sales on 11-11 -- CORRECTED 11-12: three, not one (Absolute Batman #12 $11.03 7:58 AM, Absolute Batman #10 $16.65 8:02 AM, The Demon (1972-1973) #1 $16.62 9:05 AM PT; $44.30; the two Batman sales were indexed after this note was written); 8 sales / ~$48 in four weeks against 86-374 a day before 10-12 -- still a trickle, so the silence is re-dated to 11-11. Since 2026-11-11 the revival arm breaches at 10 sales, not 1. RE-VERIFIED 2026-11-12 7:22 PM PT (Claude Code cloud): one more sale, 2022 Leadoff ICONs $0.32 on 11-12 8:55 AM PT; 9 sales / ~$48 since 11-07 (none 10-13 to 11-06), all legacy collections, none in a 2026 set; still a trickle -- silent_since date kept, last_verified_at advanced.$n$;
  frag text; nf text; n int; i int;
BEGIN
  IF md5(d) <> '94f88ff57385151c4dfb9aef88ded5d2' THEN
    RAISE EXCEPTION 'v_collection_marketplace_status drifted (md5 %); re-derive before replacing', md5(d);
  END IF;
  FOR i IN 1..2 LOOP
    frag := CASE i WHEN 1 THEN o1 ELSE o2 END;
    nf   := CASE i WHEN 1 THEN n1 ELSE n2 END;
    n := (length(d) - length(replace(d, frag, ''))) / length(frag);
    IF n <> 1 THEN RAISE EXCEPTION 'fragment % found % times, expected 1', i, n; END IF;
    d := replace(d, frag, nf);
  END LOOP;
  EXECUTE 'CREATE OR REPLACE VIEW public.v_collection_marketplace_status WITH (security_invoker = true) AS ' || d;
  IF position(o2 in pg_get_viewdef('public.v_collection_marketplace_status'::regclass, true)) > 0 THEN
    RAISE EXCEPTION 'v_collection_marketplace_status was not rewritten';
  END IF;
END $$;

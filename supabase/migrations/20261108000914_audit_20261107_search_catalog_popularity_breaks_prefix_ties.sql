-- audit_20261107_search_catalog_popularity_breaks_prefix_ties
--
-- 2026-11-07 ~4:15 PM PT (Cowork cloud; Trevor: "Keep going").
--
-- WHAT WAS WRONG. "luka" returned Luka Ilic (5 editions), Luka Garza (8) and
-- Luka Sucic (6) above Luka Doncic (Panini 177, Top Shot 106). Every one of them
-- is a PREFIX hit (+0.5), so the order fell to trigram similarity, which favours
-- the SHORTER name, while the popularity term `least(n,500)/5000` adds at most
-- 0.10 — Doncic's 177 editions were worth 0.035, less than Ilic's similarity
-- edge (~0.05). Among names that all start with what the collector typed,
-- popularity was effectively inert.
--
-- CHANGE (one expression in the final SELECT). Add, for a PREFIX hit that is
-- NOT exact only, `ln(1 + least(n,500)) / 20` (0 … 0.31). It cannot lift a
-- non-prefix hit (the term is 0 there and prefix is worth +0.5) and cannot beat
-- an exact match (+1.0). Projected from the live scores: Doncic Panini 2.16,
-- Doncic Top Shot 2.12, Modric 2.09, then Ilic 2.04, Garza 2.02.
--
-- HOW: in-place splice of the LIVE body (it has drifted from every committed
-- copy — see 20261107182853), asserting the old expression occurs ONCE.
--
-- anon-exec: unchanged (rpc_search_catalog) — CREATE OR REPLACE of an existing fn, same signature; ACL preserved (anon EXECUTE false).
--
-- REVERT: the same DO block with old/new swapped.

DO $mig$
DECLARE
  v_def text := pg_get_functiondef('public.rpc_search_catalog(text,uuid,integer)'::regprocedure);
  v_old text := $o$      + least(coalesce(u.n, 0), 500) / 5000.0
    )::real AS score$o$;
  v_new text := $n$      + least(coalesce(u.n, 0), 500) / 5000.0
      -- 2026-11-07: popularity breaks ties AMONG PREFIX HITS ("luka" → Doncic,
      -- not the shortest Luka). Bounded 0 … 0.31; never lifts a non-prefix hit,
      -- never beats an exact one.
      + CASE WHEN u.prefix AND NOT coalesce(u.exact, false)
             THEN ln(1 + least(coalesce(u.n, 0), 500)) / 20.0 ELSE 0 END
    )::real AS score$n$;
  v_hits int;
BEGIN
  v_hits := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
  IF v_hits <> 1 THEN RAISE EXCEPTION 'rpc_search_catalog base moved: expected 1 occurrence of the score tail, found %', v_hits; END IF;
  EXECUTE replace(v_def, v_old, v_new);
END
$mig$;

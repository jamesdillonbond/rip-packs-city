-- 2026-11-14 (Claude Code cloud, ~2:50 PM PT) — fresh-eyes review of search (finding 3, second half).
--
-- rpc_search_catalog's SET arm counted from `sets` / `editions`, where Disney Pinnacle has 0 rows, so no
-- Pinnacle set was ever a search hit ("star wars alphabet" → nothing) although its set pages exist and are in
-- the sitemap. Splice: a third UNION ALL arm over pinnacle_catalog, keyed by the trimmed set name — the
-- slug set_hits derives (lower → runs of non-alnum to '-') is exactly the one its set pages resolve
-- (checked live: /disney-pinnacle/set/lucasfilm-ltd-star-wars-alphabet-vol-1 → 200, renders the set).
-- md5-asserted base f6f78a8dbfe7fac8ff65387417253a31 (after 20261114222412), the anchor (end of the Panini
-- arm) occurs exactly once; CREATE OR REPLACE via pg_get_functiondef keeps the header, search_path and ACL.
-- anon-exec: unchanged (rpc_search_catalog) — CREATE OR REPLACE of an existing fn; ACL preserved, read 2026-11-14 ~2:40 PM PT has_function_privilege('anon', …, 'EXECUTE') = false.
--
-- Read back (20261114223116): md5 56b8f28bc65d92eebc626eea34f81970. 'star wars alphabet' on Pinnacle → the set
-- (104 pins, slug lucasfilm-ltd-star-wars-alphabet-vol-1); 'alphabet' across collections → the same hit;
-- control 'base set' on Top Shot → 10 hits; EXPLAIN ANALYZE 'vol' across every collection 131 ms.
-- Not changed: Pinnacle franchises ("star wars" as a TEAM hit) — the team arm reads editions.team_name.
--
-- Revert: re-apply the body from 20261114222412's splice (remove this UNION ALL arm via the inverse
-- replace of the v_new text below with v_old) and EXECUTE.
DO $$
DECLARE
  v_oid oid := 'public.rpc_search_catalog(text,uuid,integer)'::regprocedure;
  v_old text := E'      AND lower(ss.set_name) LIKE ALL (v_pats)\n    LIMIT 300)\n  ),\n  set_hits AS (';
  v_new text := E'      AND lower(ss.set_name) LIKE ALL (v_pats)\n    LIMIT 300)\n    UNION ALL\n    -- 2026-11-14: Disney Pinnacle sets live in pinnacle_catalog (0 rows in sets/editions), keyed by the\n    -- trimmed set name exactly as its set pages slug it; a pin is counted once per set.\n    (SELECT v_pin, btrim(pc.set_name), NULL::text, count(*)\n    FROM public.pinnacle_catalog pc\n    WHERE (p_collection_id IS NULL OR p_collection_id = v_pin)\n      AND pc.set_name IS NOT NULL AND btrim(pc.set_name) <> \'\'\n      AND pc.set_name ILIKE \'%\' || v_anchor || \'%\'\n      AND lower(pc.set_name) LIKE ALL (v_pats)\n    GROUP BY btrim(pc.set_name)\n    LIMIT 300)\n  ),\n  set_hits AS (';
  v_src text;
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc WHERE oid = v_oid;
  IF md5(v_src) <> 'f6f78a8dbfe7fac8ff65387417253a31' THEN RAISE EXCEPTION 'rpc_search_catalog base drifted: md5 %', md5(v_src); END IF;
  IF (length(v_src) - length(replace(v_src, v_old, ''))) / length(v_old) <> 1 THEN RAISE EXCEPTION 'anchor not found exactly once'; END IF;
  EXECUTE replace(pg_get_functiondef(v_oid), v_old, v_new);
  SELECT prosrc INTO v_src FROM pg_proc WHERE oid = v_oid;
  IF position('GROUP BY btrim(pc.set_name)' IN v_src) = 0 THEN RAISE EXCEPTION 'splice did not land'; END IF;
END $$;

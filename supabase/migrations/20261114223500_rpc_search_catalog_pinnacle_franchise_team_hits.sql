-- 2026-11-14 (Claude Code cloud, ~2:35 PM PT) — search: Disney Pinnacle FRANCHISES as team hits.
--
-- rpc_search_catalog's team arm reads editions.team_name, which is empty for Disney Pinnacle
-- (0 rows), so searching "star wars" or "mickey" never offered the franchise page
-- (/disney-pinnacle/team/<slug>, labelled FRANCHISE by lib/search/href.ts) although it exists
-- (star-wars: 740 pins). A UNION ALL arm over pinnacle_catalog x unnest(franchises) emits one
-- team row per franchise; the name has ™/®/© stripped as the franchise pages do, so the slug
-- matches the page. A pin counts once per franchise. Other collections' team arm is untouched.
-- md5-asserted base 56b8f28bc65d92eebc626eea34f81970; the anchor must occur exactly once.
-- anon-exec: unchanged (rpc_search_catalog) — CREATE OR REPLACE via pg_get_functiondef of an existing fn; ACL preserved.
-- Revert: the inverse splice — replace(pg_get_functiondef(oid), v_new, v_old) with the two literals below, then EXECUTE.
DO $$
DECLARE
  v_oid oid := 'public.rpc_search_catalog(text,uuid,integer)'::regprocedure;
  v_old text := E'      AND lower(e.team_name) LIKE ALL (v_pats)\n    GROUP BY 1, 2, 3\n  ),';
  v_new text := E'      AND lower(e.team_name) LIKE ALL (v_pats)\n    GROUP BY 1, 2, 3\n    UNION ALL\n    -- 2026-11-14: a Disney Pinnacle FRANCHISE is the `franchises` trait (0 team rows in editions), its\n    -- page slug the name with the trademark marks stripped (pinnacleFranchiseName). A pin counts once per franchise.\n    SELECT \'team\'::text,\n      regexp_replace(lower(btrim(f.nm)), \'[^a-z0-9]+\', \'-\', \'g\'),\n      v_pin, min(f.nm), count(*)::int, NULL::text,\n      max(extensions.similarity(lower(f.nm), v_q)),\n      bool_or(lower(f.nm) = v_q),\n      bool_or(lower(f.nm) LIKE v_anchor || \'%\')\n    FROM public.pinnacle_catalog pc\n    CROSS JOIN LATERAL (SELECT DISTINCT btrim(regexp_replace(x, \'[™®©]\', \'\', \'g\')) AS nm FROM unnest(pc.franchises) x) f\n    WHERE (p_collection_id IS NULL OR p_collection_id = v_pin)\n      AND f.nm <> \'\'\n      AND f.nm ILIKE \'%\' || v_anchor || \'%\'\n      AND lower(f.nm) LIKE ALL (v_pats)\n    GROUP BY 1, 2, 3\n  ),';
  v_src text;
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc WHERE oid = v_oid;
  IF md5(v_src) <> '56b8f28bc65d92eebc626eea34f81970' THEN RAISE EXCEPTION 'rpc_search_catalog base drifted: md5 %', md5(v_src); END IF;
  IF (length(v_src) - length(replace(v_src, v_old, ''))) / length(v_old) <> 1 THEN RAISE EXCEPTION 'anchor not found exactly once'; END IF;
  EXECUTE replace(pg_get_functiondef(v_oid), v_old, v_new);
  SELECT prosrc INTO v_src FROM pg_proc WHERE oid = v_oid;
  IF position('unnest(pc.franchises)' IN v_src) = 0 THEN RAISE EXCEPTION 'splice did not land'; END IF;
END $$;

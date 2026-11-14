-- 2026-11-14 (Claude Code cloud, ~2:40 PM PT) — fresh-eyes review of search.
--
-- rpc_search_catalog's player arm counted a Disney Pinnacle character's pins by `pc.character_name = p.name`.
-- `character_name` is the PIN's own name ("Welcome to Endor"), not the character; a character is the
-- `characters` TRAIT (CLAUDE.md "Disney Pinnacle grain"; get_player_detail keys on it). Characters whose pins
-- are not titled after them counted 0 and the arm's `WHERE n > 0` dropped them: live, 101 of 540 Pinnacle
-- characters could not be found by search at all ("jabba" → nothing) and 226 showed a pin count that
-- disagreed with their own page. Splice: count by `p.name = ANY(pc.characters)`. The other collections'
-- arm and every other branch are untouched. md5-asserted base 775b258c9d378f016828d222c7db5592; the anchor
-- occurs exactly once. CREATE OR REPLACE via pg_get_functiondef keeps the header, search_path and ACL.
-- anon-exec: unchanged (rpc_search_catalog) — CREATE OR REPLACE of an existing fn; ACL preserved, read 2026-11-14 ~2:40 PM PT has_function_privilege('anon', …, 'EXECUTE') = false.
--
-- Not changed (recorded): the set and team arms count from `editions`, where Pinnacle has 0 rows, so a
-- Pinnacle set or franchise ("star wars") is still not a search hit — a larger change.
--
-- Read back after apply (20261114222412): md5(prosrc) f6f78a8dbfe7fac8ff65387417253a31, anon EXECUTE false.
-- rpc_search_catalog('jabba', <Pinnacle>, 10): nothing → "Jabba the Hutt" (5 pins); control 'lebron' on Top Shot: 10 hits.
--
-- Revert: the inverse splice — replace 'WHERE p.name = ANY(pc.characters)' with
-- 'WHERE pc.character_name = p.name' in pg_get_functiondef and EXECUTE.
DO $$
DECLARE
  v_oid oid := 'public.rpc_search_catalog(text,uuid,integer)'::regprocedure;
  v_old text := 'WHERE pc.character_name = p.name';
  v_new text := 'WHERE p.name = ANY(pc.characters)';
  v_src text;
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc WHERE oid = v_oid;
  IF md5(v_src) <> '775b258c9d378f016828d222c7db5592' THEN RAISE EXCEPTION 'rpc_search_catalog base drifted: md5 %', md5(v_src); END IF;
  IF (length(v_src) - length(replace(v_src, v_old, ''))) / length(v_old) <> 1 THEN RAISE EXCEPTION 'anchor not found exactly once'; END IF;
  EXECUTE replace(pg_get_functiondef(v_oid), v_old, v_new);
  SELECT prosrc INTO v_src FROM pg_proc WHERE oid = v_oid;
  IF position(v_old IN v_src) > 0 OR position(v_new IN v_src) = 0 THEN RAISE EXCEPTION 'splice did not land'; END IF;
END $$;

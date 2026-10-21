-- audit_20261020_search_catalog_player_count_skips_another_persons_editions
--
-- 2026-10-20 9:25 PM PT (Claude Code cloud). Follow-on to 20261021034822 (a NAME is
-- not a PERSON): rpc_search_catalog's per-player result COUNT ("N Moments" beside a
-- player in search) matched `e.player_id = p.id OR e.player_name = p.name`, so the
-- Bills' Josh Allen counted Josh Hines-Allen's 8 "Josh Allen"-labelled editions and
-- Marvin Harrison / Joey Porter their sons'. The same predicate the player pages now
-- use: the name arm skips an edition linked to another person per player_relations.
-- A guarded splice over the live body (md5-pinned base, anchor counted once).
--
-- anon-exec: unchanged (rpc_search_catalog) — re-created from its own pg_get_functiondef; ACL kept.
--
-- REVERT: re-run the splice in reverse (b -> a).
DO $mig$
DECLARE
  d text; n int;
  a constant text := 'AND (e.player_id = p.id OR e.player_name = p.name)';
  b constant text := 'AND (e.player_id = p.id OR (e.player_name = p.name AND NOT public.edition_player_is_other_person(e.player_id, p.id)))';
BEGIN
  SELECT md5(prosrc) INTO d FROM pg_proc WHERE proname = 'rpc_search_catalog' AND pronamespace = 'public'::regnamespace;
  IF d <> '65ca36ebfdd7e5f7c31b431b7c552f2b' THEN RAISE EXCEPTION 'rpc_search_catalog moved (md5 %)', d; END IF;
  SELECT pg_get_functiondef(oid) INTO d FROM pg_proc WHERE proname = 'rpc_search_catalog' AND pronamespace = 'public'::regnamespace;
  n := (length(d) - length(replace(d, a, ''))) / length(a); IF n <> 1 THEN RAISE EXCEPTION 'anchor x%', n; END IF;
  EXECUTE replace(d, a, b);
END
$mig$;

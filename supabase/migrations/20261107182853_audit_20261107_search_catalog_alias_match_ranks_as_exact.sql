-- audit_20261107_search_catalog_alias_match_ranks_as_exact
--
-- 2026-11-07 ~10:40 AM PT (Cowork cloud; Trevor: "Keep going"). Follow-up to
-- audit_20261107_player_nicknames_as_search_aliases (29 nicknames registered).
--
-- WHAT WAS WRONG. rpc_search_catalog FINDS a player through player_name_aliases
-- (the 09-25 alias arm) but RANKS only on the NAME: `exact` = name == query,
-- `prefix` = name starts with the anchor. So "dame" found Damian Lillard via the
-- new alias yet scored him below Dameon Pierce, whose NAME merely starts with
-- "dame" (+0.5 prefix). Measured live after the alias landed: dame → Dameon
-- Pierce, Damian Lillard, Radamel Falcao. An alias that EQUALS the query is the
-- person the collector means; it must score like an exact name.
--
-- CHANGE (two expressions in player_hits). `exact` is also true when a registered
-- alias of that player (dashes read as spaces) equals the unaccented query;
-- `prefix` is also true when such an alias starts with the anchor ("wemb" →
-- wemby). Players without aliases score exactly as before.
--
-- HOW: the live body has drifted from every committed copy (see the 11-04
-- migration's note), so this edits the LIVE definition in place — reads
-- pg_get_functiondef, asserts each old expression occurs ONCE, replaces both,
-- executes the result. If the base has moved it fails instead of guessing.
--
-- anon-exec: unchanged (rpc_search_catalog) — CREATE OR REPLACE of an existing fn, same signature; ACL preserved (anon EXECUTE false).
--
-- REVERT: the same DO block with old/new swapped.

DO $mig$
DECLARE
  v_def text := pg_get_functiondef('public.rpc_search_catalog(text,uuid,integer)'::regprocedure);
  v_old_exact  text := $o$bool_or(lower(extensions.unaccent(nm)) = v_qa) AS exact,$o$;
  v_new_exact  text := $n$bool_or(lower(extensions.unaccent(nm)) = v_qa
              OR EXISTS (SELECT 1 FROM public.player_name_aliases a
                           JOIN public.players pp ON pp.id = a.player_id
                          WHERE pp.collection_id = cid
                            AND lower(extensions.unaccent(pp.name)) = lower(extensions.unaccent(nm))
                            AND replace(a.alias_slug, '-', ' ') = v_qa)) AS exact,$n$;
  v_old_prefix text := $o$bool_or(lower(extensions.unaccent(nm)) LIKE v_anchor_a || '%') AS prefix
    FROM player_raw WHERE n > 0 GROUP BY 1, 2, 3$o$;
  v_new_prefix text := $n$bool_or(lower(extensions.unaccent(nm)) LIKE v_anchor_a || '%'
              OR EXISTS (SELECT 1 FROM public.player_name_aliases a
                           JOIN public.players pp ON pp.id = a.player_id
                          WHERE pp.collection_id = cid
                            AND lower(extensions.unaccent(pp.name)) = lower(extensions.unaccent(nm))
                            AND replace(a.alias_slug, '-', ' ') LIKE v_anchor_a || '%')) AS prefix
    FROM player_raw WHERE n > 0 GROUP BY 1, 2, 3$n$;
  v_hits int;
BEGIN
  v_hits := (length(v_def) - length(replace(v_def, v_old_exact, ''))) / length(v_old_exact);
  IF v_hits <> 1 THEN RAISE EXCEPTION 'rpc_search_catalog base moved: expected 1 occurrence of the exact expression, found %', v_hits; END IF;
  v_hits := (length(v_def) - length(replace(v_def, v_old_prefix, ''))) / length(v_old_prefix);
  IF v_hits <> 1 THEN RAISE EXCEPTION 'rpc_search_catalog base moved: expected 1 occurrence of the prefix expression, found %', v_hits; END IF;
  EXECUTE replace(replace(v_def, v_old_exact, v_new_exact), v_old_prefix, v_new_prefix);
END
$mig$;

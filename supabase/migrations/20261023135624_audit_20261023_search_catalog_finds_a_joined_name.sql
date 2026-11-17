-- audit_20261023_search_catalog_finds_a_joined_name
--
-- 2026-10-23 (Claude Code cloud; #207 platform-wide follow-on). Site search could
-- not find Disney Pinnacle's WALL•E from either natural spelling: "walle" answered
-- Darren Waller / Sevgi Uzun and "wall-e" answered Taj Gibson; only "wall e" (a
-- space) worked. `unaccent` folds accents but keeps the "•" joiner, so the player
-- arm's token match never saw "walle" or "wall-e" in "wall•e". Measured: 1 of 9,079
-- players carries a joiner (• or ·).
--
-- Adds ONE alternative to the player arm, only for names that carry a joiner: the
-- whole query as a substring of the name with joiners read as "-" or dropped. For
-- every other name the clause is false (the `~ '[•·]'` gate), so no result changes.
-- A guarded splice over the live body (md5-pinned base, anchor counted once), the
-- 20261021042418 pattern.
--
-- anon-exec: unchanged (rpc_search_catalog) — re-created from its own pg_get_functiondef; ACL kept.
--
-- REVERT: re-run the splice in reverse (b -> a) against the new md5.
DO $mig$
DECLARE
  d text; n int;
  a constant text := 'AND replace(a.alias_slug, ''-'', '' '') LIKE ALL (v_pats_a)))';
  b constant text := 'AND replace(a.alias_slug, ''-'', '' '') LIKE ALL (v_pats_a))
           -- 2026-10-23: a name with a joiner ("WALL•E") is found from "wall-e" or
           -- "walle" — unaccent keeps the joiner, so the token match cannot.
           OR (p.name ~ ''[•·]''
               AND (translate(lower(extensions.unaccent(p.name)), ''•·'', ''--'') LIKE ''%'' || v_qa || ''%''
                    OR translate(lower(extensions.unaccent(p.name)), ''•·'', '''') LIKE ''%'' || v_qa || ''%'')))';
BEGIN
  SELECT md5(prosrc) INTO d FROM pg_proc WHERE proname = 'rpc_search_catalog' AND pronamespace = 'public'::regnamespace;
  IF d <> '37a89f0d885214f8081d752e208d58c5' THEN RAISE EXCEPTION 'rpc_search_catalog moved (md5 %)', d; END IF;
  SELECT pg_get_functiondef(oid) INTO d FROM pg_proc WHERE proname = 'rpc_search_catalog' AND pronamespace = 'public'::regnamespace;
  n := (length(d) - length(replace(d, a, ''))) / length(a); IF n <> 1 THEN RAISE EXCEPTION 'anchor x%', n; END IF;
  EXECUTE replace(d, a, b);
END
$mig$;

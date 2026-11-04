-- audit_20261103_search_catalog_never_labels_an_edition_unknown
--
-- 2026-11-03 8:41–8:46 PM PT, from the clock (applied 8:44 PM PT) (Claude Code cloud; Trevor: "Keep going, proceed with all
-- that make sense"; from a prosrc sweep for the invented literal 'Unknown' in reader functions).
--
-- WHAT WAS WRONG. Site search (/api/search → rpc_search_catalog) labelled every edition with a NULL
-- player_name "Unknown": `coalesce(e.player_name, 'Unknown') AS lbl`. Measured live: the query
-- "nfl draft" returned 11 edition rows reading "Unknown" (All Day Series 9 "NFL Draft · Draft Pick"
-- editions, which carry no player in our metadata — 36 such All Day editions, plus 1 Top Shot
-- Dynamic Duos edition). An invented name in the same type as a real one.
--
-- CHANGE (one expression). The label is the first field we actually READ:
--   coalesce(player_name, team_name, play_type, set_name, slug).
-- Rows with a player_name are unchanged (the coalesce returns it first).
--
-- ⚠ HOW: live rpc_search_catalog has DRIFTED from every committed copy (live prosrc md5
-- 476ace2a… vs 20261015052846's 114ed5e9…), so a full-body CREATE OR REPLACE from the repo would revert
-- whatever the live body carries. This migration therefore edits the LIVE definition in place: it reads
-- pg_get_functiondef, asserts the exact old expression occurs ONCE, replaces it and executes the result.
-- If the base has moved, it fails instead of guessing. Post-apply live prosrc md5 (whitespace-normalised):
-- 14656d973c9fabc6e31d31b07b0c57aa. ⚠ The repo still holds no full copy of the live body (pre-existing
-- drift, not introduced here): the next full-body change must start from pg_get_functiondef, not a file.
-- Verified after apply: "nfl draft" edition rows read "Draft Pick" (were "Unknown"); "lillard" still
-- returns Damian Lillard rows first; anon EXECUTE false.
--
-- anon-exec: unchanged (rpc_search_catalog) — the replaced definition is CREATE OR REPLACE of an existing fn, same signature; ACL preserved (anon EXECUTE false, verified 11-03).
--
-- REVERT: the same DO block with the two strings swapped.

DO $mig$
DECLARE
  v_def text := pg_get_functiondef('public.rpc_search_catalog(text,uuid,integer)'::regprocedure);
  v_old text := $o$coalesce(e.player_name, 'Unknown') AS lbl$o$;
  v_new text := $n$coalesce(e.player_name, nullif(btrim(e.team_name), ''), nullif(btrim(e.play_type), ''), nullif(btrim(e.set_name), ''), coalesce(e.external_id, e.id::text)) AS lbl$n$;
  v_hits int;
BEGIN
  v_hits := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
  IF v_hits <> 1 THEN
    RAISE EXCEPTION 'rpc_search_catalog base moved: expected 1 occurrence of the old label expression, found %', v_hits;
  END IF;
  EXECUTE replace(v_def, v_old, v_new);
END
$mig$;

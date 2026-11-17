-- audit_20261103_player_minter_refuses_placeholder_names
--
-- 2026-11-03 8:55–9:03 PM PT from the clock, applied 9:01 PM PT (Claude Code cloud; Trevor: "Keep going, proceed with all that make sense"). Follow-up to
-- 20261104045324, which retired a `players` row named "Unknown (error loading)".
--
-- WHY. ensure_players_from_edition_names (pg_cron) mints a player for every unmatched editions.player_name.
-- It already refuses a team label ('team moment', the team's own name, a city label) but nothing refuses a
-- PLACEHOLDER: on 2026-09-25 it minted "Unknown (error loading)" — /api/wallet-search's load-failure label —
-- from an edition carrying that string, and a Dynamic Duos edition then pointed at it. The upstream writer is
-- fixed (#18), but a minter that turns any stand-in into a person is one regression away from doing it again.
--
-- CHANGE. One added predicate beside the existing 'team moment' exclusion: a name that IS a placeholder
-- ("unknown…", "n/a", "null", "undefined", "tbd") or carries "error loading" is never minted. Measured before
-- apply: 0 editions currently match, so today's output is unchanged — this only closes the door.
--
-- HOW. Edited in the LIVE definition (pg_get_functiondef → assert the anchor occurs exactly once → replace →
-- execute), as in 20261104044435: the live body (prosrc md5 455999ad…) is not cleanly reproducible from a
-- repo file, and a full-body replace from a stale copy would revert whatever it carries.
--
-- anon-exec: unchanged (ensure_players_from_edition_names) — the replaced definition is CREATE OR REPLACE of an existing fn, same signature; ACL preserved (anon EXECUTE false, verified 11-03).
--
-- PROVEN after apply (one DO block, rolled back by its own RAISE): an ordinary unmatched name was minted
-- (control_minted=1) and a placeholder name was not (placeholder_minted=0); 0 rows persisted.
--
-- REVERT: the same DO block with v_new and v_old swapped.

DO $mig$
DECLARE
  v_def text := pg_get_functiondef('public.ensure_players_from_edition_names(uuid,integer)'::regprocedure);
  v_old text := $o$       AND lower(trim(e.player_name)) <> 'team moment'
$o$;
  v_new text := $n$       AND lower(trim(e.player_name)) <> 'team moment'
       -- 2026-11-03: nor a PLACEHOLDER — a stand-in for a name we could not read is not a person
       -- (it minted "Unknown (error loading)" on 2026-09-25)
       AND lower(trim(e.player_name)) !~ '^(unknown( |$|\()|n/?a$|null$|undefined$|tbd$)'
       AND strpos(lower(e.player_name), 'error loading') = 0
$n$;
  v_hits int;
BEGIN
  v_hits := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
  IF v_hits <> 1 THEN
    RAISE EXCEPTION 'ensure_players_from_edition_names base moved: expected 1 anchor, found %', v_hits;
  END IF;
  EXECUTE replace(v_def, v_old, v_new);
END
$mig$;

-- audit_20261107_panini_wc_writer_keeps_a_renamed_player
--
-- 2026-11-07 ~7:45 PM PT (Claude Code cloud), continuing Trevor's 5:58 PM
-- "make sure we're setup for long term success on these" (player renames).
--
-- WHAT WAS WRONG. sync_panini_editions_to_shared (Panini World Cup soccer →
-- shared catalog; called by sync_panini_bridge whenever catalog drift is found)
-- upserts players with `name = excluded.name` — Panini's raw spelling — on every
-- run. It was the one player-name writer left that ignored player_name_aliases
-- (runbook: docs/reference/player-identity.md "Renaming a player"), so renaming a
-- soccer player to the federation's spelling would be undone on the next drift
-- run. (The 4×/day check_player_alias_integrity watch would catch it as a
-- REVERT; this removes the cause instead of relying on the alarm.)
--
-- FIX. A player row that has a registered alias keeps its catalog name; any
-- other row still takes the source spelling exactly as before. Editions labels
-- are already normalised to the alias's player name by the editions triggers.
--
-- POSITIVE CONTROL (live, inside a rolled-back block): two WC players renamed
-- "Probe Renamed", an alias registered for one, then a real (non-dry) run of this
-- function: the aliased one KEPT "Probe Renamed", the plain one went back to its
-- source spelling ("Estevao") — 552 players upserted, nothing persisted.
--
-- HOW: in-place splice of the LIVE body, asserted single occurrence
-- (pattern of 20261108013704). Live md5(prosrc) at apply: e13f34f9….
--
-- anon-exec: unchanged (sync_panini_editions_to_shared) — CREATE OR REPLACE of an existing fn, same signature; ACL preserved.
--
-- REVERT: the same DO block with old/new swapped.

DO $mig$
DECLARE
  v_oid oid := (SELECT p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                 WHERE n.nspname = 'public' AND p.proname = 'sync_panini_editions_to_shared');
  v_def text := pg_get_functiondef(v_oid);
  o1 text := $o$select ext, v_cid, nm, v_slug, now(), now() from p
  on conflict (external_id) do update set name = excluded.name, updated_at = now();$o$;
  n1 text := $n$select ext, v_cid, nm, v_slug, now(), now() from p
  on conflict (external_id) do update set
    -- 2026-11-07: a player with a registered alias was renamed on purpose (runbook:
    -- docs/reference/player-identity.md); keep that name, never the source spelling.
    name = CASE WHEN EXISTS (SELECT 1 FROM public.player_name_aliases a WHERE a.player_id = players.id)
                THEN players.name ELSE excluded.name END,
    updated_at = now();$n$;
  v_hits int;
BEGIN
  v_hits := (length(v_def) - length(replace(v_def, o1, ''))) / length(o1);
  IF v_hits <> 1 THEN RAISE EXCEPTION 'players upsert found % times, want 1', v_hits; END IF;
  EXECUTE replace(v_def, o1, n1);
END
$mig$;

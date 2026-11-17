-- audit_20261107_panini_breakdown_matches_either_spelling
--
-- 2026-11-07 ~5:44 PM PT (Claude Code cloud). Trevor, 5:33 PM: search and the
-- concierge must "help users either way" after today's renames.
--
-- WHAT WAS WRONG. panini_holdings_breakdown filters p_player against the name
-- Panini's own tables carry (panini_editions / panini_user_holdings: "Stephen
-- Curry"), while the concierge hands it the resolver's spelling, which since
-- today's consolidation is the catalog's "Steph Curry". Measured on a collector
-- holding his cards: p_player 'Stephen Curry' → 51 cards, 'Steph Curry' → 0 —
-- and the concierge sends 'Steph Curry' for BOTH typed spellings, so "how many
-- Steph Curry cards do I have" answered 0.
--
-- FIX. The row's name is the catalog label (editions.player_name for that
-- edition) when RPC has one, else Panini's; p_player matches EITHER spelling.
-- Groups by player now read the site's name ("Steph Curry"), like every page.
--
-- HOW: in-place splice of the LIVE body (pattern of 20261108013704).
--
-- anon-exec: unchanged (panini_holdings_breakdown) — CREATE OR REPLACE of an existing fn, same signature; ACL preserved.
--
-- REVERT: the same DO block with old/new swapped.

DO $mig$
DECLARE
  v_def text := pg_get_functiondef('public.panini_holdings_breakdown(text,text,text,text,text,text,integer)'::regprocedure);
  o1 text := $o$SELECT a.ed, a.sku, a.player_name, a.set_name,$o$;
  n1 text := $n$SELECT a.ed, a.sku, coalesce(e.player_name, a.player_name) AS player_name, a.player_name AS raw_player_name, a.set_name,$n$;
  o2 text := $o$WHERE (p_player IS NULL OR p.player_name ILIKE '%' || p_player || '%')$o$;
  n2 text := $n$WHERE (p_player IS NULL OR p.player_name ILIKE '%' || p_player || '%' OR p.raw_player_name ILIKE '%' || p_player || '%')$n$;
  v_hits int;
BEGIN
  v_hits := (length(v_def) - length(replace(v_def, o1, ''))) / length(o1);
  IF v_hits <> 1 THEN RAISE EXCEPTION 'priced select found % times, want 1', v_hits; END IF;
  v_hits := (length(v_def) - length(replace(v_def, o2, ''))) / length(o2);
  IF v_hits <> 1 THEN RAISE EXCEPTION 'player filter found % times, want 1', v_hits; END IF;
  EXECUTE replace(replace(v_def, o1, n1), o2, n2);
END
$mig$;

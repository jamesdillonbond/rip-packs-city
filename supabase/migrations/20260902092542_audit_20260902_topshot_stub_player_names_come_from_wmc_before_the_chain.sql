-- Top Shot stub editions: fill `player_name` from wallet_moments_cache, which
-- already holds it, instead of asking the chain for something the chain does not have.
--
-- THE FINDING. `resolve-topshot-stubs` (pg_cron -> topshot-stub-resolver) has written
-- 37 rows in 74,800 attempts over 36 days — a 0.049% yield — re-asking the chain for a
-- player name on the same 520 editions ~4.4x a day. Every run reports
-- `rows_no_change_no_onchain_player: 50`. Measured 2026-09-02: of the 515 of those
-- missing a player name, **346 have one in `wallet_moments_cache`**. The stubs were
-- created FROM wmc rows (`stub_editions_from_wmc` inserts `player_name` as
-- "NULL -- player to be resolved later") — the row that created the stub had the answer.
--
-- ⚠ THE CONTROL DID NOT COME BACK CLEAN, AND THE UNCLEAN PART IS NOT FORMATTING.
-- Comparing wmc against Top Shot editions that ALREADY carry a player_name — a control
-- this change cannot move — 46 of 11,866 disagree. Most are benign (Steph/Stephen,
-- Vučević/Vucevic, O.G./OG Anunoby), but three are a DIFFERENT PLAYER:
--   2:1::16  editions "Trae Young"    vs wmc "Alex Sarr"
--   2:4::16  editions "John Collins"  vs wmc "Matas Buzelis"
--   2:7::16  editions "Julius Randle" vs wmc "Andre Drummond"
-- All three sit on edition_keys where wmc holds MORE THAN ONE distinct player_name.
--
-- 👉 So the filter is `exactly one distinct wmc player_name`, and it was validated on
-- the population where the risk concentrates — subedition (`::NN`) keys:
--   n_names = 1 : 2,750 checked, 8 disagree, and ALL EIGHT are Steph/Stephen Curry —
--                 ZERO wrong players.
--   n_names > 1 :    17 checked, 10 disagree — 58.8%.
-- The ambiguous bucket is excluded, and it is where every wrong name lives. A
-- multi-player play (Dynamic Duos) legitimately has two names; picking one would be
-- wrong, not merely unhelpful.
--
-- SIZE + COST. 267 of 515 fill unambiguously (79 ambiguous, 169 have no wmc name at
-- all). Candidate scan measured warm: **107 ms / 51,418 buffers, every one a cache
-- hit**, against a 60 s statement_timeout. The 1,485 OTHER nameless Top Shot editions
-- are not reachable this way — all 1,485 have no wmc row, so nothing is being skipped
-- silently.
--
-- WHAT IT DISPLACES (the standing rule for adding anything to an IO-budgeted instance):
-- `get_topshot_stub_targets` keys on a missing player_name, so filling 267 takes its
-- queue 520 -> ~253 and roughly HALVES the ~2,300 chain lookups + ~2,300 no-op
-- `editions` UPDATEs the resolver makes per day. This is a net REDUCTION in work.

CREATE OR REPLACE FUNCTION public.backfill_topshot_stub_player_names_from_wmc(p_limit integer DEFAULT 1000)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
SET statement_timeout TO '60s'
AS $function$
DECLARE
  v_updated integer;
BEGIN
  WITH cand AS (
    SELECT e.id AS edition_id, w.one_name AS player_name
    FROM editions e
    JOIN LATERAL (
      -- ⛔ n_names IS THE SAFETY, NOT AN OPTIMISATION. Without it this writes a wrong
      -- player onto multi-player plays; see the three cases in the header.
      SELECT count(DISTINCT wm.player_name) AS n_names,
             min(wm.player_name)            AS one_name
      FROM wallet_moments_cache wm
      WHERE wm.collection_id = e.collection_id
        AND wm.edition_key   = e.external_id
        AND wm.player_name IS NOT NULL
        AND wm.player_name <> ''
    ) w ON true
    WHERE e.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
      AND (e.player_name IS NULL OR e.player_name = '')
      AND w.n_names = 1
    ORDER BY e.id            -- deterministic: a bare LIMIT is physical order, not a batch
    LIMIT p_limit
  )
  UPDATE editions e
     SET player_name = c.player_name
    FROM cand c
   WHERE e.id = c.edition_id
     AND (e.player_name IS NULL OR e.player_name = '');  -- never clobber a real name

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.backfill_topshot_stub_player_names_from_wmc(integer)
  FROM PUBLIC, anon, authenticated;

-- ── POST-STATE ───────────────────────────────────────────────────────────────
DO $mig$
DECLARE
  d text := pg_get_functiondef('public.backfill_topshot_stub_player_names_from_wmc(integer)'::regprocedure);
  v_cand int;
  v_control int;
BEGIN
  IF position('SECURITY DEFINER' in d) = 0 OR position('search_path' in d) = 0 THEN
    RAISE EXCEPTION 'post-state: SECURITY DEFINER / search_path missing';
  END IF;
  -- The safety filter must be in the deployed body, not just in this file's comments.
  IF position('count(DISTINCT wm.player_name)' in d) = 0 OR position('w.n_names = 1' in d) = 0 THEN
    RAISE EXCEPTION 'post-state: the single-distinct-name safety filter is absent';
  END IF;
  IF position('e.player_name IS NULL OR e.player_name' in d) = 0 THEN
    RAISE EXCEPTION 'post-state: the never-clobber guard is absent from the UPDATE';
  END IF;

  IF has_function_privilege('anon', 'public.backfill_topshot_stub_player_names_from_wmc(integer)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.backfill_topshot_stub_player_names_from_wmc(integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'post-state: anon or authenticated can still EXECUTE this function';
  END IF;

  -- The candidate set the function would write, re-derived here independently of it.
  -- A mismatch against the filed 267 is not fatal (the population moves as wallets are
  -- walked), but zero would mean the join key or the collection id is wrong.
  SELECT count(*) INTO v_cand
  FROM editions e
  JOIN LATERAL (
    SELECT count(DISTINCT wm.player_name) AS n_names
    FROM wallet_moments_cache wm
    WHERE wm.collection_id = e.collection_id AND wm.edition_key = e.external_id
      AND wm.player_name IS NOT NULL AND wm.player_name <> ''
  ) w ON true
  WHERE e.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
    AND (e.player_name IS NULL OR e.player_name = '')
    AND w.n_names = 1;

  IF v_cand = 0 THEN
    RAISE EXCEPTION 'post-state: zero candidates — the edition_key join or the collection id is wrong';
  END IF;

  -- Positive control the change CANNOT move: editions that already carry a name are
  -- outside the candidate set by construction. If this is ever non-zero the never-clobber
  -- guard has stopped meaning what it says.
  SELECT count(*) INTO v_control
  FROM editions e
  WHERE e.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
    AND e.player_name IS NOT NULL AND e.player_name <> ''
    AND (e.player_name IS NULL OR e.player_name = '');
  IF v_control <> 0 THEN
    RAISE EXCEPTION 'post-state: the named-edition control is not zero (%)', v_control;
  END IF;

  RAISE NOTICE 'backfill_topshot_stub_player_names_from_wmc created; % candidates', v_cand;
END
$mig$;

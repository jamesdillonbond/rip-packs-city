-- audit_20260928_panini_collector_rotation_targets
--
-- WHY. Trevor (2026-09-28): check every Top Shot username RPC knows against Panini and walk the
-- overlap. 100 names matched exactly (a floor: RPC learns a Panini username only when it lists a
-- card). One walk takes ~2–4 min (pipeline_runs 09-27/28) and the box's collector walk is
-- watchdogged, so the overlap is walked a FEW names a night, least-recently-walked first, instead
-- of all at once.
--
-- WHO. A Panini owner (panini_card_serials.owner, folded) whose name is also a Top Shot username
-- in wallet_usernames or seeded_wallets. Trevor chose to walk these public profiles. Names of 4
-- characters or fewer are left out: an exact match that short (JP7, DCMG) is too likely to be two
-- different people.
--
-- The list grows by itself: a Top Shot collector who lists a Panini card joins it on the next
-- night. `nickname` is the Panini spelling (the page is queried with it).
--
-- ORDER. Never walked first, then the oldest walk; ties by cards seen (largest first) so the
-- biggest collections are read in the first nights. A name walked in the last 20 h is skipped
-- (the explicit list and linked usernames walk it too).
--
-- COST (measured 2026-09-28 before shipping): one pass over panini_card_serials, ~1.1 s,
-- ~86k buffers; called once a night.
--
-- anon-exec: revoked below — service-role only (public.panini_collector_rotation_targets)

CREATE OR REPLACE FUNCTION public.panini_collector_rotation_targets(p_limit integer)
RETURNS TABLE (username text, nickname text, cards_seen bigint, last_walk_at timestamptz)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  WITH o AS (
    SELECT lower(s.owner) AS username, min(s.owner) AS nickname, count(*) AS cards_seen
    FROM panini_card_serials s
    WHERE s.owner <> ''
    GROUP BY 1
  ), ts AS (
    SELECT lower(u.username) AS u FROM wallet_usernames u WHERE u.username IS NOT NULL
    UNION
    SELECT lower(sw.username) FROM seeded_wallets sw WHERE sw.username IS NOT NULL
  )
  SELECT o.username, o.nickname, o.cards_seen, w.last_walk_at
  FROM o
  JOIN ts ON ts.u = o.username
  LEFT JOIN panini_collector_walks w ON w.username = o.username
  WHERE length(o.username) >= 5
    AND o.username ~ '^[a-z0-9_.-]{2,16}$'
    AND (w.last_walk_at IS NULL OR w.last_walk_at < now() - interval '20 hours')
  ORDER BY w.last_walk_at NULLS FIRST, o.cards_seen DESC, o.username
  LIMIT greatest(0, least(coalesce(p_limit, 0), 50))
$$;

REVOKE ALL ON FUNCTION public.panini_collector_rotation_targets(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.panini_collector_rotation_targets(integer) TO service_role;

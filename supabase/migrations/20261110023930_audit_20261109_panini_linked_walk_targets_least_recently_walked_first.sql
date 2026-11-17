-- audit_20261109_panini_linked_walk_targets_least_recently_walked_first
--
-- 2026-11-09 (Claude Code, Trevor's laptop): the linked Panini walk (every 2 h, 36-min budget)
-- walks the plan in the order this function returns it, and that order was ALPHABETICAL
-- (DISTINCT ON's own sort key) — although the 09-27 header said "stalest complete walk first".
-- With 12 linked usernames the budget ran out before the tail on every run: `wizwit` was not
-- walked in any of the 8 linked runs on 11-09 (last walk 11-08 9:49 PM PT) and `webz80` in only
-- two, while the walk logged "the rotation picks them up next run" (this task runs with no
-- rotation). The route also trims the list to its limit AFTER this order, so past 25 linked
-- usernames the alphabetical tail would never be walked at all.
--
-- Now: least recently WALKED first (never walked first), then least recently COMPLETED, then
-- name. Ordered on the last walk ATTEMPT, not the last complete one: a profile that cannot
-- finish inside the per-walk cap (timdunkin, 5,990 cards vs a 4-min cap) has no complete walk
-- and would otherwise sit at the head of every run.
--
-- Same signature and columns (CREATE OR REPLACE keeps the grants); body only.
-- anon-exec: unchanged — service-role only (public.panini_collector_walk_targets)

CREATE OR REPLACE FUNCTION public.panini_collector_walk_targets()
RETURNS TABLE (username text, nickname text, last_complete_at timestamptz)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT t.username, t.nickname, t.last_complete_at
  FROM (
    SELECT DISTINCT ON (lower(btrim(s.identity_value)))
           lower(btrim(s.identity_value)) AS username, btrim(s.identity_value) AS nickname,
           w.last_complete_at, w.last_walk_at
    FROM saved_collector_identities s
    LEFT JOIN panini_collector_walks w ON w.username = lower(btrim(s.identity_value))
    WHERE s.collection_id = 'd1a0a7f5-609a-49f4-a1a7-4eaac55b020b'
      AND s.identity_kind = 'username'
      AND lower(btrim(s.identity_value)) ~ '^[a-z0-9_.-]{2,16}$'
    ORDER BY lower(btrim(s.identity_value)), s.created_at
  ) t
  ORDER BY t.last_walk_at ASC NULLS FIRST, t.last_complete_at ASC NULLS FIRST, t.username
$$;

-- audit_20261110_panini_linked_walk_skips_a_missing_profile_for_a_day
--
-- 2026-11-10 (Claude Code cloud, ~7:55 PM PT): the linked Panini walk (every 2 h, 36-min budget) re-walked
-- `mempheattle` on EVERY run since 7:20 AM PT 11-10 -- 6 runs, every one `profile_state = not_found` ("no collection
-- list", Panini's /usernotfound page) and logged ok=false, so `panini-collector-walk` read 8 failures / 114 runs in 24 h
-- for one linked name that has no Panini profile. This function has no cooldown (rotation has its 20 h one), and its
-- least-recently-walked-first order (20261110023930) puts a failed name straight back in line.
--
-- Now a linked username whose LAST walk found no profile is skipped until 24 h after that walk; it is re-checked once a
-- day, so a profile created later is found within a day. A user who fixes the name links a NEW identity value -- a
-- different username, walked at once. Never-walked names (no walks row) are unaffected: the test is wrapped in
-- COALESCE(..., false), because NOT of a NULL would drop them. Everything else is the 20261110023930 body verbatim
-- (live prosrc md5 3fbaf35e3f4f13a41c174e14533ff773 = that file, checked 11-10).
--
-- Same signature and columns (CREATE OR REPLACE keeps the grants); body only.
-- anon-exec: unchanged — service-role only (public.panini_collector_walk_targets)
-- REVERT: re-apply 20261110023930.

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
      -- 2026-11-10: a name whose last walk found NO profile waits 24 h before the next try.
      AND NOT COALESCE(w.profile_state = 'not_found' AND w.last_walk_at > now() - interval '24 hours', false)
    ORDER BY lower(btrim(s.identity_value)), s.created_at
  ) t
  ORDER BY t.last_walk_at ASC NULLS FIRST, t.last_complete_at ASC NULLS FIRST, t.username
$$;

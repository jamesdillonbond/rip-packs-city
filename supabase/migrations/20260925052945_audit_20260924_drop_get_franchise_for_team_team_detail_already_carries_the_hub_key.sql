-- 2026-09-24 (PT) — superseded within minutes: get_team_detail already returns
-- `league` + `team_short_slug` (the hub key the follow button uses), so the
-- team page links its franchise hub from the detail it already has and the
-- reverse lookup in 20260925052924 is redundant. Dropped so no unused SECDEF
-- function drifts. Revert: re-apply 20260925052924.
DROP FUNCTION IF EXISTS public.get_franchise_for_team(uuid, text);

-- audit_20261031_user_favorite_players
--
-- 2026-10-31 (Cowork; Trevor: "Keep going"). webz_80 asked in the concierge on
-- 10-27 for a "favorite player option similar to favorite team" (feedback row
-- 11800, source 11693). Teams are one pick per league (user_favorite_teams PK
-- (user_id, league)); players are a LIST, keyed by the collection-agnostic player
-- hub slug (/players/<slug>), capped at 50 per account by trigger.
--
-- Writes go through /api/players/follow with the user's SESSION client, so RLS is
-- the ownership check (same shape as uft_*_own). No anon access; service_role
-- bypasses RLS as usual. display_name is the hub's name at follow time.
--
-- anon-exec: intentional — enforce_user_favorite_players_cap is a trigger function (not callable as an RPC) and is revoked from anon/authenticated below (enforce_user_favorite_players_cap)
--
-- Revert: DROP TABLE public.user_favorite_players; DROP FUNCTION public.enforce_user_favorite_players_cap();

CREATE TABLE IF NOT EXISTS public.user_favorite_players (
  user_id      uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  player_slug  text        NOT NULL CHECK (player_slug ~ '^[a-z0-9-]{2,120}$' AND player_slug ~ '[a-z0-9]'),
  display_name text        NOT NULL CHECK (length(display_name) BETWEEN 1 AND 200),
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, player_slug)
);

COMMENT ON TABLE public.user_favorite_players IS
  'Players a signed-in user follows (2026-10-31, webz_80 feedback 11800). Keyed by the /players/<slug> hub slug; RLS own-row; max 50 per user (trigger).';

ALTER TABLE public.user_favorite_players ENABLE ROW LEVEL SECURITY;

CREATE POLICY ufp_select_own ON public.user_favorite_players FOR SELECT TO authenticated
  USING ((SELECT auth.uid()) = user_id);
CREATE POLICY ufp_insert_own ON public.user_favorite_players FOR INSERT TO authenticated
  WITH CHECK ((SELECT auth.uid()) = user_id);
CREATE POLICY ufp_delete_own ON public.user_favorite_players FOR DELETE TO authenticated
  USING ((SELECT auth.uid()) = user_id);

REVOKE ALL ON public.user_favorite_players FROM anon;
GRANT SELECT, INSERT, DELETE ON public.user_favorite_players TO authenticated;

CREATE OR REPLACE FUNCTION public.enforce_user_favorite_players_cap()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF (SELECT count(*) FROM public.user_favorite_players WHERE user_id = NEW.user_id) >= 50 THEN
    RAISE EXCEPTION 'favorite player limit reached (50)' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.enforce_user_favorite_players_cap() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER user_favorite_players_cap
  BEFORE INSERT ON public.user_favorite_players
  FOR EACH ROW EXECUTE FUNCTION public.enforce_user_favorite_players_cap();

-- audit_20261031_user_favorite_players_collection_scope
--
-- 2026-10-31 (Cowork; Trevor: "Make sure you have this setup for all collections we
-- support"). Player follows were keyed by the cross-collection player hub slug, and
-- the hub excludes Disney Pinnacle (characters), so a Pinnacle character could not be
-- followed. collection_slug = '' is a hub follow (Top Shot, All Day, Golazos, UFC,
-- Candy MLB, Panini — every sports collection, one follow per person); a URL
-- collection slug (e.g. 'disney-pinnacle') is a follow scoped to that collection's
-- player page. The table held 0 rows when this ran, so the PK swap moves no data.
--
-- Revert: ALTER TABLE public.user_favorite_players DROP CONSTRAINT user_favorite_players_pkey,
--   ADD PRIMARY KEY (user_id, player_slug); ALTER TABLE public.user_favorite_players DROP COLUMN collection_slug;

ALTER TABLE public.user_favorite_players
  ADD COLUMN collection_slug text NOT NULL DEFAULT ''
    CHECK (collection_slug = '' OR collection_slug ~ '^[a-z0-9-]{2,40}$');

ALTER TABLE public.user_favorite_players
  DROP CONSTRAINT user_favorite_players_pkey,
  ADD CONSTRAINT user_favorite_players_pkey PRIMARY KEY (user_id, collection_slug, player_slug);

COMMENT ON COLUMN public.user_favorite_players.collection_slug IS
  'Empty = cross-collection player hub follow (/players/<slug>); a URL collection slug = a follow of that collection''s player page (Disney Pinnacle characters, which have no hub).';

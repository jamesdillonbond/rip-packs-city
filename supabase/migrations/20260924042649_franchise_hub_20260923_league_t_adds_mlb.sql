-- Franchise hubs, step 1 of 2: MLB joins league_t so Candy MLB's 30 clubs can
-- enter teams_master (the franchise registry). ADD VALUE is its own migration
-- because a new enum value cannot be USED in the transaction that adds it.
ALTER TYPE public.league_t ADD VALUE IF NOT EXISTS 'MLB';
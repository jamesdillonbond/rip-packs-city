-- Applied to prod via Supabase MCP on 2026-07-27. Committed here for parity.
--
-- Candy jersey numbers. The Serials footnote on /insights/candy-mlb told
-- visitors that "Candy players carry no jersey number" and used that as the
-- reason the board has no jersey-match rows (Top Shot's does). The claim is
-- FALSE — verified on three independent mints 2026-07-27: Aaron Judge #99,
-- Manny Machado #13, Mike Trout #27. Every ICON carries a `Player Number`
-- trait, and the daily DAS walk already reads that same attribute map for
-- player_name and team_name.
--
-- Stored in its own table rather than as a column on `editions`: editions is a
-- hot shared table with many dependents and this is a Candy-scoped attribute.
--
-- REVERT: DROP TABLE IF EXISTS public.candy_player_numbers;

CREATE TABLE IF NOT EXISTS public.candy_player_numbers (
  external_id   text PRIMARY KEY,
  collection_id uuid NOT NULL,
  player_name   text,
  jersey_number integer,
  updated_at    timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.candy_player_numbers ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.candy_player_numbers FROM anon, authenticated;
CREATE INDEX IF NOT EXISTS idx_candy_player_numbers_jersey
  ON public.candy_player_numbers (jersey_number) WHERE jersey_number IS NOT NULL;

COMMENT ON TABLE public.candy_player_numbers IS
  'Candy jersey numbers, one row per edition external_id, harvested from the DAS "Player Number" trait by the daily editions walk. Exists because the Serials board claimed Candy has no jersey numbers — it does. Added 2026-07-27.';

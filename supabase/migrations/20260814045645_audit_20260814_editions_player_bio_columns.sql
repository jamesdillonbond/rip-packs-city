-- Player bio fields for the "fun facts" collector hooks (birthday serials,
-- draft-year serials, hometown). Confirmed AVAILABLE upstream on Top Shot's
-- PlayStats type by /api/admin/discover-moment-descriptors on 2026-08-13:
--   birthdate  -> "1999-06-17"
--   birthplace -> "Havre De Grace, MD, USA"
--   draftYear  -> 2020
--
-- Denormalized onto `editions` rather than `players`, following the existing
-- precedent on this table (player_name / team_name / jersey_number are already
-- denormalized here) and because the Top Shot catalog walker's upsert writes
-- editions. Nullable, no default: this is a metadata-only ALTER, no rewrite.
--
-- Prefixed `player_` deliberately. This table already has `game_date` and
-- `first_minted_at`, so a bare `birthdate` on an EDITION row would read as a
-- date about the moment rather than about the person.
--
-- ⚠ The writer MUST map Top Shot's SENTINELS to NULL (draftYear 0, "N/A", "")
-- via lib/topshot/play-description.ts `isSentinel` — otherwise every player
-- with unknown draft data lands draft_year = 0, and "serial matches draft
-- year" starts firing on garbage.
ALTER TABLE public.editions
  ADD COLUMN IF NOT EXISTS player_birthdate  date,
  ADD COLUMN IF NOT EXISTS player_birthplace text,
  ADD COLUMN IF NOT EXISTS player_draft_year smallint;

COMMENT ON COLUMN public.editions.player_birthdate IS
  'Player birthdate from Top Shot PlayStats.birthdate. Powers birthday-serial finds (born 6/17 -> serial 617). Sentinels normalized to NULL.';
COMMENT ON COLUMN public.editions.player_birthplace IS
  'Player birthplace from Top Shot PlayStats.birthplace, e.g. "Havre De Grace, MD, USA". Identity hook for hometown-based collecting.';
COMMENT ON COLUMN public.editions.player_draft_year IS
  'Draft year from Top Shot PlayStats.draftYear. Sentinel 0 normalized to NULL, so a serial-matches-draft-year check never fires on unknown data.';
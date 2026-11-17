-- 2026-11-15: NWSL joins league_t ahead of Panini Blockchain drop #1065 (2026 Prizm Black NWSL Soccer, Nov 20).
-- Revert: enum values cannot be dropped in place; remove dependent rows first, then recreate the type without NWSL.
ALTER TYPE public.league_t ADD VALUE IF NOT EXISTS 'NWSL';

-- 2026-10-19 (PT) — a badge_taxonomy row for the "Autographed" badge that
-- get_edition_badges_unified now emits for a signed edition (20261020030510). Without it
-- BadgeIcon renders the title as an unstyled neutral pill with no tooltip.
-- normalized_key = the lookup key normalizeBadgeKey('Autographed') produces.
-- Revert: UPDATE public.badge_taxonomy SET description = NULL WHERE id = 'autographed'; or remove the row by id.
INSERT INTO public.badge_taxonomy (id, title, category, color_family, priority, description, normalized_key)
VALUES ('autographed', 'Autographed', 'achievement', 'gold', 5,
        'Signed by the player — a digital autograph on this edition (source: Atlas autographedAt).',
        'autographed')
ON CONFLICT (id) DO NOTHING;

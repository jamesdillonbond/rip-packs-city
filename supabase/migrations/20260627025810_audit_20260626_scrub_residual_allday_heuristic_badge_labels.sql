-- Scrub the 7 residual retired-heuristic AllDay badge labels (6x "Rookie", 1x "Playoffs")
-- from badge_editions.set_play_tags. The classifyAlldayBadges set-name heuristic was retired
-- when the real per-moment Atlas badge ingest shipped (e56e4e3). These 7 editions are the
-- handful the Atlas sweep does NOT badge (confirmed via a full re-sweep 2026-06-26: 5,835
-- fetched / 0 errors, these stay un-badged) -- 4 are "Rookie Marquee" Series-7 (Marvin
-- Harrison Jr / Caleb Williams / Malik Nabers / Jayden Daniels, ext 3099-3102), the rest
-- ext 422/490/751. The real Atlas taxonomy has no plain "Rookie"/"Playoffs" (it uses
-- "Rookie Year"/"Rookie Mint"/etc.), so these are definitively heuristic residue. Removing
-- only those two titles keeps the platform 100% Atlas-consistent; affected editions now show
-- no badge (honest, matching other un-badged AllDay editions). Does NOT touch "Championship
-- Year" (a real Atlas badge on 473 editions).
-- REVERT: re-add {"title":"Rookie"} to ext 3099,3100,3101,3102,422,490 and {"title":"Playoffs"}
-- to ext 751 (retired-heuristic output; not recommended).
UPDATE public.badge_editions
SET set_play_tags = (
  SELECT coalesce(jsonb_agg(t), '[]'::jsonb)
  FROM jsonb_array_elements(set_play_tags) t
  WHERE t->>'title' NOT IN ('Rookie','Playoffs')
)
WHERE collection_id='dee28451-5d62-409e-a1ad-a83f763ac070'
  AND EXISTS (SELECT 1 FROM jsonb_array_elements(set_play_tags) t WHERE t->>'title' IN ('Rookie','Playoffs'));

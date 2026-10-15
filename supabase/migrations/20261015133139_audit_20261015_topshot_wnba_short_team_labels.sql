-- audit_20261015_topshot_wnba_short_team_labels
--
-- 2026-10-15 (Claude Code cloud; Trevor: "Take care of all of this"). Four Top
-- Shot WNBA editions carried short team labels that name no franchise, so the
-- Market Team filter (which expands a pick to its franchise's labels via
-- resolve_team_name) could not reach them and they showed as separate "teams":
--   258:9264      Kyara Linskens, WNBA Base Set              PHO     → Phoenix Mercury
--   280:9307      Raven Johnson, 2026 WNBA Playoff Premieres  Fever   → Indiana Fever
--   280:9307::20  (its parallel)                              Fever   → Indiana Fever
--   259:9305      Breanna Stewart, WNBA Top Shot This          Liberty → New York Liberty
-- Each target is the full label the same player's other editions carry.
--
-- Sticks: every Top Shot writer of editions.team_name is fill-only —
-- catalog_topshot_from_atlas COALESCE(e.team_name, b.team),
-- upsert_topshot_edition_metadata COALESCE(NULLIF(team_name,''), p_team) —
-- and sync_topshot_parallel_identity_from_base copies from the base, which is
-- corrected in the same statement. Verified after apply: 4 rows carry the full
-- names; no Top Shot or All Day edition carries a 2–4-letter all-caps label.
--
-- REVERT: UPDATE public.editions SET team_name = CASE external_id
--   WHEN '258:9264' THEN 'PHO' WHEN '259:9305' THEN 'Liberty' ELSE 'Fever' END
--   WHERE collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
--     AND external_id IN ('258:9264','280:9307','280:9307::20','259:9305');
UPDATE public.editions
SET team_name = CASE btrim(team_name)
      WHEN 'PHO' THEN 'Phoenix Mercury'
      WHEN 'Fever' THEN 'Indiana Fever'
      WHEN 'Liberty' THEN 'New York Liberty'
    END,
    updated_at = now()
WHERE collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
  AND external_id IN ('258:9264', '280:9307', '280:9307::20', '259:9305')
  AND btrim(team_name) IN ('PHO', 'Fever', 'Liberty');

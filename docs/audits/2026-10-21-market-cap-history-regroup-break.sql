-- 2026-10-21 ~6:50 AM PT (Claude Code cloud; Trevor: "Keep going") — market-cap 7-day change across a
-- definition change.
--
-- Found by a live sweep: /nfl-all-day/player/patrick-mahomes read "7-Day Change +1992.8% from $17.5K".
-- Not a market move: 20261021041717 (10-20 9:41 PM PT refresh) regrouped the market-cap PLAYER grain
-- from the edition's LABEL slug to the linked PERSON, and the namesake splits the same night (Golazos and
-- Panini Luis Suárez) moved editions between persons. market_cap_daily keeps only group rows (no edition
-- grain), so the 7-day baseline for a regrouped key is the OLD group: "patrick-mahomes" was 6 editions /
-- $18.9K on 10-19 (the "Mahomes II"-labelled 26 sat in another key); today it is 32 editions / $365.5K.
--
-- FIX (data, UPDATE only, reversible): every player-grain key whose membership the regroup changed —
-- both sides of every edition whose label slug differs from its person slug — has its pre-change history
-- rows moved aside under group_key || '~pre-20261021-regroup' (rows computed before 2026-10-21 00:00 PT).
-- Readers join on group_key, so those keys report no 7-day figure until 10-28, when the baseline is a
-- post-regroup snapshot. Nothing is deleted. Measured before the write: 22 Top Shot, 105 All Day,
-- 2 Golazos, 2 Panini keys; ~1,838 rows.
--
-- REVERT: UPDATE public.market_cap_daily
--            SET group_key = replace(group_key, '~pre-20261021-regroup', '')
--          WHERE group_key LIKE '%~pre-20261021-regroup';

WITH ed AS (
  SELECT c.slug AS coll,
         regexp_replace(lower(extensions.unaccent(e.player_name)), '[^a-z0-9]+', '-', 'g') AS old_k,
         regexp_replace(lower(extensions.unaccent(coalesce(pl.name, e.player_name))), '[^a-z0-9]+', '-', 'g') AS new_k
    FROM public.editions e
    JOIN public.collections c ON c.id = e.collection_id
    LEFT JOIN public.players pl ON pl.id = e.player_id
   WHERE coalesce(e.player_name, '') <> ''
     AND c.slug IN (SELECT DISTINCT collection_slug FROM public.market_cap_current)
), ks AS (
  SELECT coll, old_k AS k FROM ed WHERE old_k <> new_k
  UNION
  SELECT coll, new_k FROM ed WHERE old_k <> new_k
), moved AS (
  UPDATE public.market_cap_daily d
     SET group_key = d.group_key || '~pre-20261021-regroup'
    FROM ks
   WHERE d.grain = 'player'
     AND d.collection_slug = ks.coll
     AND d.group_key = ks.k
     AND d.computed_at < '2026-10-21 00:00:00-07'
  RETURNING d.collection_slug
)
SELECT collection_slug, count(*) AS rows_moved FROM moved GROUP BY 1 ORDER BY 1;

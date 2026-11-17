-- audit_20260704_golazos_title_repair
-- Repair Latin-1-as-UTF-8 mojibake in LaLiga Golazos team fields (frozen one-time import artifact).
--
-- Investigation correction: the pack/team audit reported ~85 corrupt "titles" in
-- player_name / set_name. Live measurement disproved that — player_name / set_name / name
-- are correctly-stored UTF-8 (e.g. "Abdón Prats", "Agustín Marchesín", "ElClásico") and are
-- deliberately NOT touched. The real corruption is confined to the team fields:
--   home_team (84 rows), away_team (84 rows), team_name (1 row) = 156 distinct rows.
--
-- All 8 distinct corrupt values are cleanly recoverable with 4 deterministic substitutions:
--   Ã©  -> é   (90 col-hits)   e.g. "AtlÃ©tico de Madrid" -> "Atlético de Madrid"
--   Ã¡  -> á   (34 col-hits)   e.g. "CÃ¡diz CF"           -> "Cádiz CF"
--   Ã±  -> ñ   (12 col-hits)   e.g. "Deportivo de la CoruÃ±a" -> "Deportivo de la Coruña"
--   Ã­  -> í   (32 col-hits)   e.g. "UD AlmerÃ­a"          -> "UD Almería"
--
-- No Â artifacts and no ambiguous â em/en-dash cases exist in these fields, so nothing is
-- guessed and nothing is deferred. Scoped to Golazos rows that actually carry the Ã marker;
-- replace() over a clean column is a no-op, so re-running is idempotent.
--
-- Revert (straightforward — reverse the substitutions on the same scoped set):
--   UPDATE public.editions
--   SET home_team = replace(replace(replace(replace(home_team,'é','Ã©'),'á','Ã¡'),'ñ','Ã±'),'í','Ã­'),
--       away_team = replace(replace(replace(replace(away_team,'é','Ã©'),'á','Ã¡'),'ñ','Ã±'),'í','Ã­'),
--       team_name = replace(replace(replace(replace(team_name,'é','Ã©'),'á','Ã¡'),'ñ','Ã±'),'í','Ã­')
--   WHERE collection_id = '06248cc4-b85f-47cd-af67-1855d14acd75'
--     AND external_id IN (<the 156 repaired external_ids>);
--   (revert is only exact if targeted at the repaired rows — the forward migration recorded them.)

UPDATE public.editions
SET
  home_team = replace(replace(replace(replace(home_team, 'Ã©', 'é'), 'Ã¡', 'á'), 'Ã±', 'ñ'), 'Ã­', 'í'),
  away_team = replace(replace(replace(replace(away_team, 'Ã©', 'é'), 'Ã¡', 'á'), 'Ã±', 'ñ'), 'Ã­', 'í'),
  team_name = replace(replace(replace(replace(team_name, 'Ã©', 'é'), 'Ã¡', 'á'), 'Ã±', 'ñ'), 'Ã­', 'í')
WHERE collection_id = '06248cc4-b85f-47cd-af67-1855d14acd75'
  AND (home_team LIKE '%Ã%' OR away_team LIKE '%Ã%' OR team_name LIKE '%Ã%');

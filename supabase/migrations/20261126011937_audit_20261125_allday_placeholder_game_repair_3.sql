CREATE TEMP TABLE allday_official_game3 (external_id text PRIMARY KEY, gd date, home text, away text, team text) ON COMMIT DROP;
INSERT INTO allday_official_game3 VALUES
  ('3028','2024-09-15'::date,'Green Bay Packers','Indianapolis Colts','Indianapolis Colts'),
  ('3029','2024-09-22'::date,'Indianapolis Colts','Chicago Bears','Indianapolis Colts'),
  ('3033','2024-09-05'::date,'Kansas City Chiefs','Baltimore Ravens','Kansas City Chiefs'),
  ('3046','2024-10-13'::date,'New England Patriots','Houston Texans','New England Patriots'),
  ('3047','2024-09-15'::date,'New England Patriots','Seattle Seahawks','New England Patriots'),
  ('3048','2024-11-17'::date,'New England Patriots','Los Angeles Rams','New England Patriots'),
  ('3103','2024-09-15'::date,'Arizona Cardinals','Los Angeles Rams','Arizona Cardinals');

CREATE TABLE public.audit_20261125_allday_placeholder_game_backup3 AS
SELECT e.id, e.external_id, e.play_id_onchain, e.game_date, e.home_team, e.away_team, e.team_name, now() AS backed_up_at
FROM public.editions e JOIN allday_official_game3 v ON v.external_id = e.external_id
WHERE e.collection = 'nfl_all_day';

ALTER TABLE public.audit_20261125_allday_placeholder_game_backup3 ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.audit_20261125_allday_placeholder_game_backup3 FROM PUBLIC, anon, authenticated;

UPDATE public.editions e
   SET game_date = v.gd, home_team = v.home, away_team = v.away,
       team_name = COALESCE(e.team_name, v.team), updated_at = now()
  FROM allday_official_game3 v
 WHERE e.collection = 'nfl_all_day'
   AND e.external_id = v.external_id
   AND COALESCE(e.team_name, v.team) = v.team;

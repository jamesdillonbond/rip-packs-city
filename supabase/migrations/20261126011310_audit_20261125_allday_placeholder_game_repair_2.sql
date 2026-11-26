CREATE TEMP TABLE allday_official_game2 (external_id text PRIMARY KEY, gd date, home text, away text) ON COMMIT DROP;
INSERT INTO allday_official_game2 VALUES
  ('2997','2024-12-15'::date,'Arizona Cardinals','New England Patriots'),
  ('2998','2024-09-15'::date,'Arizona Cardinals','Los Angeles Rams'),
  ('2999','2024-09-29'::date,'Arizona Cardinals','Washington Commanders'),
  ('3000','2024-09-29'::date,'Arizona Cardinals','Washington Commanders'),
  ('3001','2024-10-20'::date,'Atlanta Falcons','Seattle Seahawks'),
  ('3002','2024-12-16'::date,'Las Vegas Raiders','Atlanta Falcons'),
  ('3003','2024-12-15'::date,'New York Giants','Baltimore Ravens'),
  ('3004','2024-09-22'::date,'Dallas Cowboys','Baltimore Ravens'),
  ('3005','2024-09-12'::date,'Miami Dolphins','Buffalo Bills'),
  ('3006','2024-09-08'::date,'Buffalo Bills','Arizona Cardinals'),
  ('3007','2024-09-29'::date,'Carolina Panthers','Cincinnati Bengals'),
  ('3008','2024-12-01'::date,'Carolina Panthers','Tampa Bay Buccaneers'),
  ('3009','2024-09-08'::date,'New Orleans Saints','Carolina Panthers'),
  ('3010','2024-09-08'::date,'Chicago Bears','Tennessee Titans'),
  ('3011','2024-09-22'::date,'Indianapolis Colts','Chicago Bears'),
  ('3012','2024-09-23'::date,'Cincinnati Bengals','Washington Commanders'),
  ('3013','2024-09-15'::date,'Kansas City Chiefs','Cincinnati Bengals'),
  ('3014','2024-09-29'::date,'Carolina Panthers','Cincinnati Bengals'),
  ('3015','2024-12-02'::date,'Denver Broncos','Cleveland Browns'),
  ('3016','2024-12-15'::date,'Cleveland Browns','Kansas City Chiefs'),
  ('3017','2024-09-26'::date,'New York Giants','Dallas Cowboys'),
  ('3018','2024-09-08'::date,'Cleveland Browns','Dallas Cowboys'),
  ('3020','2024-10-06'::date,'Denver Broncos','Las Vegas Raiders'),
  ('3021','2024-10-27'::date,'Detroit Lions','Tennessee Titans'),
  ('3022','2024-09-22'::date,'Arizona Cardinals','Detroit Lions'),
  ('3023','2024-09-06'::date,'Philadelphia Eagles','Green Bay Packers'),
  ('3024','2024-09-29'::date,'Green Bay Packers','Minnesota Vikings'),
  ('3025','2024-09-15'::date,'Green Bay Packers','Indianapolis Colts'),
  ('3026','2024-09-15'::date,'Houston Texans','Chicago Bears'),
  ('3027','2024-09-15'::date,'Houston Texans','Chicago Bears'),
  ('3030','2024-09-08'::date,'Miami Dolphins','Jacksonville Jaguars'),
  ('3031','2024-10-13'::date,'Chicago Bears','Jacksonville Jaguars'),
  ('3032','2024-09-15'::date,'Kansas City Chiefs','Cincinnati Bengals'),
  ('3034','2024-09-08'::date,'Los Angeles Chargers','Las Vegas Raiders'),
  ('3035','2024-11-03'::date,'Cincinnati Bengals','Las Vegas Raiders'),
  ('3036','2024-09-08'::date,'Los Angeles Chargers','Las Vegas Raiders'),
  ('3037','2024-09-15'::date,'Carolina Panthers','Los Angeles Chargers'),
  ('3038','2024-09-08'::date,'Los Angeles Chargers','Las Vegas Raiders'),
  ('3040','2024-09-15'::date,'Arizona Cardinals','Los Angeles Rams'),
  ('3041','2024-09-08'::date,'Detroit Lions','Los Angeles Rams'),
  ('3042','2024-10-27'::date,'Miami Dolphins','Arizona Cardinals'),
  ('3043','2024-09-30'::date,'Miami Dolphins','Tennessee Titans'),
  ('3044','2024-09-08'::date,'New York Giants','Minnesota Vikings'),
  ('3049','2024-09-15'::date,'Dallas Cowboys','New Orleans Saints'),
  ('3050','2024-10-13'::date,'New Orleans Saints','Tampa Bay Buccaneers'),
  ('3051','2024-09-08'::date,'New Orleans Saints','Carolina Panthers'),
  ('3052','2024-09-08'::date,'New York Giants','Minnesota Vikings'),
  ('3053','2024-10-06'::date,'Seattle Seahawks','New York Giants'),
  ('3054','2024-09-15'::date,'Tennessee Titans','New York Jets'),
  ('3055','2024-12-01'::date,'New York Jets','Seattle Seahawks'),
  ('3056','2024-09-29'::date,'New York Jets','Denver Broncos'),
  ('3057','2024-10-13'::date,'Philadelphia Eagles','Cleveland Browns'),
  ('3058','2024-09-06'::date,'Philadelphia Eagles','Green Bay Packers'),
  ('3059','2024-09-08'::date,'Atlanta Falcons','Pittsburgh Steelers'),
  ('3061','2024-09-15'::date,'Denver Broncos','Pittsburgh Steelers'),
  ('3062','2024-10-10'::date,'Seattle Seahawks','San Francisco 49ers'),
  ('3063','2024-10-10'::date,'Seattle Seahawks','San Francisco 49ers'),
  ('3064','2024-10-27'::date,'San Francisco 49ers','Dallas Cowboys'),
  ('3065','2024-09-15'::date,'New England Patriots','Seattle Seahawks'),
  ('3066','2024-10-06'::date,'Seattle Seahawks','New York Giants'),
  ('3067','2024-10-13'::date,'New Orleans Saints','Tampa Bay Buccaneers'),
  ('3068','2024-09-08'::date,'Tampa Bay Buccaneers','Washington Commanders'),
  ('3069','2024-09-08'::date,'Tampa Bay Buccaneers','Washington Commanders'),
  ('3070','2024-09-08'::date,'Chicago Bears','Tennessee Titans'),
  ('3071','2024-09-08'::date,'Chicago Bears','Tennessee Titans'),
  ('3072','2024-10-20'::date,'Washington Commanders','Carolina Panthers'),
  ('3073','2024-09-08'::date,'Tampa Bay Buccaneers','Washington Commanders'),
  ('3074','2024-10-06'::date,'Washington Commanders','Cleveland Browns'),
  ('3075','2024-09-23'::date,'Cincinnati Bengals','Washington Commanders'),
  ('3076','2024-10-06'::date,'Washington Commanders','Cleveland Browns'),
  ('4391','2025-12-14'::date,'San Francisco 49ers','Tennessee Titans'),
  ('5988','2025-12-28'::date,'San Francisco 49ers','Chicago Bears'),
  ('5989','2025-12-28'::date,'San Francisco 49ers','Chicago Bears'),
  ('5990','2025-12-28'::date,'San Francisco 49ers','Chicago Bears'),
  ('5991','2025-12-28'::date,'San Francisco 49ers','Chicago Bears');

CREATE TABLE public.audit_20261125_allday_placeholder_game_backup2 AS
SELECT e.id, e.external_id, e.play_id_onchain, e.game_date, e.home_team, e.away_team, now() AS backed_up_at
FROM public.editions e
WHERE e.collection = 'nfl_all_day'
  AND (e.external_id IN (SELECT external_id FROM allday_official_game2)
       OR e.external_id IN ('3060','3099','3100','3101','3102'));

ALTER TABLE public.audit_20261125_allday_placeholder_game_backup2 ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.audit_20261125_allday_placeholder_game_backup2 FROM PUBLIC, anon, authenticated;

UPDATE public.editions e
   SET game_date = v.gd, home_team = v.home, away_team = v.away, updated_at = now()
  FROM allday_official_game2 v
 WHERE e.collection = 'nfl_all_day'
   AND e.external_id = v.external_id
   AND e.team_name IN (v.home, v.away);

UPDATE public.editions
   SET home_team = NULL, away_team = NULL, updated_at = now()
 WHERE collection = 'nfl_all_day'
   AND external_id IN ('3060','3099','3100','3101','3102')
   AND home_team IS NOT NULL
   AND team_name NOT IN (home_team, away_team);

-- audit_20261126_espn_ids_that_name_someone_else
--
-- 16 player_identities carried an ESPN id that is not the person (measured 2026-11-26 ~6:55 AM PT by
-- fetching each id's athlete page in its own league through pg_net):
--   · 3 are SOMEONE ELSE (matcher espn-search:stats-probe took an id from another league's search hit
--     and accepted it because the id had seasons here; ESPN ids are per league): Michael Cage → nba/31
--     Dalibor Bagaric, Michael Cooper → nba/142 John Celestand, Tim Thomas → wnba/22 Sue Wicks. Their
--     player pages and Moment slabs showed that person's stats.
--   · 13 do not exist under the league's athlete path (404 — ESPN's search served what look like college
--     ids): Candace Parker, Derrick Favors, Doc Rivers, Festus Ezeli, Hakim Warrick, Jarrett Jack, Jeremy
--     Lamb, Kenneth Faried, Kent Bazemore, Lance Stephenson, Mario Chalmers, Maurice Harkless, Nate
--     Robinson. They showed no stats.
-- The other 40 ids in the probe (every stats-probe match + every id ESPN's stored names did not cover)
-- named the right person.
--
-- The rows are cleared and RE-QUEUED (espn_id_matched_by NULL): player_stats_espn_resolve_targets takes
-- espn_id IS NULL and matched_by not 'unresolved:%', and scripts/sync-player-stats.mjs now takes an id only
-- when the league's athlete page at that id names the person (athleteCheck), pushed before this migration.
-- Until a correct id lands, these players show no stats (get_player_season_stats → NULL, the slab shows no
-- stats block) — no line beats someone else's.
--
-- Revert (restores the wrong ids):
--   update public.player_identities i set espn_id = v.espn_id, espn_league = v.espn_league, espn_id_matched_by = v.mb
--     from (values
--       ('7ae33bd6-b91e-4158-bd29-acfff7ab10f6'::uuid,'2170654','nba','espn-search:name'),
--       ('b8dfa596-47b8-4069-9c3b-45e466cc36d4'::uuid,'2488656','nba','espn-search:name'),
--       ('c4edbba2-be44-402f-830d-7f7fb3661665'::uuid,'2028616','nba','espn-search:name'),
--       ('75becee7-4544-4db1-86ed-0970a3ad88cf'::uuid,'2284122','nba','espn-search:name'),
--       ('71fc53b0-14c8-4255-bb61-b7b620242ff6'::uuid,'2049800','nba','espn-search:name'),
--       ('6319aa5a-e160-4c07-8c83-4300a5603e4d'::uuid,'2113886','nba','espn-search:name'),
--       ('470e4f72-8dbc-4c70-af18-518ddd502f5e'::uuid,'2554035','nba','espn-search:name'),
--       ('cd901c45-716f-4300-a844-fe1a6263a168'::uuid,'2284509','nba','espn-search:name'),
--       ('354f8611-69a0-44ce-b8b7-a72d1f466f55'::uuid,'2282857','nba','espn-search:name'),
--       ('8692ad43-f9c7-427f-b888-fece2734b284'::uuid,'2488691','nba','espn-search:name'),
--       ('8489b960-d50f-4c4a-9747-05f36be24192'::uuid,'2202073','nba','espn-search:name'),
--       ('cc54ece8-a1f9-47f5-a6af-01e44b2f92c0'::uuid,'2608895','nba','espn-search:name'),
--       ('176dcc07-d4ac-4dd9-a7e6-b69f67092020'::uuid,'31','nba','espn-search:stats-probe'),
--       ('ac8327da-137b-47cf-ae1d-8028ff9a6b4b'::uuid,'142','nba','espn-search:stats-probe'),
--       ('2c53d3b7-6021-4c73-a3cd-dea8c9791984'::uuid,'2115954','nba','espn-search:name'),
--       ('42159e58-e71a-4b2a-aecb-509fb1a5896b'::uuid,'22','wnba','espn-search:stats-probe')
--     ) v(id, espn_id, espn_league, mb) where i.id = v.id;

do $$
declare
  v_n int;
begin
  update public.player_identities i
     set espn_id = null, espn_league = null, espn_id_matched_by = null
    from (values
      ('7ae33bd6-b91e-4158-bd29-acfff7ab10f6'::uuid,'2170654'),
      ('b8dfa596-47b8-4069-9c3b-45e466cc36d4'::uuid,'2488656'),
      ('c4edbba2-be44-402f-830d-7f7fb3661665'::uuid,'2028616'),
      ('75becee7-4544-4db1-86ed-0970a3ad88cf'::uuid,'2284122'),
      ('71fc53b0-14c8-4255-bb61-b7b620242ff6'::uuid,'2049800'),
      ('6319aa5a-e160-4c07-8c83-4300a5603e4d'::uuid,'2113886'),
      ('470e4f72-8dbc-4c70-af18-518ddd502f5e'::uuid,'2554035'),
      ('cd901c45-716f-4300-a844-fe1a6263a168'::uuid,'2284509'),
      ('354f8611-69a0-44ce-b8b7-a72d1f466f55'::uuid,'2282857'),
      ('8692ad43-f9c7-427f-b888-fece2734b284'::uuid,'2488691'),
      ('8489b960-d50f-4c4a-9747-05f36be24192'::uuid,'2202073'),
      ('cc54ece8-a1f9-47f5-a6af-01e44b2f92c0'::uuid,'2608895'),
      ('176dcc07-d4ac-4dd9-a7e6-b69f67092020'::uuid,'31'),
      ('ac8327da-137b-47cf-ae1d-8028ff9a6b4b'::uuid,'142'),
      ('2c53d3b7-6021-4c73-a3cd-dea8c9791984'::uuid,'2115954'),
      ('42159e58-e71a-4b2a-aecb-509fb1a5896b'::uuid,'22')
    ) v(id, espn_id)
   where i.id = v.id and i.espn_id = v.espn_id;
  get diagnostics v_n = row_count;
  -- only the rows still holding the measured wrong id are touched; a row another writer already changed is left alone
  raise notice 'espn ids cleared and re-queued: %', v_n;
end
$$;

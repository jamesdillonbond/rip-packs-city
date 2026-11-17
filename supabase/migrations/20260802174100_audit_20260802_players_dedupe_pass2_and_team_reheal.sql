-- audit_20260802_players_dedupe_pass2_and_team_reheal
--
-- Applied to prod 2026-08-02 via Supabase MCP; this file is the repo record.
--
-- Companion to audit_20260802_upsert_player_canonical. That migration closed the
-- WRITERS; this one repairs the rows they already damaged. Apply together.
--
-- PART A -- second dedupe pass (25 duplicate slugs, all Top Shot).
--   24 of 25 are `flow:<playID>` rows minted in the ~9-minute window between the
--   08-02 dedupe migration landing (12:40:38Z) and the wallet-search code deploy.
--   That factory is CLOSED -- zero `flow:` rows created since 13:00Z -- so this is
--   residue, not an ongoing leak. The 25th is `john-havlicek`
--   (`nba_top_shot-john-havlicek` + `76970`), the ingest factory now fixed by
--   upsert_player_canonical.
--   Survivor/merge/repoint logic is byte-identical to
--   audit_20260802_players_dedupe_and_canonical_resolver: prefer a numeric
--   external_id, then edition count, then id; COALESCE-merge enrichable columns
--   from the doomed rows; repoint editions; delete the surplus.
--   FK sweep re-confirmed: `editions.player_id` is the ONLY FK to players.id.
--
-- PART B -- re-heal the teams the ingest writer clobbered.
--   audit_20260802_players_team_from_recent_edition repaired 148 rows at ~12:40Z.
--   By 16:38Z the ingest upsertPlayer had overwritten 23 of them with
--   `teamAtMoment`. Same derivation, re-applied: each player's team = team_name of
--   its most recent edition INSIDE the data-relative 18-month horizon. Players
--   with NO in-horizon edition stay UNTOUCHED, preserving retired-player
--   behaviour (Paul Pierce keeps Boston Celtics, not his final Nets stint) -- this
--   is why the repair set is small and not the 99 rows that merely disagree with
--   their latest-ever edition.
--   Ordering matters: PART A runs first so the merge cannot resurrect a stale
--   team onto a survivor after PART B has healed it.
--
-- VERIFIED AFTER APPLYING: duplicate slugs 25 -> 0; Top Shot players 1,384 ->
-- 1,359; in-horizon teams disagreeing with the derivation 23 -> 0; 25 rows
-- removed; 0 editions needed repointing (the doomed rows were freshly minted and
-- carried none); 0 orphaned editions; 18 teams re-healed by PART B (the PART A
-- COALESCE merge had already restored the remainder). Spot-check: Jrue Holiday ->
-- Portland Trail Blazers, Marcus Smart -> Los Angeles Lakers, Kelly Olynyk -> San
-- Antonio Spurs, Andre Drummond -> Philadelphia 76ers, Donovan Mitchell ->
-- Cleveland Cavaliers, Paul Pierce -> Boston Celtics (retired, correctly
-- preserved), John Havlicek -> Boston Celtics (retired, correctly preserved).
--
-- REVERT (both parts, in this order):
--   UPDATE public.players p SET team = b.old_team
--     FROM public.audit_20260802_players_team_backup2 b WHERE p.id = b.id;
--   UPDATE public.editions e SET player_id = r.old_player_id
--     FROM public.audit_20260802_players_dedupe2_edition_remap r WHERE e.id = r.edition_id;
--   UPDATE public.players p SET team=b.team, jersey_number=b.jersey_number,
--     position=b.position, first_name=b.first_name, last_name=b.last_name,
--     headshot_url=b.headshot_url, nba_stats_id=b.nba_stats_id,
--     player_tier=b.player_tier, is_active=b.is_active, external_id=b.external_id
--     FROM public.audit_20260802_players_dedupe2_backup b
--    WHERE p.id=b.id AND b.was_survivor;
--   INSERT INTO public.players (id, external_id, collection_id, name, first_name,
--     last_name, team, jersey_number, position, player_tier, is_active,
--     headshot_url, nba_stats_id, created_at, updated_at, collection)
--   SELECT id, external_id, collection_id, name, first_name, last_name, team,
--     jersey_number, position, player_tier, is_active, headshot_url,
--     nba_stats_id, created_at, updated_at, collection
--     FROM public.audit_20260802_players_dedupe2_backup WHERE NOT was_survivor;

-- == PART A ===================================================================
CREATE TEMP TABLE _dedupe2_map ON COMMIT DROP AS
WITH ts AS (
  SELECT p.id,
         regexp_replace(lower(trim(p.name)), '[^a-z0-9]+', '-', 'g') AS slug,
         (SELECT count(*) FROM public.editions e WHERE e.player_id = p.id) AS ed_ct,
         CASE WHEN p.external_id ~ '^[0-9]+$'  THEN 1
              WHEN p.external_id LIKE 'flow:%' THEN 3
              ELSE 2 END AS pref
    FROM public.players p
   WHERE p.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
), r AS (
  SELECT id, slug,
         count(*)        OVER (PARTITION BY slug)                                 AS grp,
         row_number()    OVER (PARTITION BY slug ORDER BY pref, ed_ct DESC, id)   AS rn,
         first_value(id) OVER (PARTITION BY slug ORDER BY pref, ed_ct DESC, id)   AS survivor_id
    FROM ts
)
SELECT id, survivor_id, slug, (rn = 1) AS is_survivor
  FROM r
 WHERE grp > 1;

CREATE TABLE public.audit_20260802_players_dedupe2_backup AS
SELECT p.*, m.survivor_id, m.is_survivor AS was_survivor
  FROM public.players p
  JOIN _dedupe2_map m ON m.id = p.id;

CREATE TABLE public.audit_20260802_players_dedupe2_edition_remap AS
SELECT e.id AS edition_id, e.player_id AS old_player_id, m.survivor_id AS new_player_id
  FROM public.editions e
  JOIN _dedupe2_map m ON m.id = e.player_id
 WHERE NOT m.is_survivor;

ALTER TABLE public.audit_20260802_players_dedupe2_backup        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_20260802_players_dedupe2_edition_remap ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.audit_20260802_players_dedupe2_backup        FROM anon, authenticated;
REVOKE ALL ON public.audit_20260802_players_dedupe2_edition_remap FROM anon, authenticated;

UPDATE public.players s SET
  team          = COALESCE(s.team,          d.team),
  jersey_number = COALESCE(s.jersey_number, d.jersey_number),
  position      = COALESCE(s.position,      d.position),
  first_name    = COALESCE(s.first_name,    d.first_name),
  last_name     = COALESCE(s.last_name,     d.last_name),
  headshot_url  = COALESCE(s.headshot_url,  d.headshot_url),
  nba_stats_id  = COALESCE(s.nba_stats_id,  d.nba_stats_id),
  player_tier   = COALESCE(s.player_tier,   d.player_tier),
  is_active     = COALESCE(s.is_active,     d.is_active),
  updated_at    = now()
FROM (
  SELECT m.survivor_id,
         (array_agg(p.team          ORDER BY p.created_at) FILTER (WHERE p.team          IS NOT NULL))[1] AS team,
         (array_agg(p.jersey_number ORDER BY p.created_at) FILTER (WHERE p.jersey_number IS NOT NULL))[1] AS jersey_number,
         (array_agg(p.position      ORDER BY p.created_at) FILTER (WHERE p.position      IS NOT NULL))[1] AS position,
         (array_agg(p.first_name    ORDER BY p.created_at) FILTER (WHERE p.first_name    IS NOT NULL))[1] AS first_name,
         (array_agg(p.last_name     ORDER BY p.created_at) FILTER (WHERE p.last_name     IS NOT NULL))[1] AS last_name,
         (array_agg(p.headshot_url  ORDER BY p.created_at) FILTER (WHERE p.headshot_url  IS NOT NULL))[1] AS headshot_url,
         (array_agg(p.nba_stats_id  ORDER BY p.created_at) FILTER (WHERE p.nba_stats_id  IS NOT NULL))[1] AS nba_stats_id,
         (array_agg(p.player_tier   ORDER BY p.created_at) FILTER (WHERE p.player_tier   IS NOT NULL))[1] AS player_tier,
         (array_agg(p.is_active     ORDER BY p.created_at) FILTER (WHERE p.is_active     IS NOT NULL))[1] AS is_active
    FROM _dedupe2_map m
    JOIN public.players p ON p.id = m.id AND NOT m.is_survivor
   GROUP BY m.survivor_id
) d
WHERE s.id = d.survivor_id;

UPDATE public.editions e
   SET player_id = m.survivor_id
  FROM _dedupe2_map m
 WHERE e.player_id = m.id
   AND NOT m.is_survivor;

DELETE FROM public.players p
 USING _dedupe2_map m
 WHERE p.id = m.id
   AND NOT m.is_survivor;

-- == PART B ===================================================================
CREATE TABLE public.audit_20260802_players_team_backup2 AS
WITH h AS (
  SELECT max(game_date) AS mg FROM public.editions
   WHERE collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd' AND game_date IS NOT NULL
), r AS (
  SELECT DISTINCT ON (e.player_name) e.player_name, e.team_name
    FROM public.editions e, h
   WHERE e.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
     AND e.team_name IS NOT NULL AND e.game_date IS NOT NULL
     AND e.game_date >= h.mg - interval '18 months'
   ORDER BY e.player_name, e.game_date DESC
)
SELECT p.id, p.name, p.team AS old_team, r.team_name AS new_team
  FROM public.players p
  JOIN r ON r.player_name = p.name
 WHERE p.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
   AND p.team IS DISTINCT FROM r.team_name;

ALTER TABLE public.audit_20260802_players_team_backup2 ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.audit_20260802_players_team_backup2 FROM anon, authenticated;

UPDATE public.players p
   SET team = b.new_team, updated_at = now()
  FROM public.audit_20260802_players_team_backup2 b
 WHERE p.id = b.id;

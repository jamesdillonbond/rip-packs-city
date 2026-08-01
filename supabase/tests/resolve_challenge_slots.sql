-- DB invariant: public.resolve_challenge_slots(uuid) -- the challenge slot-editions
-- RESOLVER (matcher, lib/challenges). NOTE: this pin points at the 2026-08-01
-- snapshot migration because the 2026-07-13 committed migration is STALE vs live.
-- It DELETE-then-reinserts challenge_slot_editions: an edition fills a slot when
-- it is in the slot's set AND its normalized player name equals the slot label
-- (exact) OR is trigram-similar (>0.6), gated by play_category; exact matches win
-- and fuzzy only fills a slot with no exact match. It also backfills
-- players.nba_stats_id when a slot resolves to exactly one player. Pinned: the
-- exact match + insert, the DELETE of stale rows, an UNRESOLVED slot (no match ->
-- no row, counted), the nba-id backfill, and the returned counts.
--
-- The function DDL below is a VERBATIM copy of the committed migration
-- (supabase/migrations/20260801231300_audit_20260801_snapshot_resolve_challenge_slots.sql);
-- __tests__/db-invariants-drift-guard.test.ts fails CI if this copy drifts, and the
-- md5 of pg_get_functiondef was confirmed byte-identical to LIVE prod on 2026-08-01
-- (14658fb2cff0cd264e850634c6833939).
--
-- Needs pg_trgm (extensions.similarity) + a public._norm_player stub. Runs inside
-- a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pg_trgm SCHEMA extensions;
CREATE FUNCTION public._norm_player(t text) RETURNS text LANGUAGE sql IMMUTABLE AS $norm$ SELECT lower(btrim(coalesce(t,''))) $norm$;
CREATE TABLE challenge_slot_editions (challenge_id uuid, slot_order int, external_id text, play_id_onchain int, UNIQUE(challenge_id, slot_order, external_id));
CREATE TABLE challenge_slots (challenge_id uuid, slot_order int, set_external_id text, label text, play_category text, nba_stats_id int);
CREATE TABLE challenges (id uuid, collection_id uuid);
CREATE TABLE editions (external_id text, collection_id uuid, set_id uuid, player_id uuid, player_name text, play_category text, play_id_onchain int);
CREATE TABLE sets (id uuid, external_id text);
CREATE TABLE players (id uuid, collection_id uuid, nba_stats_id int);

-- >>> BEGIN verbatim resolve_challenge_slots (keep byte-identical to the migration) >>>
CREATE OR REPLACE FUNCTION public.resolve_challenge_slots(p_collection_id uuid DEFAULT '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
 SET statement_timeout TO '180s'
AS $function$
DECLARE v_slots int; v_eds int; v_unresolved int; v_nba int;
BEGIN
  DELETE FROM public.challenge_slot_editions cse
  USING public.challenge_slots cs, public.challenges c
  WHERE cse.challenge_id=cs.challenge_id AND cse.slot_order=cs.slot_order
    AND cs.challenge_id=c.id AND c.collection_id=p_collection_id;

  WITH e AS (
    SELECT s.external_id AS set_uuid, ed.external_id, ed.play_id_onchain, ed.play_category,
           public._norm_player(ed.player_name) AS pn
    FROM public.editions ed JOIN public.sets s ON s.id=ed.set_id
    WHERE ed.collection_id=p_collection_id
  ),
  m AS (
    SELECT cs.challenge_id, cs.slot_order, e.external_id, e.play_id_onchain,
           (e.pn = public._norm_player(cs.label)) AS is_exact
    FROM public.challenge_slots cs
    JOIN public.challenges c ON c.id=cs.challenge_id AND c.collection_id=p_collection_id
    JOIN e ON e.set_uuid=cs.set_external_id
         AND (e.pn = public._norm_player(cs.label) OR extensions.similarity(e.pn, public._norm_player(cs.label)) > 0.6)
         AND (cs.play_category IS NULL OR e.play_category = cs.play_category)
  ),
  ranked AS (
    SELECT *, bool_or(is_exact) OVER (PARTITION BY challenge_id, slot_order) AS slot_has_exact FROM m
  )
  INSERT INTO public.challenge_slot_editions (challenge_id, slot_order, external_id, play_id_onchain)
  SELECT DISTINCT challenge_id, slot_order, external_id, play_id_onchain
  FROM ranked WHERE is_exact OR NOT slot_has_exact
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS v_eds = ROW_COUNT;

  WITH e AS (
    SELECT s.external_id AS set_uuid, ed.player_id, public._norm_player(ed.player_name) AS pn
    FROM public.editions ed JOIN public.sets s ON s.id=ed.set_id
    WHERE ed.collection_id=p_collection_id
  ),
  slot_players AS (
    SELECT cs.nba_stats_id, (array_agg(DISTINCT e.player_id))[1] AS player_id
    FROM public.challenge_slots cs
    JOIN public.challenges c ON c.id=cs.challenge_id AND c.collection_id=p_collection_id
    JOIN e ON e.set_uuid=cs.set_external_id
         AND (e.pn = public._norm_player(cs.label) OR extensions.similarity(e.pn, public._norm_player(cs.label)) > 0.6)
    WHERE cs.nba_stats_id IS NOT NULL
    GROUP BY cs.nba_stats_id
    HAVING count(DISTINCT e.player_id)=1
  )
  UPDATE public.players p SET nba_stats_id=sp.nba_stats_id
  FROM slot_players sp
  WHERE p.id=sp.player_id AND p.collection_id=p_collection_id
    AND p.nba_stats_id IS DISTINCT FROM sp.nba_stats_id;
  GET DIAGNOSTICS v_nba = ROW_COUNT;

  SELECT count(*) INTO v_slots FROM public.challenge_slots cs
    JOIN public.challenges c ON c.id=cs.challenge_id AND c.collection_id=p_collection_id;
  SELECT count(*) INTO v_unresolved FROM public.challenge_slots cs
    JOIN public.challenges c ON c.id=cs.challenge_id AND c.collection_id=p_collection_id
    WHERE NOT EXISTS (SELECT 1 FROM public.challenge_slot_editions cse
                      WHERE cse.challenge_id=cs.challenge_id AND cse.slot_order=cs.slot_order);

  RETURN jsonb_build_object('slots',v_slots,'slot_editions',v_eds,'nba_ids_backfilled',v_nba,'unresolved_slots',v_unresolved);
END $function$;

-- <<< END verbatim resolve_challenge_slots <<<

INSERT INTO challenges (id, collection_id) VALUES ('00000000-0000-0000-0000-0000000c0001','00000000-0000-0000-0000-00000000cccc');
INSERT INTO sets (id, external_id) VALUES ('00000000-0000-0000-0000-0000000005e1','set1');
-- slot1 exact-matches ed1 (LeBron James / Dunk); slot2 matches nothing (unresolved).
INSERT INTO challenge_slots (challenge_id, slot_order, set_external_id, label, play_category, nba_stats_id) VALUES
  ('00000000-0000-0000-0000-0000000c0001',1,'set1','LeBron James','Dunk', 2544),
  ('00000000-0000-0000-0000-0000000c0001',2,'set1','Nobody Here',  NULL,  NULL);
INSERT INTO editions (external_id, collection_id, set_id, player_id, player_name, play_category, play_id_onchain) VALUES
  ('ek1','00000000-0000-0000-0000-00000000cccc','00000000-0000-0000-0000-0000000005e1','00000000-0000-0000-0000-0000000009e1','LeBron James','Dunk', 100),
  ('ek2','00000000-0000-0000-0000-00000000cccc','00000000-0000-0000-0000-0000000005e1', NULL, 'Steph Curry', 'Dunk', 200);
INSERT INTO players (id, collection_id, nba_stats_id) VALUES ('00000000-0000-0000-0000-0000000009e1','00000000-0000-0000-0000-00000000cccc', NULL);
-- pre-existing STALE slot-edition that must be deleted before the re-resolve.
INSERT INTO challenge_slot_editions (challenge_id, slot_order, external_id, play_id_onchain) VALUES ('00000000-0000-0000-0000-0000000c0001',1,'stale_ek', 999);

-- Single writer call; capture the jsonb return.
CREATE TEMP TABLE r AS SELECT resolve_challenge_slots('00000000-0000-0000-0000-00000000cccc'::uuid) AS j;
SELECT _assert_eq((SELECT j->>'slots' FROM r), '2', 'counts both slots');
SELECT _assert_eq((SELECT j->>'slot_editions' FROM r), '1', 'inserts exactly the 1 exact match (ek1)');
SELECT _assert_eq((SELECT j->>'unresolved_slots' FROM r), '1', 'slot2 matches nothing -> 1 unresolved');
SELECT _assert_eq((SELECT j->>'nba_ids_backfilled' FROM r), '1', 'slot1 resolves to 1 player -> backfills its nba_stats_id');
-- The stale row is gone; ek1 is in; ek2 (wrong player) is not.
SELECT _assert_eq((SELECT count(*)::text FROM challenge_slot_editions WHERE external_id='stale_ek'), '0', 'stale slot-edition was DELETEd');
SELECT _assert_eq((SELECT external_id||'|'||play_id_onchain FROM challenge_slot_editions WHERE challenge_id='00000000-0000-0000-0000-0000000c0001' AND slot_order=1), 'ek1|100', 'slot1 resolved to the exact-match edition ek1');
SELECT _assert_eq((SELECT count(*)::text FROM challenge_slot_editions WHERE external_id='ek2'), '0', 'the non-matching edition ek2 was not inserted');
-- nba_stats_id backfilled on the resolved player.
SELECT _assert_eq((SELECT nba_stats_id::text FROM players WHERE id='00000000-0000-0000-0000-0000000009e1'), '2544', 'players.nba_stats_id backfilled from the slot');

SELECT '✓ resolve_challenge_slots invariants pass' AS result;
ROLLBACK;

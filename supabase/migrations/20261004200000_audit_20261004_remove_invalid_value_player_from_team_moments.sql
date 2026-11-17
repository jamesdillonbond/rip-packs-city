-- audit_20261004_remove_invalid_value_player_from_team_moments
--
-- 2026-10-04 ~1:10 PM PT (Claude Code cloud; Trevor: "keep going").
-- APPLIED 1:16 PM PT via the dashboard SQL editor (MCP apply_migration hit the destructive-statement
-- gate; Run approved by Trevor under manual approval). No schema_migrations row; this file is the record.
--
-- WHAT. A public player page titled "<invalid Value> — Moments & Market Value | NBA Top Shot"
-- (https://www.rippackscity.com/nba-top-shot/player/-invalid-value-) listed 11 Champion's Path 2024
-- TEAM moments with FMV and sales. Source: a players row literally named '<invalid Value>'
-- (5bf9bb01-…, external_id 'flow:5155', created 2026-04-02) — Dapper's on-chain FullName sentinel
-- for team moments, minted before the sentinel guard existed. Eight of its editions were also
-- named '<invalid Value> — The Champion''s Path 2024', and 5 wallet_moments_cache rows carried
-- player_name '<invalid Value>'.
--
-- WHY THIS IS LEFTOVER, NOT LIVE. Both writers now drop the sentinel: lib/editions-hydrate.ts
-- (resolve FullName → FirstName/LastName → '') and supabase/functions/topshot-stub-resolver
-- (INVALID_ONCHAIN), and a team moment then gets name = set_name — which is how the other 354
-- Top Shot team moments are named. Swept every collection 1:05 PM PT: this is the only players row
-- with a junk name, and the only editions/wmc rows carrying the sentinel.
--
-- CHANGE.
--   1. The 11 editions on that row: player_id → NULL (a team moment has no player — the 09-24
--      cleanup and link_editions_to_players_by_name both treat it so); the 8 junk names → set_name.
--   2. The 5 wmc rows: player_name → the edition's team_name (what every other wmc row on those
--      editions already says).
--   3. The '<invalid Value>' players row is removed, so its page 404s. Pre-checked: 0 badge /
--      pooled / bridge-candidate / identity / relation / alias references.
--
-- Backups (RLS on): audit_20261004_invalid_value_player_backup (the row),
-- audit_20261004_invalid_value_editions_backup (edition_id, player_id, name),
-- audit_20261004_invalid_value_wmc_backup (wallet_address, collection_id, moment_id, player_name).
-- REVERT: re-insert the players row from its backup; restore editions.player_id / name and
-- wallet_moments_cache.player_name from theirs.

CREATE TABLE IF NOT EXISTS public.audit_20261004_invalid_value_player_backup AS
  SELECT p.*, now() AS backed_up_at FROM public.players p WHERE false;
ALTER TABLE public.audit_20261004_invalid_value_player_backup ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.audit_20261004_invalid_value_player_backup FROM PUBLIC, anon, authenticated;

CREATE TABLE IF NOT EXISTS public.audit_20261004_invalid_value_editions_backup (
  edition_id uuid PRIMARY KEY, player_id uuid, name text, backed_up_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE public.audit_20261004_invalid_value_editions_backup ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.audit_20261004_invalid_value_editions_backup FROM PUBLIC, anon, authenticated;

CREATE TABLE IF NOT EXISTS public.audit_20261004_invalid_value_wmc_backup (
  wallet_address text, collection_id uuid, moment_id text, player_name text,
  backed_up_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (wallet_address, collection_id, moment_id));
ALTER TABLE public.audit_20261004_invalid_value_wmc_backup ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.audit_20261004_invalid_value_wmc_backup FROM PUBLIC, anon, authenticated;

DO $inv$
DECLARE
  c_ts  constant uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  c_bad constant uuid := '5bf9bb01-e054-43e1-a445-cec5b52961ba';
  v_refs int; v_eds int; v_renamed int; v_wmc int;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.players WHERE id = c_bad) THEN
    RAISE NOTICE '<invalid Value> player already removed — no-op'; RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.players WHERE id = c_bad AND name = '<invalid Value>' AND external_id = 'flow:5155' AND collection_id = c_ts) THEN
    RAISE EXCEPTION 'row 5bf9bb01 is not the measured <invalid Value> player';
  END IF;
  SELECT (SELECT count(*) FROM public.badge_editions b WHERE b.player_id::text = c_bad::text)
       + (SELECT count(*) FROM public.serial_fmv_pooled_player_effect s WHERE s.player_id::text = c_bad::text)
       + (SELECT count(*) FROM public.panini_bridge_candidate_editions x WHERE x.player_id::text = c_bad::text)
       + (SELECT count(*) FROM public.player_identities i WHERE i.player_id = c_bad)
       + (SELECT count(*) FROM public.player_relations r WHERE r.player_id = c_bad OR r.related_player_id = c_bad)
       + (SELECT count(*) FROM public.player_name_aliases a WHERE a.player_id = c_bad)
    INTO v_refs;
  IF v_refs <> 0 THEN RAISE EXCEPTION '<invalid Value> player has % non-edition references', v_refs; END IF;

  INSERT INTO public.audit_20261004_invalid_value_player_backup SELECT p.*, now() FROM public.players p WHERE p.id = c_bad;
  INSERT INTO public.audit_20261004_invalid_value_editions_backup (edition_id, player_id, name)
    SELECT id, player_id, name FROM public.editions
     WHERE collection_id = c_ts AND (player_id = c_bad OR name LIKE '<invalid Value>%')
    ON CONFLICT (edition_id) DO NOTHING;
  INSERT INTO public.audit_20261004_invalid_value_wmc_backup (wallet_address, collection_id, moment_id, player_name)
    SELECT wallet_address, collection_id, moment_id, player_name FROM public.wallet_moments_cache
     WHERE collection_id = c_ts AND player_name = '<invalid Value>'
    ON CONFLICT DO NOTHING;

  WITH r AS (
    UPDATE public.editions SET name = set_name, updated_at = now()
     WHERE collection_id = c_ts AND name LIKE '<invalid Value>%' AND set_name IS NOT NULL
    RETURNING 1) SELECT count(*) INTO v_renamed FROM r;
  WITH u AS (
    UPDATE public.editions SET player_id = NULL, updated_at = now()
     WHERE collection_id = c_ts AND player_id = c_bad
    RETURNING 1) SELECT count(*) INTO v_eds FROM u;
  WITH w AS (
    UPDATE public.wallet_moments_cache m SET player_name = e.team_name
      FROM public.editions e
     WHERE m.collection_id = c_ts AND m.player_name = '<invalid Value>'
       AND e.collection_id = m.collection_id AND e.external_id = m.edition_key AND e.team_name IS NOT NULL
    RETURNING 1) SELECT count(*) INTO v_wmc FROM w;

  DELETE FROM public.players WHERE id = c_bad;

  IF v_eds <> 11 OR v_renamed <> 8 OR v_wmc <> 5 THEN
    RAISE EXCEPTION 'expected 11 unlinked / 8 renamed / 5 wmc, got % / % / %', v_eds, v_renamed, v_wmc;
  END IF;
  IF EXISTS (SELECT 1 FROM public.editions WHERE collection_id = c_ts AND name LIKE '<invalid Value>%')
     OR EXISTS (SELECT 1 FROM public.wallet_moments_cache WHERE collection_id = c_ts AND player_name = '<invalid Value>') THEN
    RAISE EXCEPTION 'sentinel still present after cleanup';
  END IF;
  RAISE NOTICE 'removed <invalid Value> player; % editions unlinked, % renamed, % wmc rows', v_eds, v_renamed, v_wmc;
END
$inv$;

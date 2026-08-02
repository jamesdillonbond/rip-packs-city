-- audit_20260802_players_dedupe_and_canonical_resolver
--
-- WHAT / WHY
-- Top Shot `players` held 4,433 rows for 1,359 real players — 948 name-slugs with
-- >1 row, 3,074 surplus, one slug with 32 rows. `get_player_detail` therefore had
-- to CHOOSE which row's `team` a public page shows; the 2026-08-01 fix (418ed607)
-- made that choice correct via a data-relative activity horizon, but the choice
-- itself remained load-bearing. This removes the need to choose.
--
-- ROOT CAUSE (found, not assumed): app/api/wallet-search/route.ts
-- seedEditionsToSupabase() upserted a players row keyed
-- `external_id = 'flow:' || <playID>` — the SECOND segment of the `setID:playID`
-- edition key. That is PER-PLAY, not per-player, so every distinct play by the
-- same athlete minted another row (3,102 such rows, still being written as of
-- 2026-07-28; LeBron James alone had 32). The sibling writer
-- app/api/ingest/route.ts upserts `external_id = String(stats.playerID)` — the
-- real NBA stats id — and is CORRECT; it is deliberately left alone.
-- The two DB writers are also already canonical:
-- `ensure_players_from_edition_names` has a slug NOT EXISTS guard, and
-- `sync_panini_editions_to_shared` is Panini-only. So wallet-search was the sole
-- duplicate factory, and this migration pairs the cleanup with a resolver that
-- stops it recurring (per Trevor, 2026-08-01: dedupe + self-heal at write time).
--
-- SURVIVOR RULE, and why it is not "most editions":
--   1. canonical numeric external_id (the row app/api/ingest keeps upserting)
--   2. any other non-`flow:` external_id (the slug rows ensure_players_* creates)
--   3. most attached editions, then oldest id (deterministic)
-- Keeping a `flow:` row as survivor would leave the canonical ingest writing to a
-- row this migration had just deleted, re-creating the divergence within a day.
-- Measured: 942 of 948 survivors are the canonical NBA-id row; 6 groups are
-- all-`flow:` and fall back to rule 3.
--
-- HAZARD CHECKED (pg_proc bodies, not just a code grep — per the standing rule):
-- `resolve_challenge_slots` binds a challenge to `(array_agg(DISTINCT
-- e.player_id))[1]` — an ARBITRARY member of the duplicate group — and then
-- writes `nba_stats_id` onto that row. A naive dedupe can therefore delete the
-- row carrying a live Fast Break / challenge binding. Measured blast radius:
-- exactly 1 row. Closed by COALESCE-merging the enrichable columns onto the
-- survivor BEFORE deleting (step 3), so no binding is lost.
--
-- FK / reference sweep: `editions.player_id` is the ONLY FK to players.id
-- (ON DELETE NO ACTION, so a missed reference errors rather than silently
-- cascading). Two UNCONSTRAINED uuid `player_id` columns exist and would be
-- invisible to an FK-only sweep — `serial_fmv_pooled_player_effect` (0 rows) and
-- `audit_20260719_candy_metadata_backfill` (125 rows, all already orphaned by
-- design, Candy). Both verified harmless. `badge_editions.player_id` is TEXT
-- (on-chain play id vocabulary), not a players.id reference.
--
-- REVERT (fully runnable — the backup tables ARE the revert path):
--   UPDATE public.editions e
--      SET player_id = r.old_player_id
--     FROM public.audit_20260802_players_dedupe_edition_remap r
--    WHERE e.id = r.edition_id;
--   UPDATE public.players p SET
--     external_id=b.external_id, name=b.name, first_name=b.first_name,
--     last_name=b.last_name, team=b.team, jersey_number=b.jersey_number,
--     position=b.position, player_tier=b.player_tier, is_active=b.is_active,
--     headshot_url=b.headshot_url, nba_stats_id=b.nba_stats_id,
--     created_at=b.created_at, updated_at=b.updated_at, collection=b.collection
--     FROM public.audit_20260802_players_dedupe_backup b
--    WHERE p.id=b.id AND b.was_survivor;
--   INSERT INTO public.players (id, external_id, collection_id, name, first_name,
--     last_name, team, jersey_number, position, player_tier, is_active,
--     headshot_url, nba_stats_id, created_at, updated_at, collection)
--   SELECT id, external_id, collection_id, name, first_name, last_name, team,
--     jersey_number, position, player_tier, is_active, headshot_url,
--     nba_stats_id, created_at, updated_at, collection
--     FROM public.audit_20260802_players_dedupe_backup WHERE NOT was_survivor;
--   DROP FUNCTION IF EXISTS public.resolve_canonical_player(uuid, text, text);
-- (and `git revert` the wallet-search route change, which is a separate commit.)

-- ── 0. survivor/dupe map for the Top Shot collection ────────────────────────────
CREATE TEMP TABLE _dedupe_map ON COMMIT DROP AS
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
         count(*)     OVER (PARTITION BY slug)                                    AS grp,
         row_number() OVER (PARTITION BY slug ORDER BY pref, ed_ct DESC, id)      AS rn,
         first_value(id) OVER (PARTITION BY slug ORDER BY pref, ed_ct DESC, id)   AS survivor_id
    FROM ts
)
SELECT id, survivor_id, slug, (rn = 1) AS is_survivor
  FROM r
 WHERE grp > 1;

-- ── 1. full pre-state backup: EVERY row in a duplicate group ───────────────────
-- Survivors included because step 3 mutates them; without them the revert would
-- restore the deleted rows but leave the merge applied.
CREATE TABLE public.audit_20260802_players_dedupe_backup AS
SELECT p.*, m.survivor_id, m.is_survivor AS was_survivor
  FROM public.players p
  JOIN _dedupe_map m ON m.id = p.id;

CREATE TABLE public.audit_20260802_players_dedupe_edition_remap AS
SELECT e.id AS edition_id, e.player_id AS old_player_id, m.survivor_id AS new_player_id
  FROM public.editions e
  JOIN _dedupe_map m ON m.id = e.player_id
 WHERE NOT m.is_survivor;

ALTER TABLE public.audit_20260802_players_dedupe_backup       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_20260802_players_dedupe_edition_remap ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.audit_20260802_players_dedupe_backup       FROM anon, authenticated;
REVOKE ALL ON public.audit_20260802_players_dedupe_edition_remap FROM anon, authenticated;

-- ── 2. merge enrichable columns onto the survivor (COALESCE = never overwrite) ─
-- Deterministic source per column: the oldest non-NULL value among the group's
-- doomed rows. This is what preserves the 1 live challenge nba_stats_id binding.
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
    FROM _dedupe_map m
    JOIN public.players p ON p.id = m.id AND NOT m.is_survivor
   GROUP BY m.survivor_id
) d
WHERE s.id = d.survivor_id;

-- ── 3. repoint editions, then delete the surplus ──────────────────────────────
UPDATE public.editions e
   SET player_id = m.survivor_id
  FROM _dedupe_map m
 WHERE e.player_id = m.id
   AND NOT m.is_survivor;

DELETE FROM public.players p
 USING _dedupe_map m
 WHERE p.id = m.id
   AND NOT m.is_survivor;

-- ── 4. the self-heal: a canonical, race-safe player resolver ───────────────────
-- app/api/wallet-search calls this instead of upserting `flow:<playID>`. Keyed on
-- (collection_id, name-slug) using the SAME slug expression get_player_detail and
-- ensure_players_from_edition_names use, so all three agree on identity. New rows
-- adopt ensure_players_from_edition_names' `<coll_slug>-<name_slug>` external_id
-- convention rather than minting another per-play id.
CREATE OR REPLACE FUNCTION public.resolve_canonical_player(
  p_collection_id uuid,
  p_name          text,
  p_team          text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_slug      text;
  v_coll_slug text;
  v_id        uuid;
BEGIN
  IF p_collection_id IS NULL OR p_name IS NULL OR trim(p_name) = '' THEN
    RETURN NULL;
  END IF;

  v_slug := regexp_replace(lower(trim(p_name)), '[^a-z0-9]+', '-', 'g');
  IF v_slug = '' THEN
    RETURN NULL;
  END IF;

  -- Existing player wins. Tie-break mirrors this migration's survivor rule so a
  -- transient duplicate can never flip which row the resolver returns.
  SELECT p.id INTO v_id
    FROM public.players p
   WHERE p.collection_id = p_collection_id
     AND regexp_replace(lower(trim(p.name)), '[^a-z0-9]+', '-', 'g') = v_slug
   ORDER BY CASE WHEN p.external_id ~ '^[0-9]+$'  THEN 1
                 WHEN p.external_id LIKE 'flow:%' THEN 3
                 ELSE 2 END,
            (SELECT count(*) FROM public.editions e WHERE e.player_id = p.id) DESC,
            p.id
   LIMIT 1;

  IF v_id IS NOT NULL THEN
    -- Fill a missing team only; never overwrite a good value.
    IF p_team IS NOT NULL AND trim(p_team) <> '' THEN
      UPDATE public.players SET team = p_team, updated_at = now()
       WHERE id = v_id AND team IS NULL;
    END IF;
    RETURN v_id;
  END IF;

  SELECT c.slug INTO v_coll_slug FROM public.collections c WHERE c.id = p_collection_id;

  INSERT INTO public.players (external_id, collection_id, name, team, collection)
  VALUES (coalesce(v_coll_slug, 'unknown') || '-' || v_slug,
          p_collection_id, trim(p_name), nullif(trim(coalesce(p_team, '')), ''),
          coalesce(v_coll_slug, 'unknown'))
  -- NOTE: players carries BOTH `UNIQUE (external_id)` and
  -- `UNIQUE (external_id, collection_id)`. The bare one is STRICTER, so the
  -- composite arbiter would NOT catch it and the insert would raise a unique
  -- violation instead of doing nothing. Arbitrate on the bare constraint — the
  -- same one ensure_players_from_edition_names uses.
  ON CONFLICT (external_id) DO NOTHING
  RETURNING id INTO v_id;

  -- Lost an insert race: re-read the winner.
  IF v_id IS NULL THEN
    SELECT p.id INTO v_id
      FROM public.players p
     WHERE p.collection_id = p_collection_id
       AND regexp_replace(lower(trim(p.name)), '[^a-z0-9]+', '-', 'g') = v_slug
     LIMIT 1;
  END IF;

  RETURN v_id;
END
$function$;

-- Service-role only: the sole caller is a supabaseAdmin route. A new function's
-- default EXECUTE grant is to PUBLIC, which a role-only REVOKE does NOT remove.
REVOKE EXECUTE ON FUNCTION public.resolve_canonical_player(uuid, text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.resolve_canonical_player(uuid, text, text) FROM anon, authenticated;

COMMENT ON FUNCTION public.resolve_canonical_player(uuid, text, text) IS
  'Resolve-or-create a player by (collection_id, name-slug). Replaces app/api/wallet-search''s per-play `flow:<playID>` upsert, which minted a new players row for every distinct play by the same athlete (3,102 rows before audit_20260802_players_dedupe_and_canonical_resolver). Service-role only.';

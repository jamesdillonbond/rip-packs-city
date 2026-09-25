-- DB invariant: public.get_edition_badges_unified — the single source of truth for
-- an edition's badge list, rendered on every moment/edition page and folded into
-- the trophy case. Top Shot's raw play_tags mix ~9 REAL badges with ~25 gameplay
-- descriptors (Assist, Steal, …), so the ALLOWLIST here is what stops fabricated
-- badges from sprouting on every moment — the same fabricated-signal class the
-- pack-EV and jersey work guard against. A regression either invents badges or
-- drops real ones.
--
-- Pins:
--   * play_tags → 'play' badges ONLY for the normalized allowlist; a non-listed
--     gameplay descriptor is dropped;
--   * every set_play_tags entry is kept ('set_play'); has_rookie_mint injects a
--     Rookie Mint 'flag';
--   * the v2 Three-Star Rookie rule: Rookie Year + Rookie Premiere + Rookie Mint
--     present ⇒ inject Three-Star Rookie AND SUBSUME (hide) those three standalone;
--   * dedupe by normalized key with source precedence play > set_play > flag >
--     derived (a play tag wins over a set_play tag of the same key);
--   * derived-from-set-name badges appear ONLY when there are no real tags;
--   * the codename-mercury tag is relabelled "Leaderboard Reward";
--   * (2026-09-25) badges the ingest wrote onto editions.badges itself are a
--     fourth REAL source ('edition') — Candy MLB's Rainbow parallel lives only
--     there — deduped below set_play, above flag, and suppressing the derived
--     fallback like any real tag; the id is the slugged title with no edge
--     separators ("Rainbow (Blue)" -> rainbow-blue);
--   * final order: flag, play, set_play, edition, derived, then key; empty ⇒ '[]'.
--
-- The function DDL below is a VERBATIM copy of the committed migration
-- (supabase/migrations/20260925084355_audit_20260925_edition_badge_ids_trim_separators.sql);
-- __tests__/db-invariants-drift-guard.test.ts fails CI if this copy drifts from it.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

-- Supabase installs unaccent in the `extensions` schema; reproduce that so the
-- verbatim DDL (whose search_path is public,extensions,pg_temp) resolves the bare
-- unaccent() call. (Matches supabase/tests/norm_player.sql.)
CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS unaccent WITH SCHEMA extensions;

-- ── minimal fixtures ─────────────────────────────────────────────────────────
CREATE TABLE public.editions (
  id uuid PRIMARY KEY, external_id text, collection_id uuid, set_name text, badges text[]);
CREATE TABLE public.badge_editions (
  external_id text, collection_id uuid, play_tags jsonb, set_play_tags jsonb,
  has_rookie_mint boolean, is_three_star_rookie boolean);

-- Stub the set-name → derived-badges helper (real one parses set naming rules).
CREATE FUNCTION public.derive_badges_from_set_name(p_set_name text)
 RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN p_set_name = 'Playoffs Set' THEN '[{"id":"playoffs","title":"Playoffs"}]'::jsonb
    ELSE '[]'::jsonb
  END
$$;

-- >>> BEGIN verbatim get_edition_badges_unified (keep byte-identical to the migration) >>>
CREATE OR REPLACE FUNCTION public.get_edition_badges_unified(p_edition_id uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
  WITH ed AS (
    SELECT e.id, e.external_id,
           split_part(e.external_id::text, '::', 1) AS base_external_id,
           e.collection_id, e.set_name, e.badges
    FROM editions e WHERE e.id = p_edition_id
  ),
  be_row AS (
    SELECT be.*
    FROM badge_editions be
    JOIN ed ON be.external_id = ed.base_external_id AND be.collection_id = ed.collection_id
    LIMIT 1
  ),
  sync_play AS (
    SELECT pt.tag, 'play' AS source
    FROM be_row be
    CROSS JOIN LATERAL jsonb_array_elements(be.play_tags) AS pt(tag)
    WHERE jsonb_typeof(be.play_tags) = 'array'
      AND regexp_replace(
            lower(unaccent(coalesce(pt.tag->>'title', pt.tag->>'id', ''))),
            '[^a-z0-9]+', '', 'g'
          ) = ANY (ARRAY[
            'topshotdebut','rookieyear','rookiemint','rookiepremiere',
            'mvpyear','championshipyear','rookieoftheyear','allstar',
            'threestarrookie'
          ])
  ),
  sync_set_play AS (
    SELECT jsonb_array_elements(be.set_play_tags) AS tag, 'set_play' AS source
    FROM be_row be
    WHERE jsonb_typeof(be.set_play_tags) = 'array'
  ),
  sync_mint AS (
    SELECT jsonb_build_object('id','rookie-mint','title','Rookie Mint') AS tag, 'flag' AS source
    FROM be_row be
    WHERE be.has_rookie_mint = true
  ),
  -- 2026-09-25: badges the INGEST wrote onto the edition row itself
  -- (editions.badges text[]). Candy MLB carries its Rainbow parallel here
  -- ("Rainbow (Blue)") and nowhere else — badge_editions is a Top Shot / All Day
  -- sync table with no Candy rows — so until now every Candy parallel rendered
  -- with no badge and five colour printings read as the same edition.
  sync_edition AS (
    SELECT jsonb_build_object(
             'id',    btrim(regexp_replace(lower(b), '[^a-z0-9]+', '-', 'g'), '-'),
             'title', b
           ) AS tag, 'edition' AS source
    FROM ed
    CROSS JOIN LATERAL unnest(coalesce(ed.badges, '{}'::text[])) AS b
    WHERE btrim(coalesce(b, '')) <> ''
  ),
  -- real synced tags (excluding the derived-from-Three-Star injection below)
  real_tags AS (
    SELECT tag, source FROM sync_play
    UNION ALL SELECT tag, source FROM sync_set_play
    UNION ALL SELECT tag, source FROM sync_mint
    UNION ALL SELECT tag, source FROM sync_edition
  ),
  -- v2 Three-Star rule: Rookie Year + Rookie Mint + Rookie Premiere present.
  flags AS (
    SELECT
      bool_or(regexp_replace(lower(unaccent(coalesce(tag->>'title',tag->>'id',''))),'[^a-z0-9]+','','g')='rookieyear')     AS has_year,
      bool_or(regexp_replace(lower(unaccent(coalesce(tag->>'title',tag->>'id',''))),'[^a-z0-9]+','','g')='rookiepremiere') AS has_premiere,
      bool_or(regexp_replace(lower(unaccent(coalesce(tag->>'title',tag->>'id',''))),'[^a-z0-9]+','','g')='rookiemint')     AS has_mint
    FROM real_tags
  ),
  tsr AS (
    SELECT (
      COALESCE((SELECT is_three_star_rookie FROM be_row), false)
      OR COALESCE((SELECT has_year AND has_premiere AND has_mint FROM flags), false)
    ) AS v
  ),
  sync_tsr AS (
    SELECT jsonb_build_object('id','three-star-rookie','title','Three-Star Rookie') AS tag, 'flag' AS source
    FROM tsr WHERE tsr.v = true
  ),
  combined_real AS (
    SELECT tag, source FROM real_tags
    UNION ALL SELECT tag, source FROM sync_tsr
  ),
  derived AS (
    SELECT jsonb_array_elements(derive_badges_from_set_name(ed.set_name)) AS tag, 'derived' AS source
    FROM ed
  ),
  all_tags AS (
    SELECT tag, source FROM combined_real
    UNION ALL
    SELECT tag, source FROM derived
    WHERE NOT EXISTS (SELECT 1 FROM combined_real)
  ),
  normalized AS (
    SELECT
      tag, source,
      regexp_replace(
        lower(unaccent(coalesce(tag->>'title', tag->>'id', ''))),
        '[^a-z0-9]+', '', 'g'
      ) AS norm_key
    FROM all_tags
    WHERE tag ? 'id' OR tag ? 'title'
  ),
  ranked AS (
    SELECT tag, source, norm_key,
      row_number() OVER (
        PARTITION BY norm_key
        ORDER BY CASE source
          WHEN 'play' THEN 1 WHEN 'set_play' THEN 2 WHEN 'edition' THEN 3
          WHEN 'flag' THEN 4 WHEN 'derived' THEN 5
        END
      ) AS rnk
    FROM normalized
    WHERE norm_key <> ''
  ),
  has_tsr AS (
    SELECT EXISTS (SELECT 1 FROM ranked WHERE rnk = 1 AND norm_key = 'threestarrookie') AS v
  )
  SELECT coalesce(
    jsonb_agg(
      (CASE
         WHEN norm_key = 'codenamemercury'
           THEN (tag - 'title') || jsonb_build_object('title', 'Leaderboard Reward')
         ELSE tag
       END) || jsonb_build_object('source', source)
      ORDER BY
        CASE source WHEN 'flag' THEN 1 WHEN 'play' THEN 2 WHEN 'set_play' THEN 3 WHEN 'edition' THEN 4 WHEN 'derived' THEN 5 END,
        norm_key
    ),
    '[]'::jsonb
  )
  FROM ranked, has_tsr
  WHERE rnk = 1
    -- Three-Star Rookie subsumes Rookie Year + Rookie Mint + Rookie Premiere; hide
    -- those standalone badges when it is present (Top Shot Debut stays separate).
    AND NOT (has_tsr.v AND norm_key IN ('rookieyear','rookiepremiere','rookiemint'));
$function$;
-- <<< END verbatim get_edition_badges_unified <<<

\set cid '''95f28a17-224a-4025-96ad-adf8a4c63bfd'''
\set edA '''aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'''
\set edB '''bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'''
\set edC '''cccccccc-cccc-cccc-cccc-cccccccccccc'''
\set edD '''dddddddd-dddd-dddd-dddd-dddddddddddd'''
\set edE '''eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'''
\set edF '''ffffffff-ffff-ffff-ffff-ffffffffffff'''
\set edG '''99999999-9999-4999-8999-999999999999'''
\set edH '''88888888-8888-4888-8888-888888888888'''

INSERT INTO public.editions (id, external_id, collection_id, set_name) VALUES
  (:edA::uuid, '1:1', :cid::uuid, 'Rookie Set'),
  (:edB::uuid, '2:2', :cid::uuid, 'MVP Set'),
  (:edC::uuid, '3:3', :cid::uuid, 'Playoffs Set'),
  (:edD::uuid, '4:4', :cid::uuid, 'Nothing Set'),
  (:edE::uuid, '5:5', :cid::uuid, 'Reward Set'),
  (:edF::uuid, '6:6', :cid::uuid, 'Dedup Set');
-- 2026-09-25: edition-row badges (the Candy MLB shape — no badge_editions row).
INSERT INTO public.editions (id, external_id, collection_id, set_name, badges) VALUES
  (:edG::uuid, 'bobby-witt-jr-blue', :cid::uuid, 'Nothing Set', ARRAY['Rainbow (Blue)', '', 'First Mint']),
  -- edH: an edition badge AND a set name that derives one -> the real tag wins,
  -- the derived fallback stays out (same rule as every other real source).
  (:edH::uuid, 'x-pink', :cid::uuid, 'Playoffs Set', ARRAY['Rainbow (Pink)']);

INSERT INTO public.badge_editions (external_id, collection_id, play_tags, set_play_tags, has_rookie_mint, is_three_star_rookie) VALUES
  -- edA: three-star combo (year+premiere+mint-flag) + a whitelisted All-Star + a
  -- non-whitelisted "Assist"; a set_play Holo Icon. Expect: Three-Star Rookie(flag),
  -- All-Star(play), Holo Icon(set_play). Assist dropped; year/premiere/mint subsumed.
  ('1:1', :cid::uuid,
   '[{"id":"rookie-year","title":"Rookie Year"},{"id":"assist","title":"Assist"},{"id":"rookie-premiere","title":"Rookie Premiere"},{"id":"all-star","title":"All-Star"}]'::jsonb,
   '[{"id":"holo-icon","title":"Holo Icon"}]'::jsonb, true, false),
  -- edB: allowlist honesty — Steal dropped, MVP Year kept.
  ('2:2', :cid::uuid,
   '[{"id":"steal","title":"Steal"},{"id":"mvp-year","title":"MVP Year"}]'::jsonb,
   '[]'::jsonb, false, false),
  -- edE: codename-mercury relabel to Leaderboard Reward.
  ('5:5', :cid::uuid, '[]'::jsonb,
   '[{"id":"codename-mercury","title":"Codename Mercury"}]'::jsonb, false, false),
  -- edF: same key from play AND set_play — play wins.
  ('6:6', :cid::uuid,
   '[{"id":"all-star","title":"All-Star"}]'::jsonb,
   '[{"id":"all-star","title":"All-Star"}]'::jsonb, false, false);
-- edC + edD deliberately have NO badge_editions row (derived-only / empty paths).

-- ── 1. edA: three-star subsume + allowlist + set_play + flag-first ordering ────
SELECT _assert_eq(jsonb_array_length(public.get_edition_badges_unified(:edA::uuid))::text, '3', 'edA -> exactly 3 badges (Three-Star, All-Star, Holo Icon)');
SELECT _assert_eq(
  (public.get_edition_badges_unified(:edA::uuid) -> 0 ->> 'title'),
  'Three-Star Rookie', 'edA first badge is the flag (Three-Star Rookie)');
SELECT _assert(NOT (public.get_edition_badges_unified(:edA::uuid)::text ILIKE '%Rookie Year%'), 'edA: Rookie Year subsumed by Three-Star');
SELECT _assert(NOT (public.get_edition_badges_unified(:edA::uuid)::text ILIKE '%Rookie Premiere%'), 'edA: Rookie Premiere subsumed');
SELECT _assert(NOT (public.get_edition_badges_unified(:edA::uuid)::text ILIKE '%Rookie Mint%'), 'edA: Rookie Mint subsumed');
SELECT _assert(NOT (public.get_edition_badges_unified(:edA::uuid)::text ILIKE '%Assist%'), 'edA: non-allowlisted Assist dropped (no fabricated badge)');
SELECT _assert(public.get_edition_badges_unified(:edA::uuid)::text ILIKE '%All-Star%', 'edA: whitelisted All-Star kept');

-- ── 2. edB: allowlist drops Steal, keeps MVP Year ────────────────────────────
SELECT _assert_eq(jsonb_array_length(public.get_edition_badges_unified(:edB::uuid))::text, '1', 'edB -> 1 badge (MVP Year); Steal dropped');
SELECT _assert_eq((public.get_edition_badges_unified(:edB::uuid) -> 0 ->> 'title'), 'MVP Year', 'edB kept MVP Year');

-- ── 3. edC: derived-from-set-name fallback (no real tags) ─────────────────────
SELECT _assert_eq(jsonb_array_length(public.get_edition_badges_unified(:edC::uuid))::text, '1', 'edC -> derived Playoffs badge');
SELECT _assert_eq((public.get_edition_badges_unified(:edC::uuid) -> 0 ->> 'source'), 'derived', 'edC badge source = derived');

-- ── 4. edD: no tags, derive empty -> '[]' (never NULL) ───────────────────────
SELECT _assert_eq(public.get_edition_badges_unified(:edD::uuid)::text, '[]', 'edD -> empty array');

-- ── 5. edE: codename-mercury relabelled to Leaderboard Reward ────────────────
SELECT _assert_eq((public.get_edition_badges_unified(:edE::uuid) -> 0 ->> 'title'), 'Leaderboard Reward', 'edE: Codename Mercury relabelled');

-- ── 6. edF: play beats set_play on the same key (deduped to one, source=play) ─
SELECT _assert_eq(jsonb_array_length(public.get_edition_badges_unified(:edF::uuid))::text, '1', 'edF: All-Star deduped to one');
SELECT _assert_eq((public.get_edition_badges_unified(:edF::uuid) -> 0 ->> 'source'), 'play', 'edF: play source wins over set_play');

-- ── 7. edG: editions.badges is a real source (Candy parallels) ───────────────
SELECT _assert_eq(jsonb_array_length(public.get_edition_badges_unified(:edG::uuid))::text, '2', 'edG -> 2 edition badges (the empty string dropped)');
SELECT _assert_eq((public.get_edition_badges_unified(:edG::uuid) -> 0 ->> 'title'), 'First Mint', 'edG ordered by key inside the edition source');
SELECT _assert_eq((public.get_edition_badges_unified(:edG::uuid) -> 1 ->> 'title'), 'Rainbow (Blue)', 'edG carries the Rainbow parallel by its title');
SELECT _assert_eq((public.get_edition_badges_unified(:edG::uuid) -> 1 ->> 'id'), 'rainbow-blue', 'edG id is slugged with no edge separator');
SELECT _assert_eq((public.get_edition_badges_unified(:edG::uuid) -> 1 ->> 'source'), 'edition', 'edG badge source = edition');

-- ── 8. edH: an edition badge suppresses the derived fallback ─────────────────
SELECT _assert_eq(jsonb_array_length(public.get_edition_badges_unified(:edH::uuid))::text, '1', 'edH -> the edition badge only');
SELECT _assert(NOT (public.get_edition_badges_unified(:edH::uuid)::text ILIKE '%Playoffs%'), 'edH: derived Playoffs stays out when a real tag exists');

-- ── 9. no-change control: edD (no badges column value) is still empty ────────
SELECT _assert_eq(public.get_edition_badges_unified(:edD::uuid)::text, '[]', 'edD -> still empty with a NULL badges column');

SELECT '✓ get_edition_badges_unified: all assertions passed' AS result;

ROLLBACK;

-- audit_20261031_wmc_metadata_fill_writes_league
-- anon-exec: revoked (topshot_league_for) — a pure rule helper the SECURITY DEFINER fill calls as its owner; service_role/postgres only.
-- anon-exec: unchanged (backfill_wmc_metadata_from_editions) — CREATE OR REPLACE keeps the existing ACL.
--
-- Known issue #219, the half the 9:18 AM apply did NOT reach. `upsert_wallet_moments`
-- (fixed at 9:18 AM PT) has not written a Top Shot row since 2026-05-08: every Top
-- Shot wallet_moments_cache row created since 05-09 comes through
-- `upsert_wmc_batch` (keys + serials only) and is then enriched by
-- `backfill_wmc_metadata_from_editions` — which fills tier / player / set / mint /
-- team / series from `editions` and has never filled `league`. Measured
-- 2026-10-31 12:10 PM PT: Top Shot wmc = NBA 939,871 · WNBA 80,699 · **NULL 603,044**
-- (every row created since 05-09; 3,412 of the 3,459 rows seen in the last 24 h).
--
-- The reader makes the NULL a silent loss: `/api/wallet-search`'s NBA / WNBA
-- filter keeps only moment_ids whose wmc row carries that league ("if a moment is
-- unindexed we drop it from the filtered view"), so a wallet synced since May
-- loses 100 % of its newer moments under EITHER league pill — an `unknown` that is
-- actually KNOWN (CLAUDE.md honesty rule), published as absence.
--
-- Fix, in the writer that actually runs:
--   1. `public.topshot_league_for(set_name, team_name)` — ONE SQL home for the
--      rule the squeeze views (20261031040755), the Sniper (`leagueForEdition`)
--      and `upsert_wallet_moments` (20261031161800) each carry: WNBA when the SET
--      is WNBA-named / WNBA-only, OR the TEAM label is a WNBA franchise
--      (`teams_master` league = 'WNBA' plus the historic / all-star labels Top
--      Shot still prints), else NBA. NULL when the set is unknown — a league is
--      never fabricated from nothing.
--   2. `backfill_wmc_metadata_from_editions` fills `league` for Top Shot rows
--      whose league is NULL and whose edition has a set_name, under the same
--      COALESCE-never-overwrite contract as every other column, and counts the
--      row as fillable (the WHERE arm) so the per-wallet call after each walk
--      reaches it. Non-Top-Shot rows: untouched (league has no meaning there).
--
-- The 603k existing NULL rows are filled by a one-off, batched by wallet prefix
-- (not inside this migration — 603k heap + index writes do not belong in one
-- 120 s statement). Fill query, per batch:
--   UPDATE wallet_moments_cache w SET league = public.topshot_league_for(e.set_name, e.team_name)
--     FROM editions e WHERE e.collection_id = w.collection_id AND e.external_id = w.edition_key
--      AND w.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd' AND w.league IS NULL
--      AND e.set_name IS NOT NULL AND w.wallet_address >= $lo AND w.wallet_address < $hi;
--
-- Pinned: supabase/tests/backfill_wmc_metadata_from_editions.sql (re-pointed to
-- this file) + supabase/tests/topshot_league_for.sql.
--
-- Revert: re-apply the 20260925165425 body of backfill_wmc_metadata_from_editions;
-- DROP FUNCTION public.topshot_league_for(text, text); filled league values are
-- correct readings and stay.

-- >>> BEGIN verbatim topshot_league_for (keep byte-identical to the migration) >>>
CREATE OR REPLACE FUNCTION public.topshot_league_for(p_set_name text, p_team_name text)
 RETURNS text
 LANGUAGE sql
 STABLE
AS $function$
  SELECT CASE
    WHEN p_set_name IS NULL THEN NULL
    WHEN p_set_name ILIKE '%WNBA%'
      OR p_set_name = ANY (ARRAY['Rise With Us','Rise With Us 2023','In Her Bag','In Their Bag','Shining Stars','Chasing the Trophy','For the Cup'])
      THEN 'WNBA'
    WHEN p_team_name IS NOT NULL AND (
         p_team_name IN (SELECT tm.team_name FROM public.teams_master tm WHERE tm.league = 'WNBA')
      OR p_team_name = ANY (ARRAY['San Antonio Stars','San Antonio Silver Stars','Utah Starzz','Detroit Shock','Tulsa Shock','Orlando Miracle','Houston Comets','Sacramento Monarchs','Charlotte Sting','Cleveland Rockers','Miami Sol','Team Wilson','Team Stewart']))
      THEN 'WNBA'
    ELSE 'NBA'
  END
$function$;
-- <<< END verbatim topshot_league_for <<<

REVOKE EXECUTE ON FUNCTION public.topshot_league_for(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.topshot_league_for(text, text) TO postgres, service_role;
-- No SET search_path ON PURPOSE: a SET clause makes a SQL function non-inlinable, and this
-- helper runs per row inside the metadata fill (603k rows on the one-off). Same claim the
-- 10-25 recent_low_usd exemption makes, checked by check_function_search_path_drift(): LANGUAGE
-- sql, the comment prefix below, and no anon/authenticated EXECUTE. Every table it names is
-- schema-qualified and its only caller is a SECURITY DEFINER fill with its own search_path.
COMMENT ON FUNCTION public.topshot_league_for(text, text) IS
  'search_path-exempt (inlined SQL helper): per-row inside backfill_wmc_metadata_from_editions; body names only public.teams_master (schema-qualified), CASE and array/ILIKE operators; EXECUTE revoked from PUBLIC/anon/authenticated. Top Shot NBA/WNBA rule in ONE SQL home: WNBA-named or WNBA-only SET, or a WNBA TEAM label (teams_master + historic labels), else NBA; NULL when the set is unknown. #219, 2026-10-31. Pinned: supabase/tests/topshot_league_for.sql.';

-- >>> BEGIN verbatim backfill_wmc_metadata_from_editions (byte-identical to the migration/prod) >>>
CREATE OR REPLACE FUNCTION public.backfill_wmc_metadata_from_editions(p_wallet_address text DEFAULT NULL::text, p_collection_id uuid DEFAULT NULL::uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '120s'
AS $function$
DECLARE
  v_updated integer;
BEGIN
  -- ⚠ EXECUTE … USING, not a plain statement: a plain one is planned GENERIC
  -- from the sixth call of a pooled session onward, and the generic plan for
  -- this WHERE clause seq-scans `editions` and probes wmc per edition — 62x the
  -- buffers (measured 2026-09-13; see this migration's header and #113).
  EXECUTE $q$
  WITH updated AS (
    UPDATE public.wallet_moments_cache wmc
       SET tier        = COALESCE(wmc.tier,        e.tier::text),
           player_name = COALESCE(wmc.player_name, e.player_name, e.team_name),
           set_name    = COALESCE(wmc.set_name,    e.set_name),
           mint_count  = COALESCE(wmc.mint_count,  e.circulation_count),
           team_name   = COALESCE(wmc.team_name,   e.team_name),
           -- 2026-09-24: series was the one column this fill skipped (940k NULLs).
           series_number = COALESCE(wmc.series_number, e.series::int),
           -- 2026-10-31 (#219): league was the next one (603k Top Shot NULLs). Top
           -- Shot only; the rule lives in topshot_league_for; NULL stays NULL
           -- when the edition has no set (never fabricated).
           league      = COALESCE(wmc.league,
                           CASE WHEN wmc.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid
                                THEN public.topshot_league_for(e.set_name, e.team_name) END)
      FROM public.editions e
     WHERE e.collection_id = wmc.collection_id
       AND e.external_id   = wmc.edition_key
       AND wmc.edition_key IS NOT NULL
       -- Only rows where at least one NULL can actually be filled. Without the
       -- right-hand IS NOT NULL checks a row whose edition is also NULL in that
       -- column was rewritten with identical values on every run (2026-08-30).
       AND (
         (wmc.tier        IS NULL AND e.tier IS NOT NULL) OR
         (wmc.player_name IS NULL AND COALESCE(e.player_name, e.team_name) IS NOT NULL) OR
         (wmc.set_name    IS NULL AND e.set_name IS NOT NULL) OR
         (wmc.mint_count  IS NULL AND e.circulation_count IS NOT NULL) OR
         (wmc.team_name   IS NULL AND e.team_name IS NOT NULL) OR
         (wmc.series_number IS NULL AND e.series IS NOT NULL) OR
         (wmc.league IS NULL AND e.set_name IS NOT NULL
            AND wmc.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid)
       )
       AND ($1 IS NULL OR wmc.wallet_address = $1)
       AND ($2 IS NULL OR wmc.collection_id  = $2)
    RETURNING 1
  )
  SELECT COUNT(*)::int FROM updated
  $q$
  INTO v_updated
  USING p_wallet_address, p_collection_id;

  RETURN COALESCE(v_updated, 0);
END;
$function$;
-- <<< END verbatim backfill_wmc_metadata_from_editions <<<

COMMENT ON FUNCTION public.backfill_wmc_metadata_from_editions(text, uuid) IS
  'Denormalises editions onto wallet_moments_cache (tier/player/set/mint/team/series, and since 2026-10-31 league for Top Shot via topshot_league_for); COALESCE never overwrites a captured value. Pinned: supabase/tests/backfill_wmc_metadata_from_editions.sql.';

-- audit_20261113_hero_moment_auto_pick_reads_the_covering_index
--
-- Claude Code cloud, 2026-11-13 ~11:20 AM PT. One change to get_user_hero_moment (the dashboard / profile
-- hero card, /api/profile/hero-moment): the AUTO-PICK path (no manual override) finds the top-FMV holding with
-- an index-only scan, then fetches that one row. The manual-override path and the output are unchanged.
--
-- WHY. Vercel, 2026-09-03 → 11-12: 19 `[api/profile/hero-moment] code=timeout detail=57014`, 6 signed-in users.
-- The auto path read EVERY wallet row of the user to sort by fmv_usd: for the largest user (5 wallets, 47,248
-- rows) that is 42.6k buffers warm and, cold, 28,753 disk reads / 13.5 s against the function's 5 s
-- statement_timeout. The top-FMV step only needs (wallet, collection, edition_key, fmv_usd), all of which
-- idx_wmc_wallet_coll_ek_fmv_tier (wallet_address, collection_id, edition_key) INCLUDE (fmv_usd, …) carries:
-- an index-only scan of the same user is 17.0k buffers with 6,419 heap fetches (vs 47,248), then one keyed
-- lookup for the chosen row.
--
-- EQUIVALENCE, measured before writing (all 55 users with saved wallets): the new and old auto paths return
-- the same top fmv_usd for every user (0 differ); 1 user has a TIE at the top fmv, where both bodies pick an
-- arbitrary one of the tied rows. The step-1 scan requires edition_key IS NOT NULL (step 2 keys on it);
-- `SELECT count(*) FROM wallet_moments_cache WHERE edition_key IS NULL AND fmv_usd > 0` = 0 on 11-13.
--
-- Base verified: live prosrc md5 d5165b6d19cfc5d78378135d8c8745bb (no committed migration defined this
-- function before; it is recorded here for the first time). The DO block refuses if it moved.
-- anon-exec: unchanged (get_user_hero_moment) — CREATE OR REPLACE of an existing fn; ACL preserved
-- (anon false, authenticated false, read 11-13). Caller: app/api/profile/hero-moment/route.ts only.
-- Pin: supabase/tests/get_user_hero_moment.sql.
-- APPLIED 2026-11-13 ~11:12 AM PT (recorded 20261113191137). Read back: prosrc md5 de4d67d19227b7e72a7de86adf3cc226
-- = this file's body; anon/authenticated still false. Same 47k-row user after: 18.5k buffers / 0.54 s
-- (before: 44.3k buffers; 13.5 s when cold).
--
-- REVERT: re-create the previous body — identical to this one except the `auto` CTE, which was:
--   SELECT wmc.moment_id, wmc.collection_id, wmc.wallet_address, wmc.player_name, wmc.set_name, wmc.tier,
--          wmc.serial_number, wmc.mint_count, wmc.fmv_usd, wmc.image_url, wmc.is_locked, wmc.series_number,
--          wmc.edition_key, FALSE AS is_manual_override
--   FROM wallet_moments_cache wmc JOIN user_wallets uw ON uw.wallet_addr = wmc.wallet_address
--   WHERE wmc.fmv_usd IS NOT NULL AND wmc.fmv_usd > 0
--   ORDER BY wmc.fmv_usd DESC NULLS LAST LIMIT 1

DO $guard$
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.get_user_hero_moment(uuid)'::regprocedure)
     <> 'd5165b6d19cfc5d78378135d8c8745bb' THEN
    RAISE EXCEPTION 'get_user_hero_moment changed since it was read; re-derive this migration';
  END IF;
END
$guard$;

CREATE OR REPLACE FUNCTION public.get_user_hero_moment(p_user_id uuid)
 RETURNS TABLE(moment_id text, collection_id uuid, collection_slug text, wallet_address text, player_name text, set_name text, tier text, serial_number integer, mint_count integer, fmv_usd numeric, image_url text, is_locked boolean, series_number integer, edition_key text, is_manual_override boolean)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '5s'
AS $function$
  WITH override AS (
    SELECT pb.hero_moment_id, pb.hero_moment_collection_id
    FROM profile_bio pb
    WHERE pb.user_id = p_user_id
      AND pb.hero_moment_id IS NOT NULL
    LIMIT 1
  ),
  user_wallets AS (
    SELECT DISTINCT wallet_addr
    FROM saved_wallets
    WHERE user_id = p_user_id
  ),
  -- Manual override path: look up the specific moment if it's actually in the user's cache
  manual AS (
    SELECT
      wmc.moment_id,
      wmc.collection_id,
      wmc.wallet_address,
      wmc.player_name, wmc.set_name, wmc.tier,
      wmc.serial_number, wmc.mint_count, wmc.fmv_usd, wmc.image_url,
      wmc.is_locked, wmc.series_number, wmc.edition_key,
      TRUE AS is_manual_override
    FROM wallet_moments_cache wmc
    JOIN user_wallets uw ON uw.wallet_addr = wmc.wallet_address
    JOIN override o
      ON wmc.moment_id = o.hero_moment_id
     AND (o.hero_moment_collection_id IS NULL OR wmc.collection_id = o.hero_moment_collection_id)
    LIMIT 1
  ),
  -- Auto-pick path: highest fmv_usd. audit_20261113: step 1 reads only columns the covering index
  -- idx_wmc_wallet_coll_ek_fmv_tier carries (index-only scan, no heap fetch per holding); step 2 fetches the
  -- one chosen row by its keys. Reading every holding's heap row was 28.7k cold disk reads for a 47k-row user.
  top AS (
    SELECT wmc.wallet_address, wmc.collection_id, wmc.edition_key, wmc.fmv_usd
    FROM wallet_moments_cache wmc
    JOIN user_wallets uw ON uw.wallet_addr = wmc.wallet_address
    WHERE wmc.fmv_usd > 0
      AND wmc.edition_key IS NOT NULL
    ORDER BY wmc.fmv_usd DESC
    LIMIT 1
  ),
  auto AS (
    SELECT
      w.moment_id,
      w.collection_id,
      w.wallet_address,
      w.player_name, w.set_name, w.tier,
      w.serial_number, w.mint_count, w.fmv_usd, w.image_url,
      w.is_locked, w.series_number, w.edition_key,
      FALSE AS is_manual_override
    FROM top t
    CROSS JOIN LATERAL (
      SELECT wmc.*
      FROM wallet_moments_cache wmc
      WHERE wmc.wallet_address = t.wallet_address
        AND wmc.collection_id = t.collection_id
        AND wmc.edition_key = t.edition_key
        AND wmc.fmv_usd = t.fmv_usd
      LIMIT 1
    ) w
  ),
  chosen AS (
    SELECT * FROM manual
    UNION ALL
    SELECT * FROM auto WHERE NOT EXISTS (SELECT 1 FROM manual)
  )
  SELECT
    ch.moment_id,
    ch.collection_id,
    c.slug::TEXT AS collection_slug,
    ch.wallet_address,
    ch.player_name, ch.set_name, ch.tier,
    ch.serial_number, ch.mint_count, ch.fmv_usd, ch.image_url,
    ch.is_locked, ch.series_number, ch.edition_key,
    ch.is_manual_override
  FROM chosen ch
  LEFT JOIN collections c ON c.id = ch.collection_id;
$function$;

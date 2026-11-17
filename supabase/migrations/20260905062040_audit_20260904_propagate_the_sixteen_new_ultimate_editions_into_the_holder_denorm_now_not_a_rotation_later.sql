-- audit_20260904_propagate_the_sixteen_new_ultimate_editions_into_the_holder_denorm_now_not_a_rotation_later
--
-- anon-exec: creates no function; a targeted UPDATE plus an audit table. No ACL is touched.
--
-- WHY THIS EXISTS AT ALL, and it is the rule this session keeps re-learning:
-- **a data correction is not finished until the surface it changed has been
-- rendered.** `20260905061815` created the 16 Ultimate 1/1 editions, five of
-- which are held in `wallet_moments_cache`. Those five tiles were STILL blank
-- afterwards, because `wallet_moments_cache` is a denormalised copy and the
-- thing that refreshes it -- `reconcile_wmc_metadata_from_editions` -- is a
-- CURSOR ROTATION over `editions.external_id`, not a change feed.
--
-- ⚠ And the rotation had already swept past them. Its cursor sits at
-- `2eb47cb4-…`, and `'140:5141' < '253:8958' < '2eb47cb4…'` lexically, so the
-- five rows would have stayed blank until the cursor wrapped a whole cycle --
-- an unbounded wait for the most valuable Moments on the platform, on a defect
-- a user can see today.
--
-- ⭐ IT APPLIES THE RECONCILER'S OWN RULES, VERBATIM, rather than inventing a
-- second policy for the same columns: a NULL catalog value never removes a value
-- wmc already holds, and a non-empty wmc player/team is never overwritten. So
-- running this changes exactly what the rotation would have changed when it got
-- here, only sooner, and re-running it is a no-op.
--
-- ⛔ It deliberately does NOT touch `image_url` or `fmv_usd`. Those belong to
-- other lanes (the media resolver and the FMV drain); filling them from here
-- would be inventing a value the catalog does not yet hold -- the 16 rows carry
-- NULL media until the Atlas enrichment walks sets 140 and 253.
--
-- Scope: exactly the external_ids recorded in
-- `audit_20260904_ultimate_1of1_editions_created`, so it cannot reach a row that
-- migration did not create.
--
-- REVERT: restore from public.audit_20260904_wmc_ultimate_denorm_backup
--   UPDATE public.wallet_moments_cache w SET tier = b.old_tier, set_name = b.old_set_name,
--          player_name = b.old_player_name, team_name = b.old_team_name, mint_count = b.old_mint_count
--     FROM public.audit_20260904_wmc_ultimate_denorm_backup b WHERE w.id = b.wmc_id;
CREATE TABLE IF NOT EXISTS public.audit_20260904_wmc_ultimate_denorm_backup (
  wmc_id uuid PRIMARY KEY,
  edition_key text NOT NULL,
  old_tier text, old_set_name text, old_player_name text, old_team_name text, old_mint_count integer,
  new_tier text, new_set_name text, new_player_name text, new_team_name text, new_mint_count integer,
  captured_at timestamptz NOT NULL DEFAULT now()
);

WITH src AS (
  SELECT e.external_id, e.tier::text AS tier, e.set_name, e.player_name, e.team_name, e.circulation_count
    FROM public.editions e
    JOIN public.audit_20260904_ultimate_1of1_editions_created a ON a.edition_id = e.id
),
cand AS (
  SELECT w.id, w.edition_key,
         w.tier AS old_tier, w.set_name AS old_set_name, w.player_name AS old_player_name,
         w.team_name AS old_team_name, w.mint_count AS old_mint_count,
         CASE WHEN s.tier IS NOT NULL THEN s.tier ELSE w.tier END AS new_tier,
         CASE WHEN s.set_name IS NOT NULL THEN s.set_name ELSE w.set_name END AS new_set_name,
         CASE WHEN COALESCE(w.player_name, '') = '' THEN COALESCE(s.player_name, s.team_name, w.player_name) ELSE w.player_name END AS new_player_name,
         CASE WHEN COALESCE(w.team_name, '')   = '' THEN COALESCE(s.team_name, w.team_name)                  ELSE w.team_name   END AS new_team_name,
         CASE WHEN s.circulation_count IS NOT NULL THEN s.circulation_count ELSE w.mint_count END AS new_mint_count
    FROM public.wallet_moments_cache w
    JOIN src s ON s.external_id = w.edition_key
),
changed AS (
  SELECT * FROM cand
   WHERE new_tier        IS DISTINCT FROM old_tier
      OR new_set_name    IS DISTINCT FROM old_set_name
      OR new_player_name IS DISTINCT FROM old_player_name
      OR new_team_name   IS DISTINCT FROM old_team_name
      OR new_mint_count  IS DISTINCT FROM old_mint_count
),
logged AS (
  INSERT INTO public.audit_20260904_wmc_ultimate_denorm_backup
    (wmc_id, edition_key, old_tier, old_set_name, old_player_name, old_team_name, old_mint_count,
     new_tier, new_set_name, new_player_name, new_team_name, new_mint_count)
  SELECT id, edition_key, old_tier, old_set_name, old_player_name, old_team_name, old_mint_count,
         new_tier, new_set_name, new_player_name, new_team_name, new_mint_count
    FROM changed
  ON CONFLICT (wmc_id) DO NOTHING
  RETURNING 1
)
UPDATE public.wallet_moments_cache w
   SET tier = c.new_tier, set_name = c.new_set_name, player_name = c.new_player_name,
       team_name = c.new_team_name, mint_count = c.new_mint_count
  FROM changed c
 WHERE w.id = c.id;

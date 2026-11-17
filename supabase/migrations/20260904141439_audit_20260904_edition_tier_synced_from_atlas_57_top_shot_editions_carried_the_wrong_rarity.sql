-- audit_20260904_edition_tier_synced_from_atlas_57_top_shot_editions_carried_the_wrong_rarity
-- Applied to prod via MCP apply_migration 2026-09-04 14:14Z (version 20260904141439).
-- Verified after apply: first run 41 corrected / 0 skipped, second run 0 (converged);
--   5:36 P.J. Washington *Metallic Gold LE* COMMON -> RARE, 5:137 Ja Morant COMMON -> RARE,
--   12:159 Westbrook *From the Top* COMMON -> LEGENDARY, 245:8426 LeBron *Top Shot This* -> FANDOM.
--   check_secdef_anon_execute_violations() = 0; one overload; acl {postgres,service_role,cron_heavy}.
--
-- FINDING (2026-09-04, the Atlas diff, after the badge_editions refresh made Dapper's own tier
-- available for every Top Shot edition): **62 editions carry a tier that is not the one Top Shot
-- publishes** — 57 with a wrong value and 5 with none. They are not obscure: `5:36` P.J. Washington
-- *Metallic Gold LE* and `5:137` Ja Morant *Metallic Gold LE* are stored COMMON and are RARE;
-- `12:159` Westbrook *From the Top* is stored COMMON and is LEGENDARY; `245:8426` LeBron *Top Shot
-- This: Playoffs Edition* is stored COMMON and is FANDOM. **3,051 holder rows sit on those
-- editions.** `editions.tier` drives the rarity filters on both snipers, the tier weights in pack
-- EV, the tier facets on set/team/player pages and the badge on every card, so a COMMON label on a
-- RARE Moment is wrong in the collector's face and wrong in the maths behind it.
--
-- FIX: a bounded hourly sync from `badge_editions.tier` (Atlas, refreshed ~every 2.5 h) into
-- `editions.tier`, with the old value kept per row. Guards that matter:
--   • Atlas also emits the proto spelling `MOMENT_TIER_FANDOM`; it is normalised, and anything that
--     still does not cast to `tier_type` is SKIPPED rather than guessed (a bad cast would abort the
--     whole statement, and a wrong rarity is worse than a missing one).
--   • Only Top Shot. All Day / Golazos / Pinnacle / UFC keep their own vocabularies.
--   • A NULL badge tier never overwrites a populated edition tier — this only fills or corrects.
-- anon-exec: no — sync_topshot_edition_tier_from_badges is a writer; REVOKE … FROM PUBLIC, anon,
--   authenticated below; postgres/service_role/cron_heavy only.
-- REVERT: UPDATE editions e SET tier = a.old_tier::tier_type FROM audit_20260904_edition_tier_sync a
--   WHERE a.edition_id = e.id AND a.old_tier IS NOT NULL;
--   SELECT cron.unschedule('rpc-topshot-edition-tier-sync');
--   DROP FUNCTION public.sync_topshot_edition_tier_from_badges(integer);

CREATE TABLE IF NOT EXISTS public.audit_20260904_edition_tier_sync (
  edition_id  uuid PRIMARY KEY,
  external_id text NOT NULL,
  old_tier    text,
  new_tier    text NOT NULL,
  applied_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.audit_20260904_edition_tier_sync ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.audit_20260904_edition_tier_sync FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.audit_20260904_edition_tier_sync TO postgres, service_role, cron_heavy;

CREATE OR REPLACE FUNCTION public.sync_topshot_edition_tier_from_badges(p_limit integer DEFAULT 500)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
SET statement_timeout TO '60s'
AS $function$
DECLARE
  v_ts constant uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  v_started timestamptz := clock_timestamp();
  v_n integer := 0;
  v_skipped integer := 0;
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtext('sync_topshot_edition_tier_from_badges')::bigint) THEN
    RETURN jsonb_build_object('skipped', 'concurrent');
  END IF;

  WITH cand AS (
    SELECT e.id, e.external_id, e.tier::text AS old_tier,
           -- Atlas emits both `FANDOM` and the proto spelling `MOMENT_TIER_FANDOM`.
           upper(regexp_replace(be.tier, '^MOMENT_TIER_', '')) AS new_tier
      FROM public.editions e
      JOIN public.badge_editions be
        ON be.external_id = e.external_id AND be.collection_id = e.collection_id
     WHERE e.collection_id = v_ts
       AND be.tier IS NOT NULL
       AND upper(e.tier::text) IS DISTINCT FROM upper(regexp_replace(be.tier, '^MOMENT_TIER_', ''))
     LIMIT GREATEST(p_limit, 1)
  ),
  ok AS (
    -- Skip, never guess: an unknown label is counted and left alone.
    SELECT * FROM cand WHERE new_tier IN ('COMMON','FANDOM','RARE','LEGENDARY','ULTIMATE')
  ),
  logged AS (
    INSERT INTO public.audit_20260904_edition_tier_sync (edition_id, external_id, old_tier, new_tier)
    SELECT id, external_id, old_tier, new_tier FROM ok
    ON CONFLICT (edition_id) DO NOTHING
  ),
  upd AS (
    UPDATE public.editions e
       SET tier = o.new_tier::tier_type
      FROM ok o
     WHERE e.id = o.id
    RETURNING 1
  )
  SELECT (SELECT count(*)::int FROM upd),
         (SELECT count(*)::int FROM cand) - (SELECT count(*)::int FROM ok)
    INTO v_n, v_skipped;

  IF v_n > 0 OR v_skipped > 0 THEN
    PERFORM public.log_pipeline_run('topshot-edition-tier-sync', v_started, v_n + v_skipped, v_n, v_skipped, true, NULL,
              'nba_top_shot', NULL, NULL,
              jsonb_build_object('duration_ms', (extract(epoch from clock_timestamp() - v_started) * 1000)::int,
                                 'corrected', v_n, 'skipped_unknown_label', v_skipped, 'via', 'pg_cron'));
  END IF;
  RETURN jsonb_build_object('corrected', v_n, 'skipped_unknown_label', v_skipped);
END
$function$;

REVOKE EXECUTE ON FUNCTION public.sync_topshot_edition_tier_from_badges(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sync_topshot_edition_tier_from_badges(integer) TO postgres, service_role, cron_heavy;

-- :53 — one other job holds that minute (`maint-vacuum-sales-hot-partition`, a weekly), and this is
-- a sub-second no-op once the population is drained.
SELECT cron.schedule('rpc-topshot-edition-tier-sync', '53 * * * *', $$SELECT public.sync_topshot_edition_tier_from_badges(500)$$);

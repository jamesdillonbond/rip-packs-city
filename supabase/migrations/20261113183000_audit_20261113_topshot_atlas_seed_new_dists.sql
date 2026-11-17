-- audit_20261113_topshot_atlas_seed_new_dists
--
-- Applied 2026-11-13 10:18 AM PT through the dashboard SQL editor (Cowork, Trevor: "Use chrome to apply
-- any sql work"); schema_migrations row 20261113183000 inserted in the same run; pg_cron jobid 874.
--
-- Why: topshot_pack_supply_tick walks Atlas SearchDistributions once a day (list_started_at
-- older than 24 h). A Top Shot pack first seen by our catalogue after that walk is absent
-- from topshot_atlas_dists for up to ~24 h, so it gets no summary, no pool and no pack EV.
-- One-day Rookie Debut Overtime packs (8929 Dybantsa, 8930 Peterson) closed before their EV
-- existed: 8930 appeared 2026-11-12 7:25 PM PT, after the 3:36-4:30 PM PT walk.
--
-- What: seed a stub row (dist_id, title) for any numeric Top Shot pack_distributions row first
-- seen in the last 7 days that topshot_atlas_dists lacks. next_due_at stays NULL, so the tick's
-- summary branch (ORDER BY next_due_at NULLS FIRST) reads it on the next free slot, then its
-- edition pages; topshot-pool-from-atlas and topshot-atlas-pack-ev follow on their own cadence.
-- The daily list walk later fills title/end_time/supply/listed_at via its ON CONFLICT update.
-- Cost: one summary + a few edition requests per new pack, against a full ~55-page walk.
-- Readers: pack_table_rows reads only summary columns (gated on summary_fetched_at), and the
-- tick's next_due logic coalesces the NULL supply columns. No other reader of the table.
--
-- Revert:
--   SELECT cron.unschedule('rpc-ts-atlas-seed-new-dists');
--   DROP FUNCTION IF EXISTS public.topshot_atlas_seed_new_dists();
--   (Seeded rows are ordinary topshot_atlas_dists rows the list walk would have added anyway.)

CREATE OR REPLACE FUNCTION public.topshot_atlas_seed_new_dists()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_started timestamptz := clock_timestamp();
  v_ids     text[];
BEGIN
  WITH ins AS (
    INSERT INTO public.topshot_atlas_dists (dist_id, title)
    SELECT pd.dist_id, pd.title
      FROM public.pack_distributions pd
     WHERE pd.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid
       AND pd.dist_id ~ '^[0-9]+$'
       AND pd.first_seen_at > now() - interval '7 days'
       AND NOT EXISTS (SELECT 1 FROM public.topshot_atlas_dists t WHERE t.dist_id = pd.dist_id)
    ON CONFLICT (dist_id) DO NOTHING
    RETURNING dist_id
  )
  SELECT coalesce(array_agg(dist_id ORDER BY dist_id), '{}') INTO v_ids FROM ins;

  PERFORM public.log_pipeline_run(
    'topshot-atlas-seed-new-dists', v_started, cardinality(v_ids), cardinality(v_ids), 0,
    true, NULL, 'nba_top_shot', NULL, NULL,
    jsonb_build_object('seeded', to_jsonb(v_ids)));
  RETURN jsonb_build_object('seeded', to_jsonb(v_ids));
END;
$function$;

-- anon-exec: revoked (topshot_atlas_seed_new_dists) — new SECDEF writer; service_role/postgres only.
REVOKE EXECUTE ON FUNCTION public.topshot_atlas_seed_new_dists() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.topshot_atlas_seed_new_dists() TO postgres, service_role;

COMMENT ON FUNCTION public.topshot_atlas_seed_new_dists() IS
  'Seeds topshot_atlas_dists with Top Shot packs first seen in pack_distributions (last 7 d) that the daily Atlas list walk has not reached yet, so their summary/pool/EV start within the hour. 2026-11-13, see migration audit_20261113_topshot_atlas_seed_new_dists.';

SELECT cron.schedule('rpc-ts-atlas-seed-new-dists', '4,14,24,34,44,54 * * * *',
                     'SELECT public.topshot_atlas_seed_new_dists()');

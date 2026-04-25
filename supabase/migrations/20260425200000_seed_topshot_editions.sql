-- Idempotent batch seed for Top Shot editions.
--
-- Background: the compute-topshot-pack-ev edge function used to seed unseen
-- pack-content editions via a plain editions.upsert. That left new rows with
-- NULL set_id_onchain / play_id_onchain, which is the join target used by
-- bridge_integer_fmv to flow FMV across dual-format external_id pairs (the
-- coverage gap closed by 20260425193430_get_topshot_editions_dual_format).
-- Result: 99 stranded TS editions sat without onchain IDs and missed every
-- bridged FMV update until they were backfilled in production.
--
-- This RPC parses integer-pair external_ids ("setID:playID") at insert time
-- and populates the onchain ID columns directly, so future seed-on-miss calls
-- never strand a row again. The ON CONFLICT branch also heals existing rows
-- whose onchain IDs are still NULL, making the function safe to re-run.
--
-- Mirrors production (apply_migration deploy 2026-04-25).

CREATE OR REPLACE FUNCTION public.seed_topshot_editions(p_external_ids text[])
 RETURNS jsonb
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_inserted int := 0;
  v_existed  int := 0;
  v_updated  int := 0;
BEGIN
  WITH parsed AS (
    SELECT
      ext AS external_id,
      CASE WHEN ext ~ '^[0-9]+:[0-9]+$'
        THEN split_part(ext, ':', 1)::int
        ELSE NULL
      END AS set_id,
      CASE WHEN ext ~ '^[0-9]+:[0-9]+$'
        THEN split_part(ext, ':', 2)::int
        ELSE NULL
      END AS play_id
    FROM unnest(p_external_ids) AS ext
  ),
  upserted AS (
    INSERT INTO editions (
      collection_id, external_id, set_id_onchain, play_id_onchain
    )
    SELECT
      '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid,
      external_id, set_id, play_id
    FROM parsed
    ON CONFLICT (external_id, collection_id) DO UPDATE
      SET set_id_onchain = COALESCE(editions.set_id_onchain, EXCLUDED.set_id_onchain),
          play_id_onchain = COALESCE(editions.play_id_onchain, EXCLUDED.play_id_onchain)
      WHERE editions.set_id_onchain IS NULL OR editions.play_id_onchain IS NULL
    RETURNING (xmax = 0) AS was_inserted
  )
  SELECT
    count(*) FILTER (WHERE was_inserted),
    count(*) FILTER (WHERE NOT was_inserted)
  INTO v_inserted, v_updated
  FROM upserted;

  v_existed := array_length(p_external_ids, 1) - v_inserted - v_updated;

  RETURN jsonb_build_object(
    'inserted', v_inserted,
    'updated', v_updated,
    'existed_clean', GREATEST(v_existed, 0),
    'requested', COALESCE(array_length(p_external_ids, 1), 0)
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.seed_topshot_editions(text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.seed_topshot_editions(text[]) TO anon;
GRANT EXECUTE ON FUNCTION public.seed_topshot_editions(text[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.seed_topshot_editions(text[]) TO service_role;

COMMENT ON FUNCTION public.seed_topshot_editions(text[]) IS
  'Idempotent batch seed for TS editions. Parses integer-pair external_ids and populates set_id_onchain + play_id_onchain so bridge_integer_fmv can flow FMV across dual-format pairs. Replaces the edge function''s plain editions.upsert which leaves new rows stranded without onchain IDs.';

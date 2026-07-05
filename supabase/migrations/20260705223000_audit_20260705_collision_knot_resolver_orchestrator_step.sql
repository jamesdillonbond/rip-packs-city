-- Wire on-chain TopShot subedition collision-knot resolution into the daily
-- drain-conflated-subeditions orchestrator.
--
-- A "collision knot" = two moments X, Y sharing (base_external_id, serial) where
-- each is mis-keyed onto the OTHER's edition (a transposition). The existing
-- realign/split fns are collision-safe and SKIP these (they can't move X onto a
-- slot Y occupies, nor vice-versa). They surface at ~1/day as the Population B
-- base-parallel probe resolves new candidates.
--
-- Two orchestrator steps close this durably, reusing the existing on-chain path
-- (the backfill-topshot-subeditions edge fn = TopShot.getMomentsSubedition):
--   (seed)    seed_topshot_collision_knot_targets      -> queue knot OCCUPANTS
--             that are unresolved on-chain, so the edge fn resolves them next tick
--   (resolve) resolve_topshot_subedition_collision_knots -> once BOTH nfts are
--             on-chain-resolved, apply the 2-move permutation (bounded, 5/run)
-- The on-chain "verification" is the canonical topshot_moment_subeditions table
-- (populated by getMomentsSubedition) -- the same source the whole pipeline uses.

-- ---------------------------------------------------------------------------
-- Durable audit log (RLS-on, service_role-only). One row per resolved knot.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.topshot_collision_knot_resolutions (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  resolved_at       timestamptz NOT NULL DEFAULT now(),
  x_nft_id          text NOT NULL,
  x_from_edition_id uuid,
  x_to_edition_id   uuid,
  y_nft_id          text NOT NULL,
  y_from_edition_id uuid,
  y_to_edition_id   uuid,
  serial_number     integer
);
ALTER TABLE public.topshot_collision_knot_resolutions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.topshot_collision_knot_resolutions FROM anon, authenticated;
COMMENT ON TABLE public.topshot_collision_knot_resolutions IS
  'Durable audit of TopShot subedition collision-knot 2-move permutations applied by resolve_topshot_subedition_collision_knots (drain-conflated-subeditions orchestrator, step 6). One row per resolved knot (X<->Y edition transposition; serials preserved). Revert a row: restore moments/sales/wmc for x_nft_id/y_nft_id back to *_from_edition_id.';

-- ---------------------------------------------------------------------------
-- SEED: queue knot occupants (Y) that block a resolved+mis-keyed X and are not
-- yet on-chain-resolved, so the edge fn's next tick resolves their subedition.
-- Mirrors seed_topshot_miskeyed_subedition_targets' insert shape (NULL pending).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.seed_topshot_collision_knot_targets(p_limit integer DEFAULT 200)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
SET statement_timeout TO '120s'
AS $function$
DECLARE
  v_ts uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  n integer := 0;
BEGIN
  INSERT INTO topshot_moment_subeditions (nft_id, base_external_id, subedition_id)
  SELECT DISTINCT ym.nft_id, split_part(ey.external_id,'::',1), NULL::smallint
  FROM (
    -- resolved, mis-keyed X whose on-chain-correct target edition exists
    SELECT c.nft_id, c.serial_number, tgt.id AS correct_ed
    FROM (
      SELECT m.nft_id, m.serial_number, m.edition_id,
             e.external_id AS cur_ext, split_part(e.external_id,'::',1) AS base
      FROM moments m JOIN editions e ON e.id = m.edition_id
      WHERE m.collection_id = v_ts
    ) c
    JOIN topshot_moment_subeditions s
      ON s.nft_id = c.nft_id AND s.subedition_id IS NOT NULL AND s.base_external_id = c.base
    JOIN editions tgt
      ON tgt.collection_id = v_ts
     AND tgt.external_id = (CASE WHEN s.subedition_id = 0 THEN s.base_external_id
                                 ELSE s.base_external_id || '::' || s.subedition_id END)
    WHERE c.cur_ext <> (CASE WHEN s.subedition_id = 0 THEN s.base_external_id
                             ELSE s.base_external_id || '::' || s.subedition_id END)
  ) x
  JOIN moments ym
    ON ym.edition_id = x.correct_ed AND ym.serial_number = x.serial_number
   AND ym.nft_id <> x.nft_id AND ym.collection_id = v_ts
  JOIN editions ey ON ey.id = ym.edition_id
  WHERE NOT EXISTS (SELECT 1 FROM topshot_moment_subeditions t WHERE t.nft_id = ym.nft_id)
    AND ym.nft_id ~ '^[0-9]+$'
    AND split_part(ey.external_id,'::',1) ~ '^[0-9]+:[0-9]+$'
  LIMIT greatest(1, p_limit)
  ON CONFLICT (nft_id) DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END
$function$;
REVOKE ALL ON FUNCTION public.seed_topshot_collision_knot_targets(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.seed_topshot_collision_knot_targets(integer) TO service_role;

-- ---------------------------------------------------------------------------
-- RESOLVE: for up to p_limit knots where BOTH X and Y are on-chain-resolved and
-- both target editions exist, apply the 2-move permutation. Edition-only (serials
-- preserved). Uses distinct transient serial parks so the non-deferrable
-- (edition_id, serial_number) unique constraint never trips mid-permutation.
-- Third-party-occupant guarded (longer chains are skipped, left for a later tick).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.resolve_topshot_subedition_collision_knots(p_limit integer DEFAULT 5)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
SET statement_timeout TO '120s'
AS $function$
DECLARE
  v_ts uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  v_resolved int := 0;
  v_skipped  int := 0;
  rec record;
BEGIN
  -- Materialize candidates first (decouple selection from the in-loop mutation).
  DROP TABLE IF EXISTS _knot_cand;
  CREATE TEMP TABLE _knot_cand ON COMMIT DROP AS
  WITH cur AS (
    SELECT m.nft_id, m.serial_number AS serial_no, m.edition_id AS cur_ed,
           e.external_id AS cur_ext, split_part(e.external_id,'::',1) AS base
    FROM moments m JOIN editions e ON e.id = m.edition_id
    WHERE m.collection_id = v_ts
  ),
  xmis AS (
    SELECT c.nft_id, c.serial_no, c.cur_ed, tgt.id AS correct_ed
    FROM cur c
    JOIN topshot_moment_subeditions s
      ON s.nft_id = c.nft_id AND s.subedition_id IS NOT NULL AND s.base_external_id = c.base
    JOIN editions tgt
      ON tgt.collection_id = v_ts
     AND tgt.external_id = (CASE WHEN s.subedition_id = 0 THEN s.base_external_id
                                 ELSE s.base_external_id || '::' || s.subedition_id END)
    WHERE c.cur_ext <> (CASE WHEN s.subedition_id = 0 THEN s.base_external_id
                             ELSE s.base_external_id || '::' || s.subedition_id END)
  )
  SELECT x.nft_id AS x_nft, x.cur_ed AS x_cur_ed, x.correct_ed AS x_correct_ed, x.serial_no,
         ym.nft_id AS y_nft, ym.edition_id AS y_cur_ed, ysub.correct_ed AS y_correct_ed
  FROM xmis x
  JOIN moments ym
    ON ym.edition_id = x.correct_ed AND ym.serial_number = x.serial_no
   AND ym.nft_id <> x.nft_id AND ym.collection_id = v_ts
  JOIN LATERAL (
    SELECT tgt.id AS correct_ed
    FROM topshot_moment_subeditions s
    JOIN editions tgt
      ON tgt.collection_id = v_ts
     AND tgt.external_id = (CASE WHEN s.subedition_id = 0 THEN s.base_external_id
                                 ELSE s.base_external_id || '::' || s.subedition_id END)
    WHERE s.nft_id = ym.nft_id AND s.subedition_id IS NOT NULL
    LIMIT 1
  ) ysub ON true
  WHERE ysub.correct_ed <> x.correct_ed
    AND NOT EXISTS (
      SELECT 1 FROM moments z
      WHERE z.collection_id = v_ts AND z.edition_id = ysub.correct_ed
        AND z.serial_number = x.serial_no AND z.nft_id NOT IN (x.nft_id, ym.nft_id)
    )
  LIMIT greatest(1, p_limit);

  FOR rec IN SELECT * FROM _knot_cand LOOP
    -- Defensive re-check: state may have shifted (prior iteration / live pipeline).
    IF EXISTS (SELECT 1 FROM moments z WHERE z.collection_id = v_ts
                 AND z.edition_id = rec.y_correct_ed AND z.serial_number = rec.serial_no
                 AND z.nft_id NOT IN (rec.x_nft, rec.y_nft))
       OR NOT EXISTS (SELECT 1 FROM moments z WHERE z.collection_id = v_ts
                        AND z.nft_id = rec.x_nft AND z.edition_id = rec.x_cur_ed)
       OR NOT EXISTS (SELECT 1 FROM moments z WHERE z.collection_id = v_ts
                        AND z.nft_id = rec.y_nft AND z.edition_id = rec.y_cur_ed)
    THEN
      v_skipped := v_skipped + 1;
      CONTINUE;
    END IF;

    -- 2-move permutation via DISTINCT transient serial parks (X +3M, Y +4M): both
    -- share the real serial, so distinct parks free every real slot and each of
    -- the 6 single-row updates lands on an empty (edition_id, serial_number).
    UPDATE moments SET serial_number = serial_number + 3000000 WHERE collection_id = v_ts AND nft_id = rec.x_nft;
    UPDATE moments SET serial_number = serial_number + 4000000 WHERE collection_id = v_ts AND nft_id = rec.y_nft;
    UPDATE moments SET edition_id = rec.x_correct_ed, updated_at = now() WHERE collection_id = v_ts AND nft_id = rec.x_nft;
    UPDATE moments SET edition_id = rec.y_correct_ed, updated_at = now() WHERE collection_id = v_ts AND nft_id = rec.y_nft;
    UPDATE moments SET serial_number = serial_number - 3000000 WHERE collection_id = v_ts AND nft_id = rec.x_nft;
    UPDATE moments SET serial_number = serial_number - 4000000 WHERE collection_id = v_ts AND nft_id = rec.y_nft;

    -- Mirror sales + wmc (neither has a (edition,serial) unique constraint).
    UPDATE sales SET edition_id = rec.x_correct_ed
      WHERE collection_id = v_ts AND nft_id = rec.x_nft AND edition_id IS DISTINCT FROM rec.x_correct_ed;
    UPDATE sales SET edition_id = rec.y_correct_ed
      WHERE collection_id = v_ts AND nft_id = rec.y_nft AND edition_id IS DISTINCT FROM rec.y_correct_ed;
    UPDATE wallet_moments_cache w SET edition_key = ex.external_id
      FROM editions ex WHERE ex.id = rec.x_correct_ed
        AND w.collection_id = v_ts AND w.moment_id = rec.x_nft AND w.edition_key IS DISTINCT FROM ex.external_id;
    UPDATE wallet_moments_cache w SET edition_key = ey.external_id
      FROM editions ey WHERE ey.id = rec.y_correct_ed
        AND w.collection_id = v_ts AND w.moment_id = rec.y_nft AND w.edition_key IS DISTINCT FROM ey.external_id;

    INSERT INTO topshot_collision_knot_resolutions
      (x_nft_id, x_from_edition_id, x_to_edition_id, y_nft_id, y_from_edition_id, y_to_edition_id, serial_number)
    VALUES (rec.x_nft, rec.x_cur_ed, rec.x_correct_ed, rec.y_nft, rec.y_cur_ed, rec.y_correct_ed, rec.serial_no);

    v_resolved := v_resolved + 1;
  END LOOP;

  RETURN jsonb_build_object('knots_resolved', v_resolved, 'knots_skipped', v_skipped);
END
$function$;
REVOKE ALL ON FUNCTION public.resolve_topshot_subedition_collision_knots(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_topshot_subedition_collision_knots(integer) TO service_role;

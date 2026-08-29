DO $$
DECLARE v_old text; v_new text;
BEGIN
  SELECT obj_description('public.public_board_liveness_probe(integer)'::regprocedure,'pg_proc') INTO v_old;

  IF position('migration 20260829051500' in v_old) = 0 THEN
    RAISE EXCEPTION 'anchor not found: comment does not carry the hand-stamped version 20260829051500 (comment len=%)', length(v_old);
  END IF;

  v_new := replace(v_old,
    'verbatim in migration 20260829051500 and in the Project doc',
    'verbatim in migration 20260829050847 -- the version apply_migration actually recorded, NOT a hand-stamped one; the first draft of this very note carried a hand-stamped 20260829051500 and was corrected here, which is the seventh instance of the version-stamp habit in 24h -- and in the Project doc');

  EXECUTE format('COMMENT ON FUNCTION public.public_board_liveness_probe(integer) IS %L', v_new);
END $$;
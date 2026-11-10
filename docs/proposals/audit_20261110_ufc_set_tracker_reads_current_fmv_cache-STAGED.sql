-- anon-exec: intentional — get_ufc_set_progress keeps its ACL (CREATE OR REPLACE, same signature; service_role only, asserted at the end).
--
-- WHY. The UFC set tracker priced a MISSING piece from the latest NON-NULL snapshot
--   SELECT DISTINCT ON (edition_id) ... FROM fmv_snapshots
--    WHERE collection_id = p_collection_id AND fmv_usd IS NOT NULL ORDER BY edition_id, computed_at DESC
-- — the same CTE the All Day tracker carried until 20261110173413, where it summed
-- $78,407 of prices the engine had withdrawn into "cost to complete".
-- On UFC it is LATENT, not live: measured 2026-11-10 ~10:28 AM PT over the whole UFC
-- population, old CTE 572 priced editions / $18,647.80, edition_fmv_current 572 /
-- $18,647.80, 0 differing; 45 UFC editions are withdrawn today and none has an older
-- priced snapshot. The first withdrawal of a once-priced UFC edition would have put its
-- old price back into the estimate with nothing reporting it.
--
-- WHAT. The CTE reads edition_fmv_current (PK edition_id). No number changes today.
-- Body rewritten FROM THE LIVE prosrc under an md5 guard; the old CTE must occur once.
--
-- POST-CHECK: for any UFC wallet, sum(estimatedCostToComplete) is unchanged.
-- REVERT: re-run this DO block with v_old and v_new swapped and the md5 guard removed.
DO $mig$
DECLARE
  v_old constant text := E'edition_fmv AS (\n  SELECT DISTINCT ON (edition_id) edition_id, fmv_usd\n  FROM fmv_snapshots\n  WHERE collection_id = p_collection_id AND fmv_usd IS NOT NULL\n  ORDER BY edition_id, computed_at DESC\n)';
  v_new constant text := E'edition_fmv AS (\n  -- 2026-11-10: the CURRENT price per edition (edition_fmv_current), not the latest\n  -- non-null snapshot: a price the engine has withdrawn must not price a missing piece.\n  SELECT edition_id, fmv_usd\n  FROM edition_fmv_current\n  WHERE collection_id = p_collection_id AND fmv_usd IS NOT NULL\n)';
  v_src text;
  v_out text;
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc WHERE oid = 'public.get_ufc_set_progress(text, uuid)'::regprocedure;
  IF md5(v_src) <> 'eb19eb4737d9c6e2008246d070aee7e4' THEN
    RAISE EXCEPTION 'get_ufc_set_progress body changed since this migration was written (md5 %)', md5(v_src);
  END IF;
  v_out := replace(v_src, v_old, v_new);
  IF v_out = v_src OR (length(v_src) - length(replace(v_src, v_old, ''))) <> length(v_old) THEN
    RAISE EXCEPTION 'get_ufc_set_progress: expected exactly one edition_fmv CTE';
  END IF;
  EXECUTE format(
    'CREATE OR REPLACE FUNCTION public.get_ufc_set_progress(p_wallet text, p_collection_id uuid DEFAULT %L::uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS %L',
    '9b4824a8-736d-4a96-b450-8dcc0c46b023', v_out);

  IF has_function_privilege('anon', 'public.get_ufc_set_progress(text, uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.get_ufc_set_progress(text, uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'ACL widened on get_ufc_set_progress';
  END IF;
END
$mig$;

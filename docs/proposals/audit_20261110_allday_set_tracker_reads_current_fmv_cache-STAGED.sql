-- anon-exec: intentional — get_allday_set_progress / get_allday_set_detail keep their ACL (CREATE OR REPLACE, same signatures; service_role only, asserted at the end).
--
-- STAGED 2026-11-10 ~9:45 AM PT (Cowork cloud audit pass). NOT APPLIED: `apply_migration`
-- was refused for this session. Apply from the dashboard SQL editor or a Claude Code
-- session, then commit this body as
-- supabase/migrations/<recorded version>_audit_20261110_allday_set_tracker_reads_current_fmv_cache.sql
-- and delete this file.
--
-- WHY. Both All Day set-tracker functions priced a MISSING edition from
--   SELECT DISTINCT ON (edition_id) ... FROM fmv_snapshots
--    WHERE collection_id = p_collection_id AND fmv_usd IS NOT NULL ORDER BY edition_id, computed_at DESC
-- i.e. the latest NON-NULL snapshot. Two defects in one CTE:
--  (1) ACCURACY. 196 All Day editions have a NEWER snapshot whose price is NULL
--      (algo cold-tail-1.0, confidence NO_DATA, written 11-03..11-10): the pricing engine
--      WITHDREW those prices, and every other surface (edition pages, the boards on
--      edition_fmv_current) shows them unpriced. The tracker kept summing the withdrawn
--      figures into "cost to complete": $78,407.10 across the 196, one of $4,999.50, the
--      oldest dated 2026-05-10. Measured over the whole All Day population 9:20 AM PT:
--      CTE 5,735 priced / edition_fmv_current 5,539 priced / 196 in the CTE only /
--      4 in both that differ (sum $0.30, the cache's daily-reconcile lag).
--  (2) COST. The CTE streams every All Day snapshot per call whatever the wallet holds:
--      63,233 buffers, 3.7 s warm, over the route's 8 s budget cold (Vercel 8:08 AM PT).
--
-- WHAT. The CTE reads edition_fmv_current (latest snapshot per edition, PK edition_id).
-- A withdrawn price is now no price: the piece shows unpriced and adds nothing to the
-- estimate, as on its own edition page. Bodies are rewritten FROM THE LIVE prosrc under
-- an md5 guard (no transcription); the old CTE must occur exactly once in each.
--
-- PRE-CHECK (before): for wallet 0xbd94cade097e50ac the sum of estimatedCostToComplete
--   over all sets read $423,045.11 at 9:35 AM PT (258 sets with a cost).
-- POST-CHECK: the same sum falls by the withdrawn prices among that wallet's missing
--   pieces; EXPLAIN (ANALYZE, BUFFERS) select get_allday_set_progress('<wallet>') should
--   read a few thousand buffers, not ~63,000.
--
-- REVERT: re-run this DO block with v_old and v_new swapped and the md5 guards removed.
DO $mig$
DECLARE
  v_old constant text := E'edition_fmv AS (\n  SELECT DISTINCT ON (edition_id) edition_id, fmv_usd\n  FROM fmv_snapshots\n  WHERE collection_id = p_collection_id AND fmv_usd IS NOT NULL\n  ORDER BY edition_id, computed_at DESC\n)';
  v_new constant text := E'edition_fmv AS (\n  -- 2026-11-10: the CURRENT price per edition (edition_fmv_current), not the latest\n  -- non-null snapshot: a price the engine has withdrawn must not price a missing piece.\n  SELECT edition_id, fmv_usd\n  FROM edition_fmv_current\n  WHERE collection_id = p_collection_id AND fmv_usd IS NOT NULL\n)';
  v_src text;
  v_out text;
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc WHERE oid = 'public.get_allday_set_progress(text, uuid)'::regprocedure;
  IF md5(v_src) <> '074174a9ac2eb6a30938e929ebac3c4a' THEN
    RAISE EXCEPTION 'get_allday_set_progress body changed since this migration was written (md5 %)', md5(v_src);
  END IF;
  v_out := replace(v_src, v_old, v_new);
  IF v_out = v_src OR (length(v_src) - length(replace(v_src, v_old, ''))) <> length(v_old) THEN
    RAISE EXCEPTION 'get_allday_set_progress: expected exactly one edition_fmv CTE';
  END IF;
  EXECUTE format(
    'CREATE OR REPLACE FUNCTION public.get_allday_set_progress(p_wallet text, p_collection_id uuid DEFAULT %L::uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS %L',
    'dee28451-5d62-409e-a1ad-a83f763ac070', v_out);

  SELECT prosrc INTO v_src FROM pg_proc WHERE oid = 'public.get_allday_set_detail(text, uuid, uuid)'::regprocedure;
  IF md5(v_src) <> '1ed93d1952834da4c81b37a931d6fe74' THEN
    RAISE EXCEPTION 'get_allday_set_detail body changed since this migration was written (md5 %)', md5(v_src);
  END IF;
  v_out := replace(v_src, v_old, v_new);
  IF v_out = v_src OR (length(v_src) - length(replace(v_src, v_old, ''))) <> length(v_old) THEN
    RAISE EXCEPTION 'get_allday_set_detail: expected exactly one edition_fmv CTE';
  END IF;
  EXECUTE format(
    'CREATE OR REPLACE FUNCTION public.get_allday_set_detail(p_wallet text, p_set_id uuid, p_collection_id uuid DEFAULT %L::uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS %L',
    'dee28451-5d62-409e-a1ad-a83f763ac070', v_out);

  IF has_function_privilege('anon', 'public.get_allday_set_progress(text, uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.get_allday_set_progress(text, uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.get_allday_set_detail(text, uuid, uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.get_allday_set_detail(text, uuid, uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'ACL widened on an All Day set-tracker function';
  END IF;
END
$mig$;

-- PENDING — run as ONE paste in the Supabase dashboard SQL editor (project bxcqstmqfzmuolpuynti).
-- Why pending: apply_migration's destructive-DDL confirmation prompt never reaches a cloud session
-- (11-02 ~6:45 PM PT: the call timed out on the server's unanswered question; nothing applied, read back).
-- After it runs: move this file's body (minus the last two statements) to
--   supabase/migrations/20261103030000_audit_20261102_drop_uncalled_classify_acquisition.sql
-- and delete supabase/tests/classify_acquisition.sql + its entry in __tests__/db-invariants-drift-guard.test.ts
-- + its mention in supabase/tests/README.md, in the same commit.
--
-- audit_20261102_drop_uncalled_classify_acquisition
--
-- #223 residue, last name ("drop them rather than fix them"): classify_acquisition
-- UPDATEs moment_acquisitions by (nft_id, wallet) with NO collection_id — the
-- #142/#223 defect class (a moment_id is unique only within a collection, even
-- inside one wallet). The 11-02 morning drop (20261102172000) kept it because it was
-- "pinned … and named in get_pipeline_alerts_core". The second half was a false
-- positive: `ILIKE '%classify_acquisition%'` treats `_` as a one-character wildcard
-- and matched the PIPELINE NAME 'classify-acquisitions-multicollection'. A literal
-- search (strpos / regexp) finds no call there. A pin is not a caller.
--
-- Caller census, 2026-11-02 ~6:40 PM PT, immediately before writing this file:
--   repo (app, lib, workers, supabase/functions, scripts, .github): 0 calls — one
--     COMMENT in app/api/cron/classify-acquisitions-multicollection/route.ts
--   other pg_proc bodies (literal match): 0 · triggers: 0 · cron.job commands: 0
--   pg_stat_statements calls: 0 (stats window ~125 days)
--   EXECUTE: service_role + postgres only.
-- The live classifier is the classify-acquisitions-multicollection route, which does
-- not call this function.
--
-- REVERT (verbatim pg_get_functiondef, captured just before the drop):
--   CREATE OR REPLACE FUNCTION public.classify_acquisition(p_nft_id text, p_wallet text, p_method text, p_confidence text DEFAULT 'flow_scan'::text, p_buy_price numeric DEFAULT NULL::numeric)
--    RETURNS json
--    LANGUAGE plpgsql
--    SECURITY DEFINER
--    SET search_path TO 'public'
--   AS $function$
--   DECLARE
--     v_updated int;
--   BEGIN
--     UPDATE moment_acquisitions
--     SET acquisition_method = p_method,
--         acquisition_confidence = p_confidence,
--         buy_price = COALESCE(p_buy_price, buy_price)
--     WHERE nft_id = p_nft_id
--       AND wallet = p_wallet
--       AND acquisition_method = 'unknown';
--     GET DIAGNOSTICS v_updated = ROW_COUNT;
--     RETURN json_build_object('updated', v_updated > 0, 'nft_id', p_nft_id,
--       'new_method', p_method, 'new_confidence', p_confidence);
--   END;
--   $function$;
--   REVOKE ALL ON FUNCTION public.classify_acquisition(text,text,text,text,numeric) FROM PUBLIC, anon, authenticated;
--   GRANT EXECUTE ON FUNCTION public.classify_acquisition(text,text,text,text,numeric) TO service_role;
--   (and restore supabase/tests/classify_acquisition.sql + its drift-guard entry from git)

DROP FUNCTION IF EXISTS public.classify_acquisition(text, text, text, text, numeric);

-- Records the migration and reads it back in the same paste.
INSERT INTO supabase_migrations.schema_migrations(version,name,statements) VALUES ('20261103030000','audit_20261102_drop_uncalled_classify_acquisition',ARRAY['DROP FUNCTION IF EXISTS public.classify_acquisition(text, text, text, text, numeric);']) ON CONFLICT (version) DO NOTHING;
SELECT (select count(*) from pg_proc where proname='classify_acquisition') fn_left_expect_0,
       (select count(*) from supabase_migrations.schema_migrations where version='20261103030000') mig_expect_1;

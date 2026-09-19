-- audit_20260918_the_txn_control_guard_must_strip_comments_my_first_draft_flagged_the_words_do_NOT_add_COMMIT
--
-- CORRECTS the predicate in `20260919003619` (this session, one minute earlier). That draft
-- matched `p.prosrc ~* '\mcommit\M|\mrollback\M'` and immediately flagged
-- `reconcile_all_seeded_wallet_stats(integer,integer,integer)` — a procedure that is
-- CORRECTLY pinned and does NO transaction control. The only `commit` in its body is
-- inside a COMMENT that reads, in full:
--
--     -- ⛔ Do NOT add COMMIT here -- see the header.
--
-- ⭐ So the guard would have been PERMANENTLY RED ON A CORRECT OBJECT, flagging a comment
-- that exists to prevent the very defect the guard is for. This repo's own rule: a
-- permanently-red instrument is indistinguishable from a broken one, and it would have
-- shipped as a ban-at-zero that can never be zero.
--
-- ⚠ WHY THE FIRST DRAFT LOOKED SAFE: that regex is lifted from `20260914055000`, which used
-- it CORRECTLY — to identify two procedures it had already named. A predicate that is sound
-- for confirming a known set is not automatically sound as a ban-at-zero over a whole
-- population. Reused out of context, it reads comments.
--
-- ── THE FIX ─────────────────────────────────────────────────────────────────────────
-- Strip comments before matching, and require a STATEMENT rather than a mention:
--   1. `/* ... */` removed (dotall, non-greedy), then `-- ...` to end of line.
--   2. match `\mcommit\M\s*;` / `\mrollback\M\s*;` — a bare word is a mention, a word
--      followed by a semicolon is a statement.
-- Both, deliberately: stripping alone already clears this case, and the semicolon covers a
-- comment that happens to contain "COMMIT;". ⚠ The strip is naive about `--` inside a
-- string literal; that is why it is PAIRED with the semicolon test rather than trusted
-- alone. (The repo's real stripper, scripts/lib/strip-comments.mjs, is JS and cannot run here.)
--
-- ── POPULATION, NOW MEASURED RATHER THAN ASSERTED ───────────────────────────────────
-- The first draft's comment claimed "3 procedures, 2 with transaction control, 0 pinned"
-- without running the count. Measured:
--   reconcile_all_saved_wallet_stats(int,int,int,int)  pinned=false  txn_control=true   OK
--   reconcile_all_seeded_wallet_stats(int,int,int)     pinned=TRUE   txn_control=FALSE  OK
--   rpc_trust_health_precompute_refresh_p()            pinned=false  txn_control=true   OK
-- 3 procedures, 2 with transaction control, 0 of those pinned. The claim was right by
-- luck; asserting it unmeasured was the error.
--
-- ── CONTROLS, BOTH DIRECTIONS, TAKEN AGAINST LIVE SCRATCH OBJECTS (since dropped) ───
--   POSITIVE: a scratch procedure with `set search_path` and a real `commit;` IS flagged.
--   NEGATIVE: a scratch procedure whose only `commit` is in a `--` comment is NOT flagged.
--   CLEAN:    with both dropped, the guard returns [] over a non-empty population of 3.
--
-- ⚠ NOT WIRED INTO `rpc_ops_snapshot()` in this migration, deliberately and with the reason
-- stated: that is a FULL-BODY `CREATE OR REPLACE` of a large shared function, and a
-- concurrent session was pushing to main throughout this window. The repo's own rule is to
-- re-read the live object immediately before such a write; doing that safely is a separate,
-- unhurried step. 👉 NEXT: add `'procedure_txn_control_pins', public.check_procedure_transaction_control_pin_drift()`
-- beside the existing `check_function_search_path_drift()` key, after re-reading the live body.
--
-- REVERT: DROP FUNCTION public.check_procedure_transaction_control_pin_drift();

CREATE OR REPLACE FUNCTION public.check_procedure_transaction_control_pin_drift()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $function$
  WITH candidates AS (
    SELECT p.oid,
           p.proconfig,
           -- Comments stripped BEFORE matching: the first draft of this guard flagged the
           -- words "Do NOT add COMMIT here" in a comment whose whole purpose is to prevent
           -- this defect. Block comments first, then line comments.
           regexp_replace(regexp_replace(p.prosrc, '/\*.*?\*/', ' ', 'gs'), '--[^\n]*', ' ', 'g') AS body
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       -- PROCEDURES only: a FUNCTION cannot do transaction control, so the property is not
       -- true of them. The complement is check_function_search_path_drift().
       AND p.prokind = 'p'
       -- Not ours to ALTER.
       AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
       AND p.proconfig IS NOT NULL
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'kind', 'procedure_with_transaction_control_is_pinned',
           'object_name', (c.oid::regprocedure)::text,
           'proconfig', to_jsonb(c.proconfig),
           'detail', 'This PROCEDURE does transaction control (a COMMIT or ROLLBACK '
                  || 'STATEMENT, comments excluded) and carries an attached SET clause. '
                  || 'PostgreSQL runs such a routine inside an implicit transaction block, '
                  || 'so it raises 2D000 invalid transaction termination at its first '
                  || 'COMMIT. Shipped and reverted three times: R14 2026-08-22/23 (WONTFIX, '
                  || '"do NOT re-attempt"); 20260914053000 -> 20260914055000 after pg_cron '
                  || 'jobid 259 failed its first tick in 0.5 s; 20260918225909 -> '
                  || '20260919002535. Fix with ALTER PROCEDURE ... RESET search_path. If a '
                  || 'pin is genuinely wanted the only viable form is a SET search_path '
                  || 'STATEMENT inside the body.'
         ) ORDER BY (c.oid::regprocedure)::text), '[]'::jsonb)
    FROM candidates c
   WHERE c.body ~* '\mcommit\M\s*;|\mrollback\M\s*;';
$function$;

-- anon-exec: NOT intentional for check_procedure_transaction_control_pin_drift — ops-only guard, revoked on the next line.
REVOKE EXECUTE ON FUNCTION public.check_procedure_transaction_control_pin_drift() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.check_procedure_transaction_control_pin_drift() TO postgres, service_role;

COMMENT ON FUNCTION public.check_procedure_transaction_control_pin_drift() IS
  'Ban at zero: no PROCEDURE in public that does transaction control may carry an attached SET clause — PostgreSQL raises 2D000 invalid transaction termination at its first COMMIT. The INVERSE of check_function_search_path_drift(), which bans UNPINNED functions and excludes procedures; nothing asserted this direction, which is why the same pin shipped three times in three months (R14 WONTFIX 2026-08-22/23; 20260914053000 -> 20260914055000; 20260918225909 -> 20260919002535). Comments are STRIPPED before matching and a semicolon is required — the first draft flagged a comment reading "Do NOT add COMMIT here" and would have been permanently red on a correct object. Returns a jsonb ARRAY: clean is jsonb_array_length() = 0, NOT count(*) = 1. Population measured at install: 3 procedures, 2 with transaction control, 0 of those pinned.';

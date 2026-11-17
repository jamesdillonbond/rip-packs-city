-- audit_20260901_allday_unresolved_pulls_bounded_to_the_resolvable_frontier
-- anon-exec: get_allday_unresolved_pulls — SECURITY DEFINER, service_role-only. anon + authenticated were
-- REVOKED by 20260731235000_audit_20260731_revoke_anon_exec_service_role_only_secdef_reads; this migration
-- keeps the IDENTICAL signature and return type, so CREATE OR REPLACE preserves that ACL. Body only.
--
-- WHY (measured 2026-09-01). This is the queue read behind pg_cron jobid 22 (rpc-allday-resolve-pull-editions,
-- '9,39 * * * *') -> the ungitted edge fn resolve-allday-pull-editions. It is the most expensive query PER CALL
-- on the instance:
--     129,112 buffers + 21,892 temp read / 21,988 temp WRITTEN, 9,451 ms  -- to return 300 rows
-- ~45 calls/day at ~1 GB each is ~45 GB/day of disk reads on an IOPS-throttled box.
--
-- ⛔⛔ DO NOT "FIX" THIS WITH AN INDEX. That was tried on 2026-08-13 and REVERTED THE SAME DAY:
-- idx_pack_rips_collection_block_height (collection_id, block_height DESC) flipped the plan to an ordered
-- index walk with a nested loop, Limit cost 237,181 -> 579 (409x "better"), and was MUCH WORSE in practice --
-- a bounded probe over the newest 250,000 rips blew a 50 s statement_timeout against the seq-scan plan's
-- 11.2 s mean. See 20260813173127_audit_20260813_revert_pack_rips_block_height_index_regression.sql and
-- docs/overnight/inbox/2026-08-13T1730Z-disk-read-ranking-and-the-pack-rips-plan-defect.md. The seq scan +
-- sort is the CORRECT plan for "the 300 newest rows of a set whose members are all old". I re-derived the
-- density check today before touching anything: 148,170 rips sit at or above the 300th returned row's block,
-- so an ordered walk still cannot stop early. The 08-13 verdict stands.
--
-- ⭐ WHAT HAS CHANGED SINCE 08-13, AND IT IS THE WHOLE POINT. The 2026-08-13T1845Z correction established
-- that ORDER BY block_height DESC is LOAD-BEARING because it made this a FORWARD resolver, and warned that
-- without it the job would "grab 300 permanently-unresolvable historical rows every tick, forever."
-- That is now happening ANYWAY -- not because the ordering was dropped, but because the frontier got cleared:
--     unresolved pulls with a rip ABOVE the 300th returned block .... 0
--     unresolved pulls in total ..................................... 1,173,781
-- Every remaining unresolved row is at or below block 137,389,992 -- i.e. below the 137,390,146 spork floor,
-- the deep history that needs the un-deployed hydrator. So on a tick with no new arrivals, this query pays
-- ~1 GB to hand the drain the top of a 1.17M-row permanent residue.
--
-- ⚠ THE ORDERING IS STILL LOAD-BEARING AND IS KEPT. Forward resolution is real and this job is plausibly
-- doing it: 581 of the 622 rows resolved in the last 10 days sit ABOVE that residue window, i.e. they were
-- new arrivals that this DESC ordering would have surfaced first. Removing the ORDER BY, or disabling
-- jobid 22, would stop that. Neither is done here.
--
-- THE FIX IS THE WINDOW, NOT THE ORDER: bound the scan to rips that can still plausibly resolve.
--     AllDay rips in the last  30d ....... 864
--                              90d ..... 2,130
--                             180d .... 26,710
--                             all .. 2,816,273
-- and resolution happens FAST when it happens: 545 of 622 rows resolved in the last 10 days had their rip
-- sealed within 7 DAYS of resolution. 90 days is ~13x that observed lag -- generous headroom if the drain
-- is down for a while -- while cutting the scan 1,322x.
--
-- MEASURED, same query, same 0 rows out (the frontier is currently clear, which is the honest answer):
--     as written (no window) .... 129,112 buffers + 21,988 temp written .. 9,451 ms
--     180-day window ............ 104,910 buffers, no temp ............... 1,667 ms
--     90-day window ..............  8,022 buffers, no temp ...............    19 ms   <-- shipped
--     30-day window ..............  3,216 buffers, no temp ...............    12 ms
-- 90d over 30d deliberately: 30d is only 2.5x cheaper again but gives just one month before unworked
-- arrivals could age out of the window entirely, which would be a silent data loss.
--
-- ⚠ BEHAVIOUR CHANGE, STATED PLAINLY: on a tick with no forward work this now returns 0 rows instead of 300
-- residue rows. That is correct -- there IS no forward work at that moment -- but the caller is an UNGITTED
-- edge function whose source must not be pulled (it returns the live ?key= gate literal), and which writes
-- NO pipeline_runs row at all, so its reaction to an empty queue cannot be observed from here. Accepted
-- deliberately: an empty queue is the normal terminal state of every other drain in this repo, and the
-- revert below is one statement.
--
-- ⚠ ALSO NOT LOST: the ~4/day of deep-residue rows this used to nibble (41 of 622 over 10 days). At
-- 1,173,781 unresolved and that rate the residue is ~800 years of work; it is permanent residue pending the
-- hydrator, not a backlog, and paying 45 GB/day for it is the trade being deliberately refused.
--
-- WATCH + EXIT CONDITION (next pass):
--   SELECT * FROM public.ops_pgss_delta('2 hours', 50) WHERE q ILIKE '%get_allday_unresolved_pulls%';
--   PASS: blocks/call falls from ~128,335 to low thousands.
--   FALSIFIER -- the thing that would prove this change WRONG: forward resolution stops. Check
--     SELECT count(*) FROM allday_pack_pull p JOIN pack_rips r ON r.pack_nft_id=p.pack_nft_id
--      WHERE p.edition_id IS NOT NULL AND p.updated_at > now()-interval '3 days'
--        AND r.collection_id='dee28451-5d62-409e-a1ad-a83f763ac070';
--   Baseline for that arm: 622 rows per 10 days (~62/day) as of 2026-09-01. If it goes to ~0 for 3+ days,
--   REVERT -- the edge fn did depend on being handed residue, or on a non-empty queue.
--
-- REVERT (restores the exact pre-2026-09-01 body):
--   CREATE OR REPLACE FUNCTION public.get_allday_unresolved_pulls(p_limit integer DEFAULT 300)
--   RETURNS TABLE(moment_nft_id text, opener_address text, block_height bigint)
--   LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public','pg_temp' AS $f$
--     SELECT p.moment_nft_id, p.opener_address, r.block_height
--     FROM allday_pack_pull p
--     JOIN pack_rips r ON r.pack_nft_id = p.pack_nft_id
--                      AND r.collection_id='dee28451-5d62-409e-a1ad-a83f763ac070'
--     WHERE p.edition_id IS NULL AND p.opener_address IS NOT NULL AND r.block_height IS NOT NULL
--     ORDER BY r.block_height DESC
--     LIMIT p_limit;
--   $f$;
-- To WIDEN the window instead of reverting, edit the single interval literal below.

CREATE OR REPLACE FUNCTION public.get_allday_unresolved_pulls(p_limit integer DEFAULT 300)
 RETURNS TABLE(moment_nft_id text, opener_address text, block_height bigint)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  -- pack_rips leads so idx_pack_rips_collection_time_pv (collection_id, sealed_at DESC) can serve the
  -- window; the ordering stays block_height DESC because that is what makes this a FORWARD resolver
  -- (2026-08-13T1845Z). The 90-day window is the ONLY change from the pre-2026-09-01 body.
  -- ⚠ Do NOT add an index on (collection_id, block_height DESC) to "help" the ORDER BY -- that was built
  -- and reverted on 2026-08-13; see this migration's header.
  SELECT p.moment_nft_id, p.opener_address, r.block_height
  FROM pack_rips r
  JOIN allday_pack_pull p ON p.pack_nft_id = r.pack_nft_id
  WHERE r.collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070'
    AND r.sealed_at > now() - interval '90 days'
    AND r.block_height IS NOT NULL
    AND p.edition_id IS NULL
    AND p.opener_address IS NOT NULL
  ORDER BY r.block_height DESC
  LIMIT p_limit;
$function$;

DO $mig$
DECLARE
  v_def text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'get_allday_unresolved_pulls';

  IF v_def IS NULL OR v_def NOT LIKE '%90 days%' THEN
    RAISE EXCEPTION 'POST-STATE FAILED: the 90-day window is not in the body';
  END IF;
  -- The ordering is load-bearing (2026-08-13T1845Z). Assert it survived this edit.
  IF v_def NOT LIKE '%ORDER BY r.block_height DESC%' THEN
    RAISE EXCEPTION 'POST-STATE FAILED: ORDER BY r.block_height DESC was lost — that ordering is what makes this a forward resolver';
  END IF;
  -- ACL must still be service_role-only.
  IF has_function_privilege('anon', 'public.get_allday_unresolved_pulls(integer)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.get_allday_unresolved_pulls(integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POST-STATE FAILED: anon/authenticated regained EXECUTE';
  END IF;
END
$mig$;
-- Snapshot migration: public.refresh_topshot_conflated_editions_detector_only().
--
-- This function was applied to prod historically via the Supabase MCP with no
-- committed migration file, which made it UNPINNABLE — the DB-invariant drift
-- guard has nothing to compare a test copy against, and `npm run db:pins:check`
-- has no committed body to diff live `prosrc` against. This migration commits
-- the CURRENT LIVE definition verbatim (pulled via pg_get_functiondef on
-- 2026-08-15, md5 511458579340501cbb8f7e608f4877f1). Applying it is a no-op
-- against prod (it is byte-identical to what already runs there).
--
-- WHAT IT DOES, AND WHY IT WAS PRIORITISED. It rebuilds
-- public.topshot_conflated_editions: the set of Top Shot editions where the same
-- (edition_id, serial_number) has been sold under MORE THAN ONE nft_id in the
-- last 365 days — i.e. editions whose keying conflates two distinct moments.
--
-- It is one of only two SCHEDULED SECDEF functions that DELETE and were unpinned
-- (measured 2026-08-15: 169 SECDEF writers in public, 36 on an active pg_cron
-- schedule, 17 of those unpinned). Deleters were pinned first because
-- over-deletion here produces an ABSENCE, not an error, and nothing downstream
-- reports it.
--
-- ⚠ THE CONSUMER IS A PUBLIC SURFACE. `topshot_deals_vs_fmv` EXCLUDES the
-- editions in this table, so an under-populated result does not break a page —
-- it puts CONFLATED editions on the public deals board as genuine deals, priced
-- off a serial that belongs to two different moments. That is the failure this
-- table exists to prevent, and it fails silently in the direction of publishing
-- more rows rather than fewer.
--
-- ⚠ It has a SECOND, independent caller and that fact has already misled one
-- session. pg_cron jobid 62 (`rpc-remap-misattributed-sales`, `23 */6 * * *`)
-- calls it, in addition to the drain route's step 5. Deep-audit R7 reasoned that
-- because step 5 sits inside a tick that dies at its ceiling, the guard must be
-- ~15 days stale; measured live it is 0.0 days stale over 931 rows. Do not
-- re-derive that conclusion from the drain route alone.
--
-- REVERT: this is a snapshot of what is already live, so reverting the FILE
-- changes nothing in prod. To remove the function itself:
--   DROP FUNCTION public.refresh_topshot_conflated_editions_detector_only();
-- (which would also require unscheduling cron jobid 62 and removing step 5 of
-- /api/cron/drain-conflated-subeditions, both of which call it).

CREATE OR REPLACE FUNCTION public.refresh_topshot_conflated_editions_detector_only()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '120s'
AS $function$
DECLARE n integer;
BEGIN
  DROP TABLE IF EXISTS _confd;
  CREATE TEMP TABLE _confd ON COMMIT DROP AS
    SELECT ms.edition_id, count(*)::int AS shared_serials
    FROM (
      SELECT edition_id, serial_number
      FROM sales
      WHERE collection_id='95f28a17-224a-4025-96ad-adf8a4c63bfd'
        AND serial_number > 0 AND nft_id IS NOT NULL
        AND sold_at > now() - interval '365 days'
      GROUP BY edition_id, serial_number HAVING count(DISTINCT nft_id) > 1
    ) ms
    GROUP BY ms.edition_id;
  DELETE FROM public.topshot_conflated_editions WHERE true;
  INSERT INTO public.topshot_conflated_editions (edition_id, shared_serials, detected_at)
    SELECT edition_id, shared_serials, now() FROM _confd;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $function$;

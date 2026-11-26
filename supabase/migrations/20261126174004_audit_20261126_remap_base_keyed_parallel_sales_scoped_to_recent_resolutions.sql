-- audit_20261126_remap_base_keyed_parallel_sales_scoped_to_recent_resolutions
-- anon-exec: unchanged (remap_topshot_base_keyed_parallel_sales) — CREATE OR REPLACE of an existing fn, same signature; ACL preserved (re-read after apply).
--
-- 2026-11-26 ~10:15 AM PT (Claude Code cloud; Trevor: "Keep going and address all that needs it"). WHY.
-- refresh-conflated-editions (Vercel cron, daily 7:17 AM PT) failed today: its remap_base_to_parallel lane
-- (this function) hit its 120 s statement_timeout. Its run time had been climbing (11-23 108 s, 11-24 154 s,
-- 11-25 196 s for the whole route) and it moved 0 sales on each of those days: it joins EVERY mapped
-- Top Shot parallel (topshot_moment_subeditions, 2.35M rows, ~359K parallels) to all of `sales`, and the
-- table grows ~20K resolutions a day. Since #251 (20261114215605) the work it exists for is done elsewhere:
-- a sale written after its mapping lands on the parallel at write time, and
-- topshot_parallel_sales_followup() (every 2 h) re-keys sales whose mapping resolved in the last 3 days.
--
-- WHAT. Same predicate, plus `ms.resolved_at > now() - interval '7 days'` — the backstop for a mapping
-- that resolves after its sale, with a wider window than the 2-hourly lane. Measured on live data before
-- apply: 16K parallel mappings in the window, 0 sales to move, 8.9 s cold (was > 120 s).
-- Pin: supabase/tests/remap_topshot_base_keyed_parallel_sales.sql (adds: a mapping resolved 8 days ago is
-- not swept).
--
-- REVERT: re-apply the CREATE OR REPLACE from
--   20260802205000_audit_20260802_snapshot_remap_topshot_base_keyed_parallel_sales.sql and repoint the pin +
--   drift-guard entry at it.

CREATE OR REPLACE FUNCTION public.remap_topshot_base_keyed_parallel_sales()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '120s'
AS $function$
DECLARE n integer;
BEGIN
  UPDATE sales s
  SET edition_id = te.id
  FROM topshot_moment_subeditions ms,
       editions be,
       editions te
  WHERE s.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
    AND ms.nft_id = s.nft_id
    AND ms.subedition_id > 0
    -- 2026-11-26: only mappings the chain answered in the last 7 days. A sale written after its
    -- mapping is filed on the parallel at write time (#251); one written before it is moved once the
    -- mapping resolves. The full-history join timed out (120 s) on 11-26 after 0 moves for days.
    AND ms.resolved_at > now() - interval '7 days'
    AND be.id = s.edition_id
    AND be.external_id NOT LIKE '%::%'
    AND be.external_id = ms.base_external_id
    AND te.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
    AND te.external_id = be.external_id || '::' || ms.subedition_id;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END
$function$;

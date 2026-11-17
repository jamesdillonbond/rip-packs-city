-- 2026-10-15 (Claude Code cloud). get_edition_subedition_siblings: find a Top Shot edition's printings by
-- index instead of scanning every Top Shot edition.
--
-- WHY. Second-largest part of get_edition_market_bundle (every Top Shot edition page) once the All Day floor
-- join was fixed (20261015223418). `e.external_id = base OR e.external_id LIKE base || '::%'` cannot use an
-- index under en_US.UTF-8 (no text_pattern_ops), so each call filtered all 14,528 Top Shot editions: 4,390
-- buffers, ~11-25 ms, to return ~3 rows. `split_part(e.external_id, '::', 1) = base` is served by the
-- existing idx_editions_collection_base_external_id (collection_id, split_part(external_id, '::', 1)).
--
-- EQUIVALENCE. base = split_part(p_external_id, '::', 1) contains no '::', so for any base without LIKE
-- wildcards "ext = base OR ext LIKE base||'::%'" <=> "split_part(ext,'::',1) = base". Callers:
-- get_edition_market_bundle (gated on ^\d+:\d+(::\d+)?$) and lib/moment-detail/fetchers.ts (an edition's
-- external_id). Only Top Shot rows are matched and they are all digits:digits[::digits], so a base carrying
-- '_' (e.g. a Panini id) cannot prefix-match one under either predicate. Compared old vs new on 240
-- Top Shot ids (120 base, 120 parallels; all returned rows): 0 differences. ORDER BY COALESCE(subedition_id, 0)
-- has no ties in Top Shot (0 tied groups), so row order is unchanged. Timing, 40 calls: 11.50 -> 0.48 ms/call.
--
-- One predicate line changes; the rest of the body is byte-identical to the live one (md5 b5562d09...).
-- anon-exec: intentional — same signature, ACL unchanged (postgres, service_role) (get_edition_subedition_siblings)
-- REVERT: re-apply with the predicate restored to
--   `AND (e.external_id = b.base_ext OR e.external_id LIKE b.base_ext || '::%')` (md5 b5562d098e87ded5c5b59b97ec6efce4).
CREATE OR REPLACE FUNCTION public.get_edition_subedition_siblings(p_external_id text)
 RETURNS TABLE(external_id text, subedition_id smallint, subedition_name text, circulation_count integer, thumbnail_url text, fmv_usd numeric, confidence text, is_self boolean)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT e.external_id, e.subedition_id, e.subedition_name, e.circulation_count, e.thumbnail_url,
         lf.fmv_usd, lf.confidence::text, (e.external_id = p_external_id) AS is_self
  FROM (SELECT split_part(p_external_id, '::', 1) AS base_ext) b
  JOIN public.editions e
    ON e.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
   AND split_part(e.external_id, '::', 1) = b.base_ext
  LEFT JOIN LATERAL (
    SELECT fmv_usd, confidence FROM public.fmv_snapshots fs
    WHERE fs.edition_id = e.id ORDER BY computed_at DESC LIMIT 1
  ) lf ON true
  ORDER BY COALESCE(e.subedition_id, 0);
$function$;

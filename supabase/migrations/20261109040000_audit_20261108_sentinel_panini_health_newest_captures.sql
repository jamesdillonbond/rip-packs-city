-- audit_20261108_sentinel_panini_health_newest_captures
--
-- anon-exec: not granted (sentinel_panini_health) — CREATE OR REPLACE keeps the live ACL,
--   read 11-08 8:00 PM PT as {postgres=X, service_role=X}: anon cannot execute, so no revoke here.
--
-- 2026-11-08 ~7:50 PM PT (Claude Code cloud; Trevor: "Keep going").
--
-- WHY. The Sentinel's "Panini Ingest" arm read INCONCLUSIVE (db saturated) at 6:04 and 7:04 PM PT:
-- sentinel_panini_health() ran past 60 s from the MCP. Its max_serials_per_edition_26h leg counts
-- every panini_card_serials row captured in 26 h — ~470k rows today (143k when the captured_at index
-- landed, 20261003012100) — and nearly every one is a HEAP FETCH, because freshly written pages are
-- never all-visible: 2 h = 39,359 rows, 42,652 heap fetches, 7,208 reads, 1.3 s. The other legs are
-- 4 ms (newest_sale_at) or a 29 MB editions scan.
--
-- WHAT CHANGES. The leg asks one question — is the runner paging past one 30-row page — and a working
-- pager writes an edition's serials together, so the NEWEST captures answer it. It now counts the newest
-- 20,000 captures within 26 h, under a NEW key `max_serials_per_edition_newest_captures` (the old key is
-- dropped, not redefined; app/api/sentinel/route.ts reads the new key and falls back to the old one).
-- Measured 7:46 PM PT: newest 20k = last ~20 min, 151 editions, max 390 (> 30 = ok). Soundness: a value
-- > 30 here implies the 26 h max is > 30; a regression to one page reads <= 30 here as it did before.
-- Every other key unchanged. Base prosrc md5 ae23ae75a91249e1dd7b6d509b6b475c re-read 7:43 PM PT.
-- Grants unchanged (service_role, postgres).
--
-- Revert: re-apply the body from 20261101004147.

DO $premise$
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE proname = 'sentinel_panini_health') <> 'ae23ae75a91249e1dd7b6d509b6b475c' THEN
    RAISE EXCEPTION 'premise: sentinel_panini_health changed since read; re-read before replacing';
  END IF;
END
$premise$;

CREATE OR REPLACE FUNCTION public.sentinel_panini_health()
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  SELECT jsonb_build_object(
    'newest_walk_at',     (SELECT max(last_seen_at) FROM panini_editions),
    'edition_age_max_h',  (SELECT round((extract(epoch FROM now() - min(last_seen_at)) / 3600)::numeric, 1) FROM panini_editions),
    'editions',           (SELECT count(*) FROM panini_editions),
    'edition_refreshed_24h',
                          (SELECT count(*) FROM panini_editions WHERE last_seen_at > now() - interval '24 hours'),
    'max_serials_per_edition_newest_captures',
                          (SELECT COALESCE(max(n), 0) FROM (
                             SELECT count(*) AS n FROM (
                               SELECT edition_external_id FROM panini_card_serials
                                WHERE captured_at > now() - interval '26 hours'
                                ORDER BY captured_at DESC
                                LIMIT 20000) r
                              GROUP BY edition_external_id) z),
    'newest_sale_at',     (SELECT max(last_sale_at) FROM panini_card_serials)
  )
$function$;

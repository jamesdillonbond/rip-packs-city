-- audit_20261105: get_serial_backfill_targets hands out targets NEWEST-first.
--
-- WHY. The function ordered `sold_at ASC` behind a 24 h failure cooldown.
-- ~3,500 Top Shot NULL-serial rows qualify, almost all an unresolvable
-- 2023-25 `flowty_chain_v1` / `onchain` tail (oldest 2023-11-24). That tail
-- fills every 300-row run (`sales-serial-backfill`, 2-hourly, read 11-05:
-- 300/300 `onchain_nil` on most runs), so a fresh NULL-serial sale was
-- reached only in the one daily run where the whole tail sat on cooldown
-- (~4:40-6:40 AM PT; 80-136 resolved on 11-03/04/05). On 11-05 a seller
-- wave into edition offers landed 115 Top Shot offer fills with NULL serials
-- from ~12 PM PT, and they would have waited until the next trough.
-- The class: an ORDER BY on an IMMUTABLE key re-reads its own unresolvable
-- head (CLAUDE.md, "A LEG'S ORDER BY DECIDES WHETHER IT PROGRESSES").
--
-- WHAT CHANGES. Only the ORDER BY: `sold_at DESC, id` (id = deterministic
-- tiebreak; the caller reads one page at offset 0). Fresh rows (~130 Top Shot
-- in 30 d) take their slots first; the old tail keeps every slot they leave,
-- so its retry treadmill (left as an operator call in 20260831093302) is
-- unchanged. Same partial index `idx_sales_<yr>_serial_backfill_targets
-- (sold_at)`, scanned backward.
--
-- MEASURED 11-05 ~9:20 PM PT, EXPLAIN (ANALYZE, BUFFERS) of the body with the
-- Top Shot literal, LIMIT 300: ASC shared hit=13,020 read=4; DESC (+id)
-- shared hit=5,017 read=225 -> 5,242 vs 13,024 buffers touched (fewer
-- cooled-down rows probed before 300 are found). Timings were cold/warm and
-- are not the claim.
--
-- Header unchanged from live (STABLE SECURITY DEFINER, search_path public,
-- statement_timeout 15s). Live prosrc md5 before: e7e9852c1c2c21f46e5ab51e3a7c70b8.
-- ACL before: {postgres=X/postgres,service_role=X/postgres}; CREATE OR REPLACE
-- keeps it, re-asserted below.
-- anon-exec: none.
--
-- Exit (11-06): the 115 11-05 offer-fill NULL serials resolve on the first
-- runs after apply, not at the next trough; TS `resolved` per run > 0 on
-- daytime runs with fresh NULLs present.
-- Revert: re-create with `ORDER BY s.sold_at ASC` (body of the base above).

CREATE OR REPLACE FUNCTION public.get_serial_backfill_targets(p_collection_id uuid DEFAULT NULL::uuid, p_limit integer DEFAULT 200, p_offset integer DEFAULT 0)
 RETURNS TABLE(sale_id uuid, collection_id uuid, nft_id text, edition_id uuid, sold_at timestamp with time zone)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '15s'
AS $function$
  SELECT
    s.id           AS sale_id,
    s.collection_id,
    s.nft_id::text AS nft_id,
    s.edition_id,
    s.sold_at
  FROM sales s
  WHERE (s.serial_number IS NULL OR s.serial_number = 0)
    AND s.nft_id IS NOT NULL
    AND s.nft_id <> ''
    AND s.collection_id IN (
      '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid,  -- topshot
      'dee28451-5d62-409e-a1ad-a83f763ac070'::uuid   -- allday
    )
    AND (p_collection_id IS NULL OR s.collection_id = p_collection_id)
    -- Skip sales that recently failed (24h cooldown — same backfill rerun is rare)
    AND NOT EXISTS (
      SELECT 1 FROM sales_serial_backfill_failures ssbf
      WHERE ssbf.sale_id = s.id
        AND ssbf.last_failed_at > NOW() - INTERVAL '24 hours'
    )
  -- NEWEST first: an unresolvable old tail must not occupy every slot (audit_20261105).
  ORDER BY s.sold_at DESC, s.id
  LIMIT p_limit OFFSET p_offset;
$function$;

REVOKE ALL ON FUNCTION public.get_serial_backfill_targets(uuid, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_serial_backfill_targets(uuid, integer, integer) TO service_role;

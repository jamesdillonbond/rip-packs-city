-- Repo record of audit_20260803_candy_special_serials_board_union_arms,
-- applied to prod via the Supabase MCP on 2026-08-03. Idempotent: re-running is a
-- no-op against the live definition.
--
-- candy_special_serials_board: buffer touches ~397,000 -> ~42,000 (~9x).
--
-- ⚠ Wall-clock on this Micro instance is NOT a reliable measure of this change:
-- the same fixed view measured 58 ms quiet and 28,174 ms under I/O contention,
-- with an identical plan and identical buffer counts. An early note here claimed
-- "7,388ms -> 58ms (~126x)", which compared a contended BEFORE against a quiet
-- AFTER and is not defensible. Like-for-like under heavy load: 82,137 -> 28,174 ms.
-- Buffer accesses are the load-independent metric; quote those.
--
-- NOT addressed here: the candy_treasury_wallet InitPlan (GroupAggregate over all
-- 25,375 candy wmc rows to pick one top holder) is untouched and was 12,618 ms of
-- the contended 28,174 ms. Materialising it is the next lever if this board needs one.
--
-- WHY: the board is PUBLIC (/insights/candy-mlb, live since 2026-07-31) and sat
-- 2.73x over its liveness budget (11,193ms vs 4,100ms), one of the 3 boards holding
-- public_board_slow_count in BREACH. That arm warns BEFORE a board renders empty,
-- so this was a real pre-failure signal.
--
-- ROOT CAUSE: the special-serial predicate was a single OR
--   (serial=1 OR serial=circulation_count OR serial<=3 OR serial=jersey_number)
-- which Postgres cannot satisfy from an index, so for each of the 125 editions it
-- scanned EVERY serial on idx_wmc_coll_ek_serial_cover (~203 rows) and filtered 198
-- away -- 25,375 index entries, 6,623 heap fetches, to return 607 rows. Because the
-- wmc leg was correlated, the latest-FMV-per-edition Unique/Merge Append also
-- re-executed once per output row: 607 loops, 327,554 buffer hits.
--
-- NOT bloat: wmc measured 98.4% all-visible, 4.5% dead, autovacuum 40 min prior.
-- A VACUUM would have decayed within hours on a table this hot. The shape was wrong.
--
-- FIX: split the OR into three UNION arms inside a LATERAL -- each an index
-- point/range probe. Removing the correlation also collapsed the FMV join to a
-- single Hash Right Join (1,101 buffers, from 327,554).
--   UNION (not UNION ALL) is load-bearing: a serial can satisfy two arms at once
--   (circulation_count=1, or jersey_number<=3) and UNION ALL would duplicate rows
--   the original single-scan OR emitted once.
--   `serial_number <= 3` kept verbatim rather than tightened to BETWEEN 1 AND 3.
--
-- EQUIVALENCE PROVEN before applying: old and new both return 607 rows and BOTH
-- directions of EXCEPT ALL return 0 (EXCEPT ALL preserves multiplicity, so a
-- duplicate-count change would have shown).
--
-- REVERT: restore the previous definition (single OR in the WHERE clause) and
-- re-apply the ALTER VIEW below. View definition only -- no data change.
CREATE OR REPLACE VIEW public.candy_special_serials_board AS
 WITH treas AS (
         SELECT candy_treasury_wallet.wallet_address
           FROM candy_treasury_wallet
        )
 SELECT e.external_id,
    e.player_name,
    e.name AS edition_name,
    e.tier::text AS tier,
    e.tier = 'LEGENDARY'::tier_type AS is_rainbow,
    e.circulation_count,
    w.serial_number,
        CASE
            WHEN w.serial_number = 1 THEN 'first_mint'::text
            WHEN w.serial_number = e.circulation_count THEN 'last_mint'::text
            WHEN w.serial_number <= 3 THEN 'low_serial'::text
            ELSE 'jersey_match'::text
        END AS kind,
    w.wallet_address AS owner,
    w.wallet_address = (( SELECT treas.wallet_address
           FROM treas)) AS is_treasury,
    fc.fmv_usd,
    fc.confidence::text AS confidence,
    ls.last_sale_usd,
    ls.last_sale_at
   FROM editions e
     CROSS JOIN LATERAL (
             SELECT m.serial_number, m.wallet_address
               FROM wallet_moments_cache m
              WHERE m.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid
                AND m.edition_key = e.external_id::text
                AND m.serial_number <= 3
           UNION
             SELECT m.serial_number, m.wallet_address
               FROM wallet_moments_cache m
              WHERE m.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid
                AND m.edition_key = e.external_id::text
                AND m.serial_number = e.circulation_count
           UNION
             SELECT m.serial_number, m.wallet_address
               FROM wallet_moments_cache m
              WHERE m.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid
                AND m.edition_key = e.external_id::text
                AND e.jersey_number IS NOT NULL AND e.jersey_number > 0
                AND m.serial_number = e.jersey_number
        ) w
     LEFT JOIN candy_fmv_current fc ON fc.edition_id = e.id
     LEFT JOIN LATERAL ( SELECT s.price_usd AS last_sale_usd,
            s.sold_at AS last_sale_at
           FROM sales s
          WHERE s.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid AND s.edition_id = e.id AND s.serial_number = w.serial_number
          ORDER BY s.sold_at DESC
         LIMIT 1) ls ON true
  WHERE e.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid;

-- MANDATORY, NOT CLEANUP: CREATE OR REPLACE VIEW silently drops reloptions.
-- v_rpc_trust_health lost security_invoker this way twice in three days
-- (2026-08-01 and 2026-08-03). Pair this ALTER with ANY change to this view.
ALTER VIEW public.candy_special_serials_board SET (security_invoker = on);

-- Every candy view is anon+authenticated SELECT-REVOKED per CLAUDE.md; the board is
-- read via supabaseAdmin. Re-assert rather than assume.
REVOKE SELECT ON public.candy_special_serials_board FROM anon, authenticated;

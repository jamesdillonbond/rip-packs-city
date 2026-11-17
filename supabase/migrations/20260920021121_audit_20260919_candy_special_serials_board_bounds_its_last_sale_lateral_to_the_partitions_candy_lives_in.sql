-- `candy_special_serials_board` (public /candy-mlb board; 5,193 ms on the 5:28 PM PT liveness sweep,
-- one of the two `public_board_slow_count` breaches; `canceling statement due to statement timeout`
-- on the authenticated 8 s budget under every spell — Vercel 24 h group `[candy-mlb]
-- candy_special_serials_board error`, 29 events / 20 users). Two costs, two fixes:
--   1. (DONE 6:49 PM PT, 20260920015138) the sales_2026 leg of the last-sale LATERAL walked every
--      sale of the edition per serial → idx_sales_2026_candy_edition_serial_sold: 30,627 → 1,299 buffers.
--   2. (THIS) the same LATERAL still probes sales_2020 … sales_2025 and sales_2027 for a collection
--      whose FIRST sale is 2026-07-22 (measured: min(sold_at) over all 7,433 Candy sales) — seven
--      partitions × 612 rows ≈ 9,300 of the remaining 12,742 buffers, every one a probe that finds
--      nothing. `sales` is range-partitioned on sold_at, so a `sold_at >= '2026-01-01'` bound lets
--      the planner prune to sales_2026/2027. Candy cannot have a sale before 2026 (the collection
--      is a 2026 launch), so the bound cannot drop a row.
-- Applied from Cowork cloud 2026-09-19 ~7:15 PM PT. Column list unchanged (CREATE OR REPLACE VIEW
-- keeps it). CREATE OR REPLACE VIEW RESETS reloptions, so security_invoker is re-set right after
-- (the 4× trap in CLAUDE.md). Not drift-pinned in supabase/tests (checked).
-- 📏 RESULT (same minute): count(*) over the view 42,070 → 3,516 buffers (−92 % vs the morning's
--   plan; −72 % vs after fix 1 alone), only sales_2026 + the empty sales_2027 under the LATERAL;
--   612 rows before and after, security invariants 0.
-- EXIT: the liveness sweep's elapsed_ms for this view drops under 1 s and it leaves
--   public_board_slow_count.
-- FALSIFIER: any Candy sale with sold_at < 2026-01-01 ever appearing (a backfill to an earlier
--   chain era) — then the bound hides a real last sale and must move.
-- REVERT: re-apply the previous view body (pg_get_viewdef as of 2026-09-19 is the same text minus
--   the `AND s.sold_at >= '2026-01-01'` predicate) + ALTER VIEW ... SET (security_invoker = on).

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
     CROSS JOIN LATERAL ( SELECT m.serial_number,
            m.wallet_address
           FROM wallet_moments_cache m
          WHERE m.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid AND m.edition_key = e.external_id::text AND m.serial_number <= 3
        UNION
         SELECT m.serial_number,
            m.wallet_address
           FROM wallet_moments_cache m
          WHERE m.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid AND m.edition_key = e.external_id::text AND m.serial_number = e.circulation_count
        UNION
         SELECT m.serial_number,
            m.wallet_address
           FROM wallet_moments_cache m
          WHERE m.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid AND m.edition_key = e.external_id::text AND e.jersey_number IS NOT NULL AND e.jersey_number > 0 AND m.serial_number = e.jersey_number) w
     LEFT JOIN candy_fmv_current fc ON fc.edition_id = e.id
     LEFT JOIN LATERAL ( SELECT s.price_usd AS last_sale_usd,
            s.sold_at AS last_sale_at
           FROM sales s
          WHERE s.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid
            AND s.edition_id = e.id
            AND s.serial_number = w.serial_number
            -- 2026-09-19: Candy's first sale is 2026-07-22; the bound prunes sales_2020..2025.
            AND s.sold_at >= '2026-01-01'::timestamptz
          ORDER BY s.sold_at DESC
         LIMIT 1) ls ON true
  WHERE e.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid;

ALTER VIEW public.candy_special_serials_board SET (security_invoker = on);

DO $$
BEGIN
  IF NOT ((SELECT reloptions FROM pg_class WHERE relname = 'candy_special_serials_board') @> ARRAY['security_invoker=on']) THEN
    RAISE EXCEPTION 'security_invoker lost on candy_special_serials_board';
  END IF;
END $$;

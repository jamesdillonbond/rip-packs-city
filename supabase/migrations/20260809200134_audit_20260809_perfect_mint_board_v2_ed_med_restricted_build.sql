-- 2026-08-09 — STEP 1 of 2: build a v2 perfect-mint board MV whose `ed_med` leg is restricted to
-- the edition set `perfect` already produces. Built WITH NO DATA + verified by EXCEPT diff before
-- any swap; the swap is a separate migration. Nothing user-facing changes in this step.
--
-- WHY: `mv_topshot_perfect_mint_premiums_board` is the platform's largest scheduled consumer.
-- Its `ed_med` CTE computes a 180-day median over EVERY Top Shot edition with >=15 sales, then the
-- final query INNER JOINs it to `perfect` (editions with a recent perfect-serial sale) and throws
-- almost all of it away.
--
-- OUTPUT-EQUIVALENT BY CONSTRUCTION, and the proof does not depend on measurement:
--   * `ed_med` groups by edition_id; restricting its input to a SET OF edition_ids removes whole
--     groups and cannot change any surviving group's membership, so each survivor's
--     percentile_cont median and count(*) are bit-identical.
--   * `HAVING count(*) >= 15` is therefore also unaffected (it is a per-group predicate).
--   * The final join `perfect p JOIN ed_med m ON m.edition_id = p.edition_id` is INNER, so every
--     ed_med row NOT in `perfect` was already discarded. Removing it earlier changes nothing.
--   * The `editions` join is INNER on p.edition_id and the WHERE clause is unchanged.
--
-- MEASURED with planner-only EXPLAIN (safe on an IO-throttled instance — planning does no IO):
--
--   leg                    current                          restricted
--   ---------------------  -------------------------------  ------------------------------------
--   ed_med GroupAggregate  cost 78,886 over 396,644 rows    cost 2,246 over 6,202 rows
--                          (Merge Append / Index Only Scan) (Nested Loop -> per-edition
--                                                            Index Only Scan on
--                                                            idx_sales_2026_ts_edition_median)
--   perfect CTE            cost 97,947                      cost 97,946 (unchanged)
--   TOTAL                  cost 176,993                     cost 100,355  (-43%)
--
-- ⚠ Cost is NOT time (this repo has been bitten by that exact inference — packev was 92% of a plan's
--   cost and 8.5% of its runtime). The number to trust here is ROWS SCANNED: 396,644 -> 6,202, a
--   98.4% reduction in physical row reads. On an instance that is disk-IO-budget-bound rather than
--   compute-bound, that is the meaningful figure, and it is why this is expected to help.
--
-- ⚠ NOTE WHERE THE COST NOW LIVES: after this change `perfect` is 97.6% of the plan (97,946 of
--   100,355). It hash-joins a 110k-row index scan against a SEQ SCAN of `editions` on
--   `s.edition_id = e2.id AND s.serial_number = e2.circulation_count` — a cross-column correlation
--   that cannot be indexed directly. So `perfect` is a genuinely hard, SEPARATE problem; do not
--   expect a further easy win there, and do not read this migration as having addressed it.
--
-- ⚠ REJECTED ALTERNATIVE, deliberately: joining the existing `mv_topshot_edition_median_180d`,
--   whose definition is byte-equivalent to this `ed_med` CTE. It would remove the computation
--   entirely, but that MV refreshes on its own 6-hourly cron, so the median leg would carry up to
--   ~6h of staleness. The restriction above keeps the median computed fresh at refresh time and is
--   provably identical, so it is the correct trade while accuracy is the gate.
--
-- REVERT: DROP MATERIALIZED VIEW IF EXISTS public.mv_topshot_perfect_mint_premiums_board_v2;
--   (this step is additive and inert — nothing reads v2 until step 2 swaps it in.)

CREATE MATERIALIZED VIEW public.mv_topshot_perfect_mint_premiums_board_v2 AS
WITH perfect AS (
  SELECT DISTINCT ON (s.edition_id) s.edition_id,
         s.price_usd AS perfect_price,
         s.sold_at   AS perfect_sold_at,
         s.moment_id,
         s.nft_id,
         s.serial_number
    FROM sales s
    JOIN editions e2 ON e2.id = s.edition_id
   WHERE s.collection = 'nba_top_shot'::text
     AND e2.circulation_count > 1
     AND s.serial_number = e2.circulation_count
     AND s.sold_at >= (now() - '90 days'::interval)
     AND s.price_usd > 0.50
   ORDER BY s.edition_id, s.sold_at DESC
), ed_med AS (
  SELECT s.edition_id,
         percentile_cont((0.5)::double precision) WITHIN GROUP (ORDER BY ((s.price_usd)::double precision)) AS edition_median,
         count(*) AS edition_sales_180d
    FROM sales s
   WHERE s.collection = 'nba_top_shot'::text
     AND s.sold_at >= (now() - '180 days'::interval)
     AND s.price_usd > 0.50
     AND s.edition_id IN (SELECT perfect.edition_id FROM perfect)   -- <<< the only change
   GROUP BY s.edition_id
  HAVING (count(*) >= 15)
)
SELECT e.id AS edition_id,
    e.external_id,
    e.player_name,
    e.set_name,
    (e.tier)::text AS tier,
    e.circulation_count,
    e.thumbnail_url,
    p.moment_id,
    p.nft_id,
    p.serial_number AS perfect_serial,
    round((m.edition_median)::numeric, 2) AS edition_median_usd,
    round((p.perfect_price)::numeric, 2) AS perfect_last_sale_usd,
    round((((p.perfect_price)::double precision / m.edition_median))::numeric, 1) AS premium_multiple,
    p.perfect_sold_at,
    m.edition_sales_180d,
    (EXISTS ( SELECT 1
           FROM topshot_conflated_editions c
          WHERE (c.edition_id = e.id))) AS is_conflated
   FROM ((perfect p
     JOIN ed_med m ON ((m.edition_id = p.edition_id)))
     JOIN editions e ON ((e.id = p.edition_id)))
  WHERE (((e.external_id)::text ~ '^[0-9]+:[0-9]+(::[0-9]+)?$'::text)
     AND (e.thumbnail_url IS NOT NULL)
     AND (m.edition_median >= (0.75)::double precision)
     AND (((p.perfect_price)::double precision / m.edition_median) >= (5)::double precision))
WITH NO DATA;

-- REFRESH ... CONCURRENTLY requires a unique index; mirror the original exactly.
CREATE UNIQUE INDEX mv_topshot_perfect_mint_premiums_board_v2_edition_id_key
  ON public.mv_topshot_perfect_mint_premiums_board_v2 USING btree (edition_id);

-- Match the original's posture: anon/authenticated must NOT read the MV directly (they reach it
-- only through the security_invoker view). Supabase default privileges grant explicitly, so
-- revoke by role AND from PUBLIC.
REVOKE SELECT ON public.mv_topshot_perfect_mint_premiums_board_v2 FROM PUBLIC;
REVOKE SELECT ON public.mv_topshot_perfect_mint_premiums_board_v2 FROM anon, authenticated;
GRANT SELECT ON public.mv_topshot_perfect_mint_premiums_board_v2 TO service_role;
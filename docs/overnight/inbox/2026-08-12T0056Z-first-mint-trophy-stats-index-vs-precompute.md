# Decision-ready — `topshot_first_mint_trophy_stats` slow board: root-caused, urgency re-scoped, index-vs-precompute settled

Claude Code interactive, 2026-08-11 ~17:56 PDT (00:56Z Aug 12). **Read-only diagnostics only — nothing shipped.** Sharpens the open items in
`2026-08-10T1900Z-*` (item 2) and `2026-08-10T1930Z-*` (Correction 2), which flagged the board as "genuinely 3.2× over budget" and "index is probably the wrong fix" but did not pin the root cause, re-scope the urgency, or confirm build-safety. All three are done here.

## TL;DR
The 17.3s is **not a live user-facing page breach** — the page is cache-mitigated. The cost lands on the 5-min cron warm + the live API route + the liveness probe. The durable fix is **precompute** (owner's call); the covering index is a valid fast fallback but adds write-amplification to a hot partition and a reviewer already recommended against it. **No autonomous action taken; no emergency.**

## 1. Root cause of the Parallel Seq Scan — PINNED
`topshot_first_mint_trophy_stats` aggregates `topshot_first_mint_trophies`, whose expensive CTE is:
```
other_serial_avg:  SELECT edition_id, avg(price_usd), count(*)
  FROM sales_2026
  WHERE collection_id = '95f28a17-…'::uuid   -- TS
    AND serial_number > 1 AND price_usd > 0 AND sold_at >= now()-180d
  GROUP BY edition_id HAVING count(*) >= 3
```
The nearest existing index, **`idx_sales_2026_ts_edition_median`** (the 2026-08-08 `ed_med` fix) —
`(edition_id, sold_at DESC) INCLUDE (price_usd) WHERE collection='nba_top_shot' AND price_usd > 0.50` — **cannot serve this CTE, for two independent reasons**:
1. Its partial predicate keys on **`collection`** (text long-form); the CTE filters **`collection_id`** (uuid). The planner can't prove those equivalent, so the partial index is not matched.
2. Its predicate is **`price_usd > 0.50`**; the CTE filters **`price_usd > 0`** (broader). A `>0.50` partial index is unusable for a `>0` query.

So the planner falls back to a Parallel Seq Scan over `sales_2026` (per 1900Z EXPLAIN: 330,582 rows × 2 workers, 144,180 removed by filter). The `mint_one_sales` CTE (`serial_number = 1`) is already served by `idx_sales_2026_serial1` — only `other_serial_avg` seq-scans.

## 2. Urgency re-scoped DOWN — the user-facing page is already cache-mitigated
- **PAGE `/insights/first-mint`** → `readBoardOrLive("first-mint", …)` (`app/insights/first-mint/page.tsx:24`) → serves the **nc1 `public_board_snapshots` cache**. Users do NOT pay 17.3s.
- **Cron warm** (`/api/cron/refresh-insights-cache`, `*/5`) → `warmBoard("first-mint", fetchFirstMintDefault)` → **pays 17.3s every 5 min** (a real recurring saturation contributor).
- **Live API route** `/api/public/insights/first-mint` → queries the two views **directly, no cache** (`route.ts:49,72`) → pays 17.3s. Backs the concierge `get_insight_board` + any direct consumer.
- **Liveness probe** measures the stats view and reads it as over-budget.

So this is a **cron-cost / API-latency / instrument item, not a broken public page** — which lowers its priority relative to how 1900Z (pre-cache-analysis) framed it.

## 3. Build-safety confirmed (if the index route is ever chosen)
- **No duplicate / near-duplicate exists.** Full `pg_indexes` sweep of `sales_2026` (20 indexes) — none carries a `serial_number > 1` partial or a `(collection_id, sold_at) INCLUDE (edition_id, price_usd)` shape. Safe to build.
- **The fix that WOULD work:** `CREATE INDEX CONCURRENTLY idx_sales_2026_ts_otherserial_cover ON sales_2026 (collection_id, sold_at DESC) INCLUDE (edition_id, price_usd) WHERE serial_number > 1 AND price_usd > 0;` — leading `collection_id` equality, `sold_at` range, partial matches the CTE predicate exactly, INCLUDE covers `GROUP BY edition_id, avg(price_usd)` → index-only scan replaces the seq scan.

## 4. Why it is NOT an autonomous ship (two independent blockers)
1. **Reviewer recommendation stands against the index.** `1930Z` Correction 2: *"an index is probably the wrong fix anyway; retire the 'index it' framing, queue it as precompute."* This would be a **second** `INCLUDE` index on the hot `sales_2026` partition (write-amplification vs. the serial/counterparty backfills that UPDATE it — INCLUDE columns block HOT for any update to a row).
2. **DB was saturated at diagnosis time** (2026-08-11 ~17:5xZ): a 256s stuck autovacuum on `wallet_moments_cache` + multiple IO-blocked reads. `CONCURRENTLY` builds are forbidden in that window (they consume the depleted IO budget), and its phase-3 wait would stall on the long transactions anyway.

## Recommendation
Durable fix = **precompute** `topshot_first_mint_trophy_stats` (same pattern as the trust-health precompute legs; or fold the aggregate into the nc1 warm so it is computed once per warm, not on the live API route too). That is a precompute-owner design decision, not autonomous. If a fast interim win is wanted despite the write-amplification tradeoff, the §3 covering index is proven-correct and build-safe — **but only in a genuinely quiet window** (verify low `DataFileRead` wait first).

# `get_set_activity` pays ~45k buffers to find 20 sales on a sparse WIDE set (Candy "2022 All-Star Tricons")

**Filed:** 2026-11-19 ~4:05 PM PT (Claude Code cloud; Trevor: "Keep going")
**Severity:** LOW — the page degrades HONESTLY ("Recent sales couldn't be loaded"), the set is Candy (secondary market silent since 10-11), traffic is mostly crawlers.

## Evidence (measured, not inferred)

- Vercel runtime logs, 48 h: `/candy-mlb/set/2022-all-star-tricons` logged `[entity-section] set activity get_set_activity failed after retries: canceling statement due to statement timeout — degrading to empty` **5 times at 5 separate times** (11-18 00:37, 03:06, 04:26 PT; 11-18 22:30, 11-19 03:04 PT). Every other `get_set_activity` / `get_player_top_sales` / `get_team_squeeze` failure in the window is a BURST (10–15 pages within seconds at 11-18 5:03 PM PT and 11-19 5:06 AM PT) — an estate/contention event, a different class.
- The set: **4,088 editions, 20 sales ever** (newest 2026-09-08). Candy has 18,572 sales in 365 d.
- `explain (analyze, buffers) select get_set_activity(candy, '2022-all-star-tricons', 20, 0)`: **cold 3,237 ms (shared hit 39,917 / read 5,665, 3.1 s of IO); warm 94 ms, 45,300 buffers.** Function `statement_timeout` is 8 s, so any contention on a cold cache times it out.
- Path: 4,088 × 20 > 2,000 → WIDE. Head pass over Candy's newest 5,000 sales finds 0 of this set's rows (≈5k buffers, and ~150 ms of CPU on a linear `= ANY(4,088-element array)` per row). Year count = 5,000 → "big collection, sparse set" → step 1 runs an index-only LATERAL per edition across the 2025/2026/2027 partitions: ~4,088 × 3 probes ≈ 40k buffers, to rank 20 rows.

## Options (not shipped — each needs measuring against Top Shot sets too)

1. A third mode for "set has fewer than W sales in the year": answer from one scan of the collection's year via a hash semi-join (`edition_id IN (SELECT unnest(ids))`) — cost scales with the COLLECTION'S year (Candy 18.5k rows ≈ 15k buffers by the 5,000-row pass's 4,228-buffer rate), so it must be gated on collection size, never applied to Top Shot.
2. Make the head pass's membership test hashed (`IN (SELECT unnest(v_edition_ids))` instead of `= ANY(array)`) — removes the ~150 ms CPU, not the 40k buffers.
3. Leave it: honest degradation, low-traffic page on a closed market.

⚠ `get_set_activity` is a full-body `CREATE OR REPLACE` — re-read live `prosrc` and md5-guard it; measure BUFFERS on a wide Top Shot set (e.g. `the-champion-s-path`) as the no-change control before and after.

## Resolution — 2026-11-19 ~6:35 PM PT (Claude Code cloud, same thread): CLOSED, not shipping — measured

- **Option 1 measured both ways.** The hashed one-pass read for the Candy set: **5,721 buffers / 59 ms** (index-only on `idx_sales_2026_candy_edition_serial_sold`) vs 45,300 today — an 8× win. But it needs a gate on the collection's year volume, and the cheap gate (raise the existing `LIMIT 5000` year count to 50,000) costs **Top Shot 32,971 buffers / 3.7 s cold (19,869 heap fetches)** on EVERY sparse-wide-set call — a regression larger than the win, on the high-traffic collection.
- **Option 2** saves ~150 ms of CPU and none of the buffers.
- **Top Shot is not affected:** `the-champion-s-path` (48 editions) is 6,640 buffers / 0.39 s cold; its 11-19 timeouts were load bursts (many pages within seconds), not this function.
- **Decision:** leave it. The only winning shape is a Candy-specific branch for one crawler-hit page on a market silent since 10-11, and the page already degrades honestly. **Reopen if** Candy trading revives (`candy_revival_sales_since_recorded_silence` breaches) or another collection shows the same 5-separate-times pattern.
